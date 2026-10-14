import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { fail } from './http';

/**
 * Fixed-window counter stored in D1 (single atomic upsert per check).
 * Throws 429 when `limit` is exceeded within `windowMs`.
 */
export async function rateLimit(c: Context<AppEnv>, bucket: string, limit: number, windowMs: number, opts: { perIp?: boolean } = {}) {
  // Local test runs share one client IP; RATE_LIMIT_IP_SCALE relaxes only IP-keyed buckets there.
  if (opts.perIp) limit *= Math.max(1, Number(c.env.RATE_LIMIT_IP_SCALE ?? 1) || 1);
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const key = `${bucket}`;
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    c.header('Retry-After', String(Math.ceil((windowStart + windowMs - now) / 1000)));
    fail(429, 'rate_limited', 'too many requests');
  }
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'local';
}
