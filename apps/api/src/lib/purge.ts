/**
 * Permanent removal (영구 삭제) of the few records it is offered for (docs/ADMIN_SECURITY.md "영구 삭제"): an action of
 * its own beside the ordinary delete, which hides or marks a record deleted and can be undone. A super admin only
 * (`data.purge`), with the password confirmed, a reason and the target's short id typed; what goes and what stops it
 * is read from D1 as it is now, never taken from the console.
 *
 * - Offered (class B, conditional): a board post (its comments and hand links go with it), a closed table at which
 *   nothing ever happened, an archived tournament template no tournament was opened from. Each kind names what blocks
 *   it (an open report, a live notice, hands, sessions, ledger rows, …); one blocker and nothing is removed, the console
 *   says why and what to do instead. Rows that only point at the target (operations log, closed reports with their
 *   evidence, the audit log) stay and keep its id.
 * - Never (class C): members (a withdrawal anonymises), the chip ledger, hands, the audit log, reports and their events,
 *   reconciliation, refills, referrals, tournaments and their entries, policies.
 * - The preview returns the plan with a fingerprint of the state it read. The removal names that fingerprint: a target
 *   that changed meanwhile (a new comment, an edit, the template restored) is a conflict with the new plan.
 * - One D1 batch, so all of it or none: the audit row is written only where the state is still the planned one
 *   (INSERT … SELECT … WHERE), and each DELETE runs only where that row exists, children first (no ON DELETE CASCADE
 *   anywhere). A second removal of the same target finds it gone or changed; a failed batch leaves everything as it
 *   was, and the route's failure is recorded as `<action>.failed` (lib/audit.ts auditFailures).
 *
 * Counting a table's sessions, ledger rows and invites reads those tables whole (no index on their table id, and none
 * is added for an action this rare: the ledger is written on every buy-in).
 */
import { sha256 } from './crypto';

export const PURGE_KINDS = ['post', 'table', 'tournament_template'] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

/** What keeps the target from being removed, and how many rows of it there are. */
export interface PurgeBlocker {
  code: string;
  count: number;
}

export interface PurgePlan {
  kind: PurgeKind;
  id: string;
  /** The name an administrator knows it by. A post's title is shown in the console, never written to the audit log. */
  label: string;
  deletable: boolean;
  blockers: PurgeBlocker[];
  /** Rows removed, by table. */
  removes: Record<string, number>;
  /** Rows that point at it and stay. */
  keeps: Record<string, number>;
  fingerprint: string;
  /** What the administrator types to confirm: the id's first 8 characters. */
  confirmText: string;
}

type Sql = [sql: string, binds: unknown[]];

interface Read {
  label: string;
  /** What the fingerprint covers and the guard checks again. */
  state: Record<string, string | number | null>;
  blockers: PurgeBlocker[];
  removes: Record<string, number>;
  keeps: Record<string, number>;
  /** For the audit row: ids, times and sizes, never a title or a body. */
  facts: Record<string, unknown>;
  /** True while the target is as read and nothing blocks it. */
  guard: Sql;
  /** Children first. */
  deletes: Sql[];
}

const count = (r: D1Result | undefined) => Number((r?.results[0] as { n?: number } | undefined)?.n ?? 0);
const blockers = (list: [string, number][]): PurgeBlocker[] => list.filter(([, n]) => n > 0).map(([code, n]) => ({ code, count: n }));

/** A post's open reports: on the post itself or on one of its comments. */
const OPEN_REPORTS = `SELECT 1 FROM reports WHERE status = 'open' AND ((target_type = 'post' AND target_id = ?) OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)))`;

