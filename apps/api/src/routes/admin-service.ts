/**
 * Service notices (a banner on every page, in Korean and English, shown between two times) and maintenance windows
 * (no new seats or hands anywhere, optionally no member sign-in). Mounted inside the admin router: an admin session
 * and the admin origin are already required; maintenance changes also need the password confirmed recently.
 */
import { schema } from '@jc/db';
import { NOTICE_KINDS } from '@jc/types';
import { and, desc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireRecentReauth } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { tellRoomsAboutMaintenance, type RoomFanOut } from '../lib/service';
import { audit } from './admin-auth';

const ReasonSchema = z.string().trim().min(2).max(200);
const Title = z.string().trim().min(2).max(100);
/** Optional text: empty means none. */
const Text = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v) => v || null);
/** Epoch ms up to the year 2100. */
const When = z.number().int().min(0).max(4_102_444_800_000);

const NoticeFields = {
  kind: z.enum(NOTICE_KINDS),
  titleKo: Title,
  titleEn: Title,
  bodyKo: Text,
  bodyEn: Text,
  /** Defaults to now. */
  startsAt: When.optional(),
  /** Null or left out: shown until an admin ends it. */
  endsAt: When.nullish(),
};
const NoticeCreateSchema = z.object({
  ...NoticeFields,
  /** Also pin it on the board right away (Korean first, English below). */
  postToBoard: z.boolean().optional(),
  /** Also send it to every member's inbox right away, in their language. */
  sendInbox: z.boolean().optional(),
});
const NoticePatchSchema = z.object(NoticeFields).partial();

/** Longest maintenance window, and how far ahead one can be planned. */
const MAX_MAINTENANCE_MS = 48 * 3600_000;
const MAX_LEAD_MS = 90 * 24 * 3600_000;

const MaintenanceSchema = z.object({
  /** Clamped to now: a start in the past begins it at once. */
  startsAt: When,
  endsAt: When,
  blockLogin: z.boolean().optional(),
  messageKo: Text,
  messageEn: Text,
  reason: ReasonSchema,
});
const MaintenancePatchSchema = z.object({
  /** Only before it begins. */
  startsAt: When.optional(),
  endsAt: When.optional(),
  blockLogin: z.boolean().optional(),
  messageKo: Text.optional(),
  messageEn: Text.optional(),
  reason: ReasonSchema,
});
const StopSchema = z.object({ reason: ReasonSchema });

