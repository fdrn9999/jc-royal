import { createDb } from '@jc/db';
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from './env';
import { countingD1, type D1Counts } from './lib/d1-stats';
import { housekeeping } from './lib/housekeeping';
import { flushPush } from './lib/notify';
import { sharePageResponse } from './lib/og';
import { countOps } from './lib/ops';
import { sweepReferrals } from './lib/referral';
import { sweepRooms } from './lib/room';
import { rollup } from './lib/stats';
import { HttpError, csrfGuard, securityHeaders } from './lib/http';
import { academyRoutes } from './routes/academy';
import { adminRoutes } from './routes/admin';
import { adminMonitorSocket } from './routes/admin-monitor-socket';
import { authRoutes } from './routes/auth';
import { boardRoutes, myCommunityRoutes } from './routes/board';
import { meRoutes } from './routes/me';
import { messageRoutes } from './routes/messages';
import { reportRoutes } from './routes/reports';
import { roomRoutes } from './routes/rooms';
import { serviceRoutes } from './routes/service';
import { notificationRoutes } from './routes/notifications';
import { presenceRoutes } from './routes/presence';
import { realtimeSocket } from './routes/realtime';
import { blockRoutes, dmRoutes, friendPresenceRoutes, friendRoutes } from './routes/social';
import { tableRoutes, tableSocket } from './routes/tables';
import { tournamentRoutes } from './routes/tournaments';

/** wrangler.jsonc `triggers`: every minute, the push outbox; any other run is the daily one. */
const PUSH_CRON = '* * * * *';

const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', async (c, next) => {
  if (c.env.D1_STATS !== '1') {
    c.set('db', createDb(c.env.DB));
    return next();
  }
  // Local measurement (lib/d1-stats.ts): this request's own copy of the bindings, its D1 counted.
  const n: D1Counts = { queries: 0, read: 0, written: 0, unmeasured: 0 };
  const where = `${c.req.method} ${c.req.path}`;
  const trace = (sql: string, meta: D1Meta | undefined) =>
    console.log(`d1-stats ${where} read=${meta?.rows_read ?? '?'} written=${meta?.rows_written ?? '?'} ${sql.replace(/\s+/g, ' ').slice(0, 2000)}`);
  c.env = { ...c.env, DB: countingD1(c.env.DB, n, trace) };
  c.set('db', createDb(c.env.DB));
  await next();
  try {
    c.res.headers.set('x-d1-queries', String(n.queries));
    c.res.headers.set('x-d1-rows-read', String(n.read));
    c.res.headers.set('x-d1-rows-written', String(n.written));
    c.res.headers.set('x-d1-unmeasured', String(n.unmeasured));
  } catch {
    // A response whose headers cannot change (a socket handed on by a room).
  }
});
app.use('/api/*', csrfGuard);

app.get('/api/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, at: Date.now() }));
app.route('/api/auth', authRoutes);
// Before meRoutes and friendRoutes: these check the sign-in without sliding it and answer before those routers'
// requireUser would run (a use('*') of a router mounted at the same prefix applies to every path under it).
app.route('/api/me', presenceRoutes);
app.route('/api/me', notificationRoutes);
app.route('/api/friends', friendPresenceRoutes);
app.route('/api/me', meRoutes);
app.route('/api/me', myCommunityRoutes);
app.route('/api/board', boardRoutes);
app.route('/api/messages', messageRoutes);
app.route('/api/friends', friendRoutes);
app.route('/api/dm', dmRoutes);
app.route('/api/blocks', blockRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/tables', tableRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api/tournaments', tournamentRoutes);
app.route('/api/academy', academyRoutes);
app.route('/api/service', serviceRoutes);
app.route('/api/admin', adminRoutes);
app.get('/ws/tables/:id', tableSocket);
app.get('/ws/realtime', realtimeSocket);
// The control center's socket: only through the admin console's host, on its sign-in (never a member's).
app.get('/ws/admin/monitor', adminMonitorSocket);

/**
 * Shareable pages (wrangler.jsonc run_worker_first): the app's index.html with the page's own link preview, so a
 * crawler that runs no script sees it (lib/og.ts). Everything else is served by Workers Static Assets unchanged.
 */
async function sharePage(c: Context<AppEnv>) {
  if (!c.env.ASSETS) return c.text('not found', 404);
  return sharePageResponse(c.env.ASSETS, c.env.DB, new URL(c.req.url));
}
app.get('/', sharePage);
app.get('/register', sharePage);
app.get('/table/:id', sharePage);
app.get('/board/:id', sharePage);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  // SPA fallback is handled by Workers Static Assets (not_found_handling).
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('not found', 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    // A table that did not answer, mail that could not be sent: server-side failures the admin dashboard counts.
    // (Refusals during planned maintenance are not failures.)
    if (err.status >= 500 && err.code !== 'maintenance') countOps(c, 'api_error');
    return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
  }
  console.error('unhandled', err instanceof Error ? err.message : String(err));
  countOps(c, 'api_error');
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Cron trigger (wrangler.jsonc `triggers`): rolls up the day that ended into the operations statistics (before the
   * housekeeping deletes old activity markers), deletes expired short-lived rows, then wakes rooms whose close or idle
   * close stalled, and settles referrals waiting for a payout (lib/referral.ts). Awaited, so a failure shows as a failed
   * run; a failed rollup does not stop the clean-up, nor a failed referral sweep the rest. The minute trigger only sends
   * the push outbox (lib/notify.ts), and without the push keys returns before touching D1.
   */
  async scheduled(event, env) {
    if (event.cron === PUSH_CRON) {
      const sent = await flushPush(env, { limit: 50 });
      if (sent.claimed) console.log('push outbox', JSON.stringify(sent));
      return;
    }
    let failed: unknown = null;
    try {
      console.log('stats rollup', JSON.stringify(await rollup(env.DB, { maxChunks: 12 })));
    } catch (e) {
      failed = e;
      console.error('stats rollup failed', e instanceof Error ? e.message : String(e));
    }
    console.log('housekeeping', JSON.stringify(await housekeeping(env.DB)));
    console.log('room sweep', JSON.stringify(await sweepRooms(env)));
    try {
      console.log('referral sweep', JSON.stringify(await sweepReferrals(env)));
    } catch (e) {
      failed ??= e;
      console.error('referral sweep failed', e instanceof Error ? e.message : String(e));
    }
    if (failed) throw failed;
  },
} satisfies ExportedHandler<Env>;
