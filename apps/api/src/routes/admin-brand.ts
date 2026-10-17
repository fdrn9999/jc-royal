/**
 * Brand status (lib/brand.ts): the link previews and install details this deployment serves, checked in-process. Mounted
 * inside the admin router: an admin session, the admin origin and the permission table's rule are already applied.
 * Read only — nothing here changes the site; the preview image and copy are changed in code (lib/og.ts) and deployed.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { brandReport, ogImage } from '../lib/brand';
import { fail } from '../lib/http';

export const adminBrandRoutes = new Hono<AppEnv>()
  /** Every check: the shareable pages' tags (a private table showing nothing of its own), the image, the manifest and icons. */
  .get('/brand', async (c) => c.json(await brandReport(c.env.ASSETS, c.env.DB)))
  /** The preview image itself, for the console to show (its pages load images only from their own origin). */
  .get('/brand/og-image', async (c) => {
    const r = await ogImage(c.env.ASSETS);
    if (!r) fail(404, 'not_found', 'the preview image is not served by this deployment');
    return r;
  });
