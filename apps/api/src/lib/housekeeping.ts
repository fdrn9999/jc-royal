import { ACTIVE_DAYS_MAX_RETENTION, ACTIVE_DAYS_RETENTION, OPS_RETENTION_MS, REALTIME_OUTBOX_RETENTION_MS, STATS_DAY, STATS_TZ_OFFSET_MS, statsDay, streakAchievements } from '@jc/db';
import { OPS_LOG_RETENTION_MS } from '@jc/types';

/** Push outbox rows (sent, skipped, failed or expired; never what a push said) are kept this long, for the dedupe keys and the hourly cap. */
export const PUSH_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
  const [achievements, sessions, passwordResets, emailVerifications, rateLimits, opsMetrics, activeDays, pushEvents, pushDevices, realtimeEvents, inbox, opsEvents, opsAlerts] = await db.batch([
    // Not a clean-up: the seven-days-in-a-row achievement (docs/SOCIAL.md), read from active_days before any are deleted.
    streakAchievements(db, STATS_DAY, STATS_TZ_OFFSET_MS),
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
    // The push outbox: every event, a week after it happened (a pending one has long expired by then).
    db.prepare('DELETE FROM notification_events WHERE created_at < ?1').bind(now - PUSH_EVENT_RETENTION_MS),
    // Browsers registered in a sign-in that no longer exists (the sessions deleted above included): their endpoint and keys go.
    db.prepare('DELETE FROM push_subscriptions WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = push_subscriptions.session_id)'),
    // The realtime outbox (member ids and event types, never a message's text): a few days after it was done; a row
    // still pending that long after it was written expired long ago (the minute cron gives those up after 30 minutes).
    db.prepare('DELETE FROM realtime_outbox WHERE done_at < ?1 OR created_at < ?1').bind(now - REALTIME_OUTBOX_RETENTION_MS),
    // The notification inbox: an item past its time (30 days after it last happened, account security 90), read or
    // not, and the read markers of notices (kept as long as a notice can be listed).
    db.prepare('DELETE FROM notifications WHERE expires_at < ?1').bind(now),
    // The control center's operations log (codes, table ids, counts; never a member's data or a reason's text) and the
    // alerts resolved: OPS_LOG_RETENTION_MS. A sighting the next check never confirmed is gone by then anyway; one left
    // by a check that stopped running goes after a day.
    db.prepare('DELETE FROM ops_events WHERE at < ?1').bind(now - OPS_LOG_RETENTION_MS),
    db.prepare('DELETE FROM ops_alerts WHERE resolved_at < ?1 OR (confirmed_at IS NULL AND first_seen_at < ?2)').bind(now - OPS_LOG_RETENTION_MS, now - 24 * 60 * 60_000),
  ]);
  return {
    achievements: achievements!.meta.changes,
    sessions: sessions!.meta.changes,
    passwordResets: passwordResets!.meta.changes,
    emailVerifications: emailVerifications!.meta.changes,
    rateLimits: rateLimits!.meta.changes,
    opsMetrics: opsMetrics!.meta.changes,
    activeDays: activeDays!.meta.changes,
    pushEvents: pushEvents!.meta.changes,
    pushDevices: pushDevices!.meta.changes,
    realtimeEvents: realtimeEvents!.meta.changes,
    inbox: inbox!.meta.changes,
    opsEvents: opsEvents!.meta.changes,
    opsAlerts: opsAlerts!.meta.changes,
  };
}
