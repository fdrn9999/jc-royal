/**
 * The realtime outbox's rows (schema `realtime_outbox`): written in the batch of the change an event reports, sent by
 * the api after the commit and again by its minute cron while a hub did not take it (apps/api/src/lib/realtime.ts).
 */

/** The first send is the api's own, right after the commit: the cron leaves a row alone this long before it retries. */
export const REALTIME_OUTBOX_GRACE_MS = 20_000;
/** After this an event not delivered yet is dropped: the pages have read again on their own by then (poll, reconnect). */
export const REALTIME_OUTBOX_TTL_MS = 30 * 60_000;
/** Sends before one is given up (status failed). */
export const REALTIME_OUTBOX_MAX_ATTEMPTS = 6;
/** Wait after the nth failed send (the last value repeats). */
export const REALTIME_OUTBOX_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
/** How long rows that are done (sent, failed, expired) are kept for the control center, then deleted. */
export const REALTIME_OUTBOX_RETENTION_MS = 3 * 24 * 60 * 60_000;

/** An SQL condition with its own `?` parameters (numbered after the statement's). */
export interface OutboxGuard {
  sql: string;
  params?: unknown[];
}

/** Write the row only when the statement right before it in the same batch changed a row (the change happened). */
export const IF_CHANGED: OutboxGuard = { sql: 'changes() > 0' };

export interface RealtimeOutboxRow {
  /** The event's eventId. */
  id: string;
  type: string;
  /** Members (a personal event), or null: every hub. */
  users: readonly string[] | null;
  /** The event as sent (JSON-serialisable). */
  event: { eventId: string; occurredAt: number; type: string };
  now: number;
}

const values = (row: RealtimeOutboxRow) =>
  [
    row.id,
    row.type,
    row.users ? JSON.stringify([...new Set(row.users)]) : null,
    JSON.stringify(row.event),
    row.now + REALTIME_OUTBOX_GRACE_MS,
    row.now + REALTIME_OUTBOX_TTL_MS,
    row.now,
  ] as const;

/**
 * A number of the event that the change's own statement makes (a message's seq): read in the batch, after it, and set
 * at `path` (a fixed `$.a.b` path) of the event the row stores. The caller sets the same value on the event it sends.
 */
export interface OutboxFill {
  path: string;
  sql: string;
  params?: unknown[];
}

/**
 * The row's INSERT, for the batch of the change it reports; `guard`: written only when it holds; `fill`: a value of the
 * event read in the batch.
 */
export function realtimeOutboxStatement(d1: D1Database, row: RealtimeOutboxRow, guard?: OutboxGuard, fill?: OutboxFill): D1PreparedStatement {
  if (fill && !/^\$(\.[A-Za-z]+)+$/.test(fill.path)) throw new Error(`bad outbox fill path ${fill.path}`);
  const event = fill ? `json_set(?4, '${fill.path}', (${fill.sql}))` : '?4';
  // The event last: a plain `?` is numbered one past the largest number written before it, so the fill's and the guard's
  // come after ?7 only once every numbered one is behind them.
  return d1
    .prepare(
      `INSERT INTO realtime_outbox (id, type, recipients, status, attempts, next_attempt_at, expires_at, created_at, event)
       SELECT ?1, ?2, ?3, 'pending', 0, ?5, ?6, ?7, ${event}${guard ? ` WHERE (${guard.sql})` : ''}`,
    )
    .bind(...values(row), ...(fill?.params ?? []), ...(guard?.params ?? []));
}

/**
 * The row's INSERT with its members read in the batch, for a change whose members the statements choose (every entry of
 * a tournament, the reporters of a closed report): `members`, a query of one `user_id` column, run after the change.
 * Written only when it finds one; the row's own `users` are not stored (the caller sends the ones its change returned).
 */
export function realtimeOutboxForMembers(d1: D1Database, row: RealtimeOutboxRow, members: OutboxGuard): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO realtime_outbox (id, type, recipients, event, status, attempts, next_attempt_at, expires_at, created_at)
       SELECT ?1, ?2, m.users, ?4, 'pending', 0, ?5, ?6, ?7
         FROM (SELECT json_group_array(user_id) AS users, COUNT(*) AS n FROM (${members.sql})) m WHERE m.n > 0`,
    )
    .bind(...values(row), ...(members.params ?? []));
}

/**
 * The row for a Drizzle batch, unconditional: `db.insert(schema.realtimeOutbox).values(...)` among its queries (a raw
 * `db.run(sql)` with values cannot go in one: drizzle-orm's D1 batch binds them on a statement it does not have).
 */
export function realtimeOutboxValues(row: RealtimeOutboxRow) {
  const [id, type, recipients, event, nextAttemptAt, expiresAt, createdAt] = values(row);
  return { id, type, recipients, event, status: 'pending' as const, attempts: 0, nextAttemptAt, expiresAt, createdAt };
}

/** When a row whose send failed `attempts` times is tried again. */
export const realtimeOutboxRetryAt = (attempts: number, now: number) =>
  now + REALTIME_OUTBOX_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), REALTIME_OUTBOX_BACKOFF_MS.length - 1)]!;
