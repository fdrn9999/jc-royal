import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

// The production addresses are set only in env.production of the wrangler configs; development keeps localhost. The
// configs are read through wrangler itself, so these are the values a deploy would use.
const read = (app: string, env?: string) =>
  unstable_readConfig({ config: `apps/${app}/wrangler.jsonc`, ...(env ? { env } : {}) }, { hideWarnings: true });

describe('production addresses', () => {
  it('production uses jc-royal.site for origins, mail links and the sender', () => {
    const { vars } = read('api', 'production');
    expect(vars.ENVIRONMENT).toBe('production');
    expect(vars.APP_ORIGIN).toBe('https://jc-royal.site');
    expect(vars.ADMIN_ORIGIN).toBe('https://admin.jc-royal.site');
    expect(String(vars.ALLOWED_ORIGINS).split(',')).toEqual(['https://jc-royal.site', 'https://admin.jc-royal.site']);
    expect(vars.MAIL_FROM).toBe('JC ROYAL <noreply@jc-royal.site>');
    expect(JSON.stringify(vars)).not.toContain('workers.dev');
  });

  it('development keeps localhost and sends no mail', () => {
    const { vars } = read('api');
    expect(vars.ENVIRONMENT).toBe('development');
    expect(vars.APP_ORIGIN).toBe('http://localhost:5173');
    expect(vars.ADMIN_ORIGIN).toBe('http://localhost:5174');
    for (const o of String(vars.ALLOWED_ORIGINS).split(',')) expect(o).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    expect(vars.MAIL_FROM).toBeUndefined();
  });

  // The custom domains are attached in the Cloudflare dashboard. Routes in a config would make wrangler replace them on
  // deploy and, without "workers_dev": true, turn the workers.dev preview addresses off (docs/DEPLOYMENT.md section 4).
  it.each(['api', 'admin'])('%s production config leaves the domains to the dashboard and keeps workers.dev', (app) => {
    const c = read(app, 'production');
    expect(c.routes ?? []).toEqual([]);
    expect(c.route).toBeUndefined();
    expect(c.workers_dev).not.toBe(false);
  });

  it('the game worker has no public address', () => {
    const c = read('game-worker', 'production');
    expect(c.routes ?? []).toEqual([]);
    expect(c.workers_dev).toBe(false);
  });
});