async function readPost(DB: D1Database, id: string): Promise<Read | null> {
  const [post, kids, links, open, closed, live, gone, logged] = await DB.batch([
    DB.prepare(`SELECT title, body, author_id AS authorId, status, is_notice AS isNotice, comment_count AS commentCount, created_at AS createdAt, updated_at AS updatedAt FROM posts WHERE id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS last FROM comments WHERE post_id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM post_hands WHERE post_id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM (${OPEN_REPORTS})`).bind(id, id),
    DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status != 'open' AND ((target_type = 'post' AND target_id = ?) OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)))`).bind(id, id),
    DB.prepare(`SELECT COUNT(*) AS n FROM service_notices WHERE post_id = ? AND deleted_at IS NULL`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM service_notices WHERE post_id = ? AND deleted_at IS NOT NULL`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE target_type = 'post' AND target_id = ?`).bind(id),
  ]);
  const p = post?.results[0] as { title: string; body: string; authorId: string; status: string; isNotice: number; commentCount: number; createdAt: number; updatedAt: number } | undefined;
  if (!p) return null;
  const k = kids?.results[0] as { n: number; last: number };
  const state = { status: p.status, updatedAt: p.updatedAt, commentCount: p.commentCount, comments: k.n, lastComment: k.last, hands: count(links) };
  return {
    label: p.title,
    state,
    blockers: blockers([
      ['open_reports', count(open)],
      ['live_notice', count(live)],
    ]),
    removes: { comments: k.n, post_hands: state.hands, posts: 1 },
    keeps: { reports: count(closed), service_notices: count(gone), admin_audit_log: count(logged) },
    facts: {
      authorId: p.authorId,
      status: p.status,
      isNotice: !!p.isNotice,
      createdAt: p.createdAt,
      // Which text went, without keeping it: the hash of the title and body, and their lengths.
      contentHash: await sha256(`${p.title}\n${p.body}`),
      titleLength: p.title.length,
      bodyLength: p.body.length,
    },
    guard: [
      `EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = ? AND updated_at = ? AND comment_count = ?)
       AND (SELECT COUNT(*) FROM comments WHERE post_id = ?) = ? AND (SELECT COALESCE(MAX(updated_at), 0) FROM comments WHERE post_id = ?) = ?
       AND (SELECT COUNT(*) FROM post_hands WHERE post_id = ?) = ?
       AND NOT EXISTS (${OPEN_REPORTS})
       AND NOT EXISTS (SELECT 1 FROM service_notices WHERE post_id = ? AND deleted_at IS NULL)`,
      [id, p.status, p.updatedAt, p.commentCount, id, k.n, id, k.last, id, state.hands, id, id, id],
    ],
    deletes: [
      [`DELETE FROM comments WHERE post_id = ?`, [id]],
      [`DELETE FROM post_hands WHERE post_id = ?`, [id]],
      [`DELETE FROM posts WHERE id = ?`, [id]],
    ],
  };
}

/** What a table's removal waits for: every one of these is a record of something that happened at it. */
const TABLE_LINKS = [
  ['hands', `SELECT 1 FROM hands WHERE table_id = ?`],
  ['sessions', `SELECT 1 FROM table_sessions WHERE table_id = ?`],
  ['ledger', `SELECT 1 FROM chip_ledger WHERE table_id = ?`],
  ['invites', `SELECT 1 FROM direct_messages WHERE table_id = ?`],
  ['tournaments', `SELECT 1 FROM tournaments WHERE table_id = ?`],
  ['open_alerts', `SELECT 1 FROM ops_alerts WHERE table_id = ? AND resolved_at IS NULL`],
] as const;

async function readTable(DB: D1Database, id: string): Promise<Read | null> {
  const [table, ...rest] = await DB.batch([
    DB.prepare(
      `SELECT name, status, room_type AS roomType, created_by AS createdBy, hands_played AS handsPlayed, live_seated AS liveSeated, live_connections AS liveConnections, created_at AS createdAt, updated_at AS updatedAt FROM tables WHERE id = ?`,
    ).bind(id),
    ...TABLE_LINKS.map(([, sql]) => DB.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(id)),
    DB.prepare(`SELECT COUNT(*) AS n FROM ops_events WHERE table_id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM ops_alerts WHERE table_id = ? AND resolved_at IS NOT NULL`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM bot_events WHERE table_id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE target_type = 'table' AND target_id = ?`).bind(id),
  ]);
  const t = table?.results[0] as { name: string; status: string; roomType: string; createdBy: string | null; handsPlayed: number; liveSeated: number; liveConnections: number; createdAt: number; updatedAt: number } | undefined;
  if (!t) return null;
  const links = rest.slice(0, TABLE_LINKS.length).map(count);
  const [events, resolved, bots, logged] = rest.slice(TABLE_LINKS.length).map(count);
  const handRows = links[0]!;
  return {
    label: t.name,
    state: { status: t.status, roomType: t.roomType, createdAt: t.createdAt, updatedAt: t.updatedAt, handsPlayed: t.handsPlayed, liveSeated: t.liveSeated, liveConnections: t.liveConnections },
    blockers: blockers([
      ['not_closed', t.status === 'closed' ? 0 : 1],
      ['tournament_table', t.roomType === 'tournament' ? 1 : 0],
      // The room's own count too: hand rows are what an audit reads, the count is what the room played.
      ['hands', Math.max(handRows, t.handsPlayed)],
      ...TABLE_LINKS.slice(1).map(([code], i): [string, number] => [code, links[i + 1]!]),
      ['occupied', t.liveSeated + t.liveConnections],
    ]),
    removes: { tables: 1 },
    keeps: { ops_events: events!, ops_alerts: resolved!, bot_events: bots!, admin_audit_log: logged! },
    facts: { name: t.name, roomType: t.roomType, createdBy: t.createdBy, createdAt: t.createdAt, closedAt: t.updatedAt },
    guard: [
      `EXISTS (SELECT 1 FROM tables WHERE id = ? AND status = 'closed' AND room_type != 'tournament' AND created_at = ? AND updated_at = ? AND hands_played = 0 AND live_seated = 0 AND live_connections = 0)
       ${TABLE_LINKS.map(([, sql]) => `AND NOT EXISTS (${sql})`).join(' ')}`,
      [id, t.createdAt, t.updatedAt, ...TABLE_LINKS.map(() => id)],
    ],
    deletes: [[`DELETE FROM tables WHERE id = ?`, [id]]],
  };
}

