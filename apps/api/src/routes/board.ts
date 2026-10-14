import { schema } from '@jc/db';
import { CommentCreateSchema, CommentInputSchema, PostInputSchema, type AuthorDto, type CommentDto, type MyCommentDto, type PostDetailDto, type PostListItemDto, type PostPageDto } from '@jc/types';
import { and, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { handReviews } from '../lib/community';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';

const PAGE_SIZE = 20;
const replyTarget = alias(schema.users, 'reply_target');
const author = {
  id: schema.users.id,
  nickname: schema.users.nickname,
  avatarUrl: schema.users.avatarUrl,
  role: schema.users.role,
  status: schema.users.status,
};

type AuthorRow = { id: string; nickname: string; avatarUrl: string | null; role: string; status: string };
/** Posts and comments outlive a deleted account; its tombstone nickname is not shown, only "withdrawn member". */
const toAuthor = (a: AuthorRow): AuthorDto =>
  a.status === 'deleted'
    ? { id: a.id, nickname: '', avatarUrl: null, isAdmin: false, withdrawn: true }
    : { id: a.id, nickname: a.nickname, avatarUrl: a.avatarUrl, isAdmin: a.role !== 'user' };

export async function listItems(c: Context<AppEnv>, where: ReturnType<typeof and>, limit: number, offset: number): Promise<PostListItemDto[]> {
  const rows = await c.var.db
    .select({ p: schema.posts, a: author, hands: sql<number>`(SELECT COUNT(*) FROM post_hands ph WHERE ph.post_id = ${schema.posts.id})` })
    .from(schema.posts)
    .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
    .where(where)
    .orderBy(desc(schema.posts.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(({ p, a, hands }) => ({
    id: p.id,
    title: p.title,
    isNotice: p.isNotice,
    author: toAuthor(a),
    commentCount: p.commentCount,
    viewCount: p.viewCount,
    handCount: Number(hands),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/** Hand ids must be finished hands the author played; duplicates are dropped. */
async function validHandIds(c: Context<AppEnv>, userId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await c.var.db
    .select({ id: schema.handPlayers.handId })
    .from(schema.handPlayers)
    .where(and(eq(schema.handPlayers.userId, userId), inArray(schema.handPlayers.handId, unique)));
  const ok = new Set(rows.map((r) => r.id));
  const bad = unique.filter((id) => !ok.has(id));
  if (bad.length) fail(400, 'invalid_hand', 'you can only attach finished hands you played');
  return unique;
}

async function replaceHands(c: Context<AppEnv>, postId: string, handIds: string[]) {
  await c.var.db.delete(schema.postHands).where(eq(schema.postHands.postId, postId));
  if (handIds.length) await c.var.db.insert(schema.postHands).values(handIds.map((handId, sort) => ({ postId, handId, sort })));
}

export async function postDetail(c: Context<AppEnv>, id: string, viewerId: string, includeHidden = false): Promise<PostDetailDto> {
  const row = await c.var.db
    .select({ p: schema.posts, a: author })
    .from(schema.posts)
    .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
    .where(and(eq(schema.posts.id, id), includeHidden ? sql`1 = 1` : eq(schema.posts.status, 'visible')))
    .limit(1);
  const r = row[0];
  if (!r) fail(404, 'not_found', 'post not found');
  const attached = await c.var.db.select().from(schema.postHands).where(eq(schema.postHands.postId, id)).orderBy(schema.postHands.sort);
  // Hand reviews are rendered from the AUTHOR's perspective, whoever is reading.
  const hands = await handReviews(c.var.db, attached.map((h) => h.handId), r.p.authorId);
  const all = await c.var.db
    .select({ c: schema.comments, a: author, replyTo: sql<string | null>`CASE WHEN ${replyTarget.status} = 'deleted' THEN NULL ELSE ${replyTarget.nickname} END` })
    .from(schema.comments)
    .innerJoin(schema.users, eq(schema.users.id, schema.comments.authorId))
    .leftJoin(replyTarget, eq(replyTarget.id, schema.comments.replyToUserId))
    .where(eq(schema.comments.postId, id))
    .orderBy(schema.comments.createdAt);
  const shown = (s: string) => s === 'visible' || (includeHidden && s === 'hidden');
  // A removed top-level comment stays as a placeholder while it still has visible replies.
  const liveReplies = new Set(all.filter((x) => x.c.parentId && shown(x.c.status)).map((x) => x.c.parentId!));
  const cm = all.filter((x) => shown(x.c.status) || (!x.c.parentId && liveReplies.has(x.c.id)));
  return {
    id: r.p.id,
    title: r.p.title,
    body: r.p.body,
    isNotice: r.p.isNotice,
    author: toAuthor(r.a),
    isMine: r.p.authorId === viewerId,
    commentCount: r.p.commentCount,
    viewCount: r.p.viewCount,
    handCount: hands.length,
    createdAt: r.p.createdAt,
    updatedAt: r.p.updatedAt,
    hands,
    comments: cm.map(({ c: x, a, replyTo }): CommentDto => {
      const deleted = !shown(x.status);
      return {
        id: x.id,
        parentId: x.parentId,
        replyTo: replyTo ?? null,
        deleted,
        body: deleted ? '' : x.body,
        author: deleted ? { id: '', nickname: '', avatarUrl: null, isAdmin: false } : toAuthor(a),
        isMine: !deleted && x.authorId === viewerId,
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
      };
    }),
  };
}

export async function recountComments(c: Context<AppEnv>, postId: string) {
  await c.env.DB.prepare(`UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?1 AND status = 'visible') WHERE id = ?1`).bind(postId).run();
}

export const boardRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/posts', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
    const q = (c.req.query('q') ?? '').trim().slice(0, 50);
    const search = q ? or(like(schema.posts.title, `%${q}%`), like(schema.posts.body, `%${q}%`)) : undefined;
    const regular = and(eq(schema.posts.status, 'visible'), eq(schema.posts.isNotice, false), search);
    const [notices, posts, total] = await Promise.all([
      page === 1 ? listItems(c, and(eq(schema.posts.status, 'visible'), eq(schema.posts.isNotice, true)), 10, 0) : Promise.resolve([]),
      listItems(c, regular, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      c.var.db.select({ n: count() }).from(schema.posts).where(regular),
    ]);
    const out: PostPageDto = { notices, posts, total: total[0]?.n ?? 0, page, pageSize: PAGE_SIZE };
    return c.json(out);
  })
  .get('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const detail = await postDetail(c, id, c.var.user!.id);
    c.executionCtx.waitUntil(c.env.DB.prepare(`UPDATE posts SET view_count = view_count + 1 WHERE id = ?1`).bind(id).run().then(() => undefined));
    return c.json(detail);
  })
  .post('/posts', async (c) => {
    const me = c.var.user!;
    await rateLimit(c, `post:${me.id}`, 10, 60 * 60 * 1000);
    const body = await parseBody(c, PostInputSchema);
    const handIds = await validHandIds(c, me.id, body.handIds);
    const id = crypto.randomUUID();
    await c.var.db.insert(schema.posts).values({ id, authorId: me.id, title: body.title, body: body.body });
    await replaceHands(c, id, handIds);
    return c.json({ id }, 201);
  })
  .patch('/posts/:id', async (c) => {
    const me = c.var.user!;
    const id = c.req.param('id');
    const body = await parseBody(c, PostInputSchema);
    const post = await c.var.db.query.posts.findFirst({ where: eq(schema.posts.id, id) });
    if (!post || post.status === 'deleted') fail(404, 'not_found', 'post not found');
    if (post.authorId !== me.id || post.isNotice) fail(403, 'forbidden', 'only the author can edit this post');
    const handIds = await validHandIds(c, me.id, body.handIds);
    await c.var.db.update(schema.posts).set({ title: body.title, body: body.body, updatedAt: Date.now() }).where(eq(schema.posts.id, id));
    await replaceHands(c, id, handIds);
    return c.json({ ok: true });
  })
  .delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const post = await c.var.db.query.posts.findFirst({ where: eq(schema.posts.id, id) });
    if (!post || post.status === 'deleted') fail(404, 'not_found', 'post not found');
    if (post.authorId !== c.var.user!.id || post.isNotice) fail(403, 'forbidden', 'only the author can delete this post');
    await c.var.db.update(schema.posts).set({ status: 'deleted', updatedAt: Date.now() }).where(eq(schema.posts.id, id));
    return c.json({ ok: true });
  })
  .post('/posts/:id/comments', async (c) => {
    const me = c.var.user!;
    await rateLimit(c, `comment:${me.id}`, 30, 10 * 60 * 1000);
    const id = c.req.param('id');
    const body = await parseBody(c, CommentCreateSchema);
    const post = await c.var.db.query.posts.findFirst({ where: and(eq(schema.posts.id, id), eq(schema.posts.status, 'visible')) });
    if (!post) fail(404, 'not_found', 'post not found');
    let parentId: string | null = null;
    let replyToUserId: string | null = null;
    if (body.parentId) {
      const parent = await c.var.db.query.comments.findFirst({ where: and(eq(schema.comments.id, body.parentId), eq(schema.comments.postId, id)) });
      if (!parent || parent.status !== 'visible') fail(404, 'not_found', 'comment to reply to not found');
      // Threads are two levels deep: a reply to a reply joins the same thread and mentions its author.
      parentId = parent.parentId ?? parent.id;
      replyToUserId = parent.parentId ? parent.authorId : null;
    }
    const cid = crypto.randomUUID();
    await c.var.db.insert(schema.comments).values({ id: cid, postId: id, authorId: me.id, parentId, replyToUserId, body: body.body });
    await recountComments(c, id);
    return c.json({ id: cid }, 201);
  })
  .patch('/comments/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, CommentInputSchema);
    const cm = await c.var.db.query.comments.findFirst({ where: eq(schema.comments.id, id) });
    if (!cm || cm.status === 'deleted') fail(404, 'not_found', 'comment not found');
    if (cm.authorId !== c.var.user!.id) fail(403, 'forbidden', 'only the author can edit this comment');
    await c.var.db.update(schema.comments).set({ body: body.body, updatedAt: Date.now() }).where(eq(schema.comments.id, id));
    return c.json({ ok: true });
  })
  .delete('/comments/:id', async (c) => {
    const id = c.req.param('id');
    const cm = await c.var.db.query.comments.findFirst({ where: eq(schema.comments.id, id) });
    if (!cm || cm.status === 'deleted') fail(404, 'not_found', 'comment not found');
    if (cm.authorId !== c.var.user!.id) fail(403, 'forbidden', 'only the author can delete this comment');
    await c.var.db.update(schema.comments).set({ status: 'deleted', updatedAt: Date.now() }).where(eq(schema.comments.id, id));
    await recountComments(c, cm.postId);
    return c.json({ ok: true });
  });

/** Mounted under /api/me: the viewer's own posts and comments. */
export const myCommunityRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/posts', async (c) => {
    const items = await listItems(c, and(eq(schema.posts.authorId, c.var.user!.id), sql`${schema.posts.status} != 'deleted'`), 50, 0);
    return c.json(items);
  })
  .get('/comments', async (c) => {
    const rows = await c.var.db
      .select({ c: schema.comments, title: schema.posts.title })
      .from(schema.comments)
      .innerJoin(schema.posts, eq(schema.posts.id, schema.comments.postId))
      .where(and(eq(schema.comments.authorId, c.var.user!.id), eq(schema.comments.status, 'visible'), eq(schema.posts.status, 'visible')))
      .orderBy(desc(schema.comments.createdAt))
      .limit(50);
    const out: MyCommentDto[] = rows.map((r) => ({ id: r.c.id, body: r.c.body, postId: r.c.postId, postTitle: r.title, createdAt: r.c.createdAt }));
    return c.json(out);
  });
