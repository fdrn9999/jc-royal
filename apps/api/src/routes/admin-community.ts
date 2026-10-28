import { schema } from '@jc/db';
import { MessageSendSchema } from '@jc/types';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { sendMessages } from '../lib/community';
import { fail, parseBody } from '../lib/http';
import { realtimeToUsers, spreadFor } from '../lib/realtime';
import { audit } from './admin-auth';
import { listItems, postDetail, recountComments } from './board';

const NoticeSchema = z.object({ title: z.string().trim().min(2).max(100), body: z.string().trim().min(1).max(10_000) });
const StatusSchema = z.object({ status: z.enum(['visible', 'hidden', 'deleted']) });

/** Mounted inside the admin router (requireAdmin already applied). */
export const adminCommunityRoutes = new Hono<AppEnv>()
  // ---------------- board moderation & notices
  /**
   * Posts for moderation, newest first, with their status. Without `paged=1` the newest 100 as a plain array, as before.
   * With it: `q` (part of the title), `limit` (1–100, default 50) / `offset`, and whether more follow (one extra row
   * is read instead of counting every post).
   */
  .get('/board/posts', async (c) => {
    const status = c.req.query('status');
    const paged = c.req.query('paged') === '1';
    const q = paged ? (c.req.query('q') ?? '').trim().slice(0, 100) : '';
    const where = and(
      status === 'visible' || status === 'hidden' || status === 'deleted' ? eq(schema.posts.status, status) : undefined,
      q ? like(schema.posts.title, `%${q}%`) : undefined,
    );
    const limit = paged ? Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100) : 100;
    const offset = paged ? Math.max(Number(c.req.query('offset') ?? 0) || 0, 0) : 0;
    const rows = await listItems(c, where, paged ? limit + 1 : limit, offset, true);
    const items = rows.slice(0, limit);
    const statuses = await c.var.db.select({ id: schema.posts.id, status: schema.posts.status }).from(schema.posts).where(inArray(schema.posts.id, items.map((i) => i.id).concat('-')));
    const st = new Map(statuses.map((s) => [s.id, s.status]));
    const out = items.map((i) => ({ ...i, status: st.get(i.id) }));
    return c.json(paged ? { items: out, limit, offset, more: rows.length > limit } : out);
  })
  .get('/board/posts/:id', async (c) => c.json(await postDetail(c, c.req.param('id'), c.var.user!.id, true)))
  .post('/board/notices', async (c) => {
    const body = await parseBody(c, NoticeSchema);
    const id = crypto.randomUUID();
    await c.var.db.insert(schema.posts).values({ id, authorId: c.var.user!.id, title: body.title, body: body.body, isNotice: true });
    await audit(c, 'board.notice.create', { type: 'post', id }, { title: body.title });
    return c.json({ id }, 201);
  })
  .patch('/board/notices/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, NoticeSchema);
    const r = await c.var.db
      .update(schema.posts)
      .set({ title: body.title, body: body.body, updatedAt: Date.now() })
      .where(and(eq(schema.posts.id, id), eq(schema.posts.isNotice, true)))
      .returning({ id: schema.posts.id });
    if (!r[0]) fail(404, 'not_found', 'notice not found');
    await audit(c, 'board.notice.update', { type: 'post', id });
    return c.json({ ok: true });
  })
  .post('/board/posts/:id/status', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, StatusSchema);
    const r = await c.var.db.update(schema.posts).set({ status: body.status, updatedAt: Date.now() }).where(eq(schema.posts.id, id)).returning({ id: schema.posts.id });
    if (!r[0]) fail(404, 'not_found', 'post not found');
    await audit(c, 'board.post.status', { type: 'post', id }, body);
    return c.json({ ok: true });
  })
  .post('/board/comments/:id/status', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, StatusSchema);
    const r = await c.var.db.update(schema.comments).set({ status: body.status, updatedAt: Date.now() }).where(eq(schema.comments.id, id)).returning({ postId: schema.comments.postId });
    if (!r[0]) fail(404, 'not_found', 'comment not found');
    await recountComments(c, r[0].postId);
    await audit(c, 'board.comment.status', { type: 'comment', id }, body);
    return c.json({ ok: true });
  })
  // ---------------- one-way messages
  .post('/messages', async (c) => {
    const body = await parseBody(c, MessageSendSchema);
    const ids = [...new Set(body.userIds)];
    const existing = await c.var.db.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), sql`${schema.users.status} != 'deleted'`));
    if (existing.length !== ids.length) fail(400, 'bad_request', 'some recipients do not exist');
    const batchId = crypto.randomUUID();
    const sent = await sendMessages(c.var.db, { userIds: ids, category: body.category, title: body.title, body: body.body, senderId: c.var.user!.id, batchId });
    await audit(c, 'message.send', { type: 'batch', id: batchId }, { recipients: ids.length, category: body.category, title: body.title });
    // Only the recipients' pages, each reading its own unread count (never the message from the event).
    realtimeToUsers(c, ids, { scope: 'user', type: 'message.changed', payload: { spreadMs: spreadFor(ids.length) } });
    return c.json({ batchId, sent }, 201);
  })
  /** Sent batches, newest first. Without `paged=1` the newest 100 as a plain array; with it `limit` (1–100, default 20) / `offset` and whether more follow. */
  .get('/messages', async (c) => {
    const paged = c.req.query('paged') === '1';
    const limit = paged ? Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100) : 100;
    const offset = paged ? Math.max(Number(c.req.query('offset') ?? 0) || 0, 0) : 0;
    const rows = await c.env.DB.prepare(
      `SELECT m.batch_id AS batchId, MIN(m.title) AS title, MIN(m.category) AS category, MIN(m.created_at) AS createdAt,
              COUNT(*) AS recipients, SUM(CASE WHEN m.read_at IS NOT NULL THEN 1 ELSE 0 END) AS readCount,
              MIN(u.nickname) AS sender
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.batch_id IS NOT NULL GROUP BY m.batch_id ORDER BY createdAt DESC LIMIT ?1 OFFSET ?2`,
    )
      .bind(paged ? limit + 1 : limit, offset)
      .all();
    const items = rows.results.slice(0, limit);
    return c.json(paged ? { items, limit, offset, more: rows.results.length > limit } : items);
  });

