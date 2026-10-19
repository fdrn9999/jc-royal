import type { HandDetailDto, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
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
    if (r.status === 200) return r.body as HandDetailDto;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`hand ${handId} was not recorded`);
}

// Auto-muck always applies (2026-10-19, at the owner's request): no setting to turn on first, and anyone dealt in whose
// cards the showdown left face down — folded, won uncontested or lost — may show the first, the second or both. The
// room deals the next hand 5.5 s after a hand a member played settles (4 s, and 1.5 s to decide whether to show):
// everything about the shown cards happens in that gap.
describe('showing cards after the hand', () => {
  it('a player who folded, and one who won uncontested, show the cards they choose to everyone until the next deal', async () => {
    const [a, b] = [await player('it-show-0'), await player('it-show-0')];
    const spec = await player('it-show-0');
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    const first = await a.ws.waitState(live, 20_000, 'hand start');
    await b.ws.waitState((s) => s.hand?.id === first.hand!.id);
    const handId = first.hand!.id;

    // Nothing to show while the hand is played.
    expect(a.ws.state!.you.canShow).toBe(false);
    expect(await a.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'error', code: 'conflict' });
    expect(await a.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'error', code: 'conflict' });
    // A player who sits down during the hand is not dealt in, so has nothing to show after it either.
    const c = await player('it-show-0');
    expect(await c.ws.request({ t: 'sit', seatIndex: 2, buyIn: 1000 })).toMatchObject({ t: 'ack' });

    // b moves all in and a folds to it: no showdown, nobody's cards are face up.
    const [va, vb] = await playOut([a, b], (p, s) => {
      const types = s.you.legal.map((o) => o.type);
      if (p === a) return types.includes('fold') ? 'fold' : 'check';
      return types.includes('allin') ? 'allin' : types.includes('call') ? 'call' : 'check';
    });
    const [sa, sb] = [seatOf(a), seatOf(b)];
    expect(va!.hand!.id).toBe(handId);
    expect(va!.seats[sa]!.state).toBe('folded');
    expect(va!.hand!.result!.showdown).toEqual([]);
    const mine = va!.seats[sa]!.holeCards!;
    const theirs = vb!.seats[sb]!.holeCards!;
    expect(mine).toHaveLength(2);
    expect(theirs).toHaveLength(2);
    // The folder, and the winner nobody called.
    expect(va!.you.canShow).toBe(true);
    expect(vb!.you.canShow).toBe(true);
    const stacks = va!.seats.map((s) => s.stack);
    const result = JSON.stringify(va!.hand!.result);

    // Only a seated player who was dealt in.
    expect(await c.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await c.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await spec.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'error', code: 'forbidden' });

    // The second card: the table sees that one, and only that one.
    expect(await a.ws.request({ t: 'show', card: 1 })).toMatchObject({ t: 'ack' });
    for (const p of [b, c, spec]) {
      const v = await p.ws.waitState((s) => s.hand?.id === handId && !!s.seats[sa]!.shown, 3_000, 'shown');
      expect(v.seats[sa]!.shown).toEqual([null, mine[1]]);
      expect(v.seats[sa]!.holeCards ?? null).toBeNull();
      expect(v.seats.filter((s) => s.shown)).toHaveLength(1);
    }
    const own = await a.ws.waitState((s) => !!s.seats[sa]!.shown, 3_000, 'own shown');
    expect(own.seats[sa]!.shown).toEqual([null, mine[1]]);
    expect(own.seats[sa]!.holeCards).toEqual(mine);
    // The cards a and b kept were never sent to anyone else (the board is empty after a preflop fold).
    for (const p of [b, c, spec]) for (const m of p.ws.messages) expect(JSON.stringify(m)).not.toContain(JSON.stringify(mine[0]));
    for (const p of [a, c, spec]) for (const m of p.ws.messages) for (const card of theirs) expect(JSON.stringify(m)).not.toContain(JSON.stringify(card));

    // Showing it again changes nothing: no new state.
    const before = a.ws.state!.version;
    expect(await a.ws.request({ t: 'show', card: 1 })).toMatchObject({ t: 'ack' });
    expect(a.ws.state!.version).toBe(before);

    // Then both, which adds the first one.
    expect(await a.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'ack' });
    const both = await spec.ws.waitState((s) => s.seats[sa]!.shown?.[0] != null, 3_000, 'both shown');
    expect(both.seats[sa]!.shown).toEqual(mine);
    // Once both are shown, asking again changes nothing, and they stay shown.
    const after = a.ws.state!.version;
    expect(await a.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'ack' });
    expect(await a.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'ack' });
    expect(a.ws.state!.version).toBe(after);

    // The winner nobody called shows both at once.
    expect(await b.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'ack' });
    for (const p of [a, c, spec]) {
      const v = await p.ws.waitState((s) => s.hand?.id === handId && !!s.seats[sb]!.shown, 3_000, 'winner shown');
      expect(v.seats[sb]!.shown).toEqual(theirs);
      expect(v.seats[sb]!.holeCards ?? null).toBeNull();
      // Only what is shown changed: the stacks and the result are those the hand settled with.
      expect(v.seats.map((s) => s.stack)).toEqual(stacks);
      expect(JSON.stringify(v.hand!.result)).toBe(result);
    }

    // The next deal takes them away, and there is nothing to show until that hand ends.
    const next = await b.ws.waitState((s) => !!s.hand && s.hand.id !== handId, 20_000, 'next hand');
    expect(next.seats.some((s) => s.shown)).toBe(false);
    expect(next.you.canShow).toBe(false);
    expect(await a.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'error', code: 'conflict' });

    // Shown cards are not part of the record: the folded hand stays hidden in b's history, b's in a's.
    const h = await recorded(b, handId);
    expect(h.players.find((p) => p.userId === a.me.id)!.holeCards).toBeNull();
    const ha = await recorded(a, handId);
    expect(ha.players.find((p) => p.userId === b.me.id)!.holeCards).toBeNull();
    // The next deal was set 5.5 s after the hand ended: members played it (4 s, and 1.5 s to decide whether to show).
    expect(va!.nextHandAt! - ha.endedAt).toBe(5_500);
  });

  it('a losing hand kept face down at showdown can be shown; a hand already face up shows nothing more, and an older page’s setting changes nothing', async () => {
    const [a, b] = [await player('it-show-1'), await player('it-show-1')];
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    // A split pot shows both hands: play on until one hand has a single winner.
    let views: TableView[] = [];
    for (let n = 0; n < 5; n++) {
      for (const p of [a, b]) await p.ws.waitState((s) => live(s) && !views.some((v) => v.hand!.id === s.hand!.id), 20_000, 'hand start');
      views = await playOut([a, b], checkDown);
      if (views[0]!.hand!.result!.winners.length === 1) break;
    }
    const [va, vb] = views as [TableView, TableView];
    const handId = va.hand!.id;
    expect(va.hand!.result!.winners).toHaveLength(1);
    const winner = va.hand!.result!.winners[0]!.seatIndex === seatOf(a) ? a : b;
    const loser = winner === a ? b : a;
    const [vw, vl] = winner === a ? [va, vb] : [vb, va];
    const [ws, ls] = [seatOf(winner), seatOf(loser)];
    expect(vw.seats[ls]!.holeCards ?? null).toBeNull();
    // The winner's hand was turned over at showdown: nothing left to show.
    expect(vw.you.canShow).toBe(false);
    expect(vl.you.canShow).toBe(true);

    // The winner's hand is already face up: asking changes nothing.
    expect(await winner.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'ack' });
    expect(await winner.ws.request({ t: 'show', card: 'both' })).toMatchObject({ t: 'ack' });
    expect(await loser.ws.request({ t: 'show', card: 0 })).toMatchObject({ t: 'ack' });
    const seen = await winner.ws.waitState((s) => s.hand?.id === handId && !!s.seats[ls]!.shown, 3_000, 'shown');
    expect(seen.seats[ls]!.shown).toEqual([vl.seats[ls]!.holeCards![0], null]);
    expect(seen.seats[ws]!.shown).toBeUndefined();
    // The showdown result is unchanged: still only the winner's hand, with no rank for the shown card.
    expect(seen.hand!.result!.showdown.map((x) => x.seatIndex)).toEqual([ws]);

    // An older page sends its setting (off): acknowledged, nothing changes, and the loser can still show the other card.
    expect(await loser.ws.request({ t: 'muck', on: false })).toMatchObject({ t: 'ack' });
    expect(loser.ws.state!.you.canShow).toBe(true);
    expect(await loser.ws.request({ t: 'show', card: 1 })).toMatchObject({ t: 'ack' });
    const all = await winner.ws.waitState((s) => s.hand?.id !== handId || s.seats[ls]!.shown?.[1] != null, 3_000, 'second shown');
    if (all.hand?.id === handId) expect(all.seats[ls]!.shown).toEqual(vl.seats[ls]!.holeCards);
  });
});