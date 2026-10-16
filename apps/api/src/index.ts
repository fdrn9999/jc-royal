import { createDb } from '@jc/db';
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from './env';
import { housekeeping } from './lib/housekeeping';
import { metaFor, metaLocale, defaultMeta, replaceMeta, type PageMeta } from './lib/og';
import { countOps } from './lib/ops';
import { sweepReferrals } from './lib/referral';
import { sweepRooms } from './lib/room';
import { rollup } from './lib/stats';
import { HttpError, csrfGuard, securityHeaders } from './lib/http';
import { academyRoutes } from './routes/academy';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { boardRoutes, myCommunityRoutes } from './routes/board';
import { meRoutes } from './routes/me';
import { messageRoutes } from './routes/messages';
import { reportRoutes } from './routes/reports';
import { roomRoutes } from './routes/rooms';
import { serviceRoutes } from './routes/service';
import { blockRoutes, dmRoutes, friendRoutes } from './routes/social';
import { tableRoutes, tableSocket } from './routes/tables';

const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', async (c, next) => {
  c.set('db', createDb(c.env.DB));
  return next();
});
app.use('/api/*', csrfGuard);

app.get('/api/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, at: Date.now() }));
app.route('/api/auth', authRoutes);
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
app.route('/api/academy', academyRoutes);
app.route('/api/service', serviceRoutes);
app.route('/api/admin', adminRoutes);
app.get('/ws/tables/:id', tableSocket);

/**
 * Shareable pages (wrangler.jsonc run_worker_first): the app's index.html with the page's own link preview, so a
 * crawler that runs no script sees it (lib/og.ts). Everything else is served by Workers Static Assets unchanged.
 */
async function sharePage(c: Context<AppEnv>) {
  if (!c.env.ASSETS) return c.text('not found', 404);
  const url = new URL(c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(new URL('/', url)));
  if (!res.ok) return res;
  let meta: PageMeta;
  try {
    meta = await metaFor(c.env.DB, url);
  } catch (e) {
    console.error('link preview failed', url.pathname, e instanceof Error ? e.message : String(e));
    meta = defaultMeta(metaLocale(url));
  }
  const headers = new Headers(res.headers);
  // The body differs from the file the validators describe.
  headers.delete('etag');
  headers.delete('content-length');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-cache');
  return new Response(replaceMeta(await res.text(), meta), { status: 200, headers });
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
   * run; a failed rollup does not stop the clean-up, nor a failed referral sweep the rest.
   */
  async scheduled(_event, env) {
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
