/**
 * The push outbox (notification_events), written by the api and the game worker after the action a push reports has
 * been committed, never in the same batch: a push that can't be queued never undoes the action (the caller logs it).
 * A row is written only for a member who has service consent and the type on and has a browser registered, so members
 * who never turned pushes on cost nothing. At night in Korea (`night`, judged by the caller on the server's clock) only
 * members with night consent at that moment get a row, so night consent given later never reaches back to an event of
 * the night. Everything is checked again when it is sent (apps/api/src/lib/notify.ts).
 * `dedupe_key` makes each event once, however often it is written.
 */

export type OutboxType = 'dm' | 'invite' | 'friend_request' | 'friend_accepted' | 'tournament_start' | 'tournament_cancel' | 'tournament_result';

/** After this an event that could not be sent yet is dropped (a late push is worse than none). */
export const OUTBOX_TTL_MS: Record<OutboxType, number> = {
  dm: 60 * 60_000,
  invite: 30 * 60_000,
  friend_request: 6 * 3_600_000,
  friend_accepted: 6 * 3_600_000,
  tournament_start: 15 * 60_000,
  tournament_cancel: 6 * 3_600_000,
  tournament_result: 6 * 3_600_000,
};

/** The notification_settings column switching each type (fixed names: they are written into the SQL). */
const COLUMN: Record<OutboxType, string> = {
  dm: 'dm',
  invite: 'invite',
  friend_request: 'friend_request',
  friend_accepted: 'friend_accepted',
  tournament_start: 'tournament_start',
  tournament_cancel: 'tournament_cancel',
  tournament_result: 'tournament_result',
};

/** The member (an SQL expression) wants this type now (at night: with night consent) and has a browser that may get it. */
function wants(user: string, type: OutboxType, night: boolean): string {
  return `EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = ${user} AND ns.service = 1 AND ns.${COLUMN[type]} = 1${night ? ' AND ns.night = 1' : ''})
      AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = ${user} AND ps.disabled_at IS NULL)`;
}

export interface OutboxOne {
  dedupeKey: string;
  userId: string;
  type: OutboxType;
  /** An internal path ("/friends/…"). */
  url: string;
  coalesceKey?: string | null;
  now: number;
  /** `now` is night in Korea (isKstNight in @jc/types). */
  night: boolean;
}

/** One member's event. `meta.changes` is 1 when it was queued (0: not wanted, or already queued). */
export function outboxOne(d1: D1Database, e: OutboxOne): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT OR IGNORE INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, expires_at, created_at)
       SELECT lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?6
        WHERE ${wants('?2', e.type, e.night)}`,
    )
    .bind(e.dedupeKey, e.userId, e.type, e.url, e.coalesceKey ?? null, e.now, e.now + OUTBOX_TTL_MS[e.type]);
}

export interface OutboxEntries {
  tournamentId: string;
  type: 'tournament_start' | 'tournament_cancel' | 'tournament_result';
  /** tournament_entries statuses that get it. */
  statuses: readonly string[];
  /** The dedupe key is `<prefix>:<tournament>:<member>`. */
  prefix: string;
  url: string;
  /** The change it is for, as a condition on `tournaments tn` (nothing is queued without it). */
  guard: string;
  now: number;
  /** `now` is night in Korea (isKstNight in @jc/types). */
  night: boolean;
}

/** The event for every member of a tournament in the given entry states (members only: bots have no settings). */
export function outboxForEntries(d1: D1Database, e: OutboxEntries): D1PreparedStatement {
  const statuses = e.statuses.filter((s) => /^[a-z]+$/.test(s)).map((s) => `'${s}'`).join(', ');
  return d1
    .prepare(
      `INSERT OR IGNORE INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, expires_at, created_at)
       SELECT lower(hex(randomblob(16))), ?2 || ':' || ?1 || ':' || e.user_id, e.user_id, ?3, ?4, ?2 || ':' || ?1, 'pending', 0, ?5, ?6, ?5
         FROM tournament_entries e JOIN users u ON u.id = e.user_id
        WHERE e.tournament_id = ?1 AND e.status IN (${statuses || "''"}) AND u.status = 'active' AND u.is_bot = 0
          AND ${wants('e.user_id', e.type, e.night)}
          AND EXISTS (SELECT 1 FROM tournaments tn WHERE tn.id = ?1 AND ${e.guard})`,
    )
    .bind(e.tournamentId, e.prefix, e.type, e.url, e.now, e.now + OUTBOX_TTL_MS[e.type]);
}
