import type { Card, HandDetailDto, ServerMessage, TableView } from '@jc/types';
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
type Rabbit = Extract<ServerMessage, { t: 'rabbit' }>;

const seatOf = (p: Player) => p.ws.state!.you.seatIndex!;
const live = (s: TableView) => s.status === 'playing' && s.hand?.stage === 'preflop' && s.hand.actorSeat !== null;

/** Asks for the rabbit hunt of `handId`: the answer (the cards, or the refusal). */
async function rabbit(p: Player, handId: string) {
  const reqId = `r-${Math.random().toString(36).slice(2, 12)}`;
  const answer = p.ws.waitNext((m) => (m.t === 'rabbit' || m.t === 'error') && m.reqId === reqId, 15_000, 'rabbit');
  p.ws.send({ t: 'rabbit', reqId, handId });
  return answer;
}

/**
 * Plays the current hand: everybody checks or calls until `stage`, where the first to act bets and the rest fold
 * ('never': it is checked down to a showdown).
 */
async function foldAt(ps: Player[], stage: 'preflop' | 'flop' | 'turn' | 'river' | 'never') {
  const handId = ps[0]!.ws.state!.hand!.id;
  const settled = ps.map((p) => p.ws.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 30_000, 'settled'));
  let bet = false;
  for (let guard = 0; guard < 400; guard++) {
    const s0 = ps[0]!.ws.state!;
    if (s0.hand?.id !== handId || s0.hand.stage === 'settled') break;
    const actor = ps.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId);
    if (!actor) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const s = actor.ws.state!;
    const types = s.you.legal.map((o) => o.type);
    let type = types.includes('check') ? 'check' : 'call';
    let amount: number | undefined;
    if (s.hand!.stage === stage) {
      if (!bet) {
        const o = s.you.legal.find((x) => x.type === 'bet' || x.type === 'raise');
        if (o && 'min' in o) {
          type = o.type;
          amount = o.min;
          bet = true;
        }
      } else if (types.includes('fold')) type = 'fold';
    }
    const { result } = await actor.ws.act(type, amount);
    expect(result.t, JSON.stringify(result)).toBe('state');
  }
  return Promise.all(settled);
}

async function recorded(p: Player, handId: string) {
  for (let i = 0; i < 50; i++) {
    const r = await p.client.get(`/api/me/hands/${handId}`);
    if (r.status === 200) return r.body as HandDetailDto;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`hand ${handId} was not recorded`);
}

