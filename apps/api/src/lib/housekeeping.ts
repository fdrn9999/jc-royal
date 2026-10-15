import { ACTIVE_DAYS_MAX_RETENTION, ACTIVE_DAYS_RETENTION, OPS_RETENTION_MS, statsDay } from '@jc/db';

/**
 * Daily clean-up of rows that are only needed for a short time, run by the cron trigger in wrangler.jsonc (the
 * `scheduled` handler in index.ts). Every delete is bounded by a time that is at least a day in the past, so a live
 * session, a pending code or reset link, or a current rate-limit window is never touched. What is kept and why is in
 * docs/PRIVACY_OPERATIONS.md.
 */
export const HOUSEKEEPING_GRACE_MS = 24 * 60 * 60_000;

export async function housekeeping(db: D1Database, now = Date.now()) {
  const before = now - HOUSEKEEPING_GRACE_MS;
  const today = statsDay(now);
  const [sessions, passwordResets, emailVerifications, rateLimits, opsMetrics, activeDays] = await db.batch([
    // Signed-out, idle-expired and remember-me sessions that ran out: their IP and User-Agent go with them.
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(before),
    // Reset links last 30 minutes, used or not.
    db.prepare('DELETE FROM password_resets WHERE expires_at < ?1').bind(before),
    // Sign-up codes that never became an account (the address and the code hash).
    db.prepare('DELETE FROM email_verifications WHERE expires_at < ?1').bind(before),
    // Counters keyed by address, IP or member id; the longest window is an hour.
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(before),
    // Per-minute operations counters (no member data) for the admin dashboard.
    db.prepare('DELETE FROM ops_metrics WHERE bucket < ?1').bind(now - OPS_RETENTION_MS),
    // Days on which a member was active (stats.ts): older than ACTIVE_DAYS_RETENTION days, unless the statistics rollup
    // has fallen behind and still needs them for 30-day counts (rolled_through - 29); never older than
    // ACTIVE_DAYS_MAX_RETENTION days. With no rollup yet, the longest limit applies.
    db
      .prepare(
        `DELETE FROM active_days WHERE day < MAX(?2, MIN(?1, COALESCE((SELECT n - 29 FROM daily_stats WHERE day = 0 AND metric = 'rolled_through'), ?2)))`
      )
      .bind(today - ACTIVE_DAYS_RETENTION, today - ACTIVE_DAYS_MAX_RETENTION),
  ]);
  return {
    sessions: sessions!.meta.changes,
    passwordResets: passwordResets!.meta.changes,
    emailVerifications: emailVerifications!.meta.changes,
    rateLimits: rateLimits!.meta.changes,
    opsMetrics: opsMetrics!.meta.changes,
    activeDays: activeDays!.meta.changes,
  };
}
