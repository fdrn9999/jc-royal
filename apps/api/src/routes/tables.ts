import { schema } from '@jc/db';
import type { LobbyTableDto } from '@jc/types';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { Hono, type Context, type Handler } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import { fail } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { resolveSession } from '../lib/session';

type TableRow = typeof schema.tables.$inferSelect;

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
    const rows = await withHost(c)
      .where(ne(schema.tables.status, 'closed'))
      // Official tables first, then members' rooms.
      .orderBy(desc(schema.tables.roomType), asc(schema.tables.bigBlind), asc(schema.tables.name));
    return c.json(rows.map((r) => toLobbyDto(r.t, r.host)));
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
