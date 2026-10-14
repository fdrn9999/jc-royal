import { schema } from '@jc/db';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, AuthSession, AuthUser } from '../env';
import { randomToken, sha256 } from './crypto';

export const USER_COOKIE = 'jc_sid';
export const ADMIN_COOKIE = 'jc_asid';

const DAY = 24 * 60 * 60 * 1000;
export const USER_SESSION_TTL = 30 * DAY;
/** Admin sessions: short idle timeout and hard absolute cap. */
export const ADMIN_IDLE_TTL = 30 * 60 * 1000;
export const ADMIN_ABSOLUTE_TTL = 8 * 60 * 60 * 1000;
/** Window during which a fresh WebAuthn assertion authorises sensitive admin actions. */
export const ADMIN_REAUTH_WINDOW = 5 * 60 * 1000;

function cookieName(kind: 'user' | 'admin') {
  return kind === 'admin' ? ADMIN_COOKIE : USER_COOKIE;
}

function isSecure(c: Context<AppEnv>) {
  return new URL(c.req.url).protocol === 'https:';
}

export async function createSession(c: Context<AppEnv>, userId: string, kind: 'user' | 'admin') {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + (kind === 'admin' ? ADMIN_IDLE_TTL : USER_SESSION_TTL);
  const id = crypto.randomUUID();
  await c.var.db.insert(schema.sessions).values({
    id,
    userId,
    tokenHash: await sha256(token),
    kind,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
  });
  setCookie(c, cookieName(kind), token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: kind === 'admin' ? 'Strict' : 'Lax',
    path: '/',
    maxAge: Math.floor((kind === 'admin' ? ADMIN_ABSOLUTE_TTL : USER_SESSION_TTL) / 1000),
  });
  return id;
}

export interface ResolvedSession {
  user: AuthUser;
  session: AuthSession;
}

/** Validates the session cookie against D1 and slides its expiry. */
export async function resolveSession(c: Context<AppEnv>, kind: 'user' | 'admin'): Promise<ResolvedSession | null> {
  const token = getCookie(c, cookieName(kind));
  if (!token || token.length > 100) return null;
  const now = Date.now();
  const rows = await c.var.db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, await sha256(token)), eq(schema.sessions.kind, kind), gt(schema.sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.u.status !== 'active') {
    await c.var.db.delete(schema.sessions).where(eq(schema.sessions.id, row.s.id));
    return null;
  }
  if (kind === 'admin' && now - row.s.createdAt > ADMIN_ABSOLUTE_TTL) {
    await c.var.db.delete(schema.sessions).where(eq(schema.sessions.id, row.s.id));
    return null;
  }
  // Slide expiry at most once a minute to limit writes.
  if (now - row.s.lastSeenAt > 60_000) {
    const ttl = kind === 'admin' ? ADMIN_IDLE_TTL : USER_SESSION_TTL;
    c.executionCtx.waitUntil(
      c.var.db.update(schema.sessions).set({ lastSeenAt: now, expiresAt: now + ttl }).where(eq(schema.sessions.id, row.s.id)).then(() => undefined),
    );
  }
  return {
    session: { id: row.s.id, kind: row.s.kind, mfaVerifiedAt: row.s.mfaVerifiedAt, reauthAt: row.s.reauthAt, createdAt: row.s.createdAt },
    user: {
      id: row.u.id,
      email: row.u.email,
      nickname: row.u.nickname,
      role: row.u.role,
      status: row.u.status,
      avatarUrl: row.u.avatarUrl,
      locale: row.u.locale,
      balance: row.u.balance,
      createdAt: row.u.createdAt,
    },
  };
}

export async function destroySession(c: Context<AppEnv>, kind: 'user' | 'admin') {
  const token = getCookie(c, cookieName(kind));
  if (token) await c.var.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256(token)));
  deleteCookie(c, cookieName(kind), { path: '/', secure: isSecure(c) });
}
