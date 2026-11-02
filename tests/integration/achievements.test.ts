import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENT_BACKFILL_SQL, ACHIEVEMENT_HAND_SQL, ACHIEVEMENT_STREAK_SQL, ACHIEVEMENT_TOURNAMENT_SQL } from '../../packages/db/src/achievementsSql';

// Achievements (packages/db/src/achievementsSql.ts) on the real migration files in an in-memory SQLite: what a hand, a
// tournament and a run of days give; that a mucked hand and a bot give nothing and running again changes nothing; and
// that migration 0042 gives the same for what was recorded before it, keeping other badges as they were.
const dir = new URL('../../packages/db/migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const apply = (db: DatabaseSync, file: string) => {
  for (const stmt of readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
};
const at0042 = files.findIndex((f) => f.startsWith('0042_'));

function fresh(upTo = files.length) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const f of files.slice(0, upTo)) apply(db, f);
  return db;
}

/** stats.ts's day (a Korean calendar day). */
const DAY = 86_400_000;
const TZ = 9 * 3_600_000;

const user = (db: DatabaseSync, id: string, bot = false) =>
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash, is_bot) VALUES (?1, ?2, ?1, 'x', ?3)`).run(id, `${id}@example.test`, bot ? 1 : 0);

interface Row {
  hand: string;
  user: string;
  at: number;
  net?: number;
  potWon?: number | null;
  rank?: string;
  showdown?: boolean;
  shown?: boolean | null;
}
const row = (db: DatabaseSync, r: Row) =>
  db
    .prepare(
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, went_to_showdown, ended_at, shown, pot_won)
       VALUES (?1, ?2, 0, '[]', 100, 100, ?3, 0, ?4, ?5, ?6, ?7, ?8)`,
    )
    .run(r.hand, r.user, r.net ?? 0, r.rank ?? null, r.showdown ? 1 : 0, r.at, r.shown === undefined || r.shown === null ? null : r.shown ? 1 : 0, r.potWon === undefined ? null : r.potWon);

const tournament = (db: DatabaseSync, id: string, winner: string, finishedAt: number, status = 'finished') =>
  db
    .prepare(
      `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, finished_at, winner_id)
       VALUES (?1, ?1, ?2, 6, 2, 1500, '[]', 60000, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?3, ?4)`,
    )
    .run(id, status, finishedAt, winner);

/** Every badge as `user code at`, sorted. */
const badges = (db: DatabaseSync) =>
  (db.prepare(`SELECT user_id AS u, badge AS b, awarded_at AS at FROM user_badges ORDER BY u, b`).all() as { u: string; b: string; at: number }[]).map((x) => `${x.u} ${x.b} ${x.at}`);

const forHand = (db: DatabaseSync, hand: string) => ACHIEVEMENT_HAND_SQL.reduce((n, sql) => n + Number(db.prepare(sql).run(hand).changes), 0);

