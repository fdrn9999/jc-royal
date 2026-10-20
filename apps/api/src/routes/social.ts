import { outboxOne, schema, type OutboxOne } from '@jc/db';
import {
  DirectMessageSchema,
  DmReadSchema,
  FriendRequestSchema,
  isKstNight,
  MAX_BLOCKS,
  MAX_FRIENDS,
  publicRole,
  shownVip,
  SocialSettingsSchema,
  TableInviteSchema,
  type BlockedUserDto,
  type ConversationDto,
  type DirectMessageDto,
  type DmKind,
  type FriendDto,
  type FriendRequestDto,
  type FriendRequestResultDto,
  type FriendsDto,
  type FriendsPresenceDto,
  type PresenceMode,
  type PresenceState,
  type PublicUserDto,
  type RelationDto,
  type SocialSettingsDto,
} from '@jc/types';
import { and, desc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireUserQuiet } from '../lib/auth';
import { badgesFor, type Badge } from '../lib/badges';
import { fail, parseBody } from '../lib/http';
import { queuePush } from '../lib/notify';
import { applyMode, hubCall, type HubQuery } from '../lib/presence';
import { rateLimit } from '../lib/rate-limit';

const DM_PAGE = 50;

/** Friendship rows and DM threads key a pair by its two ids in sorted order. */
export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const pairKey = (x: string, y: string) => pairOf(x, y).join(':');

async function relation(c: Context<AppEnv>, me: string, other: string) {
  const [a, b] = pairOf(me, other);
  return c.var.db.query.friendships.findFirst({ where: and(eq(schema.friendships.userA, a), eq(schema.friendships.userB, b)) });
}

/**
 * A member as other players see them, with the staff role (see PublicRole) drawn from `users.role` when the social
 * policy shows that role's badge (`badge`, from badgesFor), and the VIP color (shownVip) read in the same query.
 */
const toPublic = (
  u: { id: string; nickname: string; avatarUrl: string | null; role: string; status?: string; isBot?: boolean | number; vipColor?: string | null },
  badge: Badge = publicRole,
): PublicUserDto => {
  const role = badge(u.role);
  const vip = shownVip(u);
  return { id: u.id, nickname: u.nickname, avatarUrl: u.avatarUrl, ...(role ? { role } : {}), ...(vip ? { vip } : {}) };
};

/** The player friend requests, blocks and messages are about. Table bots are not members and take none of them. */
async function publicUser(c: Context<AppEnv>, where: { id?: string; nickname?: string }): Promise<PublicUserDto | null> {
  const u = await c.var.db.query.users.findFirst({
    where: where.id ? eq(schema.users.id, where.id) : sql`lower(${schema.users.nickname}) = lower(${where.nickname ?? ''})`,
    columns: { id: true, nickname: true, avatarUrl: true, role: true, status: true, isBot: true, vipColor: true },
  });
  if (!u || u.status === 'deleted') return null;
  if (u.isBot) fail(409, 'bot_account', 'table bots take no friend requests, blocks or messages');
  return toPublic(u, await badgesFor(c, [u.role]));
}

/**
 * Staff (admins and the super admin) cannot be blocked. A block made before that rule, or before the player became
 * staff, stays in `user_blocks` but has no effect and is not listed while they are staff; it applies again if they
 * go back to being a member. Every block check joins the blocked player's role for that.
 */
const IN_FORCE = `JOIN users bu ON bu.id = ub.blocked_id AND bu.role = 'user'`;

/** SQL condition: neither of the two placeholders has blocked the other. */
const notBlocked = (a: string, b: string) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks ub ${IN_FORCE} WHERE (ub.blocker_id = ${a} AND ub.blocked_id = ${b}) OR (ub.blocker_id = ${b} AND ub.blocked_id = ${a}))`;

/** 'mine' when I blocked them, 'theirs' when they blocked me (which is never shown to me as such). */
async function blockState(c: Context<AppEnv>, me: string, other: string): Promise<'none' | 'mine' | 'theirs'> {
  const { results } = await c.env.DB.prepare(
    `SELECT ub.blocker_id AS blocker FROM user_blocks ub ${IN_FORCE} WHERE (ub.blocker_id = ?1 AND ub.blocked_id = ?2) OR (ub.blocker_id = ?2 AND ub.blocked_id = ?1)`,
  )
    .bind(me, other)
    .all<{ blocker: string }>();
  if (results.some((r) => r.blocker === me)) return 'mine';
  return results.length ? 'theirs' : 'none';
}

async function friendCount(c: Context<AppEnv>, uid: string): Promise<number> {
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM friendships WHERE (user_a = ?1 OR user_b = ?1) AND status = 'accepted'`).bind(uid).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Queues a push to `to` for an action already saved (lib/notify.ts): sent in the background, checked again when it goes
 * out; a push that can't be queued is only logged.
 */
