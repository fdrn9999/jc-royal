/**
 * Who may do what in the admin console, in one place.
 *
 * Every admin API route (under /api/admin, apart from /auth) has a rule here: the feature it belongs to, the least
 * role that may use it, and whether the password must have been confirmed in the last few minutes. `requirePermission`
 * applies the rule before the route runs and refuses a route that has none (a new route stays closed until it is
 * given one; a unit test lists every route against this table). The role is the one requireAdmin read from D1 for
 * this request, so a role change applies from the next request on.
 *
 * Some checks depend on what the request is about (an administrator as the target, the size of a chip adjustment):
 * the route keeps that check and asks `can()` for the capability below.
 *
 * Code-defined on purpose: changing who may do what is a reviewed code change, not a setting an administrator edits.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppEnv } from '../env';
import { assertRecentReauth } from './auth';
import { fail, isPreview } from './http';

export type AdminRole = 'admin' | 'super_admin';

/** Abilities that depend on the request, all held by super admins only. */
export const CAPABILITIES = {
  /** Download member data (e-mail, birth date, consent record) as CSV. */
  'members.export': 'super_admin',
  /** Make a member an administrator, or change an administrator's role. */
  'roles.change': 'super_admin',
  /** Suspend, disconnect, unsuspend, adjust chips of or issue a reset link for an administrator. */
  'admins.manage': 'super_admin',
  /** Adjust LARGE_ADJUSTMENT chips or more at once. */
  'chips.large': 'super_admin',
  /** Correct a wallet or the ledger from a reconciliation event (record / revert). */
  'ledger.correct': 'super_admin',
  /** Delete another administrator's internal note on a member. */
  'notes.delete_any': 'super_admin',
  /** Read every administrator's entries in the audit log (others read their own). */
  'audit.all': 'super_admin',
  /** See and end other administrators' console sessions (anyone may end their own). */
  'sessions.all': 'super_admin',
} as const satisfies Record<string, AdminRole>;
export type Capability = keyof typeof CAPABILITIES;

export function can(role: string | undefined, cap: Capability): boolean {
  if (role === 'super_admin') return true;
  return role === 'admin' && (CAPABILITIES[cap] as AdminRole) === 'admin';
}

/** The capabilities an administrator of this role holds (the console hides what they cannot do). */
export function capabilitiesOf(role: string | undefined): Capability[] {
  return (Object.keys(CAPABILITIES) as Capability[]).filter((k) => can(role, k));
}

export const FEATURES = [
  'dashboard',
  'members',
  'memberExport',
  'memberNotes',
  'sanctions',
  'chips',
  'resetLinks',
  'roles',
  'tables',
  'tableControl',
  'hands',
  'handRecords',
  'ledger',
  'economy',
  'stats',
  'reconcile',
  'audit',
  'reports',
  'board',
  'messages',
  'notices',
  'maintenance',
  'academy',
  'security',
] as const;
export type Feature = (typeof FEATURES)[number];

export interface RouteRule {
  feature: Feature;
  /** Names the attempt in the audit log when it fails (`<action>.failed`). */
  action: string;
  role: AdminRole;
  /** The password confirmed within ADMIN_REAUTH_WINDOW. */
  reauth?: true;
  /**
   * The route answers `preview: true` with what it would change and writes nothing; a preview is not asked for the
   * password (the change itself is). Only routes marked so: any other route given `preview: true` still asks.
   */
  preview?: true;
  /** What the route's `:id` names, for the audit row of a failed attempt. */
  target?: string;
}

const A: AdminRole = 'admin';
const r = (feature: Feature, action: string, extra: Partial<Omit<RouteRule, 'feature' | 'action'>> = {}): RouteRule => ({ feature, action, role: A, ...extra });
const reauth = true as const;
const preview = true as const;