describe('achievements', () => {
  it('a hand gives its members what it showed, once; never a bot, never a mucked hand', () => {
    const db = fresh();
    for (const id of ['m1', 'm2']) user(db, id);
    user(db, 'bot', true);
    row(db, { hand: 'h1', user: 'm1', at: 1000, net: 50, potWon: 100 });
    // A full house mucked at showdown: private, so nothing.
    row(db, { hand: 'h1', user: 'm2', at: 1000, net: -50, potWon: 0, rank: 'full-house', showdown: true, shown: false });
    row(db, { hand: 'h1', user: 'bot', at: 1000, potWon: 10, rank: 'straight-flush', showdown: true, shown: true });
    expect(forHand(db, 'h1')).toBe(3);
    expect(badges(db)).toEqual(['m1 play:first_hand 1000', 'm1 play:first_win 1000', 'm2 play:first_hand 1000']);

    // Quads shown; a full house from before mucking existed (no flag, at showdown) counts as face up.
    row(db, { hand: 'h2', user: 'm2', at: 2000, net: 200, potWon: 200, rank: 'four-of-a-kind', showdown: true, shown: true });
    row(db, { hand: 'h2', user: 'm1', at: 2000, net: -200, potWon: 0, rank: 'full-house', showdown: true, shown: null });
    // An old row without pot_won: a hand that ended ahead is a pot won.
    row(db, { hand: 'h3', user: 'bot', at: 3000, net: 20, potWon: null });
    expect(forHand(db, 'h2')).toBe(3);
    expect(badges(db)).toEqual([
      'm1 play:first_hand 1000',
      'm1 play:first_win 1000',
      'm1 play:full_house 2000',
      'm2 play:first_hand 1000',
      'm2 play:first_win 2000',
      'm2 play:quads 2000',
    ]);
    // Again, or for a hand recorded twice: nothing changes.
    expect(forHand(db, 'h1') + forHand(db, 'h2') + forHand(db, 'h3')).toBe(0);

    // A hundred hands: at the hundredth, not before.
    user(db, 'm3');
    for (let i = 1; i <= 99; i++) row(db, { hand: `c${i}`, user: 'm3', at: 10_000 + i });
    expect(forHand(db, 'c99')).toBe(1);
    expect(badges(db).filter((b) => b.includes('hands_100'))).toEqual([]);
    row(db, { hand: 'c100', user: 'm3', at: 10_100 });
    expect(forHand(db, 'c100')).toBe(1);
    expect(badges(db).filter((b) => b.includes('hands_100'))).toEqual(['m3 play:hands_100 10100']);
  });

  it('a finished tournament gives its winner one; and seven days in a row give one from the first run', () => {
    const db = fresh();
    for (const id of ['w1', 'w2', 's1', 's2', 's3']) user(db, id);
    user(db, 'bot', true);
    tournament(db, 't1', 'w1', 5000);
    tournament(db, 't2', 'w2', 6000, 'running');
    tournament(db, 't3', 'bot', 7000);
    for (const t of ['t1', 't2', 't3', 't1']) db.prepare(ACHIEVEMENT_TOURNAMENT_SQL).run(t);
    expect(badges(db)).toEqual(['w1 play:tournament_win 5000']);

    const days = (u: string, ds: number[]) => {
      for (const d of ds) db.prepare('INSERT INTO active_days (day, user_id) VALUES (?1, ?2)').run(d, u);
    };
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    days('s1', range(100, 106));
    days('s2', [...range(100, 105), 107]);
    days('s3', [...range(200, 206), ...range(300, 306)]);
    days('bot', range(100, 106));
    const streak = () => Number(db.prepare(ACHIEVEMENT_STREAK_SQL).run(DAY, TZ).changes);
    expect(streak()).toBe(2);
    expect(badges(db).filter((b) => b.includes('streak'))).toEqual([`s1 play:streak_7 ${106 * DAY - TZ}`, `s3 play:streak_7 ${206 * DAY - TZ}`]);
    expect(streak()).toBe(0);

    // Each later day is one lookup on active_days' (day, user_id) key, not a range of days read for every row.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${ACHIEVEMENT_STREAK_SQL}`).all() as { detail: string }[]).map((r) => r.detail);
    expect(plan).toContain('SEARCH d USING PRIMARY KEY (day=? AND user_id=?)');
  });

  it('migration 0042 gives the same for what was recorded before it, and turns the new privacy settings on as documented', () => {
    expect(at0042).toBeGreaterThan(0);
    const text = readFileSync(new URL(files[at0042]!, dir), 'utf8');
    for (const sql of ACHIEVEMENT_BACKFILL_SQL) expect(text).toContain(`${sql};`);

    const db = fresh(at0042);
    for (const id of ['m1', 'm2', 'm3']) user(db, id);
    user(db, 'bot', true);
    // An academy badge from before: kept as it was.
    db.prepare(`INSERT INTO user_badges (user_id, badge, awarded_at) VALUES ('m1', 'lesson:cards', 1)`).run();
    row(db, { hand: 'o1', user: 'm1', at: 1000, net: -10, potWon: null });
    row(db, { hand: 'o2', user: 'm1', at: 2000, net: 30, potWon: null, rank: 'full-house', showdown: true, shown: null });
    row(db, { hand: 'o3', user: 'm1', at: 3000, net: 50, potWon: 60, rank: 'full-house', showdown: true, shown: true });
    row(db, { hand: 'o2', user: 'm2', at: 2000, net: -30, potWon: 0, rank: 'four-of-a-kind', showdown: true, shown: false });
    row(db, { hand: 'o3', user: 'bot', at: 3000, potWon: 5, rank: 'straight-flush', showdown: true, shown: true });
    // m3's hundredth hand by time (inserted out of order).
    for (let i = 150; i >= 1; i--) row(db, { hand: `p${i}`, user: 'm3', at: 50_000 + i * 10 });
    tournament(db, 'old-2', 'm2', 9000);
    tournament(db, 'old-1', 'm2', 8000);
    tournament(db, 'old-3', 'm1', 9500, 'aborted');
    for (const f of files.slice(at0042)) apply(db, f);

    expect(badges(db)).toEqual([
      'm1 lesson:cards 1',
      'm1 play:first_hand 1000',
      'm1 play:first_win 2000',
      'm1 play:full_house 2000',
      'm2 play:first_hand 2000',
      'm2 play:tournament_win 8000',
      `m3 play:first_hand 50010`,
      'm3 play:hands_100 51000',
    ]);
    // What the per-hand statements would add afterwards is already there.
    for (const h of ['o1', 'o2', 'o3', 'p100', 'p150']) expect(forHand(db, h)).toBe(0);

    expect(db.prepare(`SELECT show_achievements AS a, show_stats AS s, share_table AS t, show_ranking AS r FROM users WHERE id = 'm1'`).get()).toEqual({ a: 1, s: 0, t: 1, r: 1 });
  });
});
