import { schema } from '@jc/db';
import {
  DirectMessageSchema,
  FriendRequestSchema,
  MAX_FRIENDS,
  type ConversationDto,
  type DirectMessageDto,
  type FriendDto,
  type FriendRequestDto,
  type FriendRequestResultDto,
  type FriendsDto,
  type PublicUserDto,
} from '@jc/types';
import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';

const DM_PAGE = 50;

/** Friendship rows and DM threads key a pair by its two ids in sorted order. */
export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const pairKey = (x: string, y: string) => pairOf(x, y).join(':');

async function relation(c: Context<AppEnv>, me: string, other: string) {
  const [a, b] = pairOf(me, other);
  return c.var.db.query.friendships.findFirst({ where: and(eq(schema.friendships.userA, a), eq(schema.friendships.userB, b)) });
}

async function publicUser(c: Context<AppEnv>, where: { id?: string; nickname?: string }): Promise<PublicUserDto | null> {
  const u = await c.var.db.query.users.findFirst({
    where: where.id ? eq(schema.users.id, where.id) : sql`lower(${schema.users.nickname}) = lower(${where.nickname ?? ''})`,
    columns: { id: true, nickname: true, avatarUrl: true, status: true },
  });
  if (!u || u.status === 'deleted') return null;
  return { id: u.id, nickname: u.nickname, avatarUrl: u.avatarUrl };
}