function pushTo(c: Context<AppEnv>, to: string, e: Omit<OutboxOne, 'userId' | 'now' | 'night'>): Promise<number> {
  let ctx: Pick<ExecutionContext, 'waitUntil'> | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  const now = Date.now();
  return queuePush(c.env, [outboxOne(c.env.DB, { ...e, userId: to, now, night: isKstNight(now) })], ctx, to);
}

/** Turns the pending request between the two into a friendship (the one who asked is told). False when there was none to accept. */
async function accept(c: Context<AppEnv>, me: string, other: string): Promise<boolean> {
  if ((await friendCount(c, me)) >= MAX_FRIENDS || (await friendCount(c, other)) >= MAX_FRIENDS) fail(409, 'friend_limit', `at most ${MAX_FRIENDS} friends`);
  const [a, b] = pairOf(me, other);
  const r = await c.env.DB.prepare(`UPDATE friendships SET status = 'accepted', accepted_at = ?3 WHERE user_a = ?1 AND user_b = ?2 AND status = 'pending' AND ${notBlocked('?1', '?2')}`)
    .bind(a, b, Date.now())
    .run();
  if (!r.meta.changes) return false;
  await pushTo(c, other, { dedupeKey: `friend_accepted:${me}:${other}`, type: 'friend_accepted', url: `/friends/${me}`, coalesceKey: `fa:${me}` });
  return true;
}

/** The same answer whether they blocked me or turned requests off, so a block is never revealed. */
const requestUnavailable = (): never => fail(403, 'request_unavailable', 'this player is not taking friend requests from you');

/**
 * GET /api/friends/presence: my accepted friends' status, mounted before friendRoutes so a friends page polling it
 * (PRESENCE_POLL_MS) checks the sign-in without sliding it. Takes no ids: the list is decided here, from D1, as the
 * friends who are active members neither side has blocked, so a pending request, a block, an unfriending, a
 * suspension or a withdrawal shows nothing (the member is simply absent, the same answer as never befriended). Online /
 * away / offline, and for a friend shown offline when they were last confirmed online (docs/PRESENCE.md): the later of
 * the hub's time and the saved one (users.last_online_at, read in the same query), to the minute, never made up.
 */
