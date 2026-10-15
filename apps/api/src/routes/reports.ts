import { schema } from '@jc/db';
import {
  PLAYER_REPORT_WINDOW_MS,
  REPORT_REASONS,
  REPORT_SEVERITIES,
  REPORT_STATS_DAYS,
  REPORT_TARGETS,
  ReportCreateSchema,
  ReportNoteSchema,
  ReportPatchSchema,
  ReportResolveSchema,
  type ReportContext,
  type ReportDto,
  type ReportEventDto,
  type ReportListDto,
  type ReportReason,
  type ReportSanction,
  type ReportSeverity,
  type ReportStatsDto,
  type ReportStatus,
  type ReportTarget,
} from '@jc/types';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { notices } from '../lib/notices';
import { looksPersonal } from '../lib/pii';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { audit } from './admin-auth';
import { isUniqueViolation } from './auth';
import { INTERNAL_HEADER } from './tables';

interface RoomReportContext {
  tableName: string;
  targetPresent: boolean;
  reporterPresent: boolean;
  handId: string | null;
  handNumber: number | null;
  chat: { text: string; at: number }[];
}

/** Asks the table's Durable Object for the reported player's recent chat and the current hand. */
async function roomReportContext(c: Context<AppEnv>, tableId: string, target: string, reporter: string): Promise<RoomReportContext | null> {
  try {
    const stub = c.env.TABLES.get(c.env.TABLES.idFromName(tableId));
    const q = new URLSearchParams({ target, reporter });
    const res = await stub.fetch(`https://room/internal/${tableId}/report-context?${q}`, { method: 'POST', headers: { [INTERNAL_HEADER]: c.env.INTERNAL_SECRET } });
    return res.ok ? ((await res.json()) as RoomReportContext) : null;
  } catch {
    return null;
  }
}

/**
 * When the two last held seats at the table at the same time, if that ended within the report window. Seat history
 * comes from table_sessions (buy-in to cash-out), so a spectator has none.
 */
async function sharedSeatTime(c: Context<AppEnv>, tableId: string, reporter: string, target: string, now: number) {
  return c.env.DB.prepare(
    `SELECT MAX(a.created_at, b.created_at) AS "from", MIN(COALESCE(a.closed_at, ?4), COALESCE(b.closed_at, ?4)) AS "to"
       FROM table_sessions a JOIN table_sessions b ON b.table_id = a.table_id AND b.user_id = ?3
      WHERE a.table_id = ?1 AND a.user_id = ?2
        AND MAX(a.created_at, b.created_at) < MIN(COALESCE(a.closed_at, ?4), COALESCE(b.closed_at, ?4))
        AND MIN(COALESCE(a.closed_at, ?4), COALESCE(b.closed_at, ?4)) >= ?5
      ORDER BY "to" DESC LIMIT 1`,
  )
    .bind(tableId, reporter, target, now, now - PLAYER_REPORT_WINDOW_MS)
    .first<{ from: number; to: number }>();
}

/** Finished hands both were dealt into during that time, newest first: ids and numbers only, never cards. */
async function sharedHands(c: Context<AppEnv>, tableId: string, a: string, b: string, from: number, to: number) {
  const { results } = await c.env.DB.prepare(
    `SELECT h.id, h.hand_number AS number FROM hands h
       JOIN hand_players pa ON pa.hand_id = h.id AND pa.user_id = ?2
       JOIN hand_players pb ON pb.hand_id = h.id AND pb.user_id = ?3
      WHERE h.table_id = ?1 AND h.ended_at BETWEEN ?4 AND ?5
      ORDER BY h.ended_at DESC LIMIT 20`,
  )
    .bind(tableId, a, b, from, to)
    .all<{ id: string; number: number }>();
  return results;
}

