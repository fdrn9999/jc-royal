/**
 * Daily operations statistics for the admin console (apps/api/src/lib/stats.ts). Days are cut at midnight Korean time
 * (UTC+9, no daylight saving): day number `d` runs from `dayStart(d)` to `dayStart(d + 1)`, and the UTC date of
 * `d * STATS_DAY` is its Korean date.
 *
 * - `active_days`: one row per member and day on which a member session was used (signing in, or the first request of
 *   a new day). Only the day is kept, never a time, page or count, and only for ACTIVE_DAYS_RETENTION days: daily,
 *   weekly and monthly active members are counted from it and kept as numbers in `daily_stats`.
 * - `daily_stats`: one number per day and metric. Most are rolled up once a day from the records the service keeps
 *   anyway (accounts, seats, hands, reports); the Academy counters are added as events arrive. Day 0 holds markers.
 */
export const STATS_TZ_OFFSET_MS = 9 * 60 * 60_000;
export const STATS_DAY = 86_400_000;
/** Activity markers are kept this long; the daily housekeeping deletes older days. */
export const ACTIVE_DAYS_RETENTION = 35;
/** ...or longer while the rollup has fallen behind and still needs them, but never longer than this. */
export const ACTIVE_DAYS_MAX_RETENTION = 60;

export const statsDay = (at: number) => Math.floor((at + STATS_TZ_OFFSET_MS) / STATS_DAY);
export const dayStart = (day: number) => day * STATS_DAY - STATS_TZ_OFFSET_MS;

/** Academy counters, added by POST /api/academy/events (anonymous: per day, never per member). */
export const ACADEMY_METRICS = ['ac_lesson_start', 'ac_lesson_done', 'ac_scenario_start', 'ac_scenario_done', 'ac_answer', 'ac_correct'] as const;
export type AcademyMetric = (typeof ACADEMY_METRICS)[number];

/** Markers on day 0: the first day with activity markers, and the last day rolled up. */
export const STATS_MARKER_DAY = 0;

/** Marks the member active on the day of `at` (once per day: repeats change nothing). */
export function activeDayInsert(d1: D1Database, userId: string, at: number): D1PreparedStatement {
  return d1.prepare('INSERT OR IGNORE INTO active_days (day, user_id) VALUES (?1, ?2)').bind(statsDay(at), userId);
}

/** One statement per counter: adds `n` to the day's row. */
export function statsIncrements(d1: D1Database, day: number, counts: Partial<Record<AcademyMetric, number>>): D1PreparedStatement[] {
  return Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([metric, n]) =>
      d1.prepare('INSERT INTO daily_stats (day, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (day, metric) DO UPDATE SET n = n + excluded.n').bind(day, metric, n),
    );
}
