import { INBOX_RETENTION_MS, INBOX_SECURITY_RETENTION_MS } from '@jc/db';
import {
  INBOX_FILTERS,
  INBOX_INVITE_TTL_MS,
  INBOX_KINDS,
  shownVip,
  type InboxFilter,
  type InboxItemDto,
  type InboxKind,
  type InboxState,
} from '@jc/types';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { realtimeToUsers } from './realtime';

/**
 * The notification inbox as the member reads it (packages/types/src/inbox.ts): their own rows of `notifications`, and
 * items read from where the thing already lives, each with the read marker the member left on it (a row of the same
 * table whose key is the item's id):
 * - the personal messages (쪽지) of the last 30 days, as one item: unread while one arrived after the marker and is unread;
 * - a tournament's start, cancel or abort, which is a system message (lib/tournament.ts tournamentNotice): that message;
 *   reading the item reads the message;
 * - service notices of the last 30 days that have started, and maintenance windows announced in the last 30 days. One
 *   that last changed before the member joined is listed read: it is not news to them (a window called off before they
 *   ever heard of it, a notice the banner already shows).
 *
 * `?1` the member, `?2` now. Columns: id, kind, cnt, at, readAt, actorId, ref, params (JSON text).
 */
const DAYS30 = INBOX_RETENTION_MS;

/** A personal message's id of a tournament notice: `tn:<tournament>:<started|cancelled|aborted>:<member>`. */
const TN_TID = `substr(m.id, 4, instr(substr(m.id, 4), ':') - 1)`;
const TN_KIND = `substr(m.id, 5 + length(${TN_TID}), instr(substr(m.id, 5 + length(${TN_TID})), ':') - 1)`;

/** A public item is unread when it changed after the member's marker (or there is none) and after they joined. */
const JOINED = `(SELECT created_at FROM users WHERE id = ?1)`;
const markerRead = (at: string) => `CASE WHEN k.read_at >= ${at} THEN k.read_at WHEN ${at} <= ${JOINED} THEN ${JOINED} END`;

export const INBOX_UNION_SQL = `
  SELECT n.id, n.kind, n.count AS cnt, n.updated_at AS at, n.read_at AS readAt, n.actor_id AS actorId, n.ref, n.params
    FROM notifications n
   WHERE n.user_id = ?1 AND n.expires_at > ?2 AND n.kind NOT IN ('message', 'notice', 'maintenance')
     AND (n.kind != 'dm' OR (SELECT dm_notifications FROM users WHERE id = ?1))
     AND (n.actor_id IS NULL OR (EXISTS (SELECT 1 FROM users a WHERE a.id = n.actor_id AND a.status != 'deleted')
          AND NOT EXISTS (SELECT 1 FROM user_blocks b JOIN users bu ON bu.id = b.blocked_id AND bu.role = 'user' WHERE b.blocker_id = ?1 AND b.blocked_id = n.actor_id)))
  UNION ALL
  SELECT m.id, CASE ${TN_KIND} WHEN 'started' THEN 'tournament_start' ELSE 'tournament_cancel' END, 1, m.created_at, m.read_at, NULL, ${TN_TID},
         json_object('name', (SELECT name FROM tournaments WHERE id = ${TN_TID}), 'aborted', json(CASE ${TN_KIND} WHEN 'aborted' THEN 'true' ELSE 'false' END))
    FROM messages m
   WHERE m.user_id = ?1 AND m.id LIKE 'tn:%' AND m.deleted_at IS NULL AND m.created_at > ?2 - ${DAYS30}
  UNION ALL
  SELECT 'message', 'message', MAX(1, SUM(m.read_at IS NULL AND m.created_at > COALESCE(k.read_at, 0))), MAX(m.created_at),
         CASE WHEN SUM(m.read_at IS NULL AND m.created_at > COALESCE(k.read_at, 0)) > 0 THEN NULL ELSE COALESCE(MAX(k.read_at), MAX(m.read_at), MAX(m.created_at)) END,
         NULL, NULL, NULL
    FROM messages m LEFT JOIN notifications k ON k.user_id = ?1 AND k.key = 'message'
   WHERE m.user_id = ?1 AND m.id NOT LIKE 'tn:%' AND m.deleted_at IS NULL AND m.created_at > ?2 - ${DAYS30}
   GROUP BY m.user_id
  UNION ALL
  SELECT 'notice:' || s.id, 'notice', 1, MAX(s.starts_at, s.updated_at), ${markerRead('MAX(s.starts_at, s.updated_at)')}, NULL, s.id,
         json_object('titleKo', s.title_ko, 'titleEn', s.title_en, 'urgent', json(CASE s.kind WHEN 'urgent' THEN 'true' ELSE 'false' END), 'postId', s.post_id, 'endsAt', s.ends_at)
    FROM service_notices s LEFT JOIN notifications k ON k.user_id = ?1 AND k.key = 'notice:' || s.id
   WHERE s.deleted_at IS NULL AND s.starts_at <= ?2 AND s.starts_at > ?2 - ${DAYS30}
  UNION ALL
  SELECT 'maintenance:' || w.id, 'maintenance', 1, w.at, ${markerRead('w.at')}, NULL, w.id,
         json_object('startsAt', w.starts_at, 'endsAt', w.ends_at, 'blockLogin', json(CASE WHEN w.block_login THEN 'true' ELSE 'false' END),
                     'endedAt', w.ended_at, 'cancelledAt', w.cancelled_at)
    FROM (SELECT *, MAX(updated_at, CASE WHEN starts_at <= ?2 THEN starts_at ELSE 0 END, COALESCE(ended_at, 0)) AS at FROM maintenance_windows WHERE created_at > ?2 - ${DAYS30}) w
    LEFT JOIN notifications k ON k.user_id = ?1 AND k.key = 'maintenance:' || w.id`;

