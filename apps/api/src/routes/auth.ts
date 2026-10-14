import { applyLedger, schema } from '@jc/db';
import {
  ChangePasswordSchema,
  DeleteAccountSchema,
  LoginSchema,
  RegisterSchema,
  ResetConfirmSchema,
  ResetRequestSchema,
  UpdateProfileSchema,
  type MeDto,
} from '@jc/types';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { requireUser } from '../lib/auth';
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { createSession, destroySession } from '../lib/session';

export function toMe(u: AuthUser): MeDto {
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    role: u.role,
    balance: u.balance,
    locale: u.locale,
    createdAt: u.createdAt,
  };
}

async function loadMe(c: { var: AppEnv['Variables'] }, id: string): Promise<MeDto> {
  const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!u) fail(404, 'not_found', 'user not found');
  return toMe(u);
}

/** D1 reports e.g. "UNIQUE constraint failed: users.email" (possibly wrapped by drizzle in `cause`). */
export function isUniqueViolation(e: unknown, column: string) {
  if (!(e instanceof Error)) return false;
  // Only inspect the constraint target: drizzle's message also embeds the full INSERT statement.
  const text = `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`;
  const target = /UNIQUE constraint failed: ([^:\n]+)/.exec(text)?.[1] ?? '';
  return target.includes(column);
}

