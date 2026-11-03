// A member's challenges (lib/challenges.ts) on SQLite with the real migrations: the periods (Korean days, weeks from
// Monday), what opening them judges and shows, and the totals. The statements' own rules are in
// tests/integration/challenges.test.ts, the settlement and the card there too.
import { challengeWeek, challengeWindows, dayStart, statsDay } from '@jc/db';
import { CHALLENGES } from '@jc/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { challengesFor } from './challenges';
import { d1Of, loadSqlite, migratedDb, type SqliteDb } from './test-sqlite';

beforeAll(loadSqlite);

const H = 3_600_000;
const DAY = 24 * H;
/** Wednesday 2026-11-04 15:00 in Korea. */
const NOW = Date.parse('2026-11-04T15:00:00+09:00');
const MONDAY = Date.parse('2026-11-02T00:00:00+09:00');

function database(): SqliteDb {
  const db = migratedDb();
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash) VALUES ('me', 'me@test.dev', 'me', 'x')`).run();
  db.prepare(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('tb', 'tb', 6, 5, 10, 100, 1000, 'open')`).run();
  return db;
}
/** Hands the member played, recorded at the times given. */
const hands = (db: SqliteDb, times: number[]) =>
  times.forEach((at, i) => {
    db.prepare(`INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES (?1, 'tb', ?2, ?3, ?3, '[]', 20, 't', '{}')`).run(`h${i}`, i + 1, at);
    db.prepare(`INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES (?1, 'me', 0, '[]', 100, 100, 0, 0, 0, ?2)`).run(`h${i}`, at);
  });

describe('challenge periods', () => {
  it('are Korean days and weeks from Monday 00:00 to the next', () => {
    const w = challengeWindows(NOW);
    expect(w.day).toEqual({ key: statsDay(NOW), from: Date.parse('2026-11-04T00:00:00+09:00'), to: Date.parse('2026-11-05T00:00:00+09:00') });
    expect(w.week.from).toBe(MONDAY);
    expect(w.week.to).toBe(MONDAY + 7 * DAY);
    // The week's edges: Monday's first moment is in it, Sunday's last moment before it is not.
    expect(challengeWindows(MONDAY).week.key).toBe(w.week.key);
    expect(challengeWindows(MONDAY - 1).week.key).toBe(w.week.key - 1);
    expect(challengeWindows(MONDAY + 7 * DAY - 1).week.key).toBe(w.week.key);
    // 23:30 UTC on Sunday is Monday 08:30 in Korea.
    expect(challengeWindows(Date.parse('2026-11-01T23:30:00Z')).week.key).toBe(w.week.key);
    // Day 0, 1970-01-01, was a Thursday: in the week whose Monday is day -3.
    expect(challengeWeek(0)).toBe(0);
    expect(challengeWeek(-3)).toBe(0);
    expect(challengeWeek(-4)).toBe(-1);
    expect(challengeWeek(4)).toBe(1);
    expect(dayStart(statsDay(MONDAY))).toBe(MONDAY);
  });
});

describe('challengesFor', () => {
  it('judges, then shows each challenge with its progress up to the target, and the totals', async () => {
    const db = database();
    // Twelve hands today, two on Monday: two days of the week, fourteen hands.
    hands(db, [...Array.from({ length: 12 }, (_, i) => NOW - 2 * H + i * 1000), MONDAY + H, MONDAY + H + 1]);
    const r = await challengesFor(d1Of(db), 'me', NOW);
    expect(r.periods).toEqual([
      { period: 'day', key: statsDay(NOW), startsAt: Date.parse('2026-11-04T00:00:00+09:00'), endsAt: Date.parse('2026-11-05T00:00:00+09:00') },
      { period: 'week', key: challengeWindows(NOW).week.key, startsAt: MONDAY, endsAt: MONDAY + 7 * DAY },
    ]);
    expect(r.items.map((x) => x.code)).toEqual(CHALLENGES.map((c) => c.code));
    const item = (code: string) => r.items.find((x) => x.code === code)!;
    // The tenth hand of today completes it, dated by that hand; the count stops at the target.
    expect(item('d_hands_10')).toEqual({ code: 'd_hands_10', period: 'day', target: 10, progress: 10, done: true, completedAt: NOW - 2 * H + 9000, points: 1 });
    expect(item('d_hands_30')).toMatchObject({ progress: 12, done: false, completedAt: null });
    expect(item('d_showdown_3')).toMatchObject({ progress: 0, done: false });
    expect(item('w_hands_100')).toMatchObject({ progress: 14, done: false });
    expect(item('w_days_3')).toMatchObject({ progress: 2, target: 3, done: false });
    expect(item('w_tournaments_2')).toMatchObject({ progress: 0, done: false });
    expect(r).toMatchObject({ points: 1, completed: 1, recent: [{ code: 'd_hands_10', period: 'day', completedAt: NOW - 2 * H + 9000, points: 1 }] });

    // Opening them again writes nothing more.
    expect(await challengesFor(d1Of(db), 'me', NOW + 1000)).toMatchObject({ points: 1, completed: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM challenge_completions`).all()).toEqual([{ n: 1 }]);
  });

  it('shows a completion of another period only in the totals, and leaves a code no longer offered out of the recent list', async () => {
    const db = database();
    const add = db.prepare(`INSERT INTO challenge_completions (user_id, code, period, points, completed_at) VALUES ('me', ?1, ?2, ?3, ?4)`);
    // Yesterday's d_hands_10, and a challenge since withdrawn from the catalogue.
    add.run('d_hands_10', statsDay(NOW) - 1, 1, NOW - DAY);
    add.run('d_retired', statsDay(NOW), 5, NOW - H);
    const r = await challengesFor(d1Of(db), 'me', NOW);
    expect(r.items.find((x) => x.code === 'd_hands_10')).toMatchObject({ done: false, progress: 0, completedAt: null });
    expect(r).toMatchObject({ points: 6, completed: 2, recent: [{ code: 'd_hands_10', completedAt: NOW - DAY, points: 1 }] });
    expect(r.recent).toHaveLength(1);
  });

  it('keeps a completion done though the records behind it are gone', async () => {
    const db = database();
    db.prepare(`INSERT INTO challenge_completions (user_id, code, period, points, completed_at) VALUES ('me', 'w_days_3', ?1, 3, ?2)`).run(challengeWindows(NOW).week.key, NOW - H);
    const r = await challengesFor(d1Of(db), 'me', NOW);
    expect(r.items.find((x) => x.code === 'w_days_3')).toMatchObject({ done: true, progress: 3, completedAt: NOW - H });
  });
});