export const friendPresenceRoutes = new Hono<AppEnv>().get('/presence', requireUserQuiet, async (c) => {
  const uid = c.var.user!.id;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.presence_mode AS mode, u.last_online_at AS lastOnline
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
      WHERE (f.user_a = ?1 OR f.user_b = ?1) AND f.status = 'accepted' AND u.status = 'active' AND u.is_bot = 0
        AND ${notBlocked('?1', 'u.id')}
      LIMIT ${MAX_FRIENDS}`,
  )
    .bind(uid)
    .all<{ id: string; mode: PresenceMode; lastOnline: number | null }>();
  // Every friend is asked about for the last-online time. Invisible friends are offline whatever their devices do, and
  // their time stays where it was when they chose it: their beats never move it (the hub's `mark`).
  let live: Record<string, PresenceState> = {};
  const seen: Record<string, number> = {};
  if (results.length) {
    // The hub's times come as how long before it answered: counted back from when the question left, on this clock.
    const asked = Date.now();
    const r = await hubCall<HubQuery>(c.env, 'query', { asker: uid, ids: results.map((f) => f.id), seen: true });
    if (r?.limited) fail(429, 'rate_limited', 'too many status requests; slow down');
    live = r?.presence ?? {};
    for (const [id, ago] of Object.entries(r?.seenAgo ?? {})) seen[id] = asked - ago;
  }
  const now = Date.now();
  const presence: Record<string, PresenceState> = {};
  const lastOnline: Record<string, number> = {};
  for (const f of results) {
    const state = applyMode(f.mode, live[f.id] ?? 'offline');
    presence[f.id] = state;
    const at = Math.min(Math.max(seen[f.id] ?? 0, f.lastOnline ?? 0), now);
    if (state === 'offline' && at > 0) lastOnline[f.id] = Math.floor(at / 60_000) * 60_000;
  }
  return c.json({ presence, ...(Object.keys(lastOnline).length ? { lastOnline } : {}) } satisfies FriendsPresenceDto);
});

type FriendRow = {
  status: 'pending' | 'accepted';
  requesterId: string;
  createdAt: number;
  acceptedAt: number | null;
  id: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  /** The member's account status (the friendship's is `status`). */
  userStatus: string;
  isBot: number;
  vipColor: string | null;
  unread: number;
  last: string | null;
};

/** Friends, received and sent requests. */
export const friendRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const uid = c.var.user!.id;
    const { results } = await c.env.DB.prepare(
      `SELECT f.status, f.requester_id AS requesterId, f.created_at AS createdAt, f.accepted_at AS acceptedAt,
              u.id, u.nickname, u.avatar_url AS avatarUrl, u.role, u.status AS userStatus, u.is_bot AS isBot, u.vip_color AS vipColor,
              (SELECT COUNT(*) FROM direct_messages d WHERE d.pair_key = f.user_a || ':' || f.user_b AND d.recipient_id = ?1 AND d.read_at IS NULL) AS unread,
              (SELECT json_object('body', d.body, 'senderId', d.sender_id, 'at', d.created_at, 'kind', d.kind) FROM direct_messages d
                WHERE d.pair_key = f.user_a || ':' || f.user_b ORDER BY d.created_at DESC LIMIT 1) AS last
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
        WHERE (f.user_a = ?1 OR f.user_b = ?1) AND u.status != 'deleted'`,
    )
      .bind(uid)
      .all<FriendRow>();
    const out: FriendsDto = { friends: [], incoming: [], outgoing: [] };
    const badge = await badgesFor(c, results.map((r) => r.role));
    for (const r of results) {
      const user = toPublic({ ...r, status: r.userStatus }, badge);
      if (r.status === 'pending') {
        const req: FriendRequestDto = { ...user, at: r.createdAt };
        (r.requesterId === uid ? out.outgoing : out.incoming).push(req);
        continue;
      }
      const last = r.last ? (JSON.parse(r.last) as { body: string; senderId: string; at: number; kind: DmKind }) : null;
      const lastMessage = last ? { body: last.body, fromMe: last.senderId === uid, at: last.at, kind: last.kind } : null;
      const f: FriendDto = { ...user, since: r.acceptedAt ?? r.createdAt, unread: r.unread, lastMessage };
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
    const block = await blockState(c, me, user.id);
    if (block === 'mine') fail(409, 'blocked_user', 'unblock this player first');
    if (block === 'theirs') requestUnavailable();
    const existing = await relation(c, me, user.id);
    if (existing?.status === 'accepted') fail(409, 'already_friends', 'already friends');
    if (existing?.requesterId === me) fail(409, 'already_requested', 'request already sent');
    if (existing) {
      // They had already asked: this completes the friendship.
      if (!(await accept(c, me, user.id))) requestUnavailable();
      return c.json({ status: 'accepted', user } satisfies FriendRequestResultDto);
    }
    const prefs = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, user.id), columns: { friendRequests: true } });
    if (prefs?.friendRequests === 'nobody') requestUnavailable();
    if ((await friendCount(c, me)) >= MAX_FRIENDS) fail(409, 'friend_limit', `at most ${MAX_FRIENDS} friends`);
    const [a, b] = pairOf(me, user.id);
    // Inserted only while neither side has blocked the other, in one statement, so a block that lands while this
    // request is in flight still wins (the block itself deletes any row written before it).
    const made = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO friendships (user_a, user_b, requester_id, status, created_at) SELECT ?1, ?2, ?3, 'pending', ?4 WHERE ${notBlocked('?1', '?2')}`,
    )
      .bind(a, b, me, Date.now())
      .run();
    const row = await relation(c, me, user.id);
    if (!row) return requestUnavailable();
    // A crossing request from the other side won the insert race.
    if (row.requesterId !== me && row.status === 'pending') {
      if (!(await accept(c, me, user.id))) requestUnavailable();
      return c.json({ status: 'accepted', user } satisfies FriendRequestResultDto);
    }
    // Told only when this made the request (the same request again within the outbox's week is not told twice).
    if (made.meta.changes > 0 && row.requesterId === me && row.status === 'pending')
      await pushTo(c, user.id, { dedupeKey: `friend_request:${me}:${user.id}`, type: 'friend_request', url: '/friends', coalesceKey: `fr:${me}` });
    return c.json({ status: row.status, user } satisfies FriendRequestResultDto, 201);
  })
  .get('/settings', async (c) => {
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, c.var.user!.id), columns: { friendRequests: true, dmNotifications: true } });
    return c.json({ friendRequests: u?.friendRequests ?? 'everyone', dmNotifications: u?.dmNotifications ?? true } satisfies SocialSettingsDto);
  })
  .patch('/settings', async (c) => {
    const body = await parseBody(c, SocialSettingsSchema);
    const [r] = await c.var.db
      .update(schema.users)
      .set({ ...body, updatedAt: Date.now() })
      .where(eq(schema.users.id, c.var.user!.id))
      .returning({ friendRequests: schema.users.friendRequests, dmNotifications: schema.users.dmNotifications });
    return c.json(r! satisfies SocialSettingsDto);
  })
  /** My side of the relation only: a player who blocked me reads as 'none'. */
  .get('/:userId/relation', async (c) => {
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    const [block, rel] = await Promise.all([blockState(c, me, other), relation(c, me, other)]);
    const kind: RelationDto['relation'] =
      block === 'mine' ? 'blocked' : !rel ? 'none' : rel.status === 'accepted' ? 'friend' : rel.requesterId === me ? 'outgoing' : 'incoming';
    return c.json({ relation: kind } satisfies RelationDto);
  })
  .post('/:userId/accept', async (c) => {
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    const row = await relation(c, me, other);
    if (!row || row.status !== 'pending' || row.requesterId === me) fail(404, 'not_found', 'no pending request from this player');
    if (!(await accept(c, me, other))) fail(404, 'not_found', 'no pending request from this player');
    return c.json({ ok: true });
  })
  /**
   * Asks a friend to play at an open table, as a 1:1 message with a join card. It carries no join code and grants
   * nothing: the table checks seats, the join code and spectating as for anyone else.
   */
  .post('/:userId/invite', async (c) => {
    const body = await parseBody(c, TableInviteSchema);
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    const rel = await relation(c, me, other);
    if (rel?.status !== 'accepted') fail(403, 'not_friends', 'you can only invite friends');
    await rateLimit(c, `invite:${me}`, 20, 10 * 60_000);
    const t = await c.env.DB.prepare(`SELECT id, name FROM tables WHERE id = ?1 AND status = 'open' AND entry_blocked = 0`)
      .bind(body.tableId)
      .first<{ id: string; name: string }>();
    if (!t) fail(409, 'table_unavailable', 'this table is not open');
    const row = await insertDm(c, me, other, { body: t.name, kind: 'invite', tableId: t.id });
    // The push opens the conversation; joining is checked by the table as always.
    await pushTo(c, other, { dedupeKey: `invite:${row.id}`, type: 'invite', url: `/friends/${me}`, coalesceKey: `invite:${me}` });
    return c.json(toDm(me)(row), 201);
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

/**
 * My block list. Blocking is personal: it deletes the friendship or pending requests with that player and stops new
 * requests and 1:1 messages both ways. It keeps nobody off a table; admin sanctions are a separate thing. Staff cannot
 * be blocked (see IN_FORCE): they answer members and send them notices.
 */
export const blockRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.nickname, u.avatar_url AS avatarUrl, u.role, u.status, u.is_bot AS isBot, u.vip_color AS vipColor, b.created_at AS at
         FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?1 AND u.status != 'deleted' AND u.role = 'user' ORDER BY b.created_at DESC`,
    )
      .bind(c.var.user!.id)
      .all<{ id: string; nickname: string; avatarUrl: string | null; role: string; status: string; isBot: number; vipColor: string | null; at: number }>();
    return c.json(results.map((r): BlockedUserDto => ({ ...toPublic(r), at: r.at })));
  })
  .put('/:userId', async (c) => {
    const me = c.var.user!.id;
    const other = c.req.param('userId');
    if (other === me) fail(400, 'block_self', 'you cannot block yourself');
    const user = await publicUser(c, { id: other });
    if (!user) fail(404, 'user_not_found', 'no such player');
    if (user.role) fail(403, 'block_staff', 'admins and the super admin cannot be blocked');
    await rateLimit(c, `block:${me}`, 60, 60 * 60_000);
    const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_blocks ub ${IN_FORCE} WHERE ub.blocker_id = ?1`).bind(me).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_BLOCKS && (await blockState(c, me, other)) !== 'mine') fail(409, 'block_limit', `at most ${MAX_BLOCKS} blocked players`);
    const [a, b] = pairOf(me, other);
    // One transaction: the block row and the end of any friendship or request between the two.
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, ?3)`).bind(me, other, Date.now()),
      c.env.DB.prepare(`DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2`).bind(a, b),
    ]);
    return c.json({ ok: true });
  })
  .delete('/:userId', async (c) => {
    const r = await c.var.db
      .delete(schema.userBlocks)
      .where(and(eq(schema.userBlocks.blockerId, c.var.user!.id), eq(schema.userBlocks.blockedId, c.req.param('userId'))))
      .returning({ id: schema.userBlocks.blockedId });
    if (!r[0]) fail(404, 'not_found', 'this player is not blocked');
    return c.json({ ok: true });
  });

type DmRow = typeof schema.directMessages.$inferSelect;

const toDm =
  (uid: string) =>
  (m: DmRow): DirectMessageDto => ({ id: m.id, seq: m.seq, fromMe: m.senderId === uid, body: m.body, kind: m.kind, tableId: m.tableId, at: m.createdAt, readAt: m.readAt });

/**
 * Writes a 1:1 message only while the two are still friends and neither has blocked the other, checked in the same
 * statement as the insert, so an unfriend or a block that lands meanwhile is never overtaken by this message.
 * The same statement takes the conversation's next seq: D1 runs statements one at a time, so seq follows the order
 * messages are saved, and the unique (pair_key, seq) index would refuse a repeat rather than store it.
 */
async function insertDm(c: Context<AppEnv>, me: string, other: string, m: { body: string; kind: DmKind; tableId: string | null }): Promise<DmRow> {
  const row = { id: crypto.randomUUID(), pairKey: pairKey(me, other), senderId: me, recipientId: other, ...m, readAt: null, createdAt: Date.now() };
  const [a, b] = pairOf(me, other);
  const r = await c.env.DB.prepare(
    `INSERT INTO direct_messages (id, pair_key, sender_id, recipient_id, body, kind, table_id, created_at, seq)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(seq), 0) + 1 FROM direct_messages WHERE pair_key = ?2)
      WHERE EXISTS (SELECT 1 FROM friendships WHERE user_a = ?9 AND user_b = ?10 AND status = 'accepted') AND ${notBlocked('?3', '?4')}
     RETURNING seq`,
  )
    .bind(row.id, row.pairKey, me, other, row.body, row.kind, row.tableId, row.createdAt, a, b)
    .first<{ seq: number }>();
  if (!r) fail(403, 'not_friends', 'you can only message friends');
  return { ...row, seq: r.seq };
}

/** 1:1 messages. Only friends can send; past messages stay readable after unfriending. */
export const dmRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  /**
   * Messages go in seq order. ?afterSeq=<n> polls for newer ones (hasMore: more remain, ask again from the last seq);
   * ?beforeSeq=<n> pages back (hasMore: older ones remain); with neither, the latest page. A time cursor can pass over a
   * message whose clock time is earlier than one already fetched but which was saved later; a seq cursor cannot.
   * ?after=<ms> and ?before=<ms>&beforeId=<id> (by time, then id) still answer pages loaded before seq existed.
   */
  .get('/:userId', async (c) => {
    const me = c.var.user!.id;
    const user = await publicUser(c, { id: c.req.param('userId') });
    if (!user || user.id === me) fail(404, 'user_not_found', 'no such player');
    const key = pairKey(me, user.id);
    const seqParam = (k: string) => {
      const v = c.req.query(k);
      return v === undefined ? undefined : Math.max(0, Math.trunc(Number(v)) || 0);
    };
    const afterSeq = seqParam('afterSeq');
    const beforeSeq = seqParam('beforeSeq');
    const before = Number(c.req.query('before')) || 0;
    const beforeId = c.req.query('beforeId');
    const after = Number(c.req.query('after')) || 0;
    const t = schema.directMessages;
    const pair = eq(t.pairKey, key);
    const newer = afterSeq !== undefined || after > 0;
    let rows: DmRow[];
    if (afterSeq !== undefined) {
      rows = await c.var.db.select().from(t).where(and(pair, gt(t.seq, afterSeq))).orderBy(t.seq).limit(DM_PAGE + 1);
    } else if (after) {
      rows = await c.var.db.select().from(t).where(and(pair, sql`${t.createdAt} >= ${after}`)).orderBy(t.createdAt, t.id).limit(DM_PAGE + 1);
    } else if (before && beforeSeq === undefined) {
      const older = beforeId ? sql`(${t.createdAt} < ${before} OR (${t.createdAt} = ${before} AND ${t.id} < ${beforeId}))` : sql`${t.createdAt} < ${before}`;
      rows = await c.var.db.select().from(t).where(and(pair, older)).orderBy(desc(t.createdAt), desc(t.id)).limit(DM_PAGE + 1);
      rows.reverse();
    } else {
      rows = await c.var.db
        .select()
        .from(t)
        .where(and(pair, beforeSeq === undefined ? undefined : lt(t.seq, beforeSeq)))
        .orderBy(desc(t.seq))
        .limit(DM_PAGE + 1);
      rows.reverse();
    }
    const hasMore = rows.length > DM_PAGE;
    if (hasMore) rows = newer ? rows.slice(0, DM_PAGE) : rows.slice(1);
    const [rel, block, read] = await Promise.all([
      relation(c, me, user.id),
      blockState(c, me, user.id),
      // Reading marks everything up to a point, so the newest read message of mine is found walking back from the end.
      c.env.DB.prepare(
        `SELECT seq, read_at AS at FROM direct_messages WHERE pair_key = ?1 AND sender_id = ?2 AND read_at IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
        .bind(key, me)
        .first<{ seq: number; at: number }>(),
    ]);
    return c.json({
      user,
      isFriend: rel?.status === 'accepted',
      blocked: block === 'mine',
      messages: rows.map(toDm(me)),
      hasMore,
      peerRead: read ?? null,
    } satisfies ConversationDto);
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
    const row = await insertDm(c, me, other, { body: body.text, kind: 'text', tableId: null });
    await pushTo(c, other, { dedupeKey: `dm:${row.id}`, type: 'dm', url: `/friends/${me}`, coalesceKey: `dm:${me}` });
    return c.json(toDm(me)(row), 201);
  })
  /**
   * Marks their messages to me as read up to upToSeq, the newest one the page has shown, so one that arrives after the
   * page last fetched stays unread. Without it (pages from before seq post an empty body), everything is marked.
   */
  .post('/:userId/read', async (c) => {
    const me = c.var.user!.id;
    const raw: unknown = await c.req.json().catch(() => ({}));
    const parsed = DmReadSchema.safeParse(raw ?? {});
    if (!parsed.success) fail(400, 'bad_request', 'validation failed');
    const upTo = parsed.data.upToSeq;
    const t = schema.directMessages;
    await c.var.db
      .update(t)
      .set({ readAt: Date.now() })
      .where(and(eq(t.pairKey, pairKey(me, c.req.param('userId'))), eq(t.recipientId, me), isNull(t.readAt), upTo === undefined ? undefined : lte(t.seq, upTo)));
    return c.json({ ok: true });
  });