/** Unread items in total (all filters): `?1` the member, `?2` now. */
export const INBOX_UNREAD_SQL = `(SELECT COUNT(*) FROM (${INBOX_UNION_SQL}) WHERE readAt IS NULL)`;

/** What the list shows of a thing that can be answered or can end, read with the page. */
const STATE_SQL = `CASE x.kind
    WHEN 'friend_request' THEN COALESCE(
      (SELECT CASE f.status WHEN 'pending' THEN 'open' ELSE 'done' END FROM friendships f
        WHERE f.user_a = MIN(?1, x.actorId) AND f.user_b = MAX(?1, x.actorId) AND (f.status = 'accepted' OR f.requester_id = x.actorId)), 'expired')
    WHEN 'invite' THEN CASE WHEN x.at > ?2 - ${INBOX_INVITE_TTL_MS} AND EXISTS (SELECT 1 FROM tables t WHERE t.id = x.ref AND t.status = 'open' AND t.entry_blocked = 0) THEN 'open' ELSE 'expired' END
    WHEN 'tournament_start' THEN COALESCE((SELECT CASE status WHEN 'running' THEN 'open' ELSE 'done' END FROM tournaments WHERE id = x.ref), 'expired')
    WHEN 'tournament_invite' THEN COALESCE((SELECT CASE
        WHEN EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.user_id = ?1 AND e.status NOT IN ('unregistered', 'dropped')) THEN 'done'
        WHEN t.status = 'registering' AND (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'registered') < t.capacity THEN 'open'
        ELSE 'expired' END FROM tournaments t WHERE t.id = x.ref), 'expired')
    WHEN 'friend_table' THEN CASE WHEN x.at > ?2 - ${INBOX_INVITE_TTL_MS}
      AND EXISTS (SELECT 1 FROM tables t WHERE t.id = x.ref AND t.status = 'open' AND t.entry_blocked = 0 AND t.is_private = 0)
      AND EXISTS (SELECT 1 FROM table_sessions s WHERE s.table_id = x.ref AND s.user_id = x.actorId AND s.status = 'seated')
      AND EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = MIN(?1, x.actorId) AND f.user_b = MAX(?1, x.actorId) AND f.status = 'accepted')
      THEN 'open' ELSE 'expired' END
  END`;

export interface InboxRowOut {
  id: string;
  kind: InboxKind;
  cnt: number;
  at: number;
  readAt: number | null;
  actorId: string | null;
  ref: string | null;
  params: string | null;
  state: InboxState | null;
  place: number | null;
  tname: string | null;
  nickname: string | null;
  role: string | null;
  status: string | null;
  isBot: number | null;
  vipColor: string | null;
}