/** Members report posts, comments, a player they met at a table, or a 1:1 message they received. */
export const reportRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .post('/', async (c) => {
    const body = await parseBody(c, ReportCreateSchema);
    const me = c.var.user!.id;
    await rateLimit(c, `report:${me}`, 20, 60 * 60_000);
    let targetUserId: string;
    let context: ReportContext;
    if (body.targetType === 'post') {
      const p = await c.var.db.query.posts.findFirst({ where: and(eq(schema.posts.id, body.targetId), eq(schema.posts.status, 'visible')) });
      if (!p) fail(404, 'not_found', 'post not found');
      targetUserId = p.authorId;
      context = { kind: 'post', postId: p.id, title: p.title, body: p.body.slice(0, 2000) };
    } else if (body.targetType === 'comment') {
      const cm = await c.var.db.query.comments.findFirst({ where: and(eq(schema.comments.id, body.targetId), eq(schema.comments.status, 'visible')) });
      if (!cm) fail(404, 'not_found', 'comment not found');
      targetUserId = cm.authorId;
      context = { kind: 'comment', postId: cm.postId, commentId: cm.id, body: cm.body };
    } else if (body.targetType === 'dm') {
      // The text comes from the server copy of the message, never from the reporter.
      const m = await c.env.DB.prepare(
        `SELECT d.id, d.pair_key AS pairKey, d.sender_id AS senderId, d.recipient_id AS recipientId, d.body, d.created_at AS at, u.status AS senderStatus
           FROM direct_messages d JOIN users u ON u.id = d.sender_id WHERE d.id = ?1`,
      )
        .bind(body.targetId)
        .first<{ id: string; pairKey: string; senderId: string; recipientId: string; body: string; at: number; senderStatus: string }>();
      // Only the two people in the conversation can see the message; to anyone else it does not exist.
      if (!m || (m.recipientId !== me && m.senderId !== me) || m.senderStatus === 'deleted') fail(404, 'not_found', 'message not found');
      const { results: earlier } = await c.env.DB.prepare(
        `SELECT id, body, created_at AS at FROM direct_messages
          WHERE pair_key = ?1 AND sender_id = ?2 AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))
          ORDER BY created_at DESC, id DESC LIMIT 5`,
      )
        .bind(m.pairKey, m.senderId, m.at, m.id)
        .all<{ id: string; body: string; at: number }>();
      targetUserId = m.senderId;
      context = { kind: 'dm', messageId: m.id, senderId: m.senderId, recipientId: m.recipientId, body: m.body, at: m.at, earlier: earlier.reverse() };
    } else {
      const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, body.targetId), columns: { id: true, status: true } });
      if (!target || target.status === 'deleted') fail(404, 'user_not_found', 'no such player');
      const table = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, body.tableId!), columns: { id: true, name: true } });
      if (!table) fail(404, 'not_found', 'table not found');
      const room = await roomReportContext(c, table.id, target.id, me);
      targetUserId = target.id;
      if (room?.targetPresent && room.reporterPresent) {
        context = { kind: 'player', tableId: table.id, tableName: room.tableName, handId: room.handId, handNumber: room.handNumber, chat: room.chat, basis: 'present' };
      } else {
        // Only players who actually shared the table can report each other: both seated at once, recently enough.
        const now = Date.now();
        const overlap = target.id === me ? null : await sharedSeatTime(c, table.id, me, target.id, now);
        if (!overlap && target.id !== me) fail(409, 'not_at_table', 'this player is not at the table with you');
        const hands = overlap ? await sharedHands(c, table.id, me, target.id, overlap.from, overlap.to) : [];
        context = {
          kind: 'player',
          tableId: table.id,
          tableName: room?.tableName ?? table.name,
          handId: hands[0]?.id ?? null,
          handNumber: hands[0]?.number ?? null,
          // What the room still remembers of their chat, limited to the time the reporter was there to see it.
          chat: overlap ? (room?.chat ?? []).filter((l) => l.at >= overlap.from && l.at <= overlap.to) : [],
          basis: 'history',
          overlap,
          sharedHands: hands,
        };
      }
    }
    if (targetUserId === me) fail(400, 'report_self', 'you cannot report yourself');
    const id = crypto.randomUUID();
    try {
      await c.var.db.insert(schema.reports).values({
        id,
        reporterId: me,
        targetType: body.targetType,
        targetId: body.targetId,
        targetUserId,
        reason: body.reason,
        detail: body.detail || null,
        context: JSON.stringify(context),
        createdAt: Date.now(),
      });
    } catch (e) {
      if (isUniqueViolation(e, 'reports.reporter_id')) fail(409, 'already_reported', 'you already reported this and it is under review');
      throw e;
    }
    return c.json({ id }, 201);
  });

type ReportRow = {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  detail: string | null;
  context: string | null;
  status: ReportStatus;
  createdAt: number;
  handledAt: number | null;
  note: string | null;
  reporterId: string;
  reporterNick: string;
  targetUserId: string;
  targetNick: string;
  targetStatus: 'active' | 'suspended' | 'deleted';
  handlerId: string | null;
  handlerNick: string | null;
  postStatus: 'visible' | 'hidden' | 'deleted' | null;
  commentStatus: 'visible' | 'hidden' | 'deleted' | null;
  priorTotal: number;
  priorResolved: number;
  priorReporters: number;
  severity: ReportSeverity | null;
  assigneeId: string | null;
  assigneeNick: string | null;
  assignedAt: number | null;
  noticeReporter: number | null;
  noticeTarget: number | null;
};

