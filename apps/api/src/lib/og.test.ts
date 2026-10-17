import { describe, expect, it } from 'vitest';
import indexHtml from '../../../web/index.html?raw';
import { clip, defaultMeta, escapeAttr, metaFor, metaLocale, OG_IMAGE, renderMeta, replaceMeta } from './og';

/** A D1 stand-in that answers every first() with `row` and remembers the SQL and bindings it was asked. */
function fakeD1(row: Record<string, unknown> | null) {
  const asked: { sql: string; args: unknown[] }[] = [];
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          asked.push({ sql, args });
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
  return { d1, asked };
}

const tag = (html: string, attr: 'property' | 'name', key: string) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)" />`).exec(html)?.[1];

describe('link preview tags', () => {
  it('index.html carries exactly the default Korean block, so pages the worker does not handle show the same preview', () => {
    const block = /<!-- og:begin -->\n([\s\S]*?)\n {4}<!-- og:end -->/.exec(indexHtml)?.[1];
    expect(block).toBe(renderMeta(defaultMeta('ko')));
  });

  it('has every tag a crawler reads, with absolute https addresses', () => {
    const html = renderMeta(defaultMeta('ko'));
    for (const k of ['og:type', 'og:title', 'og:description', 'og:image', 'og:image:secure_url', 'og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt', 'og:url', 'og:site_name', 'og:locale'])
      expect(tag(html, 'property', k), k).toBeTruthy();
    for (const k of ['description', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) expect(tag(html, 'name', k), k).toBeTruthy();
    expect(tag(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(tag(html, 'property', 'og:image')).toBe('https://jc-royal.site/og-image.png');
    expect(tag(html, 'property', 'og:image:width')).toBe('1200');
    expect(tag(html, 'property', 'og:image:height')).toBe('630');
    expect(html).toContain('<link rel="canonical" href="https://jc-royal.site/" />');
    for (const u of html.match(/(?:content|href)="(?:https?:)?\/\/[^"]*"/g) ?? []) expect(u).toMatch(/="https:\/\/jc-royal\.site\//);
    expect(html).toContain('<title>JC ROYAL | No.1 마인드 스포츠</title>');
  });

  it('English copy for ?lang=en', () => {
    expect(metaLocale(new URL('https://jc-royal.site/?lang=en'))).toBe('en');
    expect(metaLocale(new URL('https://jc-royal.site/?lang=fr'))).toBe('ko');
    const html = renderMeta(defaultMeta('en'));
    expect(tag(html, 'property', 'og:title')).toBe('JC ROYAL | No.1 Mind Sports');
    expect(tag(html, 'property', 'og:description')).toBe('Play Smart. Play Royal. Premium Texas Hold&#39;em with friends, solo bot games, and poker learning at JC ROYAL.');
    expect(tag(html, 'property', 'og:locale')).toBe('en_US');
  });

  it('escapes what members wrote and keeps it to one short line', () => {
    expect(escapeAttr(`"><script>alert('x')</script>&`)).toBe('&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;');
    expect(clip('a\n\n b\u0000c\u202e d', 50)).toBe('a b c d');
    expect(clip('가'.repeat(200), 10)).toBe(`${'가'.repeat(9)}…`);
    const html = renderMeta({ ...defaultMeta('ko'), title: '"/><script>x</script>' });
    expect(html).not.toContain('<script>');
  });

  it('replaces only the marked block', () => {
    const html = `<head>\n    <!-- og:begin -->\n    <title>old</title>\n    <!-- og:end -->\n    <link rel="icon" />\n</head>`;
    const out = replaceMeta(html, { ...defaultMeta('ko'), title: 'New' });
    expect(out).toContain('<title>New</title>');
    expect(out).not.toContain('<title>old</title>');
    expect(out).toContain('<link rel="icon" />');
    expect(replaceMeta('<head></head>', defaultMeta('ko'))).toBe('<head></head>');
    // The page language follows the preview's.
    const page = `<html lang="ko">\n${html}`;
    expect(replaceMeta(page, defaultMeta('en'))).toMatch(/^<html lang="en">/);
    expect(replaceMeta(page, defaultMeta('ko'))).toMatch(/^<html lang="ko">/);
  });
});

describe('per-page previews', () => {
  it('a public open table shows its name and blinds, never the query string', async () => {
    const { d1, asked } = fakeD1({ name: 'Royal Room', smallBlind: 5, bigBlind: 10, maxSeats: 6, isPrivate: 0, status: 'open' });
    const m = await metaFor(d1, new URL('https://jc-royal.site/table/t-1?code=secret-123&invite=abc'));
    expect(m.title).toBe('Royal Room | JC ROYAL');
    expect(m.description).toContain('5/10');
    expect(m.url).toBe('https://jc-royal.site/table/t-1');
    expect(JSON.stringify(m)).not.toMatch(/secret-123|abc/);
    expect(asked[0]!.sql).not.toMatch(/join_code/);
    expect(asked[0]!.args).toEqual(['t-1']);
  });

  it('a private or closed table gets the default preview', async () => {
    for (const row of [
      { name: 'Hidden', smallBlind: 5, bigBlind: 10, maxSeats: 6, isPrivate: 1, status: 'open' },
      { name: 'Hidden', smallBlind: 5, bigBlind: 10, maxSeats: 6, isPrivate: 0, status: 'closed' },
      null,
    ]) {
      const m = await metaFor(fakeD1(row).d1, new URL('https://jc-royal.site/table/t-2'));
      expect(m).toEqual(defaultMeta('ko', 'https://jc-royal.site/table/t-2'));
    }
  });

  it('a malformed id is not looked up or echoed', async () => {
    const { d1, asked } = fakeD1(null);
    const m = await metaFor(d1, new URL('https://jc-royal.site/table/%22%3E%3Cscript%3E'));
    expect(asked).toHaveLength(0);
    expect(m.url).toBe('https://jc-royal.site/');
  });

  it('a visible post shows its title and opening; hidden and deleted posts are not read', async () => {
    const { d1, asked } = fakeD1({ title: 'AA vs KK', body: '어제 핸드\n\n리뷰 부탁드립니다. '.repeat(20) });
    const m = await metaFor(d1, new URL('https://jc-royal.site/board/p-1?lang=en'));
    expect(m.title).toBe('AA vs KK | JC ROYAL Board');
    expect([...m.description].length).toBeLessThanOrEqual(110);
    expect(m.description.startsWith('어제 핸드 리뷰 부탁드립니다.')).toBe(true);
    expect(m.url).toBe('https://jc-royal.site/board/p-1?lang=en');
    // The query itself keeps hidden and deleted posts out.
    expect(asked[0]!.sql).toContain(`status = 'visible'`);
    const none = await metaFor(fakeD1(null).d1, new URL('https://jc-royal.site/board/p-2'));
    expect(none).toEqual(defaultMeta('ko', 'https://jc-royal.site/board/p-2'));
  });

  it('a referral link keeps a well-formed code and the default preview', async () => {
    const { d1, asked } = fakeD1(null);
    expect(await metaFor(d1, new URL('https://jc-royal.site/register?ref=jc7k4p2'))).toEqual(defaultMeta('ko', 'https://jc-royal.site/register?ref=JC7K4P2'));
    expect((await metaFor(d1, new URL('https://jc-royal.site/register?ref=%22%3E%3Cx'))).url).toBe('https://jc-royal.site/register');
    expect(asked).toHaveLength(0);
  });

  it('the home page and anything else use the default', async () => {
    const { d1 } = fakeD1(null);
    expect(await metaFor(d1, new URL('https://jc-royal.site/'))).toEqual(defaultMeta('ko'));
    expect(await metaFor(d1, new URL('https://jc-royal.site/?lang=en&utm=x'))).toEqual(defaultMeta('en', 'https://jc-royal.site/?lang=en'));
  });

  it('the image is the site banner', () => {
    expect(OG_IMAGE).toBe('https://jc-royal.site/og-image.png');
  });
});