export interface InboxQuery {
  filter?: InboxFilter;
  unread?: boolean;
  before?: { at: number; id: string };
  limit: number;
}

/** One page of the list, newest first (by when it last happened, then id), one more than `limit` to tell there is more. */
export function inboxPage(d1: D1Database, userId: string, now: number, q: InboxQuery): D1PreparedStatement {
  const kinds = q.filter ? INBOX_FILTERS[q.filter] : INBOX_KINDS;
  const where = [`x.kind IN (${kinds.map((k) => `'${k}'`).join(', ')})`];
  if (q.unread) where.push('x.readAt IS NULL');
  // Always written, so the statement takes the four values it is bound (0: the first page).
  where.push('(?3 = 0 OR x.at < ?3 OR (x.at = ?3 AND x.id < ?4))');
  return d1
    .prepare(
      `SELECT x.*, ${STATE_SQL} AS state,
              CASE x.kind WHEN 'tournament_result' THEN (SELECT place FROM tournament_entries WHERE tournament_id = x.ref AND user_id = ?1) END AS place,
              CASE x.kind WHEN 'tournament_result' THEN (SELECT name FROM tournaments WHERE id = x.ref) END AS tname,
              a.nickname, a.role, a.status, a.is_bot AS isBot, a.vip_color AS vipColor
         FROM (${INBOX_UNION_SQL}) x LEFT JOIN users a ON a.id = x.actorId
        WHERE ${where.join(' AND ')}
        ORDER BY x.at DESC, x.id DESC LIMIT ${q.limit + 1}`,
    )
    .bind(userId, now, q.before?.at ?? 0, q.before?.id ?? '');
}

/** Where an item opens on the member site. */
function hrefOf(r: InboxRowOut, params: InboxItemDto['params']): string | null {
  switch (r.kind) {
    case 'friend_request':
      return '/friends';
    case 'friend_accepted':
    case 'dm':
    case 'invite':
      return r.actorId ? `/friends/${r.actorId}` : '/friends';
    case 'friend_table':
      return r.ref ? `/table/${r.ref}` : null;
    case 'message':
      return '/messages';
    case 'tournament_start':
    case 'tournament_cancel':
    case 'tournament_result':
    case 'tournament_invite':
      return r.ref ? `/tournaments/${r.ref}` : '/tournaments';
    case 'vip':
    case 'security':
      return '/me';
    case 'notice':
      return typeof params.postId === 'string' ? `/board/${params.postId}` : null;
    case 'maintenance':
      return null;
  }
}

function maintenanceState(p: InboxItemDto['params'], now: number): InboxState {
  if (p.cancelledAt) return 'expired';
  if (p.endedAt || (typeof p.endsAt === 'number' && p.endsAt <= now)) return 'done';
  return 'open';
}

export function toInboxItem(r: InboxRowOut, now: number): InboxItemDto {
  let params: InboxItemDto['params'] = {};
  try {
    const p: unknown = r.params ? JSON.parse(r.params) : {};
    if (p && typeof p === 'object' && !Array.isArray(p)) params = p as InboxItemDto['params'];
  } catch {
    params = {};
  }
  if (r.kind === 'tournament_result') params = { ...params, name: r.tname ?? null, place: r.place ?? null };
  const vip = r.actorId ? shownVip({ role: r.role, status: r.status, isBot: r.isBot, vipColor: r.vipColor }) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    count: r.cnt,
    at: r.at,
    readAt: r.readAt,
    actor: r.actorId && r.nickname ? { id: r.actorId, nickname: r.nickname, ...(vip ? { vip } : {}) } : null,
    params,
    state: r.kind === 'maintenance' ? maintenanceState(params, now) : (r.state ?? null),
    href: hrefOf(r, params),
  };
}

/** The read marker of an item read from elsewhere: kept as long as the item can be listed. */
export const markerExpiry = (now: number) => now + DAYS30;

/**
 * Marks these items read (ids as the list gave them, already checked to be the member's own by reading them back):
 * rows by id, the 쪽지 item and notices by their marker, a tournament notice by its message. Statements for one batch.
 */
