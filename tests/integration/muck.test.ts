import type { ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function player(tableId: string) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId);
  open.push(ws);
  return { ...u, ws };
}
type Player = Awaited<ReturnType<typeof player>>;

const seatOf = (p: Player) => p.ws.state!.you.seatIndex!;
const live = (s: TableView) => s.status === 'playing' && s.hand?.stage === 'preflop' && s.hand.actorSeat !== null;

/** Plays the current hand to the end, each player choosing from `pick` on their turn. Resolves with each one's settled view. */
async function playOut(ps: Player[], pick: (p: Player, s: TableView) => string) {
  const handId = ps[0]!.ws.state!.hand!.id;
  const settled = ps.map((p) => p.ws.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 30_000, 'settled'));
  for (let guard = 0; guard < 400; guard++) {
    const s0 = ps[0]!.ws.state!;
    if (s0.hand?.id !== handId || s0.hand.stage === 'settled') break;
    const actor = ps.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId);
    if (!actor) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const { result } = await actor.ws.act(pick(actor, actor.ws.state!));
    expect(result.t, JSON.stringify(result)).toBe('state');
  }
  return Promise.all(settled);
}
const checkDown = (_: Player, s: TableView) => (s.you.legal.some((o) => o.type === 'check') ? 'check' : 'call');

/** The finished hand once D1 has it (the result goes out before the write). */
async function recorded(p: Player, handId: string) {
  for (let i = 0; i < 50; i++) {
    const r = await p.client.get(`/api/me/hands/${handId}`);
    if (r.status === 200) return r.body as { players: { userId: string; isYou: boolean; holeCards: string[] | null; rankClass: string | null }[] };
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`hand ${handId} was not recorded`);
}

const muckOn = async (p: Player, on = true) => {
  expect(await p.ws.request({ t: 'muck', on })).toMatchObject({ t: 'ack' });
  await p.ws.waitState((s) => s.you.autoMuck === on);
};

