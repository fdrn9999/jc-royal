// Signs of chips passed on purpose between two members (integrity.ts): how a hand's chips are shared out between a
// pair, when a pair is listed and in which band, and the page's reading of D1 — run on SQLite with the real migrations.
import { beforeAll, describe, expect, it } from 'vitest';
import { INTEGRITY, integrity, integrityPair, pairsOf, withNetwork, type IntegrityRow } from './integrity';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface NodeParts {
  DatabaseSync: new (path: string) => SqliteDb;
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}

let node: NodeParts;
beforeAll(async () => {
  // Node built-ins, loaded by name: this package is typed for the Workers runtime only.
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<object>;
  node = { ...(await load('node:sqlite')), ...(await load('node:fs')) } as NodeParts;
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20);
const BB = 10;

/** A hand's rows: [player, net chips, went to showdown]; players named `bot…` are table bots. */
type Seat = [string, number, boolean?];
let handNo = 0;
function rowsOf(hands: Seat[][], at = NOW - DAY): IntegrityRow[] {
  return hands.flatMap((seats) => {
    const handId = `h${++handNo}`;
    return seats.map(([userId, net, showdown]) => ({ handId, tableId: 'cash', handNumber: handNo, endedAt: at, bb: BB, userId, net, showdown: showdown ? 1 : 0, bot: userId.startsWith('bot') ? 1 : 0 }));
  });
}
const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
/** Every sign at the lowest threshold, to look at one sign at a time. */
const loose = { ...INTEGRITY, minShared: 1, minFlowBb: 0.1, oneWay: 0, minDumps: 99 };

describe('sharing a hand out between two members', () => {
  it('shares a loser’s chips over the winners by what each won, bots’ winnings too, and never pairs a bot', () => {
    // A lost 30 big blinds, B won 20 and C 10; then A lost 10, B and a bot won 5 each.
    const pairs = pairsOf(rowsOf([[['a', -300], ['b', 200], ['c', 100]], [['a', -100], ['b', 50], ['bot1', 50]]]), loose);
    const of = (from: string, to: string) => pairs.find((p) => p.from === from && p.to === to);
    expect(of('a', 'b')).toMatchObject({ shared: 2, flowBb: 25, oneWay: 1 });
    expect(of('a', 'c')).toMatchObject({ shared: 1, flowBb: 10, oneWay: 1 });
    expect(pairs.some((p) => p.from.startsWith('bot') || p.to.startsWith('bot'))).toBe(false);
    // B and C both won: nothing passed between them.
    expect(pairs.find((p) => [p.from, p.to].sort().join() === 'b,c')).toBeUndefined();
  });

  it('nets what went back, the giver named by where the chips ended', () => {
    const [p] = pairsOf(rowsOf([[['b', -300], ['a', 300]], [['a', -100], ['b', 100]]]), loose);
    expect(p).toMatchObject({ from: 'b', to: 'a', shared: 2, flowBb: 20, oneWay: 0.75 });
  });
});

describe('when a pair is listed', () => {
  it('chips one way: enough hands together, enough big blinds, and almost all of it the same way', () => {
    const steady = times(12, () => [['a', -50], ['b', 50]] as Seat[]);
    const [p] = pairsOf(rowsOf(steady));
    expect(p).toMatchObject({ from: 'a', to: 'b', shared: 12, flowBb: 60, oneWay: 1, dumps: 0, signals: ['flow'], risk: 'low' });
    // Nine hands are too few to compare; 45 big blinds too little; B winning 40 back makes it 120 of 160 one way.
    expect(pairsOf(rowsOf(times(9, () => [['a', -100], ['b', 100]] as Seat[])))).toEqual([]);
    expect(pairsOf(rowsOf(times(12, () => [['a', -37.5], ['b', 37.5]] as Seat[])))).toEqual([]);
    const back = [['b', -200, true], ['a', 200, true]] as Seat[];
    expect(pairsOf(rowsOf([...times(12, () => [['a', -100], ['b', 100]] as Seat[]), back, back]))).toEqual([]);
  });

  it('dumps: big hands given up without a showdown, the other the only winner, the same way three times', () => {
    const dump = [['a', -250], ['b', 250]] as Seat[];
    const [p] = pairsOf(rowsOf([dump, dump, dump]));
    expect(p).toMatchObject({ from: 'a', to: 'b', shared: 3, dumps: 3, signals: ['dumps'], risk: 'low' });
    expect(p!.hands.every((h) => h.dump)).toBe(true);
    // Not a dump: lost at showdown, under 20 big blinds, or a third player won too.
    const not = [
      [['a', -250, true], ['b', 250, true]],
      [['a', -190], ['b', 190]],
      [['a', -250], ['b', 200], ['c', 50]],
    ] as Seat[][];
    expect(pairsOf(rowsOf([dump, dump, ...not]))).toEqual([]);
    // Two one way and two the other are no pattern.
    expect(pairsOf(rowsOf([dump, dump, [['b', -250], ['a', 250]], [['b', -250], ['a', 250]]]))).toEqual([]);
  });

  it('two signs are the middle band, the network the third; the network is never a sign alone', () => {
    const rows = rowsOf([...times(3, () => [['a', -250], ['b', 250]] as Seat[]), ...times(9, () => [['a', -10], ['b', 10]] as Seat[])]);
    const [p] = pairsOf(rows);
    expect(p).toMatchObject({ signals: ['flow', 'dumps'], risk: 'medium', shared: 12, flowBb: 84 });
    expect(withNetwork(p!, true)).toMatchObject({ signals: ['flow', 'dumps', 'network'], risk: 'high' });
    expect(withNetwork(p!, false)).toBe(p);
    expect(pairsOf(rowsOf([[['a', -10], ['b', 10]]]))).toEqual([]);
  });

  it('lists the highest band first and keeps ten hands to look at, dumps first, then the largest flows', () => {
    const rows = rowsOf([
      ...times(12, (i) => [['c', -60 - i * 10], ['d', 60 + i * 10]] as Seat[]),
      ...times(3, () => [['a', -250], ['b', 250]] as Seat[]),
      ...times(12, () => [['a', -10], ['b', 10]] as Seat[]),
    ]);
    const pairs = pairsOf(rows);
    expect(pairs.map((p) => `${p.from}>${p.to}:${p.risk}`)).toEqual(['a>b:medium', 'c>d:low']);
    const ab = pairs[0]!.hands;
    expect(ab).toHaveLength(INTEGRITY.evidence);
    expect(ab.slice(0, 3).every((h) => h.dump && h.bb === 25)).toBe(true);
    expect(ab.slice(3).every((h) => !h.dump && h.bb === 1)).toBe(true);
    expect(pairs[1]!.hands.map((h) => h.bb)).toEqual([17, 16, 15, 14, 13, 12, 11, 10, 9, 8]);
  });
});

/** An in-memory database with every migration applied. */
function database(): SqliteDb {
  const dir = new URL('../../../../packages/db/migrations/', (import.meta as unknown as { url: string }).url);
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, dir), 'utf8'));
  for (const [id, bot] of [['a', 0], ['b', 0], ['c', 0], ['bot1', 1]] as const) {
    db.prepare(`INSERT INTO users (id, email, nickname, password_hash, is_bot) VALUES (?1, ?1 || '@test.dev', 'nick-' || ?1, 'x', ?2)`).run(id, bot);
  }
  db.prepare(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, room_type)
     VALUES ('cash', 'Cash', 9, 5, ${BB}, 400, 2000, 'official'), ('tour', 'Tour', 9, 5, ${BB}, 400, 2000, 'tournament')`,
  ).run();
  return db;
}
/** D1 as the page reads it: statements, binds and batches, answered by SQLite. */
function fakeD1(db: SqliteDb) {
  const exec = (sql: string, params: unknown[]) => ({ results: db.prepare(sql).all(...params), meta: { rows_read: 1 } });
  class Stmt {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Stmt(this.sql, params);
    }
    async all() {
      return exec(this.sql, this.params);
    }
  }
  return { prepare: (sql: string) => new Stmt(sql), batch: async (stmts: Stmt[]) => stmts.map((s) => exec(s.sql, s.params)) } as unknown as D1Database;
}
let stored = 0;
function store(db: SqliteDb, table: string, at: number, seats: Seat[]) {
  const id = `s${++stored}`;
  db.prepare(`INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES (?1, ?2, ?3, ?4, ?4, '[]', 0, 'test', '[]')`).run(id, table, stored, at);
  seats.forEach(([u, net, sd], i) =>
    db
      .prepare(`INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES (?1, ?2, ?3, '[]', 1000, 1000 + ?4, ?4, 0, ?5, ?6)`)
      .run(id, u, i, net, sd ? 1 : 0, at),
  );
  return id;
}
const session = (db: SqliteDb, user: string, ip: string, seen: number, kind = 'user') =>
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, kind, expires_at, ip, last_seen_at) VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6)`).run(`${user}-${ip}-${kind}-${seen}`, user, kind, NOW + DAY, ip, seen);

