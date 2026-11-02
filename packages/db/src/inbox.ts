/**
 * The notification inbox's rows (schema `notifications`, packages/types/src/inbox.ts): written in the batch of the change
 * an item reports, so the item is there exactly when the change is. The api reads them (apps/api/src/routes/inbox.ts).
 */
import type { OutboxGuard } from './realtime-outbox';

/** A member's own items (InboxKind in @jc/types without everyone's notice and maintenance). */
export type InboxRowKind =
  | 'friend_request'
  | 'friend_accepted'
  | 'dm'
  | 'invite'
  | 'friend_table'
  | 'message'
  | 'tournament_start'
  | 'tournament_cancel'
  | 'tournament_result'
  | 'vip'
  | 'security';

/** How long an item is kept after its last update (then the daily housekeeping deletes it, read or not). */
export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Account security items are kept longer, and the member cannot remove them earlier. */
export const INBOX_SECURITY_RETENTION_MS = 90 * 24 * 60 * 60_000;

export interface InboxRow {
  kind: InboxRowKind;
  /** The item's identity for the member: the same key again updates the item (see notifications in schema.ts). */
  key: string;
  actorId?: string | null;
  ref?: string | null;
  params?: Record<string, string | number | boolean | null> | null;
  now: number;
}

const expiry = (r: InboxRow) => r.now + (r.kind === 'security' ? INBOX_SECURITY_RETENTION_MS : INBOX_RETENTION_MS);

/**
 * The same key again: one more of it while unread (1 again once it was read), unread, the newest time, actor and facts.
 * SQLite needs a WHERE in an INSERT … SELECT before ON CONFLICT (else it reads ON as a join's), so there always is one.
 */
const UPSERT = `ON CONFLICT (user_id, key) DO UPDATE SET
      count = CASE WHEN notifications.read_at IS NULL THEN notifications.count + 1 ELSE 1 END,
      actor_id = excluded.actor_id, ref = excluded.ref, params = excluded.params,
      updated_at = excluded.updated_at, read_at = NULL, expires_at = excluded.expires_at`;

const values = (r: InboxRow) => [r.kind, r.key, r.actorId ?? null, r.ref ?? null, r.params ? JSON.stringify(r.params) : null, r.now, expiry(r)] as const;

/**
 * One member's item, for the batch of the change it reports; `guard`: written only when it holds (IF_CHANGED: the
 * statement right before it changed a row). `meta.changes` is 1 when it was written.
 */
export function inboxStatement(d1: D1Database, userId: string, row: InboxRow, guard?: OutboxGuard): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, key, actor_id, ref, params, count, created_at, updated_at, read_at, expires_at)
       SELECT lower(hex(randomblob(16))), ?8, ?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, NULL, ?7 WHERE (${guard?.sql ?? '1'})
       ${UPSERT}`,
    )
    .bind(...values(row), userId, ...(guard?.params ?? []));
}

/**
 * The item for every member a query in the batch finds (`members`: one `user_id` column, run after the change, its
 * values numbered after the row's): the entrants of a tournament, the recipients of a message.
 */
export function inboxForMembers(d1: D1Database, row: InboxRow, members: OutboxGuard): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, key, actor_id, ref, params, count, created_at, updated_at, read_at, expires_at)
       SELECT lower(hex(randomblob(16))), m.user_id, ?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, NULL, ?7 FROM (${members.sql}) m WHERE m.user_id IS NOT NULL
       ${UPSERT}`,
    )
    .bind(...values(row), ...(members.params ?? []));
}

/**
 * The member's items with these keys are read: the thing they are about was opened or answered where it lives (the
 * conversation, the request); `guard`: only when it holds (nothing unread left there).
 */
export function inboxReadStatement(d1: D1Database, userId: string, keys: readonly string[], now: number, guard?: OutboxGuard): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL AND key IN (${keys.map((_, i) => `?${i + 3}`).join(', ')})${guard ? ` AND (${guard.sql})` : ''}`,
    )
    .bind(userId, now, ...keys, ...(guard?.params ?? []));
}

/** The row for a Drizzle batch (`db.insert(schema.notifications).values(...)`), unconditional: an item with a key of its own. */
export function inboxValues(userId: string, row: InboxRow) {
  const [kind, key, actorId, ref, params, now, expiresAt] = values(row);
  return { id: crypto.randomUUID(), userId, kind, key, actorId, ref, params, count: 1, createdAt: now, updatedAt: now, readAt: null, expiresAt };
}
