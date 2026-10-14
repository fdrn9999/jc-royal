import { schema } from '@jc/db';
import { NEWCOMER_HANDS, QuickPlaySchema, type LobbyTableDto, type QuickPlayDto } from '@jc/types';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { Hono, type Context, type Handler } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { roomCall } from '../lib/room';
import { resolveSession } from '../lib/session';

type TableRow = typeof schema.tables.$inferSelect;

/** Tables quick play asks the room about, best ranked first, before giving up with tables_full. */
const QUICK_PLAY_CHECKS = 5;

export function toLobbyDto(t: TableRow, hostNickname: string | null = null): LobbyTableDto {
  return {
    id: t.id,
    name: t.name,
    roomType: t.roomType,
    host: t.roomType === 'member' && t.createdBy ? { id: t.createdBy, nickname: hostNickname ?? '' } : null,
    maxSeats: t.maxSeats,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    minBuyIn: t.minBuyIn,
    maxBuyIn: t.maxBuyIn,
    isPrivate: t.isPrivate,
    allowSpectators: t.allowSpectators,
    beginner: t.beginner,
    entryBlocked: t.entryBlocked,
    status: t.status === 'open' ? 'open' : 'closed',
    seated: t.liveSeated,
    playing: t.livePlaying,
    waitlist: t.liveWaitlist,
    spectators: t.liveSpectators,
  };
}

/** Headers the table room trusts; set only by this worker after verifying the session. */
export const INTERNAL_HEADER = 'x-jc-internal';
export const IDENTITY_HEADER = 'x-jc-identity';

export interface RoomIdentity {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  /** Holds a valid join code (or the table is public). */
  codeOk: boolean;
}

/** Tables with the nickname of the member who opened them. */
const withHost = (c: Context<AppEnv>) =>
  c.var.db.select({ t: schema.tables, host: schema.users.nickname }).from(schema.tables).leftJoin(schema.users, eq(schema.users.id, schema.tables.createdBy));

export const tableRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/', async (c) => {
    // `IN` (not `<> 'closed'`) so SQLite searches tables_status_idx instead of scanning every closed room ever made.
    const rows = await withHost(c)
      .where(inArray(schema.tables.status, ['open', 'closing']))
      // Official tables first, then members' rooms.
      .orderBy(desc(schema.tables.roomType), asc(schema.tables.bigBlind), asc(schema.tables.name));
    return c.json(rows.map((r) => toLobbyDto(r.t, r.host)));
  })
  /**
   * Quick play: picks a public open table for the caller. Newcomers (under NEWCOMER_HANDS hands) get beginner tables
   * first and others get them last; then tables that look like they have room, with players already seated, at lower
   * stakes. The lobby counts can be stale, so the table room itself confirms a free seat before a table is returned.
   * Nothing is paid here: the player confirms the buy-in at the table through the normal seat request.
   */
  .post('/quick', async (c) => {
    const body = await parseBody(c, QuickPlaySchema);
    const me = c.var.user!;
    await rateLimit(c, `quick-play:${me.id}`, 30, 60_000);
    const T = schema.tables;
    const rows = await withHost(c).where(
      and(
        eq(T.status, 'open'),
        eq(T.isPrivate, false),
        eq(T.entryBlocked, false),
        body.maxSeats ? eq(T.maxSeats, body.maxSeats) : undefined,
        body.bigBlind ? eq(T.bigBlind, body.bigBlind) : undefined,
      ),
    );
    const seatedAt = new Set(
      (
        await c.var.db
          .select({ tableId: schema.tableSessions.tableId })
          .from(schema.tableSessions)
          .where(and(eq(schema.tableSessions.userId, me.id), eq(schema.tableSessions.status, 'seated')))
      ).map((r) => r.tableId),
    );
    const skip = new Set(body.exclude);
    const matches = rows.filter((r) => !seatedAt.has(r.t.id) && !skip.has(r.t.id));
    if (!matches.length) fail(404, 'no_table', 'no open table matches');
    const affordable = matches.filter((r) => r.t.minBuyIn <= me.balance);
    if (!affordable.length) {
      fail(409, 'insufficient_balance', 'not enough chips for any matching table', { minBuyIn: Math.min(...matches.map((r) => r.t.minBuyIn)), balance: me.balance });
    }

    const played = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM hand_players WHERE user_id = ?1 LIMIT ?2)')
      .bind(me.id, NEWCOMER_HANDS)
      .first<{ n: number }>();
    const newcomer = (played?.n ?? 0) < NEWCOMER_HANDS;
    const looksOpen = (t: TableRow) => t.maxSeats - t.liveSeated > t.liveWaitlist;
    const rank = (t: TableRow) => [looksOpen(t) ? 0 : 1, t.beginner === newcomer ? 0 : 1, -t.liveSeated, t.bigBlind, t.roomType === 'official' ? 0 : 1];
    const ranked = affordable.sort((a, b) => {
      const ra = rank(a.t);
      const rb = rank(b.t);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0;
    });
    for (const r of ranked.slice(0, QUICK_PLAY_CHECKS)) {
      const check = await roomCall(c, r.t.id, 'seat-check', { user: me.id });
      if (check?.ok === true && typeof check.seatIndex === 'number') {
        const out: QuickPlayDto = { table: toLobbyDto(r.t, r.host), seatIndex: check.seatIndex };
        return c.json(out);
      }
    }
    fail(409, 'tables_full', 'every matching table is full right now');
  })
  .get('/:id', async (c) => {
    const [r] = await withHost(c).where(eq(schema.tables.id, c.req.param('id')));
    if (!r) fail(404, 'not_found', 'table not found');
    return c.json(toLobbyDto(r.t, r.host));
  });

