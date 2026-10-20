/**
 * Daily operations statistics for the admin console (apps/api/src/lib/stats.ts). Days are cut at midnight Korean time
 * (UTC+9, no daylight saving): day number `d` runs from `dayStart(d)` to `dayStart(d + 1)`, and the UTC date of
 * `d * STATS_DAY` is its Korean date.
 *
 * - `active_days`: one row per member and day on which a member session was used (signing in, or the first request of
 *   a new day). Only the day is kept, never a time, page or count, and only for ACTIVE_DAYS_RETENTION days: daily,
 *   weekly and monthly active members are counted from it and kept as numbers in `daily_stats`.
 * - `daily_stats`: one number per day and metric. Most are rolled up once a day from the records the service keeps
 *   anyway (accounts, seats, hands, reports); the Academy, free refill, hand note, settings, time bank and bot counters
 *   are added as events arrive. Day 0
 *   holds markers.
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

/**
 * Free refill claims that paid nothing, per day and reason (apps/api/src/lib/refill.ts): refused (off, paused, still
 * waiting, enough chips, suspended), held (table chips could not be confirmed) or changed under it (asked again).
 * Added as they happen, like the Academy counters, and kept by the daily rollup.
 */
export const REFILL_METRICS = ['rf_off', 'rf_paused', 'rf_cooldown', 'rf_above', 'rf_suspended', 'rf_held', 'rf_changed'] as const;
export type RefillMetric = (typeof REFILL_METRICS)[number];

/**
 * Hand notes (PUT /api/me/hands/:id/note, apps/api/src/lib/handNotes.ts): saves per kind of change, and saves refused
 * or failed per reason. Numbers only, never per member or hand, never what was written. Added as they happen and kept by
 * the daily rollup.
 */
export const HAND_NOTE_METRICS = [
  'hn_bookmark',
  'hn_tag',
  'hn_memo',
  'hn_fail_conflict',
  'hn_fail_invalid',
  'hn_fail_notfound',
  'hn_fail_limit',
  'hn_fail_error',
] as const;
export type HandNoteMetric = (typeof HAND_NOTE_METRICS)[number];

/**
 * Account settings (GET/PUT /api/me/settings, apps/api/src/lib/settings.ts): saves that changed something, a device's
 * settings from before sync taken in, saves made over a revision another device had changed (conflict), changes a newer
 * one kept out (stale), saves refused after a reset (epoch), saves and loads that failed per reason, attempts a device
 * says failed before it could reach the server, and administrators' resets and restores. Numbers only, never per
 * member, never a value. Added as they happen and kept by the daily rollup.
 */
export const SETTINGS_METRICS = [
  'ss_save',
  'ss_legacy',
  'ss_conflict',
  'ss_stale',
  'ss_epoch',
  'ss_fail_invalid',
  'ss_fail_limit',
  'ss_fail_busy',
  'ss_fail_error',
  'ss_load_fail',
  'ss_client_fail',
  'ss_reset',
  'ss_restore',
] as const;
export type SettingsMetric = (typeof SETTINGS_METRICS)[number];

/**
 * Time bank (apps/game-worker/src/room.ts): uses and seconds added, uses refused for an empty bank, turns that timed out
 * although time was added, turn timeouts the room ran more than a few seconds after the deadline (late timer), and
 * administrators' timer recoveries. Counted per hand and written with the hand record (once, also when it is written
 * again), never per member. Kept by the daily rollup.
 */
export const TIME_BANK_METRICS = ['tb_use', 'tb_sec', 'tb_empty', 'tb_expired', 'tb_late', 'tb_recover'] as const;
export type TimeBankMetric = (typeof TIME_BANK_METRICS)[number];

/**
 * Table bots' play per level (apps/game-worker/src/bot-stats.ts), metric `bt_<level>_<key>`: from each hand a bot was
 * dealt into, the public counters the bots' statistics of their opponents use (packages/poker-engine ai/profile.ts:
 * hands, chances to put chips in preflop and how often they did or raised, 3-bets, the big blind against a steal, folds
 * to an overbet); per decision, how many there were, how many fell back to a check or fold (the strategy failed or the
 * engine refused its choice), how many the engine refused, and how late the room moved (ms after the moment planned,
 * and moves over BOT_SLOW_MS late). Summed in the room over a few hands and written with a hand record (once, also when
 * it is written again), per level only, never per bot or member. Kept by the daily rollup.
 */
export const BOT_STAT_KEYS = [
  'hands',
  'vpipOpp',
  'vpip',
  'pfr',
  'threeBetOpp',
  'threeBet',
  'bbStealOpp',
  'bbFoldToSteal',
  'foldToOverbetOpp',
  'foldToOverbet',
  'decisions',
  'fallbacks',
  'failures',
  'lagMs',
  'slow',
] as const;
export type BotStatKey = (typeof BOT_STAT_KEYS)[number];
/** A bot move this much later than planned counts as slow. */
export const BOT_SLOW_MS = 1_000;
export const botStatMetric = (level: string, key: BotStatKey) => `bt_${level}_${key}`;

type Metric = AcademyMetric | RefillMetric | HandNoteMetric | SettingsMetric | TimeBankMetric;

/** Markers on day 0: the first day with activity markers, and the last day rolled up. */
export const STATS_MARKER_DAY = 0;

/** Marks the member active on the day of `at` (once per day: repeats change nothing). */
export function activeDayInsert(d1: D1Database, userId: string, at: number): D1PreparedStatement {
  return d1.prepare('INSERT OR IGNORE INTO active_days (day, user_id) VALUES (?1, ?2)').bind(statsDay(at), userId);
}

/** One statement per counter: adds `n` to the day's row. */
export function statsIncrements(d1: D1Database, day: number, counts: Partial<Record<Metric, number>>): D1PreparedStatement[] {
  return Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([metric, n]) =>
      d1.prepare('INSERT INTO daily_stats (day, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (day, metric) DO UPDATE SET n = n + excluded.n').bind(day, metric, n),
    );
}

/**
 * Like statsIncrements, for counters that come with a hand record: each adds only while hand `handId` is not recorded
 * yet, so it must run in the batch before the hand's INSERT (a record written again adds nothing).
 */
export function handStatsIncrements(d1: D1Database, day: number, handId: string, counts: Partial<Record<TimeBankMetric, number>>): D1PreparedStatement[] {
  return Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([metric, n]) =>
      d1
        .prepare(
          'INSERT INTO daily_stats (day, metric, n) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM hands WHERE id = ?4) ON CONFLICT (day, metric) DO UPDATE SET n = n + excluded.n',
        )
        .bind(day, metric, n, handId),
    );
}

/** Like handStatsIncrements for the bots' counters (`bt_*`, any number of them), in one statement. */
export function botStatsIncrement(d1: D1Database, day: number, handId: string, counts: Record<string, number>): D1PreparedStatement[] {
  const rows = Object.entries(counts).filter(([m, n]) => m.startsWith('bt_') && Number.isInteger(n) && n > 0);
  if (!rows.length) return [];
  return [
    d1
      .prepare(
        `INSERT INTO daily_stats (day, metric, n) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)
          WHERE NOT EXISTS (SELECT 1 FROM hands WHERE id = ?3) ON CONFLICT (day, metric) DO UPDATE SET n = n + excluded.n`,
      )
      .bind(day, JSON.stringify(rows), handId),
  ];
}
