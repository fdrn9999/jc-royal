import type { RealtimeIdentity } from './realtime-rules';

/**
 * The control center hub's rules (admin-monitor.ts, docs/CONTROL_CENTER.md), apart from the Durable Object so they can be
 * tested on their own. The handshake, the sign-out revokes and the sweep work as the member hub's (realtime-rules.ts),
 * but for a console sign-in (sessions.kind = 'admin') of an administrator who still has table duty.
 */

export interface MonitorAttachment extends RealtimeIdentity {
  /** The rooms this page follows (admin.monitor.room goes to it only for these). */
  watch: string[];
}

/** A console socket is checked again at least this often (the console sign-in's idle limit, ADMIN_IDLE_TTL). */
export const MONITOR_MAX_AGE_MS = 30 * 60_000;
/** The console's absolute limit on a sign-in (apps/api/src/lib/session.ts ADMIN_ABSOLUTE_TTL). */
export const ADMIN_ABSOLUTE_MS = 8 * 60 * 60_000;
/** Console pages per administrator; a newer one closes the oldest. */
export const MONITOR_MAX_PER_ADMIN = 5;
/** Console sockets on the hub; past it a handshake is refused with 1013. */
export const MONITOR_MAX_PER_HUB = 500;
/**
 * While sockets are open the hub reads D1 this often for their sign-ins and duties: a revoke that never reached it (a
 * sign-out, a role or duty taken away) leaves a socket open this long at most.
 */
export const MONITOR_SWEEP_MS = 2 * 60_000;
/** Sessions per sweep query: a D1 statement binds at most 100 values, two of them the clock. */
export const MONITOR_SWEEP_CHUNK = 98;
/** Frames a page may send a minute (what it follows changes when the operator opens a table); past it its socket closes. */
export const MONITOR_FRAMES_PER_MIN = 60;

/** Whether a socket must be checked again before it gets anything more. */
export const staleMonitor = (a: RealtimeIdentity, now: number) => now >= a.expiresAt || now - a.authAt >= MONITOR_MAX_AGE_MS;

/**
 * The sweep's query for `n` session ids (then `now` and the oldest sign-in still allowed): those that are still a
 * console sign-in, unexpired and within the absolute limit, of an active administrator, with that administrator's role
 * and stored duties (which `hasTableDuty` reads).
 */
export const liveAdminSessionsSql = (n: number) =>
  `SELECT s.id AS id, u.role AS role, p.grants AS grants FROM sessions s JOIN users u ON u.id = s.user_id
   LEFT JOIN admin_permissions p ON p.user_id = u.id
   WHERE s.id IN (${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')}) AND s.kind = 'admin' AND s.expires_at > ?${n + 1}
     AND s.created_at > ?${n + 2} AND u.status = 'active' AND u.role IN ('admin', 'super_admin')`;

/** As apps/api/src/lib/permissions.ts grantsOf: a super admin has every duty; a plain administrator the stored ones. */
export function hasTableDuty(role: string, grants: string | null): boolean {
  if (role === 'super_admin') return true;
  if (role !== 'admin' || !grants) return false;
  try {
    const v: unknown = JSON.parse(grants);
    return Array.isArray(v) && v.includes('tables');
  } catch {
    return false;
  }
}

/** The rooms a page asked to follow, as the hub keeps them (deduplicated, in the page's order). */
export const watchOf = (tables: readonly string[]): string[] => [...new Set(tables)];
