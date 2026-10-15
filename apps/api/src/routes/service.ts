import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { serviceStatus } from '../lib/service';

/** Public: the banner and the maintenance page read this before and after sign-in. */
export const serviceRoutes = new Hono<AppEnv>().get('/status', async (c) => {
  c.header('cache-control', 'no-store');
  return c.json(await serviceStatus(c.env.DB));
});
