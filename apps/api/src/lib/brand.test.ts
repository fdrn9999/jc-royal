import { describe, expect, it } from 'vitest';
import indexHtml from '../../../web/index.html?raw';
import { manifestChecks, pageChecks, pngSize, readHead, REQUIRED_TAGS } from './brand';
import { defaultMeta, OG_IMAGE, renderMeta, replaceMeta, SITE } from './og';

const status = (cs: { id: string; status: string }[], id: string) => cs.find((c) => c.id === id)?.status;
const page = (meta = defaultMeta('ko')) => replaceMeta(indexHtml, meta);

describe('readHead', () => {
  it('reads tags as a crawler does: the first HTML only, entities decoded, every occurrence kept', () => {
    const h = readHead('<html lang="en"><head><title>A &amp; B</title><meta property="og:title" content="x &quot;y&quot;"><meta property="og:title" content="z" /><meta name="description" content="d"><link rel="canonical" href="https://a/"></head><body><meta property="og:image" content="late"></body></html>');
    expect(h.lang).toBe('en');
    expect(h.titles).toEqual(['A & B']);
    expect(h.tags['og:title']).toEqual(['x "y"', 'z']);
    expect(h.tags.description).toEqual(['d']);
    expect(h.links.canonical).toEqual(['https://a/']);
    // A tag a script would add after the head is not what a crawler sees.
    expect(h.tags['og:image']).toBeUndefined();
  });
});

describe('pngSize', () => {
  it('reads the IHDR width and height, and refuses anything that is not a PNG', () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, 1200);
    new DataView(b.buffer).setUint32(20, 630);
    expect(pngSize(b)).toEqual({ width: 1200, height: 630 });
    expect(pngSize(b.slice(0, 20))).toBeNull();
    const jpeg = b.slice();
    jpeg[0] = 0xff;
    expect(pngSize(jpeg)).toBeNull();
  });
});

describe('pageChecks', () => {
  it('passes every check on the page the worker serves for the home page', () => {
    const checks = pageChecks(readHead(page()), { url: `${SITE}/`, locale: 'ko' });
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
  });

  it('names a missing tag, a second og:title and a wrong address', () => {
    const html = page().replace(/<meta property="og:image:alt"[^>]*>/, '').replace('</head>', '<meta property="og:title" content="again" /></head>');
    const checks = pageChecks(readHead(html), { url: `${SITE}/board/1`, locale: 'ko' });
    expect(checks.find((c) => c.id === 'tags')).toMatchObject({ status: 'fail', value: 'og:image:alt' });
    expect(checks.find((c) => c.id === 'duplicates')).toMatchObject({ status: 'warn', value: 'og:title' });
    expect(status(checks, 'url')).toBe('fail');
    expect(status(checks, 'canonical')).toBe('warn');
  });

  it('fails a private table whose preview carries anything but the site default', () => {
    const own = { ...defaultMeta('ko'), title: 'Secret room · JC Royal' };
    const leak = pageChecks(readHead(page(own)), { url: `${SITE}/`, locale: 'ko', defaultOnly: true });
    expect(status(leak, 'private')).toBe('fail');
    const safe = pageChecks(readHead(page()), { url: `${SITE}/`, locale: 'ko', defaultOnly: true });
    expect(status(safe, 'private')).toBe('ok');
  });

  it('warns on an image elsewhere and fails one that is not https', () => {
    const other = page().replaceAll(OG_IMAGE, 'https://cdn.example.com/og.png');
    expect(status(pageChecks(readHead(other), { url: `${SITE}/`, locale: 'ko' }), 'image')).toBe('warn');
    const plain = page().replaceAll(OG_IMAGE, 'http://example.com/og.png');
    expect(status(pageChecks(readHead(plain), { url: `${SITE}/`, locale: 'ko' }), 'image')).toBe('fail');
  });

  it('asks for the same tags the link preview renders', () => {
    const h = readHead(`<head><title>t</title>${renderMeta(defaultMeta('en'))}</head>`);
    expect(REQUIRED_TAGS.filter((k) => !h.tags[k]?.[0])).toEqual([]);
  });
});

describe('manifestChecks', () => {
  const index = readHead(indexHtml);
  const good = {
    name: 'JC Royal',
    short_name: 'JC Royal',
    start_url: '/',
    display: 'standalone',
    theme_color: index.tags['theme-color']?.[0],
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
  };

  it('passes a complete manifest, and reports the missing service worker as a deliberate note', () => {
    const checks = manifestChecks(good, index);
    expect(checks.filter((c) => c.status === 'fail' || c.status === 'warn')).toEqual([]);
    expect(checks.find((c) => c.id === 'serviceWorker')).toMatchObject({ status: 'info', value: false });
    expect(status(checks, 'maskable')).toBe('info');
  });

  it('fails a manifest that cannot be installed', () => {
    expect(manifestChecks(null, index)).toEqual([{ id: 'manifestJson', status: 'fail' }]);
    const bad = manifestChecks({ ...good, short_name: ' ', display: 'browser', icons: [good.icons[0]] }, index);
    expect(bad.find((c) => c.id === 'manifestFields')).toMatchObject({ status: 'fail', value: 'short_name' });
    expect(status(bad, 'display')).toBe('fail');
    expect(status(bad, 'icons')).toBe('fail');
    expect(status(manifestChecks({ ...good, theme_color: '#ffffff' }, index), 'themeColor')).toBe('warn');
  });

  it('checks the built index.html links the manifest and an apple-touch-icon', () => {
    const checks = manifestChecks(good, index);
    expect(status(checks, 'manifestLink')).toBe('ok');
    expect(status(checks, 'appleIcon')).toBe('ok');
  });
});
