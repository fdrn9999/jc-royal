import type { TableView } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, signupBody, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

/**
 * The game server dies (the workerd process is killed, as a redeploy or an eviction would end it) at the points of a
 * hand restart.test.ts does not reach: on the flop, the turn and the river of one hand, right after a showdown, and
 * while a hand with side pots settles. After each restart the room must come back from its storage with the same hand:
 * the same cards to the same players (and nobody else's), the same board and whose turn it is with the same clock, and
 * then settle that hand once, every chip kept. The fault is the process kill and nothing else: no hook in the server.
 */
const tables = [
  ...TABLES,
  { id: 'it-recover-streets', maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  { id: 'it-recover-settled', maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  { id: 'it-recover-side', maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
];

type View = TableView;
type Hand = NonNullable<View['hand']>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await sleep(300);
  }
}

/** What one player's page holds of a hand: everything that has to come back the same after a restart. */
function snapshot(s: View) {
  const me = s.you.seatIndex!;
  const h = s.hand!;
  return {
    hand: h.id,
    seq: h.seq,
    stage: h.stage,
    board: h.board,
    deadline: h.deadline,
    actor: h.actorSeat,
    pot: h.potTotal,
    chips: s.seats.map((x) => x.stack + x.streetBet),
    mine: s.seats[me]!.holeCards,
  };
}

/** Other players' cards this view shows: none, while the hand is live. */
const othersCards = (s: View) => s.seats.filter((_, i) => i !== s.you.seatIndex).flatMap((x) => x.holeCards ?? []);

describe('game server recovery at every point of a hand', () => {
  const state = resolve(root, 'tests/.state/recovery');
  const port = 8818;
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
  });

  async function start() {
    if (worker) return worker;
    await prepareState(state, tables);
    worker = await startWorker(port, state);
    return worker;
  }

  async function restart() {
    await worker!.stop();
    worker = await startWorker(port, state);
  }

  async function user(n: string, base: string) {
    const c = new Client(WEB_ORIGIN, base);
    const r = await c.post('/api/auth/register', await signupBody(c, { email: `${n}-${Date.now()}@recovery.dev`, nickname: `${n}${Date.now() % 100000}` }));
    expect(r.status).toBe(201);
    return c;
  }

  const balanceOf = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;

  /** Everyone stands up (a hand under way ends for them first) and every chip has to be back in the wallets. */
  async function allBack(cs: Client[], ws: TableSocket[], total: number) {
    for (const w of ws) if (w.state?.you.seatIndex != null) expect(await w.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    const wallets = async () => {
      let n = 0;
      for (const c of cs) n += await balanceOf(c);
      return n;
    };
    await until(wallets, (n) => n === total, 'every chip back in the wallets', 60_000);
  }

  /** Seats everyone and waits for a hand all of them were dealt into (an earlier one, begun before the last sat, is played out). */
  async function dealtToAll(cs: Client[], tableId: string, buyIns: number[], base: string) {
    const ws = await Promise.all(cs.map((c) => TableSocket.open(c, tableId, { base })));
    await Promise.all(ws.map((w, i) => w.request({ t: 'sit', seatIndex: i, buyIn: buyIns[i]! }).then((r) => expect(r).toMatchObject({ t: 'ack' }))));
    for (let tries = 0; tries < 5; tries++) {
      const s = await ws[0]!.waitState((v) => !!v.hand && v.hand.stage !== 'settled' && v.hand.actorSeat !== null, 20_000, 'hand start');
      const id = s.hand!.id;
      const views = await Promise.all(ws.map((w) => w.waitState((v) => v.hand?.id === id, 10_000, 'same hand')));
      if (views.every((v) => (v.seats[v.you.seatIndex!]!.holeCards?.length ?? 0) === 2)) return { ws, handId: id };
      await playUntil(ws, id, () => false);
      await ws[0]!.waitState((v) => v.hand?.id !== id, 30_000, 'next hand');
    }
    throw new Error('no hand dealt to every player');
  }

  /** Plays check/call (or `pick`) for whoever's turn it is, until `stop` holds for the hand or the hand is over. */
  async function playUntil(ws: TableSocket[], handId: string, stop: (s: View) => boolean, pick?: (s: View) => string) {
    for (let guard = 0; guard < 400; guard++) {
      const s = ws[0]!.state!;
      if (s.hand?.id !== handId || s.hand.stage === 'settled') return s;
      if (stop(s)) return s;
      // Only the page whose turn it is in page 0's view, once it sees that same step: a page that is ahead must not move
      // the hand past the point `stop` is checked at.
      const seq = s.hand.seq;
      const actor = ws.find((x) => x.state?.hand?.id === handId && x.state.hand.seq === seq && isMyTurn(x.state));
      if (!actor) {
        await sleep(100);
        continue;
      }
      const type = pick?.(actor.state!) ?? (actor.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call');
      await actor.act(type);
    }
    throw new Error('the hand did not move');
  }

  /** The hand's record in D1 (written once the room settles it), and its players' rows. */
  async function record(handId: string) {
    const hands = await until(() => d1<{ board: string; pot_total: number }>(`SELECT board, pot_total FROM hands WHERE id = '${handId}'`, state), (r) => r.length > 0, 'hand record');
    const players = await d1<{ user_id: string; seat_index: number; hole_cards: string; stack_start: number; stack_end: number; net: number; won: number }>(
      `SELECT user_id, seat_index, hole_cards, stack_start, stack_end, net, won FROM hand_players WHERE hand_id = '${handId}' ORDER BY seat_index`,
      state,
    );
    return { hands, players };
  }

  it('dies on the flop, the turn and the river of one hand: each time the same hand comes back, then settles once with every chip kept', async () => {
    const { url: base } = await start();
    const cs = [await user('sa', base), await user('sb', base), await user('sc', base)];
    let { ws, handId } = await dealtToAll(cs, 'it-recover-streets', [500, 400, 300], base);
    const cards = new Map<number, Hand['board']>();
    const boards: Hand['board'][] = [];

    for (const stage of ['flop', 'turn', 'river'] as const) {
      await playUntil(ws, handId, (s) => s.hand!.stage === stage && s.hand!.actorSeat !== null);
      // Every page has the state of the same moment (the last action's) before the server dies.
      const seq = ws[0]!.state!.hand!.seq;
      const before = await Promise.all(ws.map((w) => w.waitState((s) => s.hand?.seq === seq, 10_000, 'same seq')));
      expect(before[0]!.hand).toMatchObject({ id: handId, stage });
      for (const s of before) {
        expect(othersCards(s)).toEqual([]);
        cards.set(s.you.seatIndex!, s.seats[s.you.seatIndex!]!.holeCards!);
      }
      boards.push(before[0]!.hand!.board);
      for (const w of ws) w.close();
      await restart();

      ws = await Promise.all(cs.map((c) => TableSocket.open(c, 'it-recover-streets', { base })));
      for (const [i, w] of ws.entries()) {
        // The same hand at the same step: cards, board, pot, stacks, whose turn and its deadline (no time given back).
        expect(snapshot(w.state!)).toEqual(snapshot(before[i]!));
        // Each page still holds its own two cards and no one else's.
        expect(othersCards(w.state!)).toEqual([]);
      }
    }

    // The hand is played to its end after the last restart, and recorded once.
    await playUntil(ws, handId, () => false);
    const done = await ws[0]!.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 15_000, 'settled');
    const { hands, players } = await record(handId);
    expect(hands).toHaveLength(1);
    const board = JSON.parse(hands[0]!.board) as string[];
    expect(board).toHaveLength(5);
    // The cards dealt after each restart come from the same deck: what was on the board stays its first cards.
    for (const b of boards) expect(board.slice(0, b.length)).toEqual(b);
    expect(players).toHaveLength(3);
    for (const p of players) expect(JSON.parse(p.hole_cards)).toEqual(cards.get(p.seat_index));
    // No card twice in the hand.
    const all = [...board, ...players.flatMap((p) => JSON.parse(p.hole_cards) as string[])];
    expect(new Set(all).size).toBe(all.length);
    expect(players.reduce((a, p) => a + p.net, 0)).toBe(0);
    expect(players.reduce((a, p) => a + p.won, 0)).toBe(hands[0]!.pot_total);
    // Every chip is in a wallet or on the table.
    const stacks = done.seats.reduce((a, s) => a + s.stack, 0);
    let wallets = 0;
    for (const c of cs) wallets += await balanceOf(c);
    expect(wallets + stacks).toBe(30_000);
    for (const w of ws) w.close();
  }, 420_000);

  it('dies right after a showdown, before the next hand: the settled hand is not paid or recorded again', async () => {
    const { url: base } = await start();
    const cs = [await user('ta', base), await user('tb', base)];
    let { ws, handId } = await dealtToAll(cs, 'it-recover-settled', [600, 400], base);
    await playUntil(ws, handId, () => false);
    // Killed the moment the hand is settled: its record may or may not have reached D1 yet.
    const settled = await ws[0]!.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 15_000, 'settled');
    for (const w of ws) w.close();
    await restart();

    ws = await Promise.all(cs.map((c) => TableSocket.open(c, 'it-recover-settled', { base })));
    // Each seat holds what the hand left it (with the next hand's blind back in it, if that hand has begun).
    const after = ws[0]!.state!;
    for (const i of [0, 1]) expect(after.seats[i]!.stack + after.seats[i]!.streetBet).toBe(settled.seats[i]!.stack);
    const first = await record(handId);
    expect(first.hands).toHaveLength(1);
    expect(first.players).toHaveLength(2);
    expect(first.players.map((p) => p.stack_end)).toEqual([settled.seats[0]!.stack, settled.seats[1]!.stack]);

    // Once more: still one record, and the wallets and table hold every chip.
    for (const w of ws) w.close();
    await restart();
    ws = await Promise.all(cs.map((c) => TableSocket.open(c, 'it-recover-settled', { base })));
    expect(await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM hands WHERE id = '${handId}'`, state)).toEqual([{ n: 1 }]);
    expect(await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = '${handId}'`, state)).toEqual([{ n: 2 }]);
    await allBack(cs, ws, 20_000);
    for (const w of ws) w.close();
  }, 300_000);

  it('dies while a hand with side pots settles (three stacks all in): each pot is paid once, to no more than each player could win', async () => {
    const { url: base } = await start();
    const cs = [await user('ua', base), await user('ub', base), await user('uc', base)];
    const buyIns = [100, 200, 300];
    let { ws, handId } = await dealtToAll(cs, 'it-recover-side', buyIns, base);
    // Everyone goes all in (or calls an all-in that covers them): no one acts after that, the board runs out and the
    // hand settles at once. The server dies right then.
    await playUntil(ws, handId, (s) => s.hand!.actorSeat === null, (s) => (s.you.legal.some((o) => o.type === 'allin') ? 'allin' : 'call'));
    for (const w of ws) w.close();
    await restart();

    ws = await Promise.all(cs.map((c) => TableSocket.open(c, 'it-recover-side', { base })));
    const { hands, players } = await record(handId);
    expect(hands).toHaveLength(1);
    expect(players).toHaveLength(3);
    expect(players.map((p) => p.stack_start)).toEqual(buyIns);
    expect(players.reduce((a, p) => a + p.net, 0)).toBe(0);
    // All three were all in for their whole stacks. The record's pot is what was paid out, so it holds the deepest
    // stack's uncalled 100 handed back too (as for every hand: the sum of the payouts).
    expect(hands[0]!.pot_total).toBe(100 + 200 + 300);
    expect(players.reduce((a, p) => a + p.won, 0)).toBe(hands[0]!.pot_total);
    // The main pot (100 from each) is all the shortest stack could win, the side pot (100 more from two) the most the
    // next could add; the deepest gets at least its uncalled 100 back.
    expect(players[0]!.won).toBeLessThanOrEqual(300);
    expect(players[1]!.won).toBeLessThanOrEqual(500);
    expect(players[2]!.won).toBeGreaterThanOrEqual(100);
    const all = [...(JSON.parse(hands[0]!.board) as string[]), ...players.flatMap((p) => JSON.parse(p.hole_cards) as string[])];
    expect(new Set(all).size).toBe(all.length);

    // The room's seats hold what the record says (or that and the next hand's blinds).
    const s = ws[0]!.state!;
    const seated = (i: number) => (s.seats[i]?.userId ? s.seats[i]!.stack + s.seats[i]!.streetBet : 0);
    for (const p of players) if (seated(p.seat_index) > 0) expect(seated(p.seat_index)).toBe(p.stack_end);
    // Another restart pays nothing more.
    for (const w of ws) w.close();
    await restart();
    expect(await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = '${handId}'`, state)).toEqual([{ n: 3 }]);
    ws = await Promise.all(cs.map((c) => TableSocket.open(c, 'it-recover-side', { base })));
    await allBack(cs, ws, 30_000);
    for (const w of ws) w.close();
  }, 360_000);
});
