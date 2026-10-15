import { HandEngine, nextButtonSeat, type HandRecord } from '@jc/poker-engine';
import type { Position } from '@jc/types';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { HAND_STATS_SQL } from '../../packages/db/src/handStats';

// The statistics statement runs on the real migration files in an in-memory SQLite, over hands the real engine played
// with random seats, buttons, stacks and actions. The expected values are worked out here from the engine itself
// (the button it was given, the options it offered, the bets on the table), not from the action log the SQL reads.
const dir = new URL('../../packages/db/migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const apply = (db: DatabaseSync, file: string) => {
  for (const stmt of readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
};

/** mulberry32: a seeded generator, so a failing hand can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Expected {
  position: Position;
  vpip: number;
  pfr: number;
  saw_flop: number;
  pot_won: number;
}

/** Position by seat order from the button, named the way the statistics page explains it. */
function positionsFromButton(dealt: number[], button: number): Map<number, Position> {
  const at = dealt.indexOf(button);
  const order = [...dealt.slice(at), ...dealt.slice(0, at)];
  const out = new Map<number, Position>();
  if (order.length === 2) return out.set(order[0]!, 'BTN').set(order[1]!, 'BB');
  out.set(order[0]!, 'BTN').set(order[1]!, 'SB').set(order[2]!, 'BB');
  if (order.length >= 4) out.set(order.at(-1)!, 'CO');
  const middle = order.slice(3, -1);
  middle.forEach((s, j) => out.set(s, j < Math.ceil(middle.length / 2) ? 'EP' : 'MP'));
  return out;
}

const seen = { timeoutFold: 0, timeoutCheck: 0, allinRaise: 0, allinCall: 0, blindAllIn: 0, sizes: new Set<number>() };

async function randomHand(r: () => number, handId: string): Promise<{ rec: HandRecord; expected: Map<string, Expected> }> {
  const n = 2 + Math.floor(r() * 8);
  const free = Array.from({ length: 9 }, (_, i) => i);
  const dealt: number[] = [];
  while (dealt.length < n) dealt.push(free.splice(Math.floor(r() * free.length), 1)[0]!);
  dealt.sort((a, b) => a - b);
  const button = nextButtonSeat(r() < 0.2 ? null : Math.floor(r() * 9), dealt, 9);
  const stack = () => (r() < 0.12 ? 1 + Math.floor(r() * 14) : 30 + Math.floor(r() * 1500));
  const h = HandEngine.start({
    handId,
    rules: { maxSeats: 9, smallBlind: 5, bigBlind: 10, turnMs: 20_000 },
    seats: dealt.map((seatIndex) => ({ playerId: `p${seatIndex}`, seatIndex, stack: stack(), displayName: `P${seatIndex}` })),
    buttonSeat: button,
    now: 1_000,
  });
  seen.sizes.add(n);
  const vpip = new Set<string>();
  const pfr = new Set<string>();
  const foldedPreflop = new Set<string>();
  let now = 2_000;
  for (let guard = 0; guard < 400 && !h.isSettled; guard++) {
    if (h.isStalled()) {
      await h.resolveStall(++now);
      continue;
    }
    const who = h.actorId()!;
    const preflop = h.stage === 'preflop';
    const legal = h.legalOptions(who);
    const table = h.seatInfo(null);
    const mine = table.get(h.seatOf(who)!)!;
    const highest = Math.max(0, ...[...table.values()].map((s) => s.streetBet));
    const x = r();
    if (x < 0.07) {
      const canCheck = legal.some((o) => o.type === 'check');
      expect((await h.timeout(who, ++now)).ok).toBe(true);
      if (canCheck) seen.timeoutCheck++;
      else {
        seen.timeoutFold++;
        if (preflop) foldedPreflop.add(who);
      }
      continue;
    }
    const has = (t: string) => legal.find((o) => o.type === t);
    const raise = has('raise') ?? has('bet');
    let req: { type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'; amount?: number };
    if (x < 0.2 && has('fold')) req = { type: 'fold' };
    else if (x < 0.32 && has('allin')) req = { type: 'allin' };
    else if (x < 0.5 && raise && 'min' in raise) req = { type: raise.type as 'bet' | 'raise', amount: r() < 0.5 ? raise.min : raise.min + Math.floor(r() * (raise.max - raise.min + 1)) };
    else if (has('check')) req = { type: 'check' };
    else if (has('call')) req = { type: 'call' };
    else req = { type: legal[0]!.type };
    const res = await h.act(who, req, `${handId}-${guard}`, ++now);
    if (!res.ok) throw new Error(`${handId}: ${who} ${req.type} ${req.amount ?? ''} rejected: ${res.reason}`);
    if (!preflop) continue;
    if (req.type === 'fold') foldedPreflop.add(who);
    if (req.type !== 'fold' && req.type !== 'check') vpip.add(who);
    const allinTotal = mine.streetBet + mine.stack;
    if (req.type === 'raise' || req.type === 'bet' || (req.type === 'allin' && allinTotal > highest)) pfr.add(who);
    if (req.type === 'allin') seen[allinTotal > highest ? 'allinRaise' : 'allinCall']++;
  }
  expect(h.isSettled).toBe(true);
  const rec = h.record(9_000);
  if (rec.players.some((p) => p.stackStart <= 10 && rec.actions.some((a) => a.playerId === p.playerId && a.type.startsWith('post-') && a.amount === p.stackStart))) seen.blindAllIn++;

  // Chips put in per player (from the engine's payout identity), and the uncalled part of the largest contribution.
  const put = rec.players.map((p) => ({ id: p.playerId, put: p.won - p.net })).sort((a, b) => b.put - a.put);
  const uncalled = put[0]!.put - put[1]!.put;
  const pos = positionsFromButton(dealt, button);
  const expected = new Map<string, Expected>();
  for (const p of rec.players) {
    expected.set(p.playerId, {
      position: pos.get(p.seatIndex)!,
      vpip: +vpip.has(p.playerId),
      pfr: +pfr.has(p.playerId),
      saw_flop: +(rec.board.length >= 3 && !foldedPreflop.has(p.playerId)),
      pot_won: Math.max(0, p.won - (p.playerId === put[0]!.id ? uncalled : 0)),
    });
  }
  return { rec, expected };
}

function insert(db: DatabaseSync, rec: HandRecord, eventLog = JSON.stringify({ actions: rec.actions, engine: 'H4sIAAAA' })) {
  db.prepare('INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    rec.handId,
    't',
    1,
    rec.startedAt,
    rec.endedAt,
    JSON.stringify(rec.board),
    rec.potTotal,
    rec.engineVersion,
    eventLog,
  );
  const row = db.prepare(
    'INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const p of rec.players) row.run(rec.handId, p.playerId, p.seatIndex, JSON.stringify(p.holeCards), p.stackStart, p.stackEnd, p.net, p.won, p.rankClass, p.rankValue, null, p.wentToShowdown ? 1 : 0, rec.endedAt);
}

const stored = (db: DatabaseSync, handId: string) =>
  Object.fromEntries(
    (db.prepare('SELECT user_id, position, vpip, pfr, saw_flop, pot_won FROM hand_players WHERE hand_id = ? ORDER BY user_id').all(handId) as Record<string, unknown>[]).map(({ user_id, ...rest }) => [user_id, { ...rest }]),
  );

describe('hand statistics (HAND_STATS_SQL, migration 0010)', () => {
  it('migration 0010 backfilled with the statement the game worker runs, except that the worker starts from the hands still to do', () => {
    const file = files.find((f) => f.startsWith('0010_'))!;
    // Applied migrations are not edited. The worker's copy differs only in where the two lookups start.
    const migrated = HAND_STATS_SQL.replace('FROM todo CROSS JOIN hands h ON h.id = todo.hand_id', 'FROM hands h JOIN todo ON todo.hand_id = h.id')
      .replace('FROM todo CROSS JOIN hand_players p ON p.hand_id = todo.hand_id', 'FROM hand_players p JOIN todo ON todo.hand_id = p.hand_id')
      .replace(' AND hand_players.hand_id IN (SELECT hand_id FROM todo)', '');
    expect(migrated).not.toBe(HAND_STATS_SQL);
    expect(readFileSync(new URL(file, dir), 'utf8')).toContain(`${migrated};`);
  });

  it('positions, VPIP, PFR, saw-flop and pot won match the engine for random hands, before and after the migration', async () => {
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
    const at = files.findIndex((f) => f.startsWith('0010_'));
    for (const f of files.slice(0, at)) apply(db, f);
    const r = rng(20261015);
    const check = (hands: { rec: HandRecord; expected: Map<string, Expected> }[]) => {
      for (const { rec, expected } of hands) expect(stored(db, rec.handId), JSON.stringify(rec.actions)).toEqual(Object.fromEntries([...expected].sort(([a], [b]) => (a < b ? -1 : 1))));
    };

    // Hands recorded before the columns existed: the migration fills them.
    const before = [];
    for (let i = 0; i < 150; i++) before.push(await randomHand(r, `old-${i}`));
    for (const h of before) insert(db, h.rec);
    for (const f of files.slice(at)) apply(db, f);
    check(before);

    // Hands recorded afterwards (the worker inserts without these columns, then runs the statement).
    const after = [];
    for (let i = 0; i < 150; i++) after.push(await randomHand(r, `new-${i}`));
    for (const h of after) insert(db, h.rec);
    // A log that isn't JSON and one without actions: only pot_won can be worked out.
    insert(db, { ...after[0]!.rec, handId: 'bad-json' }, '{"actions": [');
    insert(db, { ...after[1]!.rec, handId: 'no-actions' }, '{"engine": "x"}');
    expect(Number(db.prepare(HAND_STATS_SQL).run().changes)).toBe([...after, after[0], after[1]].reduce((a, h) => a + h!.rec.players.length, 0));
    check(after);
    for (const id of ['bad-json', 'no-actions']) {
      const src = id === 'bad-json' ? after[0]! : after[1]!;
      expect(stored(db, id)).toEqual(Object.fromEntries([...src.expected].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { position: null, vpip: null, pfr: null, saw_flop: null, pot_won: v.pot_won }])));
    }
    // Nothing left to do: running it again touches no row.
    expect(Number(db.prepare(HAND_STATS_SQL).run().changes)).toBe(0);
    // The partial index keeps that check cheap.
    expect(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT hand_id FROM hand_players WHERE pot_won IS NULL`).all())).toContain('hp_stats_todo_idx');
    // And the statement reads only the hands still to do: no pass over every recorded hand or player row (it runs after every hand).
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${HAND_STATS_SQL}`).all() as { detail: string }[]).map((r) => r.detail);
    expect(plan.filter((d) => /^SCAN (hand_players|p|h|hands)\b/.test(d) && !d.includes('hp_stats_todo_idx'))).toEqual([]);

    // The random hands covered what the rules single out.
    const all = [...before, ...after].flatMap((h) => [...h.expected.values()]);
    expect([...seen.sizes].sort()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(all.map((e) => e.position))).toEqual(new Set(['EP', 'MP', 'CO', 'BTN', 'SB', 'BB']));
    for (const k of ['vpip', 'pfr', 'saw_flop'] as const) expect(new Set(all.map((e) => e[k]))).toEqual(new Set([0, 1]));
    for (const k of ['timeoutFold', 'timeoutCheck', 'allinRaise', 'allinCall', 'blindAllIn'] as const) expect(seen[k], k).toBeGreaterThan(0);
    // Somebody got only uncalled chips back (won > 0, pot won 0).
    expect([...before, ...after].some((h) => h.rec.players.some((p) => p.won > 0 && h.expected.get(p.playerId)!.pot_won === 0))).toBe(true);
  });
});
