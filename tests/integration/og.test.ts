import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { root } from '../support/worker';

// Link previews in the first HTML (apps/api/src/lib/og.ts): crawlers do not run the app, so the tags must be in the
// HTML the server sends. These run against the built web app served by wrangler dev, as in production.
let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

/** The HTML a crawler gets: no cookies, no script. */
async function crawl(path: string) {
  const r = await fetch(`${BASE()}${path}`, { headers: { 'User-Agent': 'facebookexternalhit/1.1', Accept: 'text/html' }, redirect: 'manual' });
  return { status: r.status, headers: r.headers, html: await r.text() };
}

const meta = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)" />`).exec(html)?.[1];

const REQUIRED = [
  'description', 'og:type', 'og:title', 'og:description', 'og:image', 'og:image:secure_url', 'og:image:width', 'og:image:height', 'og:image:type',
  'og:image:alt', 'og:url', 'og:site_name', 'og:locale', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image',
];

describe('link previews', () => {
  it('the home page has every tag in the first HTML, with absolute https addresses', async () => {
    const r = await crawl('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    for (const k of REQUIRED) expect(meta(r.html, k), k).toBeTruthy();
    expect(r.html).toContain('<title>JC ROYAL | No.1 마인드 스포츠</title>');
    expect(meta(r.html, 'og:title')).toBe('JC ROYAL | No.1 마인드 스포츠');
    expect(meta(r.html, 'og:image')).toBe('https://jc-royal.site/og-image.png');
    expect(meta(r.html, 'og:url')).toBe('https://jc-royal.site/');
    expect(meta(r.html, 'twitter:card')).toBe('summary_large_image');
    expect(r.html).toContain('<link rel="canonical" href="https://jc-royal.site/" />');
    // The app itself still loads from the same page.
    expect(r.html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[^"]+\.js"><\/script>/);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('?lang=en gives the English copy', async () => {
    const r = await crawl('/?lang=en');
    expect(meta(r.html, 'og:title')).toBe('JC ROYAL | No.1 Mind Sports');
    expect(meta(r.html, 'og:description')).toBe('Play Smart. Play Royal. Premium Texas Hold&#39;em with friends, solo bot games, and poker learning at JC ROYAL.');
    expect(meta(r.html, 'og:locale')).toBe('en_US');
    expect(meta(r.html, 'og:url')).toBe('https://jc-royal.site/?lang=en');
    expect(r.html).toContain('<html lang="en">');
  });

  it('the image is the attached banner: 200, image/png, 1200x630, byte for byte', async () => {
    const r = await fetch(`${BASE()}/og-image.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await r.arrayBuffer());
    const file = readFileSync(resolve(root, 'apps/web/public/og-image.png'));
    expect(body.length).toBe(1_054_620);
    expect(createHash('sha256').update(body).digest('hex').toUpperCase()).toBe('68DEED47FAFBD16D526ADC2C133B39E0D2865466344681865DEE51FE4157E68B');
    expect(body.equals(file)).toBe(true);
    // PNG header: width and height of the IHDR chunk.
    expect(body.readUInt32BE(16)).toBe(1200);
    expect(body.readUInt32BE(20)).toBe(630);
  });

  it('a public table shows its name and blinds; the query string is never echoed', async () => {
    const r = await crawl('/table/it-admin-0?code=royal-777&token=abc123');
    expect(r.status).toBe(200);
    expect(meta(r.html, 'og:title')).toBe('it-admin-0 | JC ROYAL');
    expect(meta(r.html, 'og:description')).toContain('5/10');
    expect(meta(r.html, 'og:url')).toBe('https://jc-royal.site/table/it-admin-0');
    expect(r.html).not.toMatch(/royal-777|abc123/);
  });

  it('a private table shows nothing of its own, and no join code', async () => {
    await d1(`UPDATE tables SET name = 'Secret Lounge 77' WHERE id = 'it-private'`);
    const r = await crawl('/table/it-private');
    expect(r.status).toBe(200);
    expect(meta(r.html, 'og:title')).toBe('JC ROYAL | No.1 마인드 스포츠');
    expect(r.html).not.toContain('Secret Lounge');
    expect(r.html).not.toContain('royal-777');
    const [row] = await d1<{ hash: string }>(`SELECT join_code_hash AS hash FROM tables WHERE id = 'it-private'`);
    expect(row?.hash).toBeTruthy();
    expect(r.html).not.toContain(row!.hash);
    // A table that does not exist answers the same way.
    expect(meta((await crawl('/table/no-such-table')).html, 'og:title')).toBe('JC ROYAL | No.1 마인드 스포츠');
  });

  it('a visible post shows its title and opening; once hidden or deleted, nothing of it', async () => {
    const u = await newUser();
    const created = await u.client.post('/api/board/posts', { title: 'OG 미리보기 <b>"글"</b>', body: '첫 줄입니다.\n\n둘째 줄 & 셋째 줄' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    let r = await crawl(`/board/${id}`);
    expect(meta(r.html, 'og:title')).toBe('OG 미리보기 &lt;b&gt;&quot;글&quot;&lt;/b&gt; | JC ROYAL 게시판');
    expect(meta(r.html, 'og:description')).toBe('첫 줄입니다. 둘째 줄 &amp; 셋째 줄');
    expect(r.html).not.toContain('<b>');

    expect((await admin.post(`/api/admin/board/posts/${id}/status`, { status: 'hidden' })).status).toBe(200);
    r = await crawl(`/board/${id}`);
    expect(meta(r.html, 'og:title')).toBe('JC ROYAL | No.1 마인드 스포츠');
    expect(r.html).not.toContain('미리보기');

    expect((await admin.post(`/api/admin/board/posts/${id}/status`, { status: 'visible' })).status).toBe(200);
    expect((await u.client.req('DELETE', `/api/board/posts/${id}`)).status).toBe(200);
    r = await crawl(`/board/${id}`);
    expect(r.html).not.toContain('미리보기');
    expect(r.html).not.toContain('셋째 줄');
  });

  it('a referral link keeps the default preview and a well-formed code only', async () => {
    let r = await crawl('/register?ref=JC7K4P2');
    expect(r.status).toBe(200);
    expect(meta(r.html, 'og:title')).toBe('JC ROYAL | No.1 마인드 스포츠');
    expect(meta(r.html, 'og:url')).toBe('https://jc-royal.site/register?ref=JC7K4P2');
    r = await crawl('/register?ref=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(meta(r.html, 'og:url')).toBe('https://jc-royal.site/register');
    expect(r.html).not.toContain('alert(1)');
  });

  it('other app pages still get the app with the default tags', async () => {
    for (const path of ['/me', '/board', '/board/write', '/board/x/edit', '/academy']) {
      const r = await crawl(path);
      expect(r.status, path).toBe(200);
      expect(meta(r.html, 'og:image'), path).toBe('https://jc-royal.site/og-image.png');
      expect(r.html, path).toContain('<div id="root"></div>');
    }
  });

  it('the pages the worker writes keep the static pages\' security headers', async () => {
    const plain = await crawl('/me');
    const shared = await crawl('/table/it-admin-0');
    for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'])
      expect(shared.headers.get(h), h).toBe(plain.headers.get(h));
    expect(shared.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
