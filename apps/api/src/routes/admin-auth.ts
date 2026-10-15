/**
 * Administrator authentication: email + password, on a session separate from
 * the player site.
 *
 * Hardware-key (WebAuthn/FIDO2) authentication from the directive was dropped
 * by the project owner on 2026-10-14 (no FIDO devices available). Compensating
 * controls:
 *  - separate admin session cookie (jc_asid, SameSite=Strict, 30 min idle / 8 h absolute),
 *  - role re-read from D1 on every request, admin-origin check,
 *  - per-account and per-IP login rate limits, failed attempts audited,
 *  - password re-confirmation (`reauthAt`, 5 min) before sensitive actions,
 *  - every admin action written to admin_audit_log, refused and failed attempts too (lib/audit.ts),
 *  - one table of who may do what (lib/permissions.ts).
 */
import { schema } from '@jc/db';
import { EmailSchema } from '@jc/types';
import { eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { requireAdmin } from '../lib/auth';
import { DUMMY_HASH, verifyPassword } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { capabilitiesOf } from '../lib/permissions';
import { ADMIN_REAUTH_WINDOW, createSession, destroySession } from '../lib/session';


export { audit };


/** Admin console requests must come from the admin origin (defence in depth on top of SameSite=Strict). */
export const requireAdminOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && origin !== c.env.ADMIN_ORIGIN) fail(403, 'forbidden', 'admin origin required');
  return next();
};

export const adminAuthRoutes = new Hono<AppEnv>()
  .use('*', requireAdminOrigin)
  /** First super admin: promote an existing account with the deployment's one-time bootstrap secret. */
  .post('/bootstrap', async (c) => {
    await rateLimit(c, `admin-bootstrap:${clientIp(c)}`, 5, 60 * 60 * 1000, { perIp: true });
    const body = await parseBody(c, z.object({ token: z.string().min(16).max(200), email: EmailSchema }));
    const expected = c.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected || expected.length < 16 || body.token !== expected) fail(403, 'forbidden', 'invalid bootstrap token');
    const existing = await c.var.db.query.users.findFirst({ where: eq(schema.users.role, 'super_admin'), columns: { id: true } });
    if (existing) fail(409, 'conflict', 'a super admin already exists');
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.email, body.email) });
    if (!u || u.status !== 'active') fail(404, 'not_found', 'register the account first');
    await c.var.db.update(schema.users).set({ role: 'super_admin', updatedAt: Date.now() }).where(eq(schema.users.id, u.id));
    c.set('user', { ...u, role: 'super_admin' });
    await audit(c, 'admin.bootstrap', { type: 'user', id: u.id });
    return c.json({ ok: true });
  })
  .post('/login', async (c) => {
    const body = await parseBody(c, z.object({ email: EmailSchema, password: z.string().min(1).max(128) }));
    await rateLimit(c, `admin-login-ip:${clientIp(c)}`, 20, 15 * 60 * 1000, { perIp: true });
    await rateLimit(c, `admin-login:${body.email}`, 5, 15 * 60 * 1000);
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.email, body.email) });
    const ok = await verifyPassword(body.password, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !ok || u.status !== 'active' || (u.role !== 'admin' && u.role !== 'super_admin')) {
      if (u) {
        c.set('user', { ...u });
        await audit(c, 'admin.login.failed', { type: 'user', id: u.id }, undefined, 'failed');
      }
      fail(401, 'invalid_credentials', 'invalid credentials');
    }
    await createSession(c, u.id, 'admin');
    c.set('user', { ...u });
    await audit(c, 'admin.login', { type: 'user', id: u.id });
    return c.json({ ok: true });
  })
  .post('/logout', async (c) => {
    await destroySession(c, 'admin');
    return c.json({ ok: true });
  })
  .get('/me', requireAdmin, async (c) => {
    const u = c.var.user!;
    const s = c.var.session!;
    return c.json({
      user: { id: u.id, email: u.email, nickname: u.nickname, role: u.role },
      reauthValidUntil: s.reauthAt ? s.reauthAt + ADMIN_REAUTH_WINDOW : null,
      sessionStartedAt: s.createdAt,
      /** What this administrator may do beyond the console's common features (the console hides the rest). */
      permissions: capabilitiesOf(u.role),
    });
  })
  /** Re-enter the password to unlock sensitive actions for a few minutes. */
  .post('/reauth', requireAdmin, async (c) => {
    await rateLimit(c, `admin-reauth:${c.var.user!.id}`, 10, 15 * 60 * 1000);
    const body = await parseBody(c, z.object({ password: z.string().min(1).max(128) }));
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, c.var.user!.id) });
    if (!u || !(await verifyPassword(body.password, u.passwordHash))) {
      await audit(c, 'admin.reauth.failed', undefined, undefined, 'failed');
      fail(401, 'invalid_credentials', 'password is incorrect');
    }
    const now = Date.now();
    await c.var.db.update(schema.sessions).set({ reauthAt: now }).where(eq(schema.sessions.id, c.var.session!.id));
    await audit(c, 'admin.reauth');
    return c.json({ ok: true, reauthValidUntil: now + ADMIN_REAUTH_WINDOW });
  });