async function readTemplate(DB: D1Database, id: string): Promise<Read | null> {
  const [tpl, used, logged] = await DB.batch([
    DB.prepare(`SELECT name, status, version, created_at AS createdAt, updated_at AS updatedAt FROM tournament_templates WHERE id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM tournaments WHERE template_id = ?`).bind(id),
    DB.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE target_type = 'tournament_template' AND target_id = ?`).bind(id),
  ]);
  const t = tpl?.results[0] as { name: string; status: string; version: number; createdAt: number; updatedAt: number } | undefined;
  if (!t) return null;
  return {
    label: t.name,
    state: { status: t.status, version: t.version, updatedAt: t.updatedAt },
    blockers: blockers([
      ['not_archived', t.status === 'archived' ? 0 : 1],
      ['tournaments', count(used)],
    ]),
    removes: { tournament_templates: 1 },
    keeps: { admin_audit_log: count(logged) },
    facts: { name: t.name, version: t.version, createdAt: t.createdAt },
    guard: [
      `EXISTS (SELECT 1 FROM tournament_templates WHERE id = ? AND status = 'archived' AND version = ? AND updated_at = ?) AND NOT EXISTS (SELECT 1 FROM tournaments WHERE template_id = ?)`,
      [id, t.version, t.updatedAt, id],
    ],
    deletes: [[`DELETE FROM tournament_templates WHERE id = ?`, [id]]],
  };
}

const READERS: Record<PurgeKind, (DB: D1Database, id: string) => Promise<Read | null>> = { post: readPost, table: readTable, tournament_template: readTemplate };

/**
 * The plan for removing `kind` `id`, or null when there is no such record. `probe` adds blockers D1 cannot show (a
 * table's room), asked only when D1 shows none.
 */
export async function planPurge(DB: D1Database, kind: PurgeKind, id: string, probe?: () => Promise<PurgeBlocker[]>): Promise<{ plan: PurgePlan; read: Read } | null> {
  const read = await READERS[kind](DB, id);
  if (!read) return null;
  if (read.blockers.length === 0 && probe) read.blockers.push(...(await probe()));
  const plan: PurgePlan = {
    kind,
    id,
    label: read.label,
    deletable: read.blockers.length === 0,
    blockers: read.blockers,
    removes: read.removes,
    keeps: read.keeps,
    fingerprint: await sha256(JSON.stringify({ kind, id, state: read.state })),
    confirmText: id.slice(0, 8),
  };
  return { plan, read };
}

/**
 * Removes what `read` planned and writes its audit row, in one batch. False when the target changed or became blocked
 * since it was read (nothing written then); a batch that fails throws, and nothing is written either.
 */
export async function runPurge(DB: D1Database, read: Read, row: { id: string; actorId: string; action: string; targetType: string; targetId: string; detail: unknown; ip: string | null; at: number }): Promise<boolean> {
  const claimed = `EXISTS (SELECT 1 FROM admin_audit_log WHERE id = ?)`;
  const [claim] = await DB.batch([
    DB.prepare(`INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, ip, outcome, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'ok', ? WHERE ${read.guard[0]}`).bind(
      row.id,
      row.actorId,
      row.action,
      row.targetType,
      row.targetId,
      JSON.stringify(row.detail),
      row.ip,
      row.at,
      ...read.guard[1],
    ),
    ...read.deletes.map(([sql, binds]) => DB.prepare(`${sql} AND ${claimed}`).bind(...binds, row.id)),
  ]);
  return (claim?.meta.changes ?? 0) === 1;
}