async function seated(tableId: string, n: number) {
  const ps: Player[] = [];
  for (let i = 0; i < n; i++) {
    const p = await player(tableId);
    expect(await p.ws.request({ t: 'sit', seatIndex: i, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    ps.push(p);
  }
  const first = await ps[0]!.ws.waitState(live, 20_000, 'hand start');
  for (const p of ps) await p.ws.waitState((s) => s.hand?.id === first.hand!.id);
  return { ps, handId: first.hand!.id };
}

// The room deals the next hand 5.5 s after a hand members played settles: everything about a rabbit hunt happens in
// that gap, and only there.
describe('rabbit hunting', () => {
  it('a hand folded before the flop: five cards to the asker alone, the same every time, nothing of the table changed, gone with the next deal', async () => {
    const { ps, handId } = await seated('it-rabbit-0', 2);
    const [a, b] = ps as [Player, Player];
    const spec = await player('it-rabbit-0');
    // A player who sits down during the hand is not dealt in.
    const c = await player('it-rabbit-0');
    expect(await c.ws.request({ t: 'sit', seatIndex: 2, buyIn: 1000 })).toMatchObject({ t: 'ack' });

    // Never while the hand is played: not offered, and refused when asked for anyway.
    for (const p of [a, b]) {
      expect(p.ws.state!.you.canRabbit).toBe(false);
      expect(await rabbit(p, handId)).toMatchObject({ t: 'error', code: 'conflict' });
    }

    const [va, vb] = (await foldAt([a, b], 'preflop')) as [TableView, TableView];
    expect(va.hand!.board).toEqual([]);
    expect(va.hand!.result!.showdown).toEqual([]);
    expect(va.you.canRabbit).toBe(true);
    expect(vb.you.canRabbit).toBe(true);
    const mine = va.seats[seatOf(a)]!.holeCards!;
    const theirs = vb.seats[seatOf(b)]!.holeCards!;
    const stacks = va.seats.map((s) => s.stack);
    const result = JSON.stringify(va.hand!.result);
    const version = a.ws.state!.version;

    // Only a player the hand dealt in, and only that hand.
    expect(await rabbit(c, handId)).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await rabbit(spec, handId)).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await rabbit(a, 'some-other-hand')).toMatchObject({ t: 'error', code: 'conflict' });
    expect(spec.ws.state!.you.canRabbit).toBeFalsy();
    expect(c.ws.state!.you.canRabbit).toBeFalsy();

    const first = (await rabbit(a, handId)) as Rabbit;
    expect(first).toMatchObject({ t: 'rabbit', handId });
    expect(first.cards).toHaveLength(5);
    // No card twice, and none of them a card that was dealt.
    expect(new Set<Card>([...first.cards, ...mine, ...theirs]).size).toBe(9);
    // Asked again, at once and by the other player: the same cards (they are the deck's, not drawn anew).
    const again = (await Promise.all([rabbit(a, handId), rabbit(a, handId), rabbit(b, handId)])) as Rabbit[];
    for (const r of again) expect(r.cards).toEqual(first.cards);

    // Nothing of the table changed: no new state for anyone, the stacks and the result as the hand settled them.
    expect(a.ws.state!.version).toBe(version);
    expect(a.ws.state!.seats.map((s) => s.stack)).toEqual(stacks);
    expect(JSON.stringify(a.ws.state!.hand!.result)).toBe(result);
    expect(a.ws.state!.hand!.board).toEqual([]);
    // The answer went to the asker alone, and it told nobody a hole card that was not theirs.
    for (const p of [c, spec]) expect(p.ws.messages.some((m) => m.t === 'rabbit')).toBe(false);
    for (const p of [b, c, spec]) for (const m of p.ws.messages) for (const card of mine) expect(JSON.stringify(m)).not.toContain(JSON.stringify(card));
    for (const p of [a, c, spec]) for (const m of p.ws.messages) for (const card of theirs) expect(JSON.stringify(m)).not.toContain(JSON.stringify(card));

    // The next deal: it is not offered, and the hand being played tells nobody what is to come.
    const next = await a.ws.waitState((s) => !!s.hand && s.hand.id !== handId, 20_000, 'next hand');
    expect(next.you.canRabbit).toBe(false);
    expect(await rabbit(a, next.hand!.id)).toMatchObject({ t: 'error', code: 'conflict' });

    // The record is the hand as it was played: no board, and the cards kept hidden stay hidden.
    const rec = await recorded(a, handId);
    expect(rec.board).toEqual([]);
    expect(rec.players.find((p) => p.userId === b.me.id)!.holeCards).toBeNull();
  });

  it('folded on the flop: the turn and the river; on the turn: the river; on the river or at showdown: nothing', async () => {
    const { ps } = await seated('it-rabbit-1', 2);
    const [a, b] = ps as [Player, Player];
    const want = [
      ['flop', 2],
      ['turn', 1],
      ['river', 0],
      ['showdown', 0],
    ] as const;
    const seen: string[] = [];
    for (const [stage, count] of want) {
      for (const p of [a, b]) await p.ws.waitState((s) => live(s) && !seen.includes(s.hand!.id), 20_000, 'hand start');
      const handId = a.ws.state!.hand!.id;
      seen.push(handId);
      const [va] = (await foldAt([a, b], stage === 'showdown' ? 'never' : stage)) as [TableView, TableView];
      const board = va.hand!.board;
      if (stage === 'showdown') expect(va.hand!.result!.showdown.length).toBeGreaterThan(0);
      expect(board).toHaveLength(5 - count);
      expect(va.you.canRabbit).toBe(count > 0);
      const r = await rabbit(a, handId);
      if (!count) {
        expect(r).toMatchObject({ t: 'error', code: 'conflict' });
        continue;
      }
      expect((r as Rabbit).cards).toHaveLength(count);
      const holes = [va.seats[seatOf(a)]!.holeCards!, b.ws.state!.seats[seatOf(b)]!.holeCards!].flat();
      expect(new Set<Card>([...board, ...(r as Rabbit).cards, ...holes]).size).toBe(9);
      expect(((await rabbit(b, handId)) as Rabbit).cards).toEqual((r as Rabbit).cards);
      // The board the table shows is the board that was dealt.
      expect(a.ws.state!.hand!.board).toEqual(board);
    }
  });
});

// A request sent in the last moment of that gap (or held up on the way) reaches the room after the deal. The game waits
// for nobody; the hand that went stays answerable for a short while instead (apps/game-worker/src/rabbit.ts).
describe('rabbit hunting: a request the next deal overtook', () => {
  it('the hand before is still answered, with the same cards, to its players alone, and changes nothing of the hand played now; gone once that hand settles', async () => {
    const { ps, handId } = await seated('it-rabbit-2', 2);
    const [a, b] = ps as [Player, Player];
    const spec = await player('it-rabbit-2');
    await foldAt([a, b], 'preflop');
    const before = (await rabbit(b, handId)) as Rabbit;
    expect(before.cards).toHaveLength(5);

    const next = await a.ws.waitState((s) => !!s.hand && s.hand.id !== handId && live(s), 20_000, 'next hand');
    await b.ws.waitState((s) => s.hand?.id === next.hand!.id);
    const nextId = next.hand!.id;
    const seen = { version: a.ws.state!.version, seq: a.ws.state!.hand!.seq, pot: a.ws.state!.hand!.potTotal, stacks: a.ws.state!.seats.map((s) => s.stack), mine: a.ws.state!.seats[seatOf(a)]!.holeCards };

    // Late, twice, and from both players: the cards the hand's own deck held, as they were told before the deal.
    const late = (await Promise.all([rabbit(a, handId), rabbit(a, handId), rabbit(b, handId)])) as Rabbit[];
    for (const r of late) expect(r).toMatchObject({ t: 'rabbit', handId, cards: before.cards });
    // Nothing of the hand played now is told or changed: it is refused its own rabbit hunt, and no state went out.
    expect(await rabbit(a, nextId)).toMatchObject({ t: 'error', code: 'conflict' });
    expect(await rabbit(a, 'some-other-hand')).toMatchObject({ t: 'error', code: 'conflict' });
    expect(a.ws.state!.version).toBe(seen.version);
    expect(a.ws.state!.hand).toMatchObject({ id: nextId, seq: seen.seq, potTotal: seen.pot, board: [] });
    expect(a.ws.state!.seats.map((s) => s.stack)).toEqual(seen.stacks);
    expect(a.ws.state!.seats[seatOf(a)]!.holeCards).toEqual(seen.mine);
    expect(a.ws.state!.you.canRabbit).toBe(false);

    // Not to a spectator, nor to a player who sat down after that hand.
    expect(await rabbit(spec, handId)).toMatchObject({ t: 'error', code: 'forbidden' });
    const c = await player('it-rabbit-2');
    expect(await c.ws.request({ t: 'sit', seatIndex: 2, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await rabbit(c, handId)).toMatchObject({ t: 'error', code: 'forbidden' });
    for (const p of [c, spec]) expect(p.ws.messages.some((m) => m.t === 'rabbit')).toBe(false);

    // The hand played now ends: from then on it is the one with a rabbit hunt, and the one before it has none.
    for (const p of [a, b]) await p.ws.waitState((s) => s.hand?.id === nextId);
    await foldAt([a, b], 'preflop');
    expect(await rabbit(a, handId)).toMatchObject({ t: 'error', code: 'conflict' });
    const own = (await rabbit(a, nextId)) as Rabbit;
    expect(own).toMatchObject({ t: 'rabbit', handId: nextId });
    expect(own.cards).toHaveLength(5);

    // Chips are where the two hands put them: none made or lost by asking.
    expect(a.ws.state!.seats.reduce((n, s) => n + s.stack, 0)).toBe(3000);
    const rec = await recorded(a, handId);
    expect(rec.board).toEqual([]);
  });

  it('a hand that left a turn and a river behind answers those two; a hand with a full board leaves nothing', async () => {
    const { ps, handId } = await seated('it-rabbit-3', 2);
    const [a, b] = ps as [Player, Player];
    const [va] = (await foldAt([a, b], 'flop')) as [TableView, TableView];
    const board = va.hand!.board;
    expect(board).toHaveLength(3);
    const second = await a.ws.waitState((s) => !!s.hand && s.hand.id !== handId && live(s), 20_000, 'next hand');
    await b.ws.waitState((s) => s.hand?.id === second.hand!.id);
    const late = (await rabbit(a, handId)) as Rabbit;
    expect(late).toMatchObject({ t: 'rabbit', handId });
    expect(late.cards).toHaveLength(2);
    expect(new Set<Card>([...board, ...late.cards]).size).toBe(5);

    // Checked down to a showdown: the board is complete, and nothing is kept of it.
    const secondId = second.hand!.id;
    const [vs] = (await foldAt([a, b], 'never')) as [TableView, TableView];
    expect(vs.hand!.board).toHaveLength(5);
    const third = await a.ws.waitState((s) => !!s.hand && s.hand.id !== secondId && live(s), 20_000, 'third hand');
    expect(third.you.canRabbit).toBe(false);
    expect(await rabbit(a, secondId)).toMatchObject({ t: 'error', code: 'conflict' });
    expect(await rabbit(a, handId)).toMatchObject({ t: 'error', code: 'conflict' });
  });

  it('it is answered for a short while only: 20 s after the deal the hand before is refused, with the next still being played', async () => {
    const { ps, handId } = await seated('it-rabbit-4', 2);
    const [a, b] = ps as [Player, Player];
    await foldAt([a, b], 'preflop');
    const next = await a.ws.waitState((s) => !!s.hand && s.hand.id !== handId && live(s), 20_000, 'next hand');
    const dealtBy = Date.now();
    expect(await rabbit(a, handId)).toMatchObject({ t: 'rabbit', handId });
    // (Turns here are 60 s: nobody acts, so the hand is still the one being played when the time is up.)
    await new Promise((r) => setTimeout(r, Math.max(0, dealtBy + 20_500 - Date.now())));
    expect(a.ws.state!.hand).toMatchObject({ id: next.hand!.id, stage: 'preflop' });
    expect(await rabbit(a, handId)).toMatchObject({ t: 'error', code: 'conflict' });
    expect(await rabbit(b, handId)).toMatchObject({ t: 'error', code: 'conflict' });
  }, 90_000);
});

describe('minimum raise: double the highest bet of the street, enforced by the room', () => {
  it('an amount under the minimum sent straight over the socket is refused, and the turn stays where it was', async () => {
    const { ps, handId } = await seated('it-minraise-0', 3);
    const actor = () => ps.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId)!;
    const window = (p: Player) => p.ws.state!.you.legal.find((o) => o.type === 'raise' || o.type === 'bet') as { type: string; min: number; max: number };
    const refused = async (p: Player, type: string, amount: number) => {
      const seq = p.ws.state!.hand!.seq;
      const { result } = await p.ws.act(type, amount);
      expect(result, `${type} ${amount}`).toMatchObject({ t: 'error', code: 'illegal_action' });
      expect(p.ws.state!.hand!.seq).toBe(seq);
      expect(isMyTurn(p.ws.state!)).toBe(true);
    };
    const taken = async (p: Player, type: string, amount?: number) => {
      const { result } = await p.ws.act(type, amount);
      expect(result.t, JSON.stringify(result)).toBe('state');
      const seq = (result as Extract<ServerMessage, { t: 'state' }>).state.hand!.seq;
      // Every socket is read on its own: all of them have the move before the next actor is looked for.
      for (const q of ps) await q.ws.waitState((s) => s.hand?.id === handId && s.hand.seq >= seq);
    };

    // To open: two big blinds (20 at 5/10). 15 is refused.
    const first = actor();
    expect(window(first)).toMatchObject({ type: 'raise', min: 20 });
    await refused(first, 'raise', 15);
    await refused(first, 'raise', 19);
    await taken(first, 'raise', 25);

    // Over a raise to 25: 50 at least. The standard rule's 40 and 45 are refused.
    const second = actor();
    expect(second).not.toBe(first);
    expect(window(second)).toMatchObject({ type: 'raise', min: 50 });
    await refused(second, 'raise', 40);
    await refused(second, 'raise', 45);
    await refused(second, 'raise', 49);
    await taken(second, 'raise', 50);

    // Over 50: 100.
    const third = actor();
    expect(window(third)).toMatchObject({ type: 'raise', min: 100 });
    await refused(third, 'raise', 75);
    await refused(third, 'raise', 99);
    await taken(third, 'raise', 100);

    // And over 100: 200, for the player who opened.
    expect(actor()).toBe(first);
    expect(window(first)).toMatchObject({ type: 'raise', min: 200 });
    await refused(first, 'raise', 150);
    await taken(first, 'call');
    await taken(actor(), 'call');

    // The flop: a bet of 30, then 60 at least.
    for (const p of ps) await p.ws.waitState((s) => s.hand?.id === handId && s.hand.stage === 'flop', 10_000, 'flop');
    const bettor = actor();
    expect(window(bettor)).toMatchObject({ type: 'bet', min: 10 });
    await taken(bettor, 'bet', 30);
    const raiser = actor();
    expect(window(raiser)).toMatchObject({ type: 'raise', min: 60 });
    await refused(raiser, 'raise', 50);
    await refused(raiser, 'raise', 59);
    await taken(raiser, 'raise', 60);
    expect(window(actor())).toMatchObject({ type: 'raise', min: 120 });
  });
});