export const authRoutes = new Hono<AppEnv>()
  .post('/register', async (c) => {
    await rateLimit(c, `register:${clientIp(c)}`, 10, 60 * 60 * 1000, { perIp: true });
    const body = await parseBody(c, RegisterSchema);
    const db = c.var.db;
    const nickTaken = await db.query.users.findFirst({ where: sql`lower(${schema.users.nickname}) = lower(${body.nickname})`, columns: { id: true } });
    if (nickTaken) fail(409, 'nickname_taken', 'nickname already in use');
    const id = crypto.randomUUID();
    try {
      await db.insert(schema.users).values({
        id,
        email: body.email,
        nickname: body.nickname,
        passwordHash: await hashPassword(body.password, Number(c.env.PBKDF2_ITERATIONS)),
      });
    } catch (e) {
      if (isUniqueViolation(e, 'nickname')) fail(409, 'nickname_taken', 'nickname already in use');
      // Same response as a fresh signup would leak nothing, but the user needs to know; keep it generic.
      if (isUniqueViolation(e, 'email')) fail(409, 'email_taken', 'email already registered');
      throw e;
    }
    const grant = Number(c.env.SIGNUP_GRANT);
    if (grant > 0) {
      await applyLedger(c.env.DB, { userId: id, type: 'signup_grant', amount: grant, idempotencyKey: `signup:${id}`, memo: 'welcome chips' });
    }
    await createSession(c, id, 'user');
    return c.json(await loadMe(c, id), 201);
  })
  .post('/login', async (c) => {
    const body = await parseBody(c, LoginSchema);
    await rateLimit(c, `login-ip:${clientIp(c)}`, 30, 15 * 60 * 1000, { perIp: true });
    await rateLimit(c, `login-acct:${body.email}`, 10, 15 * 60 * 1000);
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.email, body.email) });
    const ok = await verifyPassword(body.password, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !ok || u.status === 'deleted') fail(401, 'invalid_credentials', 'email or password is incorrect');
    if (u.status === 'suspended') fail(403, 'suspended', u.suspendedReason ?? 'account suspended');
    await createSession(c, u.id, 'user');
    return c.json(toMe(u));
  })
  .post('/logout', async (c) => {
    await destroySession(c, 'user');
    return c.json({ ok: true });
  })
  .post('/password-reset/request', async (c) => {
    const body = await parseBody(c, ResetRequestSchema);
    await rateLimit(c, `reset:${clientIp(c)}`, 5, 60 * 60 * 1000, { perIp: true });
    const u = await c.var.db.query.users.findFirst({ where: and(eq(schema.users.email, body.email), eq(schema.users.status, 'active')) });
    let devToken: string | undefined;
    if (u) {
      const token = randomToken();
      await c.var.db.insert(schema.passwordResets).values({ tokenHash: await sha256(token), userId: u.id, expiresAt: Date.now() + 30 * 60 * 1000 });
      // No mail provider is configured in this project. Outside production the
      // token is returned so the flow can be exercised; in production an admin
      // issues the link from the admin console (see docs/ADMIN_SECURITY.md).
      if (c.env.ENVIRONMENT !== 'production') devToken = token;
    }
    return c.json({ ok: true, ...(devToken ? { devToken } : {}) });
  })
  .post('/password-reset/confirm', async (c) => {
    const body = await parseBody(c, ResetConfirmSchema);
    await rateLimit(c, `reset-confirm:${clientIp(c)}`, 10, 60 * 60 * 1000, { perIp: true });
    const hash = await sha256(body.token);
    const db = c.var.db;
    const row = await db.query.passwordResets.findFirst({
      where: and(eq(schema.passwordResets.tokenHash, hash), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, Date.now())),
    });
    if (!row) fail(400, 'invalid_token', 'reset link is invalid or expired');
    const newHash = await hashPassword(body.newPassword, Number(c.env.PBKDF2_ITERATIONS));
    await db.batch([
      db.update(schema.passwordResets).set({ usedAt: Date.now() }).where(eq(schema.passwordResets.tokenHash, hash)),
      db.update(schema.users).set({ passwordHash: newHash, updatedAt: Date.now() }).where(eq(schema.users.id, row.userId)),
      db.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId)),
    ]);
    return c.json({ ok: true });
  })
  // ----- authenticated -----
  .get('/me', requireUser, async (c) => c.json(toMe(c.var.user!)))
  .patch('/me', requireUser, async (c) => {
    const body = await parseBody(c, UpdateProfileSchema);
    const me = c.var.user!;
    const db = c.var.db;
    if (body.nickname && body.nickname.toLowerCase() !== me.nickname.toLowerCase()) {
      const taken = await db.query.users.findFirst({
        where: and(sql`lower(${schema.users.nickname}) = lower(${body.nickname})`, ne(schema.users.id, me.id)),
        columns: { id: true },
      });
      if (taken) fail(409, 'nickname_taken', 'nickname already in use');
    }
    try {
      await db
        .update(schema.users)
        .set({
          ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
          ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(schema.users.id, me.id));
    } catch (e) {
      if (isUniqueViolation(e, 'nickname')) fail(409, 'nickname_taken', 'nickname already in use');
      throw e;
    }
    return c.json(await loadMe(c, me.id));
  })
  .get('/nickname-available', async (c) => {
    const nick = c.req.query('nickname') ?? '';
    await rateLimit(c, `nick:${clientIp(c)}`, 60, 60 * 1000, { perIp: true });
    const u = await c.var.db.query.users.findFirst({ where: sql`lower(${schema.users.nickname}) = lower(${nick})`, columns: { id: true } });
    return c.json({ available: !u });
  })
  .post('/me/password', requireUser, async (c) => {
    const body = await parseBody(c, ChangePasswordSchema);
    const me = c.var.user!;
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, me.id) });
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) fail(400, 'invalid_credentials', 'current password is incorrect');
    const hash = await hashPassword(body.newPassword, Number(c.env.PBKDF2_ITERATIONS));
    const db = c.var.db;
    await db.batch([
      db.update(schema.users).set({ passwordHash: hash, updatedAt: Date.now() }).where(eq(schema.users.id, me.id)),
      // Sign out every other device.
      db.delete(schema.sessions).where(and(eq(schema.sessions.userId, me.id), ne(schema.sessions.id, c.var.session!.id))),
    ]);
    return c.json({ ok: true });
  })
  .get('/me/sessions', requireUser, async (c) => {
    const rows = await c.var.db.query.sessions.findMany({
      where: and(eq(schema.sessions.userId, c.var.user!.id), eq(schema.sessions.kind, 'user'), gt(schema.sessions.expiresAt, Date.now())),
      columns: { id: true, createdAt: true, lastSeenAt: true, userAgent: true, ip: true },
    });
    return c.json(rows.map((r) => ({ ...r, current: r.id === c.var.session!.id })));
  })
  .delete('/me/sessions/:id', requireUser, async (c) => {
    await c.var.db.delete(schema.sessions).where(and(eq(schema.sessions.id, c.req.param('id')), eq(schema.sessions.userId, c.var.user!.id)));
    return c.json({ ok: true });
  })
  .post('/me/delete', requireUser, async (c) => {
    const body = await parseBody(c, DeleteAccountSchema);
    const me = c.var.user!;
    const db = c.var.db;
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, me.id) });
    if (!u || !(await verifyPassword(body.password, u.passwordHash))) fail(400, 'invalid_credentials', 'password is incorrect');
    const seated = await db.query.tableSessions.findFirst({ where: and(eq(schema.tableSessions.userId, me.id), eq(schema.tableSessions.status, 'seated')) });
    if (seated) fail(409, 'seated', 'leave all tables before deleting the account');
    const tomb = `deleted-${me.id}`;
    await db.batch([
      db
        .update(schema.users)
        .set({ status: 'deleted', email: `${tomb}@deleted.invalid`, nickname: tomb.slice(0, 24), avatarUrl: null, passwordHash: 'disabled', updatedAt: Date.now() })
        .where(eq(schema.users.id, me.id)),
      db.delete(schema.sessions).where(eq(schema.sessions.userId, me.id)),
    ]);
    await destroySession(c, 'user');
    return c.json({ ok: true });
  });
