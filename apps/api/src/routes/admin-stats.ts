/**
 * Operations statistics by day, week and month (lib/stats.ts): aggregate numbers only, no member is named. Days are
 * rolled up by the daily cron; if the page is opened before that ran (or after it failed), the missing days are rolled
 * up first, one chunk at a time, so the page never waits on more than ROLLUP_CHUNK_DAYS days.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { fail } from '../lib/http';
import { operationsStats, rollup, STATS_UNITS, type StatsUnit } from '../lib/stats';

/** Mounted inside the admin router (requireAdmin and the permission rules already applied). */
export const adminStatsRoutes = new Hono<AppEnv>().get('/stats', async (c) => {
  const unit = (c.req.query('unit') ?? 'day') as StatsUnit;
  const limits = STATS_UNITS[unit];
  if (!limits || !Object.hasOwn(STATS_UNITS, unit)) fail(400, 'invalid_input', 'unit must be day, week or month');
  const asked = c.req.query('n');
  const n = asked === undefined ? limits.default : Math.trunc(Number(asked));
  if (!Number.isFinite(n) || n < 1 || n > limits.max) fail(400, 'invalid_input', `n must be 1 to ${limits.max} for ${unit}`);
  const at = Date.now();
  let rolled: { days: number; behind: number } | { failed: true } | null = null;
  try {
    const r = await rollup(c.env.DB, { now: at, maxChunks: 1 });
    if (r.spans.length) rolled = { days: r.spans.reduce((s, x) => s + x.to - x.from + 1, 0), behind: r.behind };
  } catch (e) {
    // The page still shows what was rolled up before; it says the latest days are missing.
    console.error('stats rollup failed', e instanceof Error ? e.message : String(e));
    rolled = { failed: true };
  }
  const out = await operationsStats(c.env.DB, unit, n, at);
  return c.json({ ...out, rolled, at, d1Ms: Date.now() - at });
});
