import { INBOX_FILTERS, INBOX_KINDS, INBOX_PAGE, InboxListQuerySchema, InboxReadSchema, type InboxItemDto, type InboxPageDto } from '@jc/types';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { INBOX_UNION_SQL, INBOX_UNREAD_SQL, inboxMarkRead, inboxPage, toInboxItem, type InboxRowOut } from '../lib/inbox';
import { realtimeToUsers } from '../lib/realtime';

/** Items "read all" marks in one request (the rest stay unread: a second press reads them). */
const READ_ALL_MAX = 500;

/**
 * The notification inbox (packages/types/src/inbox.ts, lib/inbox.ts): the member's own items, newest first, and marking
 * them read. Every page of the member (another tab, another device) reads it again when one is read here.
 */
export const inboxRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const parsed = InboxListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) fail(400, 'bad_request', 'validation failed');
    const q = parsed.data;
    const uid = c.var.user!.id;
    const now = Date.now();
    const limit = q.limit ?? INBOX_PAGE;
    const cut = q.before?.indexOf(':') ?? -1;
    const before = q.before ? { at: Number(q.before.slice(0, cut)), id: q.before.slice(cut + 1) } : undefined;
    const [page, unread] = await c.env.DB.batch([
      inboxPage(c.env.DB, uid, now, { filter: q.filter, unread: q.unread === '1', before, limit }),
      c.env.DB.prepare(`SELECT ${INBOX_UNREAD_SQL} AS n`).bind(uid, now),
    ]);
    const rows = (page?.results ?? []) as unknown as InboxRowOut[];
    const items = rows.slice(0, limit).map((r) => toInboxItem(r, now));
    const last = items[items.length - 1];
    return c.json({
      items,
      next: rows.length > limit && last ? `${last.at}:${last.id}` : null,
      unread: Number((unread?.results[0] as { n?: number } | undefined)?.n ?? 0),
    } satisfies InboxPageDto);
  })
  /** These items, or every unread one (of a filter). Items that are not the member's, or no longer listed, are skipped. */
  .post('/read', async (c) => {
    const body = await parseBody(c, InboxReadSchema);
    const uid = c.var.user!.id;
    const now = Date.now();
    const db = c.env.DB;
    let found: { results: unknown[] };
    if ('ids' in body) {
      const ids = [...new Set(body.ids)];
      found = await db
        .prepare(`SELECT x.id, x.kind, x.at FROM (${INBOX_UNION_SQL}) x WHERE x.readAt IS NULL AND x.id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})`)
        .bind(uid, now, ...ids)
        .all();
    } else {
      const kinds = body.filter ? INBOX_FILTERS[body.filter] : INBOX_KINDS;
      found = await db
        .prepare(`SELECT x.id, x.kind, x.at FROM (${INBOX_UNION_SQL}) x WHERE x.readAt IS NULL AND x.kind IN (${kinds.map((k) => `'${k}'`).join(', ')}) LIMIT ${READ_ALL_MAX}`)
        .bind(uid, now)
        .all();
    }
    const items = found.results as Pick<InboxItemDto, 'id' | 'kind' | 'at'>[];
    if (items.length) {
      await db.batch(inboxMarkRead(db, uid, items, now));
      // Every page of the member reads the bell again; a tournament notice read here is a personal message read too.
      realtimeToUsers(c, [uid], { scope: 'user', type: 'notification.changed' });
      if (items.some((i) => i.kind === 'tournament_start' || i.kind === 'tournament_cancel')) realtimeToUsers(c, [uid], { scope: 'user', type: 'message.changed' });
    }
    return c.json({ read: items.length });
  });
