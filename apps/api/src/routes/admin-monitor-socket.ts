import { ADMIN_MONITOR_HUB } from '@jc/types';
import type { Handler } from 'hono';
import type { AppEnv } from '../env';
import { fail } from '../lib/http';
import { hasGrant } from '../lib/permissions';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { resolveSession } from '../lib/session';
import { IDENTITY_HEADER, INTERNAL_HEADER } from './tables';

/**
 * GET /ws/admin/monitor: the control center's socket (docs/CONTROL_CENTER.md), reached only through the admin console's
 * host (apps/admin/worker forwards this one path). The console sign-in (jc_asid) is checked here, as every admin route
 * checks it: from the console's own origin (a page elsewhere cannot open it with the administrator's cookie, and a
 * missing Origin is refused too, since every browser sends one on a socket), an active administrator with table duty
 * (the `tables` feature, read from D1; a super admin has every one). A member's sign-in is not one, whatever its role.
 * The hub (the game worker's AdminMonitorHub) gets who this is from the api, never from the page, and checks the
 * sign-in and the duty again on its sweep; logouts, ended sessions, suspensions and role or duty changes close the
 * socket at once (lib/admin-monitor.ts adminMonitorRevoke).
 */
export const adminMonitorSocket: Handler<AppEnv> = async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'bad_request', 'websocket upgrade required');
  if (c.req.header('origin') !== c.env.ADMIN_ORIGIN) fail(403, 'forbidden', 'admin origin required');
  const resolved = await resolveSession(c, 'admin', { touch: false });
  if (!resolved) fail(401, 'unauthorized', 'admin login required');
  c.set('user', resolved.user);
  c.set('session', resolved.session);
  if (resolved.user.role !== 'admin' && resolved.user.role !== 'super_admin') fail(403, 'forbidden', 'not an administrator');
  if (!(await hasGrant(c, 'tables'))) fail(403, 'permission_off', 'table duty is switched off for this administrator');
  const authAt = Date.now();
  await rateLimit(c, `adm-ws:${resolved.user.id}:${clientIp(c)}`, 30, 60 * 1000);
  const identity = { userId: resolved.user.id, sessionId: resolved.session.id, authAt, expiresAt: resolved.session.expiresAt };
  const headers = new Headers(c.req.raw.headers);
  headers.set(INTERNAL_HEADER, c.env.INTERNAL_SECRET);
  headers.set(IDENTITY_HEADER, encodeURIComponent(JSON.stringify(identity)));
  // Local tests only (as /ws/realtime): the hub's sign-in sweep runs this often instead of every few minutes.
  if (c.env.REALTIME_SWEEP_MS) headers.set('x-jc-sweep-ms', c.env.REALTIME_SWEEP_MS);
  else headers.delete('x-jc-sweep-ms');
  const stub = c.env.ADMIN_MONITOR.get(c.env.ADMIN_MONITOR.idFromName(ADMIN_MONITOR_HUB));
  const url = new URL(c.req.url);
  url.pathname = '/connect';
  url.search = '';
  return stub.fetch(new Request(url.toString(), { headers, method: 'GET' }));
};
