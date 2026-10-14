import { createDb } from '@jc/db';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { HttpError, csrfGuard, securityHeaders } from './lib/http';
import { academyRoutes } from './routes/academy';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { boardRoutes, myCommunityRoutes } from './routes/board';
import { meRoutes } from './routes/me';
import { messageRoutes } from './routes/messages';
import { reportRoutes } from './routes/reports';
import { roomRoutes } from './routes/rooms';
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
app.route('/api/admin', adminRoutes);
app.get('/ws/tables/:id', tableSocket);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  // SPA fallback is handled by Workers Static Assets (not_found_handling).
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('not found', 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
  }
  console.error('unhandled', err instanceof Error ? err.message : String(err));
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

export default app;