/** `METHOD /path` as the route is declared, relative to /api/admin. */
export const ROUTE_RULES: Record<string, RouteRule> = {
  'GET /dashboard': r('dashboard', 'dashboard.view'),
  'GET /ops/live': r('dashboard', 'dashboard.live'),

  'GET /users': r('members', 'user.list'),
  'POST /users/export': r('memberExport', 'user.export', { role: CAPABILITIES['members.export'], reauth }),
  'GET /users/:id': r('members', 'user.view', { target: 'user' }),
  'GET /users/:id/activity': r('members', 'user.activity', { target: 'user' }),
  'GET /users/:id/timeline': r('members', 'user.timeline', { target: 'user' }),
  'POST /users/:id/notes': r('memberNotes', 'note.create', { target: 'user' }),
  'DELETE /users/:id/notes/:noteId': r('memberNotes', 'note.delete', { target: 'user' }),
  'POST /users/:id/suspend': r('sanctions', 'user.suspend', { reauth, preview, target: 'user' }),
  'POST /users/:id/disconnect': r('sanctions', 'user.disconnect', { reauth, preview, target: 'user' }),
  'POST /users/:id/unsuspend': r('sanctions', 'user.unsuspend', { reauth, preview, target: 'user' }),
  'POST /users/:id/role': r('roles', 'user.role', { role: CAPABILITIES['roles.change'], reauth, preview, target: 'user' }),
  'POST /users/:id/chips': r('chips', 'user.chips', { reauth, preview, target: 'user' }),
  'POST /users/:id/reset-link': r('resetLinks', 'user.reset_link', { reauth, target: 'user' }),

  'GET /tables': r('tables', 'table.list'),
  'POST /tables': r('tables', 'table.create'),
  'GET /tables/:id': r('tables', 'table.view', { target: 'table' }),
  'PATCH /tables/:id': r('tables', 'table.update', { target: 'table' }),
  'POST /tables/:id/control': r('tableControl', 'table.control', { reauth, target: 'table' }),
  'POST /tables/:id/close': r('tableControl', 'table.close', { reauth, preview, target: 'table' }),

  'GET /hands': r('hands', 'hand.list'),
  // A finished hand with every player's cards. Hands are written only once settled, so a hand in play cannot be read.
  'GET /hands/:id': r('handRecords', 'hand.view_sensitive', { reauth, target: 'hand' }),
  'GET /ledger': r('ledger', 'ledger.view'),
  'GET /audit': r('audit', 'audit.view'),
  'GET /economy': r('economy', 'economy.view'),
  // Aggregate numbers only; opening the page may roll up days the daily cron has not reached yet.
  'GET /stats': r('stats', 'stats.view'),
  'POST /reconcile/run': r('reconcile', 'reconcile.run'),
  'GET /reconcile': r('reconcile', 'reconcile.list'),
  'GET /reconcile/:id': r('reconcile', 'reconcile.view', { target: 'reconciliation' }),
  'POST /reconcile/:id/resolve': r('reconcile', 'reconcile.resolve', { reauth, target: 'reconciliation' }),
  'GET /academy/stats': r('academy', 'academy.stats'),

  'GET /board/posts': r('board', 'board.list'),
  'GET /board/posts/:id': r('board', 'board.view', { target: 'post' }),
  'POST /board/notices': r('board', 'board.notice.create'),
  'PATCH /board/notices/:id': r('board', 'board.notice.update', { target: 'post' }),
  'POST /board/posts/:id/status': r('board', 'board.post.status', { target: 'post' }),
  'POST /board/comments/:id/status': r('board', 'board.comment.status', { target: 'comment' }),
  'POST /messages': r('messages', 'message.send'),
  'GET /messages': r('messages', 'message.list'),

  'GET /reports': r('reports', 'report.view'),
  'GET /reports/stats': r('reports', 'report.stats'),
  'GET /reports/assignees': r('reports', 'report.assignees'),
  'GET /reports/:id/events': r('reports', 'report.events', { target: 'report' }),
  'POST /reports/:id/notes': r('reports', 'report.note', { target: 'report' }),
  'PATCH /reports/:id': r('reports', 'report.update', { target: 'report' }),
  'POST /reports/:id': r('reports', 'report.resolve', { target: 'report' }),

  'GET /service/notices': r('notices', 'service.notice.list'),
  'POST /service/notices': r('notices', 'service.notice.create'),
  'PATCH /service/notices/:id': r('notices', 'service.notice.update', { target: 'notice' }),
  'POST /service/notices/:id/end': r('notices', 'service.notice.end', { target: 'notice' }),
  'DELETE /service/notices/:id': r('notices', 'service.notice.delete', { target: 'notice' }),
  'GET /service/maintenance': r('maintenance', 'maintenance.list'),
  // Every administrator, so whoever is on duty can stop the service in an emergency; the password is asked again.
  'POST /service/maintenance': r('maintenance', 'maintenance.schedule', { reauth }),
  'PATCH /service/maintenance/:id': r('maintenance', 'maintenance.update', { reauth, target: 'maintenance' }),
  'POST /service/maintenance/:id/stop': r('maintenance', 'maintenance.stop', { reauth, target: 'maintenance' }),

  // Ending a session only protects an account, so it needs no password; whose sessions one sees is `sessions.all`.
  'GET /security/sessions': r('security', 'admin.session.list'),
  'DELETE /security/sessions/:id': r('security', 'admin.session.end', { target: 'session' }),
  'POST /security/sessions/end-others': r('security', 'admin.session.end_others'),
  'GET /security/permissions': r('security', 'admin.permission.view'),
};

const ADMIN_BASE = '/api/admin';

const relative = (path: string) => (path.startsWith(`${ADMIN_BASE}/`) ? path.slice(ADMIN_BASE.length) : path);

export interface MatchedRoute {
  key: string;
  rule: RouteRule | undefined;
  /** The route's `:name` parts of this request's path (read here because a middleware's own params are empty). */
  params: Record<string, string>;
}

/** The route this request matched (its declared path, relative to /api/admin), or null when none did (a 404). */
export function matchedRoute(c: Context<AppEnv>): MatchedRoute | null {
  // Middleware is registered for every method ('ALL'); the first route with a method is the one that answers.
  const m = matchedRoutes(c).find((x) => x.method !== 'ALL');
  if (!m) return null;
  const pattern = relative(m.path);
  const key = `${m.method} ${pattern}`;
  const names = pattern.split('/');
  const parts = relative(c.req.path).split('/');
  const params: Record<string, string> = {};
  if (names.length === parts.length) {
    names.forEach((n, i) => {
      if (!n.startsWith(':')) return;
      try {
        params[n.slice(1)] = decodeURIComponent(parts[i]!);
      } catch {
        params[n.slice(1)] = parts[i]!;
      }
    });
  }
  return { key, rule: Object.hasOwn(ROUTE_RULES, key) ? ROUTE_RULES[key] : undefined, params };
}

/**
 * Applies the route's rule (after requireAdmin). Same refusals as before the table: 'super admin only', reauth_required.
 * The role is checked for previews too; only the password is left to the change itself.
 */
export const requirePermission: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = matchedRoute(c);
  if (!m) return next();
  if (!m.rule) fail(403, 'forbidden', 'no permission rule for this action');
  if (m.rule.role === 'super_admin' && c.var.user?.role !== 'super_admin') fail(403, 'forbidden', 'super admin only');
  if (m.rule.reauth && !(m.rule.preview && (await isPreview(c)))) assertRecentReauth(c);
  return next();
};
