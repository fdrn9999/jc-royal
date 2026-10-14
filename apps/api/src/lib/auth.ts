import type { MiddlewareHandler } from 'hono';
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

/**
 * Admin console guard. The role is read from D1 on every request (never taken
 * from the client) and only the separate admin session cookie is accepted.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const resolved = await resolveSession(c, 'admin');
  if (!resolved) fail(401, 'unauthorized', 'admin login required');
  if (resolved.user.role !== 'admin' && resolved.user.role !== 'super_admin') fail(403, 'forbidden', 'not an administrator');
  c.set('user', resolved.user);
  c.set('session', resolved.session);
  return next();
};

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user?.role !== 'super_admin') fail(403, 'forbidden', 'super admin only');
  return next();
};

/** Sensitive admin actions need the password re-entered within the last few minutes. */
export const requireRecentReauth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const at = c.var.session?.reauthAt;
  if (!at || Date.now() - at > ADMIN_REAUTH_WINDOW) fail(401, 'reauth_required', 'password re-confirmation required');
  return next();
};