const page = (c: Context<AppEnv>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

type NoticeRow = typeof schema.serviceNotices.$inferSelect;
type WindowRow = typeof schema.maintenanceWindows.$inferSelect;

function noticeState(n: NoticeRow, now: number) {
  if (n.deletedAt) return 'deleted';
  if (n.endsAt !== null && n.endsAt <= now) return 'ended';
  return n.startsAt <= now ? 'live' : 'scheduled';
}

function windowState(w: WindowRow, now: number) {
  if (w.cancelledAt) return 'cancelled';
  if (w.endedAt) return 'ended_early';
  if (w.endsAt <= now) return 'finished';
  return w.startsAt <= now ? 'active' : 'scheduled';
}

function checkNoticeWindow(startsAt: number, endsAt: number | null | undefined, now: number) {
  if (endsAt == null) return;
  if (endsAt <= startsAt) fail(400, 'bad_request', 'the end must come after the start');
  if (endsAt <= now) fail(400, 'bad_request', 'the end has already passed');
}

function checkMaintenanceWindow(startsAt: number, endsAt: number, now: number) {
  if (endsAt <= startsAt || endsAt <= now) fail(400, 'bad_request', 'the end must come after the start and after now');
  if (endsAt - startsAt > MAX_MAINTENANCE_MS) fail(400, 'bad_request', 'maintenance lasts at most 48 hours');
  if (startsAt - now > MAX_LEAD_MS) fail(400, 'bad_request', 'maintenance can be planned at most 90 days ahead');
}

/** The board post: Korean first, the English version below it (the board has one language per post). */
function boardBody(n: { titleKo: string; titleEn: string; bodyKo: string | null; bodyEn: string | null }) {
  return `${n.bodyKo ?? n.titleKo}\n\n---\n\n[English] ${n.titleEn}${n.bodyEn ? `\n\n${n.bodyEn}` : ''}`;
}

/** What the fan-out found, for the audit log and the admin. */
const fanOutSummary = (r: RoomFanOut) => ({ tables: r.tables, reached: r.reached, unreached: r.unreached.length, truncated: r.truncated });

export const adminServiceRoutes = new Hono<AppEnv>()
  // ---------------------------------------------------------------- notices
  .get('/service/notices', async (c) => {
    const { limit, offset } = page(c);
    const now = Date.now();
    const N = schema.serviceNotices;
    const status = c.req.query('status');
    const where =
      status === 'live'
        ? and(isNull(N.deletedAt), lte(N.startsAt, now), or(isNull(N.endsAt), gt(N.endsAt, now)))
        : status === 'scheduled'
          ? and(isNull(N.deletedAt), gt(N.startsAt, now))
          : status === 'ended'
            ? and(isNull(N.deletedAt), isNotNull(N.endsAt), lte(N.endsAt, now))
            : status === 'deleted'
              ? isNotNull(N.deletedAt)
              : isNull(N.deletedAt);
    const rows = await c.var.db
      .select({ n: N, author: schema.users.nickname })
      .from(N)
      .leftJoin(schema.users, eq(schema.users.id, N.createdBy))
      .where(where)
      .orderBy(desc(N.startsAt), desc(N.createdAt))
      .limit(limit)
      .offset(offset);
    return c.json({ now, items: rows.map((r) => ({ ...r.n, author: r.author, state: noticeState(r.n, now) })) });
  })
  .post('/service/notices', async (c) => {
    const body = await parseBody(c, NoticeCreateSchema);
    const now = Date.now();
    const startsAt = Math.max(body.startsAt ?? now, now);
    checkNoticeWindow(startsAt, body.endsAt, now);
    const me = c.var.user!.id;
    const id = crypto.randomUUID();
    let postId: string | null = null;
    if (body.postToBoard) {
      postId = crypto.randomUUID();
      await c.var.db.insert(schema.posts).values({ id: postId, authorId: me, title: body.titleKo, body: boardBody(body), isNotice: true });
    }
    await c.var.db.insert(schema.serviceNotices).values({
      id,
      kind: body.kind,
      titleKo: body.titleKo,
      titleEn: body.titleEn,
      bodyKo: body.bodyKo,
      bodyEn: body.bodyEn,
      startsAt,
      endsAt: body.endsAt ?? null,
      postId,
      createdBy: me,
      createdAt: now,
      updatedAt: now,
    });
    let sent = 0;
    let batchId: string | null = null;
    if (body.sendInbox) {
      // One statement for every member, each in their own language (the inbox lists it as one send).
      batchId = crypto.randomUUID();
      const r = await c.env.DB.prepare(
        `INSERT INTO messages (id, user_id, category, title, body, sender_id, batch_id, created_at)
         SELECT lower(hex(randomblob(16))), id, 'notice', CASE WHEN locale = 'en' THEN ?1 ELSE ?2 END,
                CASE WHEN locale = 'en' THEN ?3 ELSE ?4 END, ?5, ?6, ?7
         FROM users WHERE status = 'active'`,
      )
        .bind(body.titleEn, body.titleKo, body.bodyEn ?? body.titleEn, body.bodyKo ?? body.titleKo, me, batchId, now)
        .run();
      sent = r.meta.changes ?? 0;
    }
    await audit(c, 'service.notice.create', { type: 'notice', id }, { kind: body.kind, titleKo: body.titleKo, startsAt, endsAt: body.endsAt ?? null, postId, batchId, sent });
    return c.json({ id, postId, batchId, sent }, 201);
  })
  .patch('/service/notices/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, NoticePatchSchema);
    const n = await c.var.db.query.serviceNotices.findFirst({ where: eq(schema.serviceNotices.id, id) });
    if (!n || n.deletedAt) fail(404, 'not_found', 'notice not found');
    const now = Date.now();
    const startsAt = body.startsAt ?? n.startsAt;
    const endsAt = body.endsAt === undefined ? n.endsAt : body.endsAt;
    if (body.startsAt !== undefined || body.endsAt !== undefined) checkNoticeWindow(startsAt, endsAt, now);
    const next = {
      kind: body.kind ?? n.kind,
      titleKo: body.titleKo ?? n.titleKo,
      titleEn: body.titleEn ?? n.titleEn,
      bodyKo: body.bodyKo === undefined ? n.bodyKo : body.bodyKo,
      bodyEn: body.bodyEn === undefined ? n.bodyEn : body.bodyEn,
      startsAt,
      endsAt,
    };
    await c.var.db.update(schema.serviceNotices).set({ ...next, updatedAt: now }).where(eq(schema.serviceNotices.id, id));
    // The board post written with it follows the edit; an inbox message already sent stays as it was.
    if (n.postId) await c.var.db.update(schema.posts).set({ title: next.titleKo, body: boardBody(next), updatedAt: now }).where(eq(schema.posts.id, n.postId));
    await audit(c, 'service.notice.update', { type: 'notice', id }, { before: { titleKo: n.titleKo, startsAt: n.startsAt, endsAt: n.endsAt, kind: n.kind }, after: { titleKo: next.titleKo, startsAt, endsAt, kind: next.kind } });
    return c.json({ ok: true });
  })
  /** Stops showing it now (it stays in the list as ended). */
  .post('/service/notices/:id/end', async (c) => {
    const id = c.req.param('id');
    const now = Date.now();
    const N = schema.serviceNotices;
    const r = await c.var.db
      .update(N)
      .set({ endsAt: now, updatedAt: now })
      .where(and(eq(N.id, id), isNull(N.deletedAt), or(isNull(N.endsAt), gt(N.endsAt, now))))
      .returning({ id: N.id });
    if (!r[0]) fail(409, 'conflict', 'this notice has already ended');
    await audit(c, 'service.notice.end', { type: 'notice', id });
    return c.json({ ok: true });
  })
  /** Removes it from every list but the audit trail; the board post, if any, is moderated on the board. */
  .delete('/service/notices/:id', async (c) => {
    const id = c.req.param('id');
    const now = Date.now();
    const N = schema.serviceNotices;
    const r = await c.var.db
      .update(N)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(N.id, id), isNull(N.deletedAt)))
      .returning({ titleKo: N.titleKo });
    if (!r[0]) fail(404, 'not_found', 'notice not found');
    await audit(c, 'service.notice.delete', { type: 'notice', id }, { titleKo: r[0].titleKo });
    return c.json({ ok: true });
  })
  // ---------------------------------------------------------------- maintenance
  /** Windows newest first, and how many tables still hold seats or a hand (a hand running when it begins plays out). */
  .get('/service/maintenance', async (c) => {
    const { limit, offset } = page(c);
    const now = Date.now();
    const W = schema.maintenanceWindows;
    const [rows, live] = await Promise.all([
      c.var.db.select({ w: W, author: schema.users.nickname }).from(W).leftJoin(schema.users, eq(schema.users.id, W.createdBy)).orderBy(desc(W.createdAt)).limit(limit).offset(offset),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN live_playing = 1 THEN 1 ELSE 0 END), 0) AS playing, COALESCE(SUM(CASE WHEN live_seated > 0 THEN 1 ELSE 0 END), 0) AS seated,
                COALESCE(SUM(live_seated), 0) AS players
         FROM tables WHERE status IN ('open', 'closing')`,
      ).first<{ playing: number; seated: number; players: number }>(),
    ]);
    return c.json({
      now,
      tables: { playing: live?.playing ?? 0, withSeats: live?.seated ?? 0, players: live?.players ?? 0 },
      items: rows.map((r) => ({ ...r.w, author: r.author, state: windowState(r.w, now) })),
    });
  })
  .post('/service/maintenance', requireRecentReauth, async (c) => {
    const body = await parseBody(c, MaintenanceSchema);
    const now = Date.now();
    const startsAt = Math.max(body.startsAt, now);
    checkMaintenanceWindow(startsAt, body.endsAt, now);
    const id = crypto.randomUUID();
    // One statement, so two admins planning at once cannot both succeed.
    const r = await c.env.DB.prepare(
      `INSERT INTO maintenance_windows (id, starts_at, ends_at, block_login, message_ko, message_en, created_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
       WHERE NOT EXISTS (SELECT 1 FROM maintenance_windows WHERE ended_at IS NULL AND cancelled_at IS NULL AND ends_at > ?8)`,
    )
      .bind(id, startsAt, body.endsAt, body.blockLogin ? 1 : 0, body.messageKo, body.messageEn, c.var.user!.id, now)
      .run();
    if (!r.meta.changes) fail(409, 'conflict', 'another maintenance window is planned or under way');
    const rooms = await tellRoomsAboutMaintenance(c.env);
    await audit(c, 'maintenance.schedule', { type: 'maintenance', id }, { startsAt, endsAt: body.endsAt, blockLogin: !!body.blockLogin, reason: body.reason, rooms: fanOutSummary(rooms) });
    return c.json({ id, startsAt, rooms }, 201);
  })
  /** Move a planned window, or extend / shorten one under way (its start stays). */
  .patch('/service/maintenance/:id', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, MaintenancePatchSchema);
    const W = schema.maintenanceWindows;
    const w = await c.var.db.query.maintenanceWindows.findFirst({ where: eq(W.id, id) });
    if (!w) fail(404, 'not_found', 'maintenance not found');
    const now = Date.now();
    if (windowState(w, now) !== 'active' && windowState(w, now) !== 'scheduled') fail(409, 'conflict', 'this maintenance is already over');
    const started = w.startsAt <= now;
    if (started && body.startsAt !== undefined && body.startsAt !== w.startsAt) fail(400, 'bad_request', 'maintenance under way keeps its start');
    const startsAt = started || body.startsAt === undefined ? w.startsAt : Math.max(body.startsAt, now);
    const endsAt = body.endsAt ?? w.endsAt;
    checkMaintenanceWindow(startsAt, endsAt, now);
    const next = {
      startsAt,
      endsAt,
      blockLogin: body.blockLogin ?? w.blockLogin,
      messageKo: body.messageKo === undefined ? w.messageKo : body.messageKo,
      messageEn: body.messageEn === undefined ? w.messageEn : body.messageEn,
    };
    // Only while it is still unfinished: an end or cancel that came first wins.
    const r = await c.var.db
      .update(W)
      .set({ ...next, updatedAt: now })
      .where(and(eq(W.id, id), isNull(W.endedAt), isNull(W.cancelledAt), gt(W.endsAt, now)))
      .returning({ id: W.id });
    if (!r[0]) fail(409, 'conflict', 'this maintenance is already over');
    const rooms = await tellRoomsAboutMaintenance(c.env);
    await audit(
      c,
      'maintenance.update',
      { type: 'maintenance', id },
      { before: { startsAt: w.startsAt, endsAt: w.endsAt, blockLogin: w.blockLogin }, after: { startsAt, endsAt, blockLogin: next.blockLogin }, reason: body.reason, rooms: fanOutSummary(rooms) },
    );
    return c.json({ ok: true, rooms });
  })
  /** Ends a window under way now, or cancels a planned one. Tables deal again as soon as they hear of it. */
  .post('/service/maintenance/:id/stop', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, StopSchema);
    const W = schema.maintenanceWindows;
    const now = Date.now();
    const r = await c.var.db
      .update(W)
      .set({
        endedAt: sql`CASE WHEN ${W.startsAt} <= ${now} THEN ${now} ELSE NULL END`,
        cancelledAt: sql`CASE WHEN ${W.startsAt} <= ${now} THEN NULL ELSE ${now} END`,
        updatedAt: now,
      })
      .where(and(eq(W.id, id), isNull(W.endedAt), isNull(W.cancelledAt), gt(W.endsAt, now)))
      .returning({ startsAt: W.startsAt, endsAt: W.endsAt });
    if (!r[0]) fail(409, 'conflict', 'this maintenance is already over');
    const action = r[0].startsAt <= now ? 'maintenance.end' : 'maintenance.cancel';
    const rooms = await tellRoomsAboutMaintenance(c.env);
    await audit(c, action, { type: 'maintenance', id }, { startsAt: r[0].startsAt, plannedEnd: r[0].endsAt, reason: body.reason, rooms: fanOutSummary(rooms) });
    return c.json({ ok: true, ended: action === 'maintenance.end', rooms });
  });
