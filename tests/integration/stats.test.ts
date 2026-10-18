import { dealOrder, HandEngine, stackedDeck, type HandRecord } from '@jc/poker-engine';
import { POSITIONS, type Card, type HandDetailDto, type HandReviewDto, type Position, type StatsDto, type StatsTrendDto, type TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { HAND_STATS_SQL } from '../../packages/db/src/handStats';
import { Client, newUser } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const c = (s: string) => s.split(' ') as Card[];
type Step = [player: string, type: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number];
let seq = 0;

/**
 * Plays one hand in the real engine and returns its record. Seat i is player `p${i}`, the button is seat 0, `holes`
 * are listed by seat. After the scripted steps everyone left checks or calls to the end.
 */
async function play(stacks: number[], steps: Step[], cards?: { holes: string[]; board: string }) {
  const deck = cards && stackedDeck(dealOrder(stacks.length, 0).map((i) => c(cards.holes[i]!)), c(cards.board));
  const h = HandEngine.start({
    handId: `it-stats-${Date.now().toString(36)}-${++seq}`,
    rules: { maxSeats: 6, smallBlind: 5, bigBlind: 10, turnMs: 20_000 },
    seats: stacks.map((stack, i) => ({ playerId: `p${i}`, seatIndex: i, stack, displayName: `P${i}` })),
    buttonSeat: 0,
    now: 1_000,
    deck,
  });
  let now = 2_000;
  const act = async (who: string, type: Step[1], amount?: number) => {
    const r = await h.act(who, { type, amount }, `it-stats-intent-${++seq}`, ++now);
    if (!r.ok) throw new Error(`${who} ${type} ${amount ?? ''} rejected: ${r.reason}`);
    if (h.isStalled()) await h.resolveStall(++now);
  };
  for (const [who, type, amount] of steps) await act(who, type, amount);
  for (let guard = 0; guard < 50 && !h.isSettled; guard++) {
    const who = h.actorId()!;
    await act(who, h.legalOptions(who).some((o) => o.type === 'check') ? 'check' : 'call');
  }
  expect(h.isSettled).toBe(true);
  return h.record(Date.now());
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Stores a finished hand the way the game worker does (settlement.recordHand), with `p${i}` mapped to real users.
 * `log` replaces the stored event log (to store one that can't be read).
 */
async function store(rec: HandRecord, users: string[], opts: { log?: string } = {}) {
  const log = opts.log ?? JSON.stringify({ actions: rec.actions });
  await d1(
    [
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES (${q(rec.handId)}, 'it-stats-0', ${++seq}, ${rec.startedAt}, ${rec.endedAt}, ${q(JSON.stringify(rec.board))}, ${rec.potTotal}, ${q(rec.engineVersion)}, ${q(log)})`,
      ...rec.players.map(
        (p, i) =>
          `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at) VALUES (${q(rec.handId)}, ${q(users[i]!)}, ${p.seatIndex}, ${q(JSON.stringify(p.holeCards))}, ${p.stackStart}, ${p.stackEnd}, ${p.net}, ${p.won}, ${p.rankClass ? q(p.rankClass) : 'NULL'}, ${p.rankValue ?? 'NULL'}, ${p.bestFive ? q(JSON.stringify(p.bestFive)) : 'NULL'}, ${p.wentToShowdown ? 1 : 0}, ${rec.endedAt})`,
      ),
    ].join('; '),
  );
}

const results = (rec: HandRecord) => ({ won: rec.players.map((p) => p.won), net: rec.players.map((p) => p.net), potTotal: rec.potTotal });
const stats = async (u: { client: Client }) => (await u.client.get('/api/me/stats')).body as StatsDto;

/** Every position in order, zeros except the ones given. */
const positions = (given: Partial<Record<Position, [hands: number, vpip: number, pfr: number, net: number]>>) =>
  POSITIONS.map((position) => {
    const [hands, vpip, pfr, net] = given[position] ?? [0, 0, 0, 0];
    return { position, hands, vpip, pfr, net };
  });

describe('play statistics', () => {
  it('count the contested pot (not uncalled chips handed back), wins, VPIP, PFR, showdowns and positions, for fold wins, split pots and side pots', async () => {
    const [u0, u1, u2, u3, u4] = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);
    const ids = [u0, u1, u2, u3, u4].map((u) => u.me.id);

    // Fold win: p0 (button) raises to 40, both blinds fold. 30 of the 40 come back uncalled, so the pot was 25.
    const foldWin = await play([1000, 1000, 1000], [['p0', 'raise', 40], ['p1', 'fold'], ['p2', 'fold']]);
    expect(results(foldWin)).toEqual({ won: [55, 0, 0], net: [15, -5, -10], potTotal: 55 });

    // Split pot heads-up: the button (small blind) raises to 100, the big blind calls; the board is a royal flush and
    // both get their 100 back.
    const split = await play([1000, 1000], [['p0', 'raise', 100], ['p1', 'call']], { holes: ['2c 3d', '4c 5d'], board: 'As Ks Qs Js Ts' });
    expect(results(split)).toEqual({ won: [100, 100], net: [0, 0], potTotal: 200 });

    // Side pot: p0 all-in for 100 (a raise over the big blind), p1 for 500 (a raise), p2 for 300 (a call). Main pot
    // 300 (p0's aces), side pot 400 (p2's kings); p1's last 200 had no caller and come back to a player who lost 300.
    const side = await play([100, 500, 300], [['p0', 'allin'], ['p1', 'allin'], ['p2', 'allin']], { holes: ['Ac Ad', '2c 7d', 'Kc Kd'], board: '9h 8s 4d 3c Jh' });
    expect(results(side)).toEqual({ won: [300, 200, 400], net: [200, -300, 100], potTotal: 900 });

    // A pot of 1,800 that p0 folded out of before putting a chip in: not a pot p0 played.
    const sitOut = await play([1000, 1000, 1000], [['p0', 'fold'], ['p1', 'raise', 900], ['p2', 'call']], { holes: ['2c 7d', 'Ah Ad', 'Kh Kd'], board: '9h 8s 4d 3c Jc' });
    expect(results(sitOut)).toEqual({ won: [0, 1800, 0], net: [0, 900, -900], potTotal: 1800 });

    // A hand whose action log can't be read: what needs the actions isn't counted for it (nor guessed).
    const unreadable = await play([1000, 1000], [['p0', 'raise', 40], ['p1', 'fold']]);
    expect(results(unreadable)).toEqual({ won: [50, 0], net: [10, -10], potTotal: 50 });

    // The query reads each player's chips put in as won - net: check that against the actions the engine logged.
    for (const rec of [foldWin, split, side, sitOut, unreadable]) {
      for (const p of rec.players) {
        const put = rec.actions.filter((a) => a.playerId === p.playerId).reduce((sum, a) => sum + a.amount, 0);
        expect(p.won - p.net, `${rec.handId} ${p.playerId}`).toBe(put);
      }
    }

    await store(foldWin, [ids[0]!, ids[1]!, ids[2]!]);
    await store(split, [ids[0]!, ids[1]!]);
    await store(side, [ids[0]!, ids[1]!, ids[2]!]);
    await store(sitOut, [ids[0]!, ids[2]!, ids[3]!]);
    await store(unreadable, [ids[4]!, ids[3]!], { log: 'not json' });
    // What the game worker runs after recording a hand.
    await d1(HAND_STATS_SQL);

    // Before: "biggest pot" was MAX(won), 300 for u0 (the main pot only) and 200 for u1 (its own chips back); a hand
    // counted as won when chips came back, so u1 had 2 wins (the side pot hand was a loss of 300).
    expect(await stats(u0)).toEqual({
      handsPlayed: 4,
      handsWon: 3,
      winRate: 75,
      totalWon: 425,
      netChips: 215,
      largestPot: 700,
      avgPot: 308, // (25 + 200 + 700) / 3; the 1,800 pot p0 folded out of doesn't count
      biggestWin: 200,
      bestHand: expect.objectContaining({ rankClass: 'straight-flush' }), // the royal flush on the board
      vpip: { n: 3, of: 4 },
      pfr: { n: 3, of: 4 },
      raiseShare: { n: 3, of: 3 },
      wtsd: { n: 2, of: 2 },
      wsd: { n: 2, of: 2 },
      positions: positions({ BTN: [4, 3, 3, 215] }),
    });
    expect(await stats(u1)).toMatchObject({
      handsPlayed: 3,
      handsWon: 1,
      winRate: 33.3,
      totalWon: 100,
      netChips: -305,
      largestPot: 700,
      avgPot: 308,
      biggestWin: 0,
      vpip: { n: 2, of: 3 },
      pfr: { n: 1, of: 3 },
      raiseShare: { n: 1, of: 2 },
      wtsd: { n: 2, of: 2 },
      wsd: { n: 1, of: 2 },
      positions: positions({ SB: [2, 1, 1, -305], BB: [1, 1, 0, 0] }),
    });
    expect(await stats(u2)).toMatchObject({
      handsPlayed: 3,
      handsWon: 2,
      winRate: 66.7,
      totalWon: 2200,
      netChips: 990,
      largestPot: 1800,
      avgPot: 842,
      biggestWin: 900,
      vpip: { n: 2, of: 3 },
      pfr: { n: 1, of: 3 },
      raiseShare: { n: 1, of: 2 },
      wtsd: { n: 2, of: 2 },
      wsd: { n: 2, of: 2 },
      positions: positions({ SB: [1, 1, 1, 900], BB: [2, 1, 0, 90] }),
    });
    // u3 played the unreadable hand too: it counts for hands, chips and pots, not for VPIP, showdowns or positions.
    expect(await stats(u3)).toMatchObject({
      handsPlayed: 2,
      handsWon: 0,
      winRate: 0,
      totalWon: 0,
      netChips: -910,
      largestPot: 1800,
      avgPot: 910,
      biggestWin: 0,
      vpip: { n: 1, of: 1 },
      pfr: { n: 0, of: 1 },
      raiseShare: { n: 0, of: 1 },
      wtsd: { n: 1, of: 1 },
      wsd: { n: 0, of: 1 },
      positions: positions({ BB: [1, 1, 0, -900] }),
    });
    expect(await stats(u4)).toMatchObject({
      handsPlayed: 1,
      handsWon: 1,
      winRate: 100,
      totalWon: 20,
      netChips: 10,
      vpip: { n: 0, of: 0 },
      pfr: { n: 0, of: 0 },
      wtsd: { n: 0, of: 0 },
      wsd: { n: 0, of: 0 },
      positions: positions({}),
    });
  });

  it('net chips by day for the last 7, 30 or 90 days, cut at the caller’s time zone', async () => {
    const [u, other] = await Promise.all([newUser(), newUser()]);
    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const now = Date.now();
    const midnight3 = Date.parse(iso(now - 3 * DAY)); // a UTC midnight three days ago
    const start7 = Date.parse(iso(now - 6 * DAY)); // where the 7-day window starts in UTC
    const times = [now - 1_000, midnight3 - HOUR / 2, midnight3 + HOUR / 2, start7 - 1, start7, now - 20 * DAY, now - 60 * DAY, now - 120 * DAY];
    // Heads-up, u raises and the big blind folds: +10 for u every hand.
    const base = await play([1000, 1000], [['p0', 'raise', 40], ['p1', 'fold']]);
    for (const [k, t] of times.entries()) await store({ ...base, handId: `${base.handId}-t${k}`, startedAt: t - 1_000, endedAt: t }, [u.me.id, other.me.id]);

    const trend = async (qs: string) => (await u.client.get(`/api/me/stats/trend${qs}`)).body as StatsTrendDto;
    /** The same days worked out from the local dates as text. */
    const expected = (days: number, tz: number) => {
      const local = (t: number) => iso(t + tz * 60_000);
      const from = local(now - (days - 1) * DAY);
      const by = new Map<string, number>();
      for (const t of times) if (local(t) >= from) by.set(local(t), (by.get(local(t)) ?? 0) + 1);
      return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, hands]) => ({ day, hands, net: 10 * hands }));
    };

    for (const [days, tz] of [[7, 0], [30, 0], [90, 0], [7, 60], [7, -60], [90, 540]] as const) {
      expect(await trend(`?days=${days}&tz=${tz}`), `${days} days at ${tz}`).toEqual({ days, tz, points: expected(days, tz) });
    }
    const days7 = (await trend('?days=7&tz=0')).points;
    expect(days7.find((p) => p.day === iso(start7))).toMatchObject({ hands: 1 }); // the first moment of the window counts
    expect(days7.find((p) => p.day === iso(start7 - 1))).toBeUndefined(); // the moment before doesn't
    expect(days7.filter((p) => p.day === iso(midnight3) || p.day === iso(midnight3 - DAY))).toHaveLength(2); // either side of midnight
    expect((await trend('?days=7&tz=60')).points).toContainEqual({ day: iso(midnight3), hands: 2, net: 20 }); // 00:30 and 01:30
    expect((await trend('?days=7&tz=-60')).points).toContainEqual({ day: iso(midnight3 - DAY), hands: 2, net: 20 }); // 22:30 and 23:30
    expect((await trend('?days=30&tz=0')).points.map((p) => p.day)).toContain(iso(now - 20 * DAY));
    expect((await trend('?days=30&tz=0')).points.map((p) => p.day)).not.toContain(iso(now - 60 * DAY));
    expect((await trend('?days=90&tz=0')).points.map((p) => p.day)).toContain(iso(now - 60 * DAY));
    expect((await trend('?days=90&tz=0')).points.map((p) => p.day)).not.toContain(iso(now - 120 * DAY));
    // Defaults: 30 days, UTC.
    expect(await trend('')).toEqual({ days: 30, tz: 0, points: expected(30, 0) });
    // The other player's days are their own.
    expect((await other.client.get('/api/me/stats/trend?days=7&tz=0')).body.points.every((p: { net: number }) => p.net < 0)).toBe(true);

    for (const qs of ['?days=14', '?days=x', '?days=7&tz=900', '?days=7&tz=-721', '?days=7&tz=1.5', '?days=7&tz=abc']) {
      const r = await u.client.get(`/api/me/stats/trend${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.code, qs).toBe('bad_request');
    }
    // Only for the signed-in user themself.
    for (const p of ['/api/me/stats', '/api/me/stats/trend']) expect((await new Client().get(p)).status, p).toBe(401);
  });
});

