import { schema } from '@jc/db';
import { PLAYER_REPORT_WINDOW_MS, ReportCreateSchema, ReportResolveSchema, type ReportContext, type ReportDto, type ReportReason, type ReportStatus, type ReportTarget } from '@jc/types';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
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
};

const toReport = (r: ReportRow): ReportDto => ({
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
  priorReports: { total: r.priorTotal, resolved: r.priorResolved },
  handledBy: r.handlerId ? { id: r.handlerId, nickname: r.handlerNick ?? '' } : null,
  handledAt: r.handledAt,
  note: r.note,
});

const REPORT_SELECT = `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.detail, r.context, r.status,
       r.created_at AS createdAt, r.handled_at AS handledAt, r.note,
       r.reporter_id AS reporterId, ru.nickname AS reporterNick,
       r.target_user_id AS targetUserId, tu.nickname AS targetNick, tu.status AS targetStatus,
       r.handled_by AS handlerId, hu.nickname AS handlerNick,
       p.status AS postStatus, cm.status AS commentStatus,
       (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id != r.id) AS priorTotal,
       (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id != r.id AND o.status = 'resolved') AS priorResolved
  FROM reports r
  JOIN users ru ON ru.id = r.reporter_id
  JOIN users tu ON tu.id = r.target_user_id
  LEFT JOIN users hu ON hu.id = r.handled_by
  LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
  LEFT JOIN comments cm ON r.target_type = 'comment' AND cm.id = r.target_id`;

/** Mounted inside the admin router (requireAdmin already applied). */
export const adminReportRoutes = new Hono<AppEnv>()
  /** ?status=open|resolved|dismissed (default open, 'all' for every report); ?userId= narrows to one reported member. */
  .get('/reports', async (c) => {
    const status = c.req.query('status') ?? 'open';
    const userId = c.req.query('userId');
    const where: string[] = [];
    const args: unknown[] = [];
    if (status !== 'all') {
      if (!['open', 'resolved', 'dismissed'].includes(status)) fail(400, 'bad_request', 'unknown status');
      args.push(status);
      where.push(`r.status = ?${args.length}`);
    }
    if (userId) {
      args.push(userId);
      where.push(`r.target_user_id = ?${args.length}`);
    }
    const sql = `${REPORT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT 200`;
    const [list, open] = await c.env.DB.batch([c.env.DB.prepare(sql).bind(...args), c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`)]);
    return c.json({ items: (list!.results as ReportRow[]).map(toReport), openCount: (open!.results[0] as { n: number }).n });
  })
  /**
   * Closes a report, and every other open report on the same target, optionally hiding the reported content.
   *
   * One D1 batch (a single transaction). The first statement writes this request's audit row, but only while the
   * report is still open; that row (its id is new for every request) is the claim, and every later statement runs
   * only if it exists. Two admins, or one admin's double click, handling the same report at once therefore get
   * exactly one decision, one hide and one audit row, and a failure part-way leaves nothing half done.
   */
  .post('/reports/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, ReportResolveSchema);
    const r = await c.var.db.query.reports.findFirst({ where: eq(schema.reports.id, id) });
    if (!r) fail(404, 'not_found', 'report not found');
    if (r.status !== 'open') fail(409, 'report_closed', 'report already handled');
    if (body.hideContent && r.targetType !== 'post' && r.targetType !== 'comment') fail(400, 'bad_request', 'only posts and comments can be hidden');
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
      // This report and every other report still open on the same target.
      DB.prepare(
        `UPDATE reports SET status = ?5, note = ?6, handled_by = ?3, handled_at = ?4
          WHERE target_type = ?7 AND target_id = ?8 AND status = 'open' AND ${claimed}`,
      ).bind(claim, id, me, at, body.status, body.note || null, r.targetType, r.targetId),
      DB.prepare(
        `UPDATE admin_audit_log SET detail = json_object(
           'target', json_object('type', ?5, 'id', ?6),
           'closed', (SELECT COUNT(*) FROM reports WHERE target_type = ?5 AND target_id = ?6 AND handled_by = ?3 AND handled_at = ?4),
           'hidden', json(?7), 'note', ?8)
         WHERE id = ?1`,
      ).bind(claim, id, me, at, r.targetType, r.targetId, body.hideContent ? 'true' : 'false', body.note ?? null),
    );
    const results = await DB.batch(stmts);
    if (!results[0]!.meta.changes) fail(409, 'report_closed', 'report already handled');
    return c.json({ ok: true, closed: results[results.length - 2]!.meta.changes });
  });
