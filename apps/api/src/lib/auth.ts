import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { fail } from './http';
import { ADMIN_REAUTH_WINDOW, resolveSession } from './session';

/** Requires a valid player session cookie. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const resolved = await resolveSession(c, 'user');
  if (!resolved) fail(401, 'unauthorized', 'login required');
  c.set('user', resolved.user);
  c.set('session', resolved.session);
  return next();
};

/** requireUser for the presence heartbeat: the same check, without sliding the session (no D1 write). */
export const requireUserQuiet: MiddlewareHandler<AppEnv> = async (c, next) => {
  const resolved = await resolveSession(c, 'user', { touch: false });
  if (!resolved) fail(401, 'unauthorized', 'login required');
  c.set('user', resolved.user);
  c.set('session', resolved.session);
  return next();
};

/**
 * Admin console guard. The role is read from D1 on every request (never taken
 * from the client) and only the separate admin session cookie is accepted.
 * What each role may do is lib/permissions.ts.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const resolved = await resolveSession(c, 'admin');
  if (!resolved) fail(401, 'unauthorized', 'admin login required');
  // Set before the role check, so a refused member is on the audit record (lib/audit.ts).
  c.set('user', resolved.user);
  c.set('session', resolved.session);
  if (resolved.user.role !== 'admin' && resolved.user.role !== 'super_admin') fail(403, 'forbidden', 'not an administrator');
  return next();
};

/** Sensitive admin actions need the password re-entered within the last few minutes. */
export function assertRecentReauth(c: Context<AppEnv>) {
  const at = c.var.session?.reauthAt;
  if (!at || Date.now() - at > ADMIN_REAUTH_WINDOW) fail(401, 'reauth_required', 'password re-confirmation required');
}