describe('the integrity page’s reading of D1', () => {
  it('reads the period’s cash-table hands only, names the members, their network and the reports open on them', async () => {
    const db = database();
    const dumps = times(3, (i) => store(db, 'cash', NOW - (i + 1) * 3_600_000, [['a', -250], ['b', 250], ['bot1', 0]]));
    times(12, (i) => store(db, 'cash', NOW - DAY - i * 60_000, [['a', -10], ['b', 10]]));
    // Older than the period, or tournament chips: not read.
    times(3, () => store(db, 'cash', NOW - 8 * DAY, [['c', -250], ['b', 250]]));
    times(3, () => store(db, 'tour', NOW - DAY, [['c', -250], ['b', 250]]));
    db.prepare(`INSERT INTO reports (id, reporter_id, target_type, target_id, target_user_id, reason, context, created_at) VALUES ('r1', 'c', 'player', 'b', 'b', 'cheating', ?1, ?2)`).run(
      JSON.stringify({ kind: 'signal', partnerId: 'a' }),
      NOW - DAY,
    );
    const out = await integrity(fakeD1(db), 7, NOW);
    expect(out).toMatchObject({ days: 7, since: NOW - 7 * DAY, from: NOW - 7 * DAY, capped: false, hands: 15 });
    expect(out.pairs).toHaveLength(1);
    const [p] = out.pairs;
    expect(p).toMatchObject({ from: 'a', to: 'b', shared: 15, dumps: 3, signals: ['flow', 'dumps'], risk: 'medium', review: 'r1' });
    expect(p!.fromUser).toEqual({ id: 'a', nickname: 'nick-a', status: 'active', openReports: 0 });
    expect(p!.toUser).toEqual({ id: 'b', nickname: 'nick-b', status: 'active', openReports: 1 });
    expect(p!.hands.slice(0, 3).map((h) => h.id).sort()).toEqual(dumps.sort());

    // One network in the period: the third sign. An admin session, or one seen before the period, does not count.
    session(db, 'a', '10.0.0.9', NOW - 9 * DAY);
    session(db, 'b', '10.0.0.9', NOW - DAY);
    session(db, 'a', '10.0.0.7', NOW - DAY, 'admin');
    session(db, 'b', '10.0.0.7', NOW - DAY);
    expect((await integrity(fakeD1(db), 7, NOW)).pairs[0]!.signals).toEqual(['flow', 'dumps']);
    session(db, 'a', '10.0.0.9', NOW - 2 * DAY);
    const shared = await integrity(fakeD1(db), 7, NOW);
    expect(shared.pairs[0]).toMatchObject({ signals: ['flow', 'dumps', 'network'], risk: 'high' });
    expect(JSON.stringify(shared)).not.toMatch(/10\.0\.0/);

    // The pair read again for a review agrees with the list.
    const again = await integrityPair(fakeD1(db), 'a', 'b', 7, NOW);
    const { fromUser, toUser, review, ...listed } = shared.pairs[0]!;
    expect(again).toEqual({ since: NOW - 7 * DAY, pair: listed });
    expect(await integrityPair(fakeD1(db), 'a', 'c', 7, NOW)).toBeNull();
  });

  it('past the row cap reads the newest hands, leaves out the one cut part way and says where the period starts', async () => {
    const db = database();
    times(5, (i) => store(db, 'cash', NOW - (i + 1) * 60_000, [['a', -250], ['b', 200], ['c', 50]]));
    const out = await integrity(fakeD1(db), 7, NOW, { ...INTEGRITY, rowCap: 7 });
    // Seven rows: two whole hands and one of the third's players.
    expect(out).toMatchObject({ capped: true, hands: 2, from: NOW - 2 * 60_000, pairs: [] });
  });
});