const toReport = (r: ReportRow, sanctions: ReportSanction[]): ReportDto => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  reason: r.reason,
  detail: r.detail,
  status: r.status,
  createdAt: r.createdAt,
  reporter: { id: r.reporterId, nickname: r.reporterNick },
  target: { id: r.targetUserId, nickname: r.targetNick, status: r.targetStatus },
  context: r.context ? (JSON.parse(r.context) as ReportContext) : null,
  contentStatus: r.targetType === 'post' ? r.postStatus : r.targetType === 'comment' ? r.commentStatus : null,
  priorReports: { total: r.priorTotal, resolved: r.priorResolved, reporters: r.priorReporters },
  handledBy: r.handlerId ? { id: r.handlerId, nickname: r.handlerNick ?? '' } : null,
  handledAt: r.handledAt,
  note: r.note,
  severity: r.severity,
  assignee: r.assigneeId ? { id: r.assigneeId, nickname: r.assigneeNick ?? '' } : null,
  assignedAt: r.assignedAt,
  // Reports closed before the notice options existed have neither column set: nothing was sent.
  notice: r.status === 'open' ? null : { reporter: !!r.noticeReporter, target: !!r.noticeTarget },
  sanctions,
});

const REPORT_SELECT = `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.detail, r.context, r.status,
       r.created_at AS createdAt, r.handled_at AS handledAt, r.note,
       r.reporter_id AS reporterId, ru.nickname AS reporterNick,
       r.target_user_id AS targetUserId, tu.nickname AS targetNick, tu.status AS targetStatus,
       r.handled_by AS handlerId, hu.nickname AS handlerNick,
       p.status AS postStatus, cm.status AS commentStatus,
       r.severity, r.assignee_id AS assigneeId, au.nickname AS assigneeNick, r.assigned_at AS assignedAt,
       r.notice_reporter AS noticeReporter, r.notice_target AS noticeTarget,
       (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id != r.id) AS priorTotal,
       (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id != r.id AND o.status = 'resolved') AS priorResolved,
       (SELECT COUNT(DISTINCT o.reporter_id) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id != r.id) AS priorReporters
  FROM reports r
  JOIN users ru ON ru.id = r.reporter_id
  JOIN users tu ON tu.id = r.target_user_id
  LEFT JOIN users hu ON hu.id = r.handled_by
  LEFT JOIN users au ON au.id = r.assignee_id
  LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
  LEFT JOIN comments cm ON r.target_type = 'comment' AND cm.id = r.target_id`;