/** The public log the game worker stores with a hand (settlement.ts): actions, button and pots. */
const publicLog = (rec: HandRecord) => JSON.stringify({ actions: rec.actions, button: rec.buttonSeat, pots: rec.pots });

describe('replay settlement', () => {
  it('shows a bet nobody called as handed back by what the hand’s statistics stored, on the hand page and in a board post', async () => {
    const [u0, u1, u2] = await Promise.all([newUser(), newUser(), newUser()]);
    const ids = [u0, u1, u2].map((u) => u.me.id);
    // p0 (button) raises to 40, both blinds fold. Nobody was all in, so the engine pays one pot of 55; 30 of it is p0's
    // raise nobody called.
    const foldWin = await play([1000, 1000, 1000], [['p0', 'raise', 40], ['p1', 'fold'], ['p2', 'fold']]);
    expect(foldWin.pots).toEqual([{ amount: 55, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 55 }], uncalled: false }]);
    // All in: the engine pays p1's last 200, which nobody called, as a pot of its own.
    const side = await play([100, 500, 300], [['p0', 'allin'], ['p1', 'allin'], ['p2', 'allin']], { holes: ['Ac Ad', '2c 7d', 'Kc Kd'], board: '9h 8s 4d 3c Jh' });
    expect(side.pots!.filter((p) => p.uncalled)).toEqual([{ amount: 200, eligibleSeats: [1], winners: [{ seatIndex: 1, amount: 200 }], uncalled: true }]);
    await store(foldWin, ids, { log: publicLog(foldWin) });
    await store(side, ids, { log: publicLog(side) });
    const detail = async (rec: HandRecord) => (await u0.client.get(`/api/me/hands/${rec.handId}`)).body as HandDetailDto;

    // Until the statistics are filled: the pots as stored, and nothing said to have come back. Tables left by earlier
    // files keep playing on this worker, and every hand they record fills the statistics of all hands, these two
    // included; once filled they stay filled, so rows still empty after both reads were empty during them.
    const before = [await detail(foldWin), await detail(side)];
    const empty = (await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM hand_players WHERE hand_id IN (${q(foldWin.handId)}, ${q(side.handId)}) AND pot_won IS NULL`))[0]!.n;
    if (empty === 6) {
      expect(before[0]).toMatchObject({ pots: foldWin.pots, returned: null });
      expect(before[1]).toMatchObject({ pots: side.pots, returned: null });
    }

    // What the game worker runs after recording a hand.
    await d1(HAND_STATS_SQL);
    const split = [
      { amount: 25, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 25 }], uncalled: false },
      { amount: 30, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 30 }], uncalled: true },
    ];
    expect(await detail(foldWin)).toMatchObject({ potTotal: 55, pots: split, returned: { seatIndex: 0, amount: 30 } });
    // The engine's own pot and the statistics agree on it: the pots stay as stored.
    expect(await detail(side)).toMatchObject({ potTotal: 900, pots: side.pots, returned: { seatIndex: 1, amount: 200 } });
    // The record itself is as the engine settled it.
    expect((await detail(foldWin)).players.map((p) => [p.won, p.net])).toEqual([[55, 15], [0, -5], [0, -10]]);

    // A board post's hand review reads the same, for a reader who played neither hand.
    const post = await u0.client.post('/api/board/posts', { title: '레이즈 폴드', body: 'x', handIds: [foldWin.handId, side.handId] });
    expect(post.status).toBe(201);
    const reader = await newUser();
    const view = (await reader.client.get(`/api/board/posts/${post.body.id}`)).body as { hands: HandReviewDto[] };
    expect(view.hands.map((h) => [h.id, h.pots, h.returned])).toEqual([
      [foldWin.handId, split, { seatIndex: 0, amount: 30 }],
      [side.handId, side.pots, { seatIndex: 1, amount: 200 }],
    ]);
  });
});

describe('play statistics from a real table', () => {
  const open: TableSocket[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });
  const join = async () => {
    const u = await newUser();
    const ws = await TableSocket.open(u.client, 'it-stats-0');
    open.push(ws);
    return { ...u, ws };
  };

  it('are filled when the game worker records the hand, for the players dealt in and not for a spectator', async () => {
    const [a, b, watcher] = [await join(), await join(), await join()];
    for (const [p, seatIndex] of [[a, 0], [b, 1]] as const) {
      expect(await p.ws.request({ t: 'sit', seatIndex, buyIn: 500 })).toMatchObject({ t: 'ack' });
    }
    const live = (s: TableView) => !!s.hand && s.status === 'playing';
    const hand = (await a.ws.waitState(live, 20_000, 'hand')).hand!;
    await b.ws.waitState(live);
    // Check or call to the end: the small blind (the button heads-up) calls, the big blind checks.
    for (let guard = 0; guard < 100; guard++) {
      const s = a.ws.state!;
      if (s.hand?.id !== hand.id || s.hand.stage === 'settled') break;
      const actor = [a, b].find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === hand.id);
      if (!actor) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const type = actor.ws.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call';
      expect((await actor.ws.act(type)).result.t).toBe('state');
    }
    // Stand up before the next hand starts.
    for (const p of [a, b]) expect(await p.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });

    const [btn, bb] = hand.sbSeat === 0 ? [a, b] : [b, a];
    let sb: StatsDto | undefined;
    for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
      sb = await stats(btn);
      if (sb.vpip.of > 0) break;
    }
    expect(sb).toMatchObject({ handsPlayed: 1, vpip: { n: 1, of: 1 }, pfr: { n: 0, of: 1 }, wtsd: { n: 1, of: 1 }, wsd: { of: 1 }, positions: positions({ BTN: [1, 1, 0, sb!.netChips] }) });
    const sbb = await stats(bb);
    expect(sbb).toMatchObject({ handsPlayed: 1, vpip: { n: 0, of: 1 }, pfr: { n: 0, of: 1 }, wtsd: { n: 1, of: 1 }, wsd: { of: 1 }, positions: positions({ BB: [1, 0, 0, sbb.netChips] }) });
    // A pot of 20 went to one of them or was split; nothing came back uncalled.
    expect(sb!.totalWon + sbb.totalWon).toBe(20);
    expect(sb!.handsWon + sbb.handsWon).toBeGreaterThanOrEqual(1);
    expect(sb!.netChips + sbb.netChips).toBe(0);
    // Watching the whole hand counts for nothing.
    expect(await stats(watcher)).toMatchObject({ handsPlayed: 0, handsWon: 0, totalWon: 0, avgPot: null, vpip: { n: 0, of: 0 }, positions: positions({}) });
  });
});
