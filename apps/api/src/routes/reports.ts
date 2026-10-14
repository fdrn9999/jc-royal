import { schema } from '@jc/db';
import { ReportCreateSchema, ReportResolveSchema, type ReportContext, type ReportDto, type ReportReason, type ReportStatus, type ReportTarget } from '@jc/types';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { audit } from './admin-auth';
import { isUniqueViolation } from './auth';
import { recountComments } from './board';
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

/** Members report posts, comments, or a player they met at a table. */
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
    } else {
      const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, body.targetId), columns: { id: true, status: true } });
      if (!target || target.status === 'deleted') fail(404, 'user_not_found', 'no such player');
      const table = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, body.tableId!), columns: { id: true } });
      if (!table) fail(404, 'not_found', 'table not found');
      const room = await roomReportContext(c, table.id, target.id, me);
      // Only players who actually shared the table can report each other.
      if (!room?.targetPresent || !room.reporterPresent) fail(409, 'not_at_table', 'this player is not at the table with you');
      targetUserId = target.id;
      context = { kind: 'player', tableId: table.id, tableName: room.tableName, handId: room.handId, handNumber: room.handNumber, chat: room.chat };
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
  handledBy: r.handlerId ? { id: r.handlerId, nickname: r.handlerNick ?? '' } : null,
  handledAt: r.handledAt,
  note: r.note,
});

const REPORT_SELECT = `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.detail, r.context, r.status,
       r.created_at AS createdAt, r.handled_at AS handledAt, r.note,
       r.reporter_id AS reporterId, ru.nickname AS reporterNick,
       r.target_user_id AS targetUserId, tu.nickname AS targetNick, tu.status AS targetStatus,
       r.handled_by AS handlerId, hu.nickname AS handlerNick,
       p.status AS postStatus, cm.status AS commentStatus
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
  /** Closes a report, and every other open report on the same target, optionally hiding the reported content. */
  .post('/reports/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, ReportResolveSchema);
    const r = await c.var.db.query.reports.findFirst({ where: eq(schema.reports.id, id) });
    if (!r) fail(404, 'not_found', 'report not found');
    if (r.status !== 'open') fail(409, 'report_closed', 'report already handled');
    if (body.hideContent) {
      if (r.targetType === 'post') {
        await c.var.db.update(schema.posts).set({ status: 'hidden', updatedAt: Date.now() }).where(and(eq(schema.posts.id, r.targetId), eq(schema.posts.status, 'visible')));
      } else if (r.targetType === 'comment') {
        const hid = await c.var.db
          .update(schema.comments)
          .set({ status: 'hidden', updatedAt: Date.now() })
          .where(and(eq(schema.comments.id, r.targetId), eq(schema.comments.status, 'visible')))
          .returning({ postId: schema.comments.postId });
        if (hid[0]) await recountComments(c, hid[0].postId);
      } else {
        fail(400, 'bad_request', 'only posts and comments can be hidden');
      }
    }
    const closed = await c.var.db
      .update(schema.reports)
      .set({ status: body.status, note: body.note || null, handledBy: c.var.user!.id, handledAt: Date.now() })
      .where(and(eq(schema.reports.targetType, r.targetType), eq(schema.reports.targetId, r.targetId), eq(schema.reports.status, 'open')))
      .returning({ id: schema.reports.id });
    await audit(c, `report.${body.status}`, { type: 'report', id }, { target: { type: r.targetType, id: r.targetId }, closed: closed.length, hidden: !!body.hideContent, note: body.note });
    return c.json({ ok: true, closed: closed.length });
  });
