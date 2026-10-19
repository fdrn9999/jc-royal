import { activeDayInsert, schema, statsDay } from '@jc/db';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, AuthSession, AuthUser } from '../env';
import { randomToken, sha256 } from './crypto';

export const USER_COOKIE = 'jc_sid';
export const ADMIN_COOKIE = 'jc_asid';

const DAY = 24 * 60 * 60 * 1000;
export const USER_SESSION_TTL = 30 * DAY;
/** Without "자동 로그인": the server forgets a session idle this long (the cookie itself ends with the browser). */
export const BROWSER_SESSION_TTL = DAY;
/** Admin sessions: short idle timeout and hard absolute cap. */
export const ADMIN_IDLE_TTL = 30 * 60 * 1000;
export const ADMIN_ABSOLUTE_TTL = 8 * 60 * 60 * 1000;
/** Window during which a password re-confirmation authorises sensitive admin actions. */
export const ADMIN_REAUTH_WINDOW = 5 * 60 * 1000;

function cookieName(kind: 'user' | 'admin') {
  return kind === 'admin' ? ADMIN_COOKIE : USER_COOKIE;
}

export function isSecure(c: Context<AppEnv>) {
  return new URL(c.req.url).protocol === 'https:';
}

/**
 * Marks the member active today for the operations statistics (stats.ts: the day only). Separate from the sign-in
 * and the session write, so a failure here never fails either; it is logged and the day may go uncounted.
 */
function markActive(c: Context<AppEnv>, userId: string, at: number) {
  c.executionCtx.waitUntil(
    activeDayInsert(c.env.DB, userId, at)
      .run()
      .then(
        () => undefined,
        (e: unknown) => console.error('activity marker not written', e instanceof Error ? e.message : String(e)),
      ),
  );
}

function userTtl(remember: boolean) {
  return remember ? USER_SESSION_TTL : BROWSER_SESSION_TTL;
}

function setSessionCookie(c: Context<AppEnv>, kind: 'user' | 'admin', token: string, remember: boolean) {
  // A user cookie without "자동 로그인" has no Max-Age, so the browser drops it when it closes.
  const maxAgeMs = kind === 'admin' ? ADMIN_ABSOLUTE_TTL : remember ? USER_SESSION_TTL : null;
  setCookie(c, cookieName(kind), token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: kind === 'admin' ? 'Strict' : 'Lax',
    path: '/',
    ...(maxAgeMs === null ? {} : { maxAge: Math.floor(maxAgeMs / 1000) }),
  });
}

export async function createSession(c: Context<AppEnv>, userId: string, kind: 'user' | 'admin', remember = true) {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + (kind === 'admin' ? ADMIN_IDLE_TTL : userTtl(remember));
  const id = crypto.randomUUID();
  const insert = c.var.db.insert(schema.sessions).values({
    id,
    userId,
    tokenHash: await sha256(token),
    kind,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
    remember: kind === 'user' && remember,
  });
  // A member sign-in is remembered on the account (the admin console shows it after the session itself is gone).
  if (kind === 'user') {
    await c.var.db.batch([insert, c.var.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, userId))]);
    markActive(c, userId, now);
  } else await insert;
  setSessionCookie(c, kind, token, remember);
  return id;
}

/** Re-issues a "자동 로그인" cookie so it lasts as long as the sliding session behind it (called when the app loads). */
export function renewUserCookie(c: Context<AppEnv>) {
  const token = getCookie(c, USER_COOKIE);
  if (token && c.var.session?.kind === 'user' && c.var.session.remember) setSessionCookie(c, 'user', token, true);
}

export interface ResolvedSession {
  user: AuthUser;
  session: AuthSession;
}

export interface ResolveOptions {
  /**
   * Slide the expiry and mark the member active (default). False for the presence heartbeat: it comes every half
   * minute from every open page, so it must never write to D1 (a page left open does not keep a sign-in alive either).
   */
  touch?: boolean;
}

/** Validates the session cookie against D1 and slides its expiry. */
export async function resolveSession(c: Context<AppEnv>, kind: 'user' | 'admin', opts: ResolveOptions = {}): Promise<ResolvedSession | null> {
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
  // Slide expiry at most once a minute to limit writes, and on a member's first request of a new day (Korean time),
  // which also marks the member active that day: one more write per member and day.
  const touch = opts.touch !== false;
  const newDay = touch && kind === 'user' && statsDay(now) !== statsDay(row.s.lastSeenAt);
  if (newDay) markActive(c, row.u.id, now);
  if (touch && (now - row.s.lastSeenAt > 60_000 || newDay)) {
    const ttl = kind === 'admin' ? ADMIN_IDLE_TTL : userTtl(row.s.remember);
    c.executionCtx.waitUntil(
      c.var.db.update(schema.sessions).set({ lastSeenAt: now, expiresAt: now + ttl }).where(eq(schema.sessions.id, row.s.id)).then(() => undefined),
    );
  }
  return {
    session: { id: row.s.id, kind: row.s.kind, reauthAt: row.s.reauthAt, createdAt: row.s.createdAt, remember: row.s.remember, expiresAt: row.s.expiresAt },
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
      presenceMode: row.u.presenceMode,
    },
  };
}

/** Ends the sign-in this request carries. Returns it (null: there was none), for what must end with it. */
export async function destroySession(c: Context<AppEnv>, kind: 'user' | 'admin'): Promise<{ id: string; userId: string } | null> {
  const token = getCookie(c, cookieName(kind));
  const gone = token
    ? await c.var.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256(token))).returning({ id: schema.sessions.id, userId: schema.sessions.userId })
    : [];
  deleteCookie(c, cookieName(kind), { path: '/', secure: isSecure(c) });
  return gone[0] ?? null;
}