async function friendCount(c: Context<AppEnv>, uid: string): Promise<number> {
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM friendships WHERE (user_a = ?1 OR user_b = ?1) AND status = 'accepted'`).bind(uid).first<{ n: number }>();
  return r?.n ?? 0;
}

async function accept(c: Context<AppEnv>, me: string, other: string) {
  if ((await friendCount(c, me)) >= MAX_FRIENDS || (await friendCount(c, other)) >= MAX_FRIENDS) fail(409, 'friend_limit', `at most ${MAX_FRIENDS} friends`);
  const [a, b] = pairOf(me, other);
  await c.var.db
    .update(schema.friendships)
    .set({ status: 'accepted', acceptedAt: Date.now() })
    .where(and(eq(schema.friendships.userA, a), eq(schema.friendships.userB, b), eq(schema.friendships.status, 'pending')));
}

type FriendRow = { status: 'pending' | 'accepted'; requesterId: string; createdAt: number; acceptedAt: number | null; id: string; nickname: string; avatarUrl: string | null; unread: number; last: string | null };

/** Friends, received and sent requests. */
export const friendRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const uid = c.var.user!.id;
    const { results } = await c.env.DB.prepare(
      `SELECT f.status, f.requester_id AS requesterId, f.created_at AS createdAt, f.accepted_at AS acceptedAt,
              u.id, u.nickname, u.avatar_url AS avatarUrl,
              (SELECT COUNT(*) FROM direct_messages d WHERE d.pair_key = f.user_a || ':' || f.user_b AND d.recipient_id = ?1 AND d.read_at IS NULL) AS unread,
              (SELECT json_object('body', d.body, 'senderId', d.sender_id, 'at', d.created_at) FROM direct_messages d
                WHERE d.pair_key = f.user_a || ':' || f.user_b ORDER BY d.created_at DESC LIMIT 1) AS last
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
        WHERE (f.user_a = ?1 OR f.user_b = ?1) AND u.status != 'deleted'`,
    )
      .bind(uid)
      .all<FriendRow>();
    const out: FriendsDto = { friends: [], incoming: [], outgoing: [] };
    for (const r of results) {
      const user = { id: r.id, nickname: r.nickname, avatarUrl: r.avatarUrl };
      if (r.status === 'pending') {
        const req: FriendRequestDto = { ...user, at: r.createdAt };
        (r.requesterId === uid ? out.outgoing : out.incoming).push(req);
        continue;
      }
      const last = r.last ? (JSON.parse(r.last) as { body: string; senderId: string; at: number }) : null;
      const f: FriendDto = { ...user, since: r.acceptedAt ?? r.createdAt, unread: r.unread, lastMessage: last ? { body: last.body, fromMe: last.senderId === uid, at: last.at } : null };
      out.friends.push(f);
    }
    // Recent conversations first, then by name.
    out.friends.sort((x, y) => (y.lastMessage?.at ?? 0) - (x.lastMessage?.at ?? 0) || x.nickname.localeCompare(y.nickname));
    out.incoming.sort((x, y) => y.at - x.at);
    out.outgoing.sort((x, y) => y.at - x.at);
    return c.json(out);
  })
  .post('/requests', async (c) => {
    const body = await parseBody(c, FriendRequestSchema);
    const me = c.var.user!.id;
    await rateLimit(c, `friend-req:${me}`, 30, 60 * 60_000);
    const user = await publicUser(c, body.userId ? { id: body.userId } : { nickname: body.nickname });
    if (!user) fail(404, 'user_not_found', 'no such player');
    if (user.id === me) fail(400, 'friend_self', 'you cannot add yourself');
    const existing = await relation(c, me, user.id);
    if (existing?.status === 'accepted') fail(409, 'already_friends', 'already friends');
    if (existing?.requesterId === me) fail(409, 'already_requested', 'request already sent');
    if (existing) {
      // They had already asked: this completes the friendship.
      await accept(c, me, user.id);
      return c.json({ status: 'accepted', user } satisfies FriendRequestResultDto);
    }
    if ((await friendCount(c, me)) >= MAX_FRIENDS) fail(409, 'friend_limit', `at most ${MAX_FRIENDS} friends`);
    const [a, b] = pairOf(me, user.id);
    await c.var.db.insert(schema.friendships).values({ userA: a, userB: b, requesterId: me, createdAt: Date.now() }).onConflictDoNothing();
    const row = await relation(c, me, user.id);
    // A crossing request from the other side won the insert race.
    if (row && row.requesterId !== me && row.status === 'pending') {
      await accept(c, me, user.id);
      return c.json({ status: 'accepted', user } satisfies FriendRequestResultDto);
    }
    return c.json({ status: row?.status ?? 'pending', user } satisfies FriendRequestResultDto, 201);
  })
  .post('/:userId/accept', async (c) => {
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    const row = await relation(c, me, other);
    if (!row || row.status !== 'pending' || row.requesterId === me) fail(404, 'not_found', 'no pending request from this player');
    await accept(c, me, other);
    return c.json({ ok: true });
  })
  /** Declines a received request, cancels a sent one, or removes a friend. */
  .delete('/:userId', async (c) => {
    const [a, b] = pairOf(c.var.user!.id, c.req.param('userId'));
    const r = await c.var.db
      .delete(schema.friendships)
      .where(and(eq(schema.friendships.userA, a), eq(schema.friendships.userB, b)))
      .returning({ a: schema.friendships.userA });
    if (!r[0]) fail(404, 'not_found', 'no friendship or request with this player');
    return c.json({ ok: true });
  });

const toDm = (uid: string) => (m: typeof schema.directMessages.$inferSelect): DirectMessageDto => ({ id: m.id, fromMe: m.senderId === uid, body: m.body, at: m.createdAt, readAt: m.readAt });

/** 1:1 messages. Only friends can send; past messages stay readable after unfriending. */
export const dmRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  /**
   * ?before=<ms>&beforeId=<id> pages back from the oldest message the client has (messages are ordered by time, then id,
   * so ties in the same millisecond are not skipped); ?after=<ms> polls for new messages (inclusive, the client drops ids it has).
   */
  .get('/:userId', async (c) => {
    const me = c.var.user!.id;
    const user = await publicUser(c, { id: c.req.param('userId') });
    if (!user || user.id === me) fail(404, 'user_not_found', 'no such player');
    const key = pairKey(me, user.id);
    const before = Number(c.req.query('before')) || 0;
    const beforeId = c.req.query('beforeId');
    const after = Number(c.req.query('after')) || 0;
    const t = schema.directMessages;
    let rows;
    if (after) {
      rows = await c.var.db.select().from(t).where(and(eq(t.pairKey, key), sql`${t.createdAt} >= ${after}`)).orderBy(t.createdAt, t.id).limit(DM_PAGE + 1);
    } else {
      const older = !before
        ? undefined
        : beforeId
          ? sql`(${t.createdAt} < ${before} OR (${t.createdAt} = ${before} AND ${t.id} < ${beforeId}))`
          : sql`${t.createdAt} < ${before}`;
      rows = await c.var.db
        .select()
        .from(t)
        .where(and(eq(t.pairKey, key), older))
        .orderBy(sql`${t.createdAt} DESC`, sql`${t.id} DESC`)
        .limit(DM_PAGE + 1);
      rows.reverse();
    }
    const hasMore = rows.length > DM_PAGE;
    if (hasMore) rows = after ? rows.slice(0, DM_PAGE) : rows.slice(1);
    const rel = await relation(c, me, user.id);
    return c.json({ user, isFriend: rel?.status === 'accepted', messages: rows.map(toDm(me)), hasMore } satisfies ConversationDto);
  })
  .post('/:userId', async (c) => {
    const body = await parseBody(c, DirectMessageSchema);
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    const rel = await relation(c, me, other);
    if (rel?.status !== 'accepted') fail(403, 'not_friends', 'you can only message friends');
    const user = await publicUser(c, { id: other });
    if (!user) fail(404, 'user_not_found', 'no such player');
    await rateLimit(c, `dm:${me}`, 30, 60_000);
    const row = { id: crypto.randomUUID(), pairKey: pairKey(me, other), senderId: me, recipientId: other, body: body.text, createdAt: Date.now() };
    await c.var.db.insert(schema.directMessages).values(row);
    return c.json(toDm(me)({ ...row, readAt: null }), 201);
  })
  .post('/:userId/read', async (c) => {
    const me = c.var.user!.id;
    const t = schema.directMessages;
    await c.var.db
      .update(t)
      .set({ readAt: Date.now() })
      .where(and(eq(t.pairKey, pairKey(me, c.req.param('userId'))), eq(t.recipientId, me), sql`${t.readAt} IS NULL`));
    return c.json({ ok: true });
  });
