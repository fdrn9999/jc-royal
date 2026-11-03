/**
 * Korean days (UTC+9, no daylight saving), as the statistics (stats.ts) and challenges (challengesSql.ts) count them:
 * day number `d` runs from `dayStart(d)` to `dayStart(d + 1)`, and the UTC date of `d * STATS_DAY` is its Korean date.
 * Apart from stats.ts, which binds D1, so the tests can use them on node:sqlite.
 */
export const STATS_TZ_OFFSET_MS = 9 * 60 * 60_000;
export const STATS_DAY = 86_400_000;

export const statsDay = (at: number) => Math.floor((at + STATS_TZ_OFFSET_MS) / STATS_DAY);
export const dayStart = (day: number) => day * STATS_DAY - STATS_TZ_OFFSET_MS;
