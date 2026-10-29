import type { Handler } from 'hono';
import { realtimeHubName, realtimeShardOf } from '@jc/types';
import type { AppEnv } from '../env';
import { fail } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { resolveSession } from '../lib/session';
import { IDENTITY_HEADER, INTERNAL_HEADER } from './tables';

/**
 * GET /ws/realtime: a signed-in page's socket for changes outside the tables (docs/REALTIME.md). Authenticated like the
 * table socket (session cookie, allowed Origin), then handed to the hub of this member with the verified member and
 * session: the page never says who it is. The session is read without sliding it, so an open page does not keep a
 * sign-in alive; the hub closes the socket when the session would expire, and at least hourly, for a fresh check, and
 * every few minutes reads D1 for its sockets' sessions, closing those that ended without the hub hearing of it.
 */
export const realtimeSocket: Handler<AppEnv> = async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'bad_request', 'websocket upgrade required');
  // Cross-site sockets are refused (CSWSH), as for the table socket.
  const origin = c.req.header('origin');
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (origin && origin !== new URL(c.req.url).origin && !allowed.includes(origin)) fail(403, 'forbidden', 'origin not allowed');
  const resolved = await resolveSession(c, 'user', { touch: false });
  if (!resolved) fail(401, 'unauthorized', 'login required');
  const authAt = Date.now();
  await rateLimit(c, `rt-ws:${resolved.user.id}:${clientIp(c)}`, 30, 60 * 1000);
  const identity = { userId: resolved.user.id, sessionId: resolved.session.id, authAt, expiresAt: resolved.session.expiresAt };
  const headers = new Headers(c.req.raw.headers);
  headers.set(INTERNAL_HEADER, c.env.INTERNAL_SECRET);
  headers.set(IDENTITY_HEADER, encodeURIComponent(JSON.stringify(identity)));
  if (c.env.REALTIME_SWEEP_MS) headers.set('x-jc-sweep-ms', c.env.REALTIME_SWEEP_MS);
  else headers.delete('x-jc-sweep-ms');
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(realtimeHubName(realtimeShardOf(resolved.user.id))));
  const url = new URL(c.req.url);
  url.pathname = '/connect';
  url.search = '';
  return stub.fetch(new Request(url.toString(), { headers, method: 'GET' }));
};