/**
 * WebSocket entry: authenticate via session cookie, then hand the upgrade to
 * the table's Durable Object together with the verified identity.
 */
export const tableSocket: Handler<AppEnv> = async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'bad_request', 'websocket upgrade required');
  // Browsers send Origin on WebSocket handshakes; reject cross-site sockets (CSWSH).
  const origin = c.req.header('origin');
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (origin && origin !== new URL(c.req.url).origin && !allowed.includes(origin)) fail(403, 'forbidden', 'origin not allowed');
  const resolved = await resolveSession(c, 'user');
  if (!resolved) fail(401, 'unauthorized', 'login required');
  await rateLimit(c, `ws:${resolved.user.id}:${clientIp(c)}`, 60, 60 * 1000);
  const tableId = c.req.param('id')!;
  const t = await c.var.db.query.tables.findFirst({ where: and(eq(schema.tables.id, tableId), ne(schema.tables.status, 'closed')) });
  if (!t) fail(404, 'not_found', 'table not found');
  let codeOk = !t.isPrivate;
  const code = c.req.query('code');
  if (t.isPrivate && code && t.joinCodeHash) codeOk = (await sha256(`${t.id}:${code}`)) === t.joinCodeHash;
  if (t.isPrivate && !codeOk && !t.allowSpectators) fail(403, 'forbidden', 'join code required');

  const identity: RoomIdentity = {
    userId: resolved.user.id,
    nickname: resolved.user.nickname,
    avatarUrl: resolved.user.avatarUrl,
    role: resolved.user.role,
    codeOk,
  };
  const headers = new Headers(c.req.raw.headers);
  headers.set(INTERNAL_HEADER, c.env.INTERNAL_SECRET);
  headers.set(IDENTITY_HEADER, encodeURIComponent(JSON.stringify(identity)));
  const stub = c.env.TABLES.get(c.env.TABLES.idFromName(tableId));
  const url = new URL(c.req.url);
  url.pathname = `/ws/${tableId}`;
  return stub.fetch(new Request(url.toString(), { headers, method: 'GET' }));
};