export function inboxMarkRead(d1: D1Database, userId: string, items: readonly Pick<InboxItemDto, 'id' | 'kind' | 'at'>[], now: number): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  // D1 caps bound parameters per statement: ids go 90 to a statement.
  const byIds = (table: 'notifications' | 'messages', ids: string[]) => {
    for (let s = 0; s < ids.length; s += 90) {
      const chunk = ids.slice(s, s + 90);
      out.push(
        d1
          .prepare(`UPDATE ${table} SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL AND id IN (${chunk.map((_, i) => `?${i + 3}`).join(', ')})`)
          .bind(userId, now, ...chunk),
      );
    }
  };
  byIds('notifications', items.filter((i) => !VIRTUAL.has(i.kind)).map((i) => i.id));
  byIds('messages', items.filter((i) => i.kind === 'tournament_start' || i.kind === 'tournament_cancel').map((i) => i.id));
  for (const i of items) {
    if (i.kind !== 'message' && i.kind !== 'notice' && i.kind !== 'maintenance') continue;
    // The marker's time is now: an item changed later than this is unread again.
    out.push(
      d1
        .prepare(
          `INSERT INTO notifications (id, user_id, kind, key, ref, count, created_at, updated_at, read_at, expires_at)
           VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, 1, ?5, ?5, ?5, ?6)
           ON CONFLICT (user_id, key) DO UPDATE SET read_at = excluded.read_at, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        )
        .bind(userId, i.kind, i.id, i.kind === 'message' ? null : i.id.slice(i.id.indexOf(':') + 1), now, markerExpiry(now)),
    );
  }
  return out;
}

/** Kinds listed from elsewhere (not a row of their own in `notifications`). */
const VIRTUAL = new Set<InboxKind>(['message', 'notice', 'maintenance', 'tournament_start', 'tournament_cancel']);

/** A short label of the browser and system of a sign-in, from its user agent (never the address or anything finer). */
export function deviceLabel(ua: string | undefined | null): string {
  const s = ua ?? '';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /SamsungBrowser\//.test(s)
      ? 'Samsung Internet'
      : /Whale\//.test(s)
        ? 'Whale'
        : /OPR\//.test(s)
          ? 'Opera'
          : /Firefox\//.test(s)
            ? 'Firefox'
            : /Chrome\//.test(s)
              ? 'Chrome'
              : /Safari\//.test(s)
                ? 'Safari'
                : 'Other';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'Other';
  return `${browser} · ${os}`;
}

/**
 * A sign-in, as an account security item (one per browser and system, deviceLabel): unread when the account has no other
 * sign-in on that device now (`sessions`) and no item of it from the last 90 days; read when it has (a device it uses is
 * not news, and its first sign-in after this was deployed is not either). An item of the last 90 days is left as it was.
 * Written right after the session `sessionId` (a sign-in never fails for it; a failure is only logged). `known`: the
 * device is known (sign-up).
 */
export async function inboxSignIn(c: Context<AppEnv>, userId: string, sessionId: string, opts: { known?: boolean } = {}) {
  const now = Date.now();
  const device = deviceLabel(c.req.header('user-agent'));
  try {
    const others = await c.env.DB.prepare(`SELECT user_agent AS ua FROM sessions WHERE user_id = ?1 AND id != ?2 AND kind = 'user' AND expires_at > ?3`)
      .bind(userId, sessionId, now)
      .all<{ ua: string | null }>();
    const known = opts.known || others.results.some((s) => deviceLabel(s.ua) === device);
    const r = await c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, kind, key, params, count, created_at, updated_at, read_at, expires_at)
       VALUES (lower(hex(randomblob(16))), ?1, 'security', ?2, ?3, 1, ?4, ?4, ?5, ?6)
       ON CONFLICT (user_id, key) DO UPDATE SET count = 1, params = excluded.params, created_at = excluded.created_at,
         updated_at = excluded.updated_at, read_at = excluded.read_at, expires_at = excluded.expires_at
       WHERE notifications.expires_at <= excluded.created_at`,
    )
      .bind(userId, `security:signin:${device}`, JSON.stringify({ event: 'sign_in', device }), now, known ? now : null, now + INBOX_SECURITY_RETENTION_MS)
      .run();
    if (r.meta.changes && !known) realtimeToUsers(c, [userId], { scope: 'user', type: 'notification.changed' });
  } catch (e) {
    console.warn('inbox sign-in not saved', e instanceof Error ? e.message : String(e));
  }
}