describe('showdown muck', () => {
  it('a losing covered hand stays face down for the table and in others’ history; its owner keeps it', async () => {
    const [a, b] = [await player('it-muck-0'), await player('it-muck-0')];
    const spec = await player('it-muck-0');
    // Not seated: nothing to set.
    expect(spec.ws.state!.you.autoMuck ?? null).toBeNull();
    expect(await spec.ws.request({ t: 'muck', on: true })).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(a.ws.state!.you.autoMuck).toBe(false);
    await muckOn(a);
    await muckOn(b);
    // A split pot shows both hands (both won chips): play on until one hand has a single winner.
    let views: TableView[] = [];
    for (let n = 0; n < 5; n++) {
      for (const p of [a, b]) await p.ws.waitState((s) => live(s) && !views.some((v) => v.hand!.id === s.hand!.id), 20_000, 'hand start');
      views = await playOut([a, b], checkDown);
      if (views[0]!.hand!.result!.winners.length === 1) break;
    }
    const [va, vb] = views as [TableView, TableView];
    const res = va.hand!.result!;
    expect(res.winners).toHaveLength(1);
    const winner = res.winners[0]!.seatIndex === seatOf(a) ? a : b;
    const loser = winner === a ? b : a;
    const [vw, vl] = winner === a ? [va, vb] : [vb, va];
    const ws = seatOf(winner);
    const ls = seatOf(loser);
    // The winner's hand is face up for everyone; the loser's only for the loser.
    expect(res.showdown.map((x) => x.seatIndex)).toEqual([ws]);
    expect(vl.hand!.result!.showdown.map((x) => x.seatIndex)).toEqual([ws]);
    expect(vw.seats[ls]!.holeCards ?? null).toBeNull();
    expect(vw.seats[ws]!.holeCards).toHaveLength(2);
    expect(vl.seats[ls]!.holeCards).toHaveLength(2);
    expect(vl.seats[ws]!.holeCards).toHaveLength(2);
    const sv = await spec.ws.waitState((s) => s.hand?.id === va.hand!.id && s.hand.stage === 'settled');
    expect(sv.seats[ls]!.holeCards ?? null).toBeNull();
    expect(sv.hand!.result!.showdown.map((x) => x.seatIndex)).toEqual([ws]);
    expect(vw.seats.reduce((x, s) => x + s.stack, 0)).toBe(2000);

    // Turning muck off after the hand settled does not turn the cards over.
    expect(await loser.ws.request({ t: 'muck', on: false })).toMatchObject({ t: 'ack' });
    await loser.ws.waitState((s) => s.you.autoMuck === false);
    const sync = winner.ws.waitNext((m) => m.t === 'state');
    winner.ws.send({ t: 'sync' });
    const after = ((await sync) as Extract<ServerMessage, { t: 'state' }>).state;
    if (after.hand?.id === va.hand!.id) {
      expect(after.seats[ls]!.holeCards ?? null).toBeNull();
      expect(after.hand.result!.showdown.map((x) => x.seatIndex)).toEqual([ws]);
    }
    // Nobody else is shown a player's setting: it is only ever in the viewer's own `you`.
    for (const p of [winner, spec]) for (const m of p.ws.messages) if (m.t === 'state') expect(JSON.stringify(m.state.seats)).not.toContain('autoMuck');

    // History: the loser's cards and rank are withheld from the winner; the loser still has them.
    const handId = va.hand!.id;
    const forWinner = await recorded(winner, handId);
    const lw = forWinner.players.find((p) => p.userId === loser.me.id)!;
    expect(lw.holeCards).toBeNull();
    expect(lw.rankClass).toBeNull();
    expect(forWinner.players.find((p) => p.isYou)!.holeCards).toHaveLength(2);
    const forLoser = await recorded(loser, handId);
    const mine = forLoser.players.find((p) => p.isYou)!;
    expect(mine.holeCards).toHaveLength(2);
    expect(mine.rankClass).not.toBeNull();
    expect(forLoser.players.find((p) => p.userId === winner.me.id)!.holeCards).toHaveLength(2);
    const rows = await d1<{ user_id: string; shown: number | null; went_to_showdown: number }>(
      `SELECT user_id, shown, went_to_showdown FROM hand_players WHERE hand_id = '${handId}'`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.user_id, [r.shown, r.went_to_showdown]]))).toEqual({ [winner.me.id]: [1, 1], [loser.me.id]: [0, 1] });

    // A hand review the winner shares shows the loser's cards to nobody.
    const outsider = await newUser();
    const post = await winner.client.post('/api/board/posts', { title: 'muck review', body: 'x', handIds: [handId] });
    expect(post.status).toBe(201);
    const review = (await outsider.client.get(`/api/board/posts/${post.body.id}`)).body.hands[0];
    const lr = review.players.find((p: { isAuthor: boolean }) => !p.isAuthor);
    expect(lr.holeCards).toBeNull();
    expect(lr.rankClass).toBeNull();
    expect(JSON.stringify(review)).not.toContain(JSON.stringify(mine.holeCards));

    // Rows recorded before muck existed have no flag and read as shown down.
    await d1(`UPDATE hand_players SET shown = NULL WHERE hand_id = '${handId}'`);
    expect((await recorded(winner, handId)).players.find((p) => p.userId === loser.me.id)!.holeCards).toEqual(mine.holeCards);
  });

  it('when the betting ended all in, every hand is shown whatever the settings', async () => {
    const [a, b] = [await player('it-muck-1'), await player('it-muck-1')];
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    await muckOn(a);
    await muckOn(b);
    for (const p of [a, b]) await p.ws.waitState(live, 20_000, 'hand start');
    // Taken now: a player who busts stands up once the hand is settled.
    const seats = [seatOf(a), seatOf(b)].sort();
    // The short stack moves in; the covering stack calls (or checks behind once called).
    const [va] = await playOut([a, b], (p, s) => {
      const types = s.you.legal.map((o) => o.type);
      if (p === a && types.includes('allin')) return 'allin';
      return types.includes('call') ? 'call' : 'check';
    });
    const res = va!.hand!.result!;
    expect(res.showdown.map((x) => x.seatIndex).sort()).toEqual(seats);
    const rows = await (async () => {
      for (let i = 0; i < 50; i++) {
        const r = await d1<{ user_id: string; shown: number | null }>(`SELECT user_id, shown FROM hand_players WHERE hand_id = '${va!.hand!.id}'`);
        if (r.length === 2) return r;
        await new Promise((res) => setTimeout(res, 200));
      }
      throw new Error('hand not recorded');
    })();
    expect(rows.map((r) => r.shown)).toEqual([1, 1]);
  });
});