/** Most severe first; reports nobody has rated come last; oldest first among equals. */
const SEVERITY_RANK = `CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
const SORTS = {
  newest: 'r.created_at DESC, r.id DESC',
  oldest: 'r.created_at ASC, r.id ASC',
  severity: `${SEVERITY_RANK}, r.created_at ASC, r.id ASC`,
} as const;
/** Audit actions shown on a report as the reported member's sanction history. */
const SANCTIONS = ['user.suspend', 'user.unsuspend', 'user.disconnect'];
/** Who a report can be assigned to (matches the partial index users_staff_idx). */
const STAFF = `role != 'user' AND status = 'active'`;
const HOUR = 3_600_000;

/** The last five sanctions on each member, newest first (one query for the whole page). */
async function sanctionsOf(DB: D1Database, userIds: string[]) {
  const by = new Map<string, ReportSanction[]>();
  if (!userIds.length) return by;
  const { results } = await DB.prepare(
    `SELECT userId, action, at, reason, reportId, actorId, actorNick FROM (
       SELECT a.target_id AS userId, a.action, a.created_at AS at, json_extract(a.detail, '$.reason') AS reason,
              json_extract(a.detail, '$.reportId') AS reportId, a.actor_id AS actorId, u.nickname AS actorNick,
              ROW_NUMBER() OVER (PARTITION BY a.target_id ORDER BY a.created_at DESC, a.id DESC) AS n
         FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.target_type = 'user' AND a.target_id IN (SELECT value FROM json_each(?1)) AND a.action IN (${SANCTIONS.map((s) => `'${s}'`).join(', ')}))
      WHERE n <= 5 ORDER BY at DESC`,
  )
    .bind(JSON.stringify(userIds))
    .all<{ userId: string; action: ReportSanction['action']; at: number; reason: string | null; reportId: string | null; actorId: string; actorNick: string | null }>();
  for (const s of results) {
    const list = by.get(s.userId) ?? [];
    list.push({ action: s.action, at: s.at, reason: s.reason, reportId: s.reportId, actor: { id: s.actorId, nickname: s.actorNick } });
    by.set(s.userId, list);
  }
  return by;
}

/** A query parameter that must be one of `allowed` when given. */
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], what: string): T | undefined => {
  if (v === undefined || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) fail(400, 'bad_request', `unknown ${what}`);
  return v as T;
};

/** Mounted inside the admin router (requireAdmin already applied). */
export const adminReportRoutes = new Hono<AppEnv>()
  /**
   * The queue. ?status=open|resolved|dismissed (default open, 'all' for every report); ?userId= narrows to one reported
   * member, ?reporterId= to what one member reported; ?severity=low|medium|high|critical|none, ?reason=, ?targetType=,
   * ?assignee=me|none|<admin id>; ?sort=newest|oldest|severity; ?page= (from 1) and ?limit= (default 50, at most 100).
   */
  .get('/reports', async (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    const status = q('status') ?? 'open';
    const userId = q('userId');
    const reporterId = q('reporterId');
    const severity = oneOf(q('severity'), [...REPORT_SEVERITIES, 'none'], 'severity');
    const reason = oneOf(q('reason'), REPORT_REASONS, 'reason');
    const targetType = oneOf(q('targetType'), REPORT_TARGETS, 'target type');
    const assignee = q('assignee');
    const sort = oneOf(q('sort'), ['newest', 'oldest', 'severity'] as const, 'sort') ?? 'newest';
    const limit = Math.min(Math.max(Math.floor(Number(q('limit') ?? 50)) || 50, 1), 100);
    const page = Math.min(Math.max(Math.floor(Number(q('page') ?? 1)) || 1, 1), 100_000);
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (cond: (param: string) => string, v: unknown) => {
      args.push(v);
      where.push(cond(`?${args.length}`));
    };
    if (status !== 'all') {
      if (!['open', 'resolved', 'dismissed'].includes(status)) fail(400, 'bad_request', 'unknown status');
      add((p) => `r.status = ${p}`, status);
    }
    if (userId) add((p) => `r.target_user_id = ${p}`, userId);
    if (reporterId) add((p) => `r.reporter_id = ${p}`, reporterId);
    if (severity === 'none') where.push('r.severity IS NULL');
    else if (severity) add((p) => `r.severity = ${p}`, severity);
    if (reason) add((p) => `r.reason = ${p}`, reason);
    if (targetType) add((p) => `r.target_type = ${p}`, targetType);
    if (assignee === 'none') where.push('r.assignee_id IS NULL');
    else if (assignee) add((p) => `r.assignee_id = ${p}`, assignee === 'me' ? c.var.user!.id : assignee);
    const cond = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const DB = c.env.DB;
    const [list, count, open] = await DB.batch([
      DB.prepare(`${REPORT_SELECT}${cond} ORDER BY ${SORTS[sort]} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).bind(...args),
      DB.prepare(`SELECT COUNT(*) AS n FROM reports r${cond}`).bind(...args),
      DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`),
    ]);
    const rows = list!.results as ReportRow[];
    const sanctions = await sanctionsOf(DB, [...new Set(rows.map((r) => r.targetUserId))]);
    const items = rows.map((r) => toReport(r, sanctions.get(r.targetUserId) ?? []));
    // Evidence can quote 1:1 messages and table chat, so every look is recorded with what it showed.
    await audit(c, 'report.view', undefined, {
      status,
      userId: userId ?? null,
      reporterId: reporterId ?? null,
      severity: severity ?? null,
      reason: reason ?? null,
      targetType: targetType ?? null,
      assignee: assignee ?? null,
      sort,
      page,
      count: items.length,
      dm: items.filter((r) => r.targetType === 'dm').map((r) => r.id),
    });
    const body: ReportListDto = { items, total: (count!.results[0] as { n: number }).n, page, limit, openCount: (open!.results[0] as { n: number }).n };
    return c.json(body);
  })
  /**
   * Reference figures for staff: reports filed in the last ?days=7|30|90 by reason and by kind of target, the open
   * backlog and how long it has waited, how long decisions took, and members reported again and again. Nothing here
   * acts on anyone: a member is never suspended for a number of reports, only by an administrator who read them.
   */
  .get('/reports/stats', async (c) => {
    const days = Number(c.req.query('days') ?? 30);
    if (!(REPORT_STATS_DAYS as readonly number[]).includes(days)) fail(400, 'bad_request', 'days must be 7, 30 or 90');
    const now = Date.now();
    const since = now - days * 24 * HOUR;
    const DB = c.env.DB;
    const outcomes = `COUNT(*) AS total, SUM(status = 'open') AS open, SUM(status = 'resolved') AS resolved, SUM(status = 'dismissed') AS dismissed,
      CAST(AVG(CASE WHEN status != 'open' THEN handled_at - created_at END) AS INTEGER) AS avgHandleMs`;
    const [byReason, byTarget, backlog, handled, repeated] = await DB.batch([
      DB.prepare(`SELECT reason, ${outcomes} FROM reports WHERE created_at >= ?1 GROUP BY reason ORDER BY total DESC, reason`).bind(since),
      DB.prepare(`SELECT target_type AS targetType, ${outcomes} FROM reports WHERE created_at >= ?1 GROUP BY target_type ORDER BY total DESC, target_type`).bind(since),
      DB.prepare(
        `SELECT COUNT(*) AS open, COALESCE(SUM(assignee_id IS NULL), 0) AS unassigned,
                COALESCE(SUM(created_at < ?1), 0) AS over24h, COALESCE(SUM(created_at < ?2), 0) AS over72h, MIN(created_at) AS oldestOpenAt,
                COALESCE(SUM(severity IS NULL), 0) AS none, COALESCE(SUM(severity = 'low'), 0) AS low, COALESCE(SUM(severity = 'medium'), 0) AS medium,
                COALESCE(SUM(severity = 'high'), 0) AS high, COALESCE(SUM(severity = 'critical'), 0) AS critical
           FROM reports WHERE status = 'open'`,
      ).bind(now - 24 * HOUR, now - 72 * HOUR),
      DB.prepare(
        `SELECT COUNT(*) AS count, CAST(AVG(handled_at - created_at) AS INTEGER) AS avgMs, MAX(handled_at - created_at) AS maxMs
           FROM reports WHERE status IN ('resolved', 'dismissed') AND handled_at >= ?1`,
      ).bind(since),
      // MATERIALIZED: read only the period's reports (reports_created_idx). Without it SQLite walks every report in
      // reported-member order (reports_target_user_idx) to save the grouping sort, whatever the period.
      DB.prepare(
        `WITH recent AS MATERIALIZED (SELECT target_user_id, reporter_id, status, created_at FROM reports WHERE created_at >= ?1)
         SELECT r.target_user_id AS id, u.nickname, u.status, COUNT(*) AS reports, COUNT(DISTINCT r.reporter_id) AS reporters,
                SUM(r.status = 'open') AS open, SUM(r.status = 'resolved') AS resolved, SUM(r.status = 'dismissed') AS dismissed,
                MAX(r.created_at) AS lastAt,
                (SELECT COUNT(*) FROM admin_audit_log a WHERE a.target_type = 'user' AND a.target_id = r.target_user_id AND a.action = 'user.suspend') AS suspensions
           FROM recent r JOIN users u ON u.id = r.target_user_id
          GROUP BY r.target_user_id HAVING COUNT(*) >= 2
          ORDER BY reports DESC, lastAt DESC LIMIT 20`,
      ).bind(since),
    ]);
    type Outcomes = { total: number; open: number; resolved: number; dismissed: number; avgHandleMs: number | null };
    const b = backlog!.results[0] as { open: number; unassigned: number; over24h: number; over72h: number; oldestOpenAt: number | null } & Record<ReportSeverity | 'none', number>;
    const h = handled!.results[0] as { count: number; avgMs: number | null; maxMs: number | null };
    type Repeated = { id: string; nickname: string; status: 'active' | 'suspended' | 'deleted'; reports: number; reporters: number; open: number; resolved: number; dismissed: number; lastAt: number; suspensions: number };
    const body: ReportStatsDto = {
      days,
      since,
      byReason: byReason!.results as (Outcomes & { reason: ReportReason })[],
      byTarget: byTarget!.results as (Outcomes & { targetType: ReportTarget })[],
      backlog: {
        open: b.open,
        unassigned: b.unassigned,
        over24h: b.over24h,
        over72h: b.over72h,
        oldestOpenAt: b.oldestOpenAt,
        bySeverity: { none: b.none, low: b.low, medium: b.medium, high: b.high, critical: b.critical },
      },
      handled: { count: h.count, avgMs: h.avgMs, maxMs: h.maxMs },
      repeated: (repeated!.results as Repeated[]).map(({ id, nickname, status, ...n }) => ({ user: { id, nickname, status }, ...n })),
    };
    return c.json(body);
  })
  /** Active administrators a report can be assigned to. */
  .get('/reports/assignees', async (c) => {
    const { results } = await c.env.DB.prepare(`SELECT id, nickname, role FROM users WHERE ${STAFF} ORDER BY nickname`).all<{ id: string; nickname: string; role: string }>();
    return c.json({ items: results });
  })
  /** A report's history, oldest first: notes, severity, assignment and status changes, and sanctions given from it. */
  .get('/reports/:id/events', async (c) => {
    const id = c.req.param('id');
    const DB = c.env.DB;
    const [found, list] = await DB.batch([
      DB.prepare(`SELECT 1 AS ok FROM reports WHERE id = ?1`).bind(id),
      DB.prepare(
        `SELECT e.id, e.kind, e.from_value AS "from", e.to_value AS "to", fu.nickname AS fromName, tu.nickname AS toName, e.body,
                e.actor_id AS actorId, u.nickname AS actorNick, e.created_at AS createdAt
           FROM report_events e
           LEFT JOIN users u ON u.id = e.actor_id
           LEFT JOIN users fu ON e.kind = 'assign' AND fu.id = e.from_value
           LEFT JOIN users tu ON e.kind = 'assign' AND tu.id = e.to_value
          WHERE e.report_id = ?1 ORDER BY e.created_at, e.rowid`,
      ).bind(id),
    ]);
    if (!found!.results.length) fail(404, 'not_found', 'report not found');
    type Row = Omit<ReportEventDto, 'actor'> & { actorId: string; actorNick: string | null };
    const items: ReportEventDto[] = (list!.results as Row[]).map(({ actorId, actorNick, ...e }) => ({ ...e, actor: { id: actorId, nickname: actorNick } }));
    return c.json({ items });
  })
  /** An internal note on a report (administrators only, never shown to members; no personal data). Also on closed ones. */
  .post('/reports/:id/notes', async (c) => {
    const id = c.req.param('id');
    const { body } = await parseBody(c, ReportNoteSchema);
    if (looksPersonal(body)) fail(400, 'note_pii', 'notes must not hold e-mail addresses, phone, card or ID numbers');
    const eventId = crypto.randomUUID();
    const createdAt = Date.now();
    const res = await c.env.DB.prepare(`INSERT INTO report_events (id, report_id, actor_id, kind, body, created_at) SELECT ?1, id, ?3, 'note', ?4, ?5 FROM reports WHERE id = ?2`)
      .bind(eventId, id, c.var.user!.id, body, createdAt)
      .run();
    if (!res.meta.changes) fail(404, 'not_found', 'report not found');
    // The note is kept with the report; the audit row says who wrote one and when, not what it says.
    await audit(c, 'report.note', { type: 'report', id }, { eventId, length: body.length });
    return c.json({ id: eventId, createdAt }, 201);
  })
  /**
   * One change to an open report: its severity, who works on it (an active administrator, or nobody), or `take` it
   * while nobody does. The same claim as closing one: the audit row is written only while the change still applies
   * (with what it was before), and the history entry and the change itself only if that row was. Two admins taking the
   * same report at once get one assignee, one history entry and one audit row; the other is told who was first.
   */
  .patch('/reports/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, ReportPatchSchema);
    const me = c.var.user!.id;
    const DB = c.env.DB;
    if (body.assigneeId) {
      const staff = await DB.prepare(`SELECT 1 AS ok FROM users WHERE id = ?1 AND ${STAFF}`).bind(body.assigneeId).first();
      if (!staff) fail(400, 'bad_request', 'assignee must be an active administrator');
    }
    const kind = 'severity' in body ? 'severity' : 'assign';
    const column = kind === 'severity' ? 'severity' : 'assignee_id';
    const to = kind === 'severity' ? (body.severity ?? null) : body.take ? me : (body.assigneeId ?? null);
    // Only while it changes something: a different value, or, to take it, nobody on it yet.
    const applies = body.take ? 'assignee_id IS NULL' : `${column} IS NOT ?5`;
    const claim = crypto.randomUUID();
    const at = Date.now();
    const claimed = `EXISTS (SELECT 1 FROM admin_audit_log WHERE id = ?1)`;
    // ?1 claim (audit row id), ?2 report id, ?3 admin, ?4 time, ?5 new value; further parameters per statement.
    const [first] = await DB.batch([
      DB.prepare(
        `INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, ip, detail, created_at)
         SELECT ?1, ?3, 'report.${kind}', 'report', ?2, ?6, json_object('from', ${column}, 'to', ?5), ?4
           FROM reports WHERE id = ?2 AND status = 'open' AND ${applies}`,
      ).bind(claim, id, me, at, to, clientIp(c)),
      DB.prepare(
        `INSERT INTO report_events (id, report_id, actor_id, kind, from_value, to_value, created_at)
         SELECT ?6, ?2, ?3, '${kind}', json_extract(detail, '$.from'), ?5, ?4 FROM admin_audit_log WHERE id = ?1`,
      ).bind(claim, id, me, at, to, crypto.randomUUID()),
      DB.prepare(
        kind === 'severity'
          ? `UPDATE reports SET severity = ?5 WHERE id = ?2 AND ${claimed}`
          : `UPDATE reports SET assignee_id = ?5, assigned_at = CASE WHEN ?5 IS NULL THEN NULL ELSE ?4 END WHERE id = ?2 AND ${claimed}`,
      ).bind(claim, id, me, at, to),
    ]);
    if (first!.meta.changes) return c.json({ ok: true, changed: true });
    const r = await DB.prepare(`SELECT status, assignee_id AS assigneeId FROM reports WHERE id = ?1`).bind(id).first<{ status: ReportStatus; assigneeId: string | null }>();
    if (!r) fail(404, 'not_found', 'report not found');
    if (r.status !== 'open') fail(409, 'report_closed', 'report already handled');
    if (body.take && r.assigneeId && r.assigneeId !== me) fail(409, 'report_taken', 'another administrator is handling this report');
    return c.json({ ok: true, changed: false });
  })
  /**
   * Closes a report, and every other open report on the same target, optionally hiding the reported content and
   * telling the members involved how it ended: each member who reported it (notifyReporter), and, when upheld, the
   * reported member (notifyTarget), each in their own account language. Neither message names anyone or quotes the
   * staff note.
   *
   * One D1 batch (a single transaction). The first statement writes this request's audit row, but only while the
   * report is still open; that row (its id is new for every request) is the claim, and every later statement runs
   * only if it exists. Two admins, or one admin's double click, handling the same report at once therefore get
   * exactly one decision, one hide, one message per member and one audit row, and a failure part-way leaves nothing
   * half done.
   */
  .post('/reports/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, ReportResolveSchema);
    const r = await c.var.db.query.reports.findFirst({ where: eq(schema.reports.id, id) });
    if (!r) fail(404, 'not_found', 'report not found');
    if (r.status !== 'open') fail(409, 'report_closed', 'report already handled');
    const hidable = r.targetType === 'post' || r.targetType === 'comment';
    if (body.hideContent && !hidable) fail(400, 'bad_request', 'only posts and comments can be hidden');
    const DB = c.env.DB;
    const me = c.var.user!.id;
    const at = Date.now();
    const claim = crypto.randomUUID();
    // ?1 claim (audit row id), ?2 report id, ?3 admin, ?4 time; further parameters per statement.
    const claimed = `EXISTS (SELECT 1 FROM admin_audit_log WHERE id = ?1)`;
    const stmts: D1PreparedStatement[] = [
      DB.prepare(
        `INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, ip, created_at)
         SELECT ?1, ?3, 'report.' || ?5, 'report', ?2, ?6, ?4 WHERE EXISTS (SELECT 1 FROM reports WHERE id = ?2 AND status = 'open')`,
      ).bind(claim, id, me, at, body.status, clientIp(c)),
    ];
    if (body.hideContent && r.targetType === 'post') {
      stmts.push(DB.prepare(`UPDATE posts SET status = 'hidden', updated_at = ?4 WHERE id = ?5 AND status = 'visible' AND ${claimed}`).bind(claim, id, me, at, r.targetId));
    }
    if (body.hideContent && r.targetType === 'comment') {
      stmts.push(
        DB.prepare(`UPDATE comments SET status = 'hidden', updated_at = ?4 WHERE id = ?5 AND status = 'visible' AND ${claimed}`).bind(claim, id, me, at, r.targetId),
        DB.prepare(
          `UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND status = 'visible')
            WHERE id = (SELECT post_id FROM comments WHERE id = ?5) AND ${claimed}`,
        ).bind(claim, id, me, at, r.targetId),
      );
    }
    stmts.push(
      // The status change on the history of each report closed here (before the close below, while they are open).
      DB.prepare(
        `INSERT INTO report_events (id, report_id, actor_id, kind, from_value, to_value, body, created_at)
         SELECT lower(hex(randomblob(16))), id, ?3, 'status', 'open', ?5, ?6, ?4 FROM reports
          WHERE target_type = ?7 AND target_id = ?8 AND status = 'open' AND ${claimed}`,
      ).bind(claim, id, me, at, body.status, body.note || null, r.targetType, r.targetId),
    );
    // This report and every other report still open on the same target.
    const closeAt =
      stmts.push(
        DB.prepare(
          `UPDATE reports SET status = ?5, note = ?6, handled_by = ?3, handled_at = ?4, notice_reporter = ?9, notice_target = ?10
            WHERE target_type = ?7 AND target_id = ?8 AND status = 'open' AND ${claimed}`,
        ).bind(claim, id, me, at, body.status, body.note || null, r.targetType, r.targetId, body.notifyReporter ? 1 : 0, body.notifyTarget ? 1 : 0),
      ) - 1;
    const ko = notices('ko');
    const en = notices('en');
    let reportersAt = -1;
    if (body.notifyReporter) {
      const k = ko.reportOutcome(r.targetType, body.status === 'resolved');
      const e = en.reportOutcome(r.targetType, body.status === 'resolved');
      // Each member whose report was closed just now, once, in their language; not to deleted accounts.
      reportersAt =
        stmts.push(
          DB.prepare(
            `INSERT INTO messages (id, user_id, category, title, body, sender_id, created_at)
             SELECT lower(hex(randomblob(16))), u.id, 'notice', CASE WHEN u.locale = 'en' THEN ?5 ELSE ?6 END, CASE WHEN u.locale = 'en' THEN ?7 ELSE ?8 END, ?3, ?4
               FROM users u
              WHERE u.id IN (SELECT reporter_id FROM reports WHERE target_type = ?9 AND target_id = ?10 AND handled_by = ?3 AND handled_at = ?4)
                AND u.status != 'deleted' AND ${claimed}`,
          ).bind(claim, id, me, at, e.title, k.title, e.body, k.body, r.targetType, r.targetId),
        ) - 1;
    }
    let targetAt = -1;
    if (body.notifyTarget) {
      const hidden = !!body.hideContent && hidable;
      const k = ko.reportUpheld(r.targetType, r.reason, hidden);
      const e = en.reportUpheld(r.targetType, r.reason, hidden);
      targetAt =
        stmts.push(
          DB.prepare(
            `INSERT INTO messages (id, user_id, category, title, body, sender_id, created_at)
             SELECT lower(hex(randomblob(16))), id, 'sanction', CASE WHEN locale = 'en' THEN ?5 ELSE ?6 END, CASE WHEN locale = 'en' THEN ?7 ELSE ?8 END, ?3, ?4
               FROM users WHERE id = ?9 AND status != 'deleted' AND ${claimed}`,
          ).bind(claim, id, me, at, e.title, k.title, e.body, k.body, r.targetUserId),
        ) - 1;
    }
    stmts.push(
      DB.prepare(
        `UPDATE admin_audit_log SET detail = json_object(
           'target', json_object('type', ?5, 'id', ?6),
           'closed', (SELECT COUNT(*) FROM reports WHERE target_type = ?5 AND target_id = ?6 AND handled_by = ?3 AND handled_at = ?4),
           'hidden', json(?7), 'note', ?8, 'notify', json_object('reporter', json(?9), 'target', json(?10)))
         WHERE id = ?1`,
      ).bind(claim, id, me, at, r.targetType, r.targetId, body.hideContent ? 'true' : 'false', body.note ?? null, body.notifyReporter ? 'true' : 'false', body.notifyTarget ? 'true' : 'false'),
    );
    const results = await DB.batch(stmts);
    if (!results[0]!.meta.changes) fail(409, 'report_closed', 'report already handled');
    const changes = (i: number) => (i < 0 ? 0 : results[i]!.meta.changes);
    return c.json({ ok: true, closed: changes(closeAt), notified: { reporters: changes(reportersAt), target: changes(targetAt) } });
  });
