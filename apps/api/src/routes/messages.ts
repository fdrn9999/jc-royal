import { schema } from '@jc/db';
import type { MessageDto } from '@jc/types';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail } from '../lib/http';

const sender = alias(schema.users, 'sender');

/** One-way inbox: users can read and delete messages, never send them. */
export const messageRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const uid = c.var.user!.id;
    const rows = await c.var.db
      .select({ m: schema.messages, from: sender.nickname })
      .from(schema.messages)
      .leftJoin(sender, eq(sender.id, schema.messages.senderId))
      .where(and(eq(schema.messages.userId, uid), isNull(schema.messages.deletedAt)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(100);
    const out: MessageDto[] = rows.map(({ m, from }) => ({ id: m.id, category: m.category, title: m.title, body: m.body, fromAdmin: m.senderId ? (from ?? 'admin') : null, readAt: m.readAt, createdAt: m.createdAt }));
    return c.json(out);
  })
  .get('/unread-count', async (c) => {
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?1 AND read_at IS NULL AND deleted_at IS NULL`).bind(c.var.user!.id).first<{ n: number }>();
    return c.json({ unread: r?.n ?? 0 });
  })
  .post('/read-all', async (c) => {
    await c.var.db.update(schema.messages).set({ readAt: Date.now() }).where(and(eq(schema.messages.userId, c.var.user!.id), isNull(schema.messages.readAt)));
    return c.json({ ok: true });
  })
  .post('/:id/read', async (c) => {
    const r = await c.var.db
      .update(schema.messages)
      .set({ readAt: sql`COALESCE(${schema.messages.readAt}, ${Date.now()})` })
      .where(and(eq(schema.messages.id, c.req.param('id')), eq(schema.messages.userId, c.var.user!.id)))
      .returning({ id: schema.messages.id });
    if (!r[0]) fail(404, 'not_found', 'message not found');
    return c.json({ ok: true });
  })
  .delete('/:id', async (c) => {
    const r = await c.var.db
      .update(schema.messages)
      .set({ deletedAt: Date.now() })
      .where(and(eq(schema.messages.id, c.req.param('id')), eq(schema.messages.userId, c.var.user!.id)))
      .returning({ id: schema.messages.id });
    if (!r[0]) fail(404, 'not_found', 'message not found');
    return c.json({ ok: true });
  });
