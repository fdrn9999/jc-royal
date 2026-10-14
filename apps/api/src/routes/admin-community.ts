import { schema } from '@jc/db';
import { MessageSendSchema } from '@jc/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { sendMessages } from '../lib/community';
import { fail, parseBody } from '../lib/http';
import { audit } from './admin-auth';
import { listItems, postDetail, recountComments } from './board';

const NoticeSchema = z.object({ title: z.string().trim().min(2).max(100), body: z.string().trim().min(1).max(10_000) });
const StatusSchema = z.object({ status: z.enum(['visible', 'hidden', 'deleted']) });

/** Mounted inside the admin router (requireAdmin already applied). */
export const adminCommunityRoutes = new Hono<AppEnv>()
  // ---------------- board moderation & notices
  .get('/board/posts', async (c) => {
    const status = c.req.query('status');
    const where = status === 'visible' || status === 'hidden' || status === 'deleted' ? eq(schema.posts.status, status) : undefined;
    const items = await listItems(c, and(where), 100, 0);
    const statuses = await c.var.db.select({ id: schema.posts.id, status: schema.posts.status }).from(schema.posts).where(inArray(schema.posts.id, items.map((i) => i.id).concat('-')));
    const st = new Map(statuses.map((s) => [s.id, s.status]));
    return c.json(items.map((i) => ({ ...i, status: st.get(i.id) })));
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
    return c.json({ batchId, sent }, 201);
  })
  .get('/messages', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT m.batch_id AS batchId, MIN(m.title) AS title, MIN(m.category) AS category, MIN(m.created_at) AS createdAt,
              COUNT(*) AS recipients, SUM(CASE WHEN m.read_at IS NOT NULL THEN 1 ELSE 0 END) AS readCount,
              MIN(u.nickname) AS sender
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.batch_id IS NOT NULL GROUP BY m.batch_id ORDER BY createdAt DESC LIMIT 100`,
    ).all();
    return c.json(rows.results);
  });

