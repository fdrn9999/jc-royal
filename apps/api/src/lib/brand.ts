/**
 * The admin console's brand check (routes/admin-brand.ts): what this deployment gives a link-preview crawler and a
 * browser offering to install the site. Everything is read in-process — the shareable pages through the same code that
 * answers crawlers (og.ts sharePageResponse), files from the static assets — so it checks what this worker serves, with
 * no request to the outside. Whether KakaoTalk or Facebook have cached an older preview is for their own debuggers
 * (TOOLS); this only says what they will find when they fetch again.
 *
 * Read only: nothing is written, and only what a stranger may see is looked at (a public table, a visible post).
 */
import { defaultMeta, OG_IMAGE, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, renderMeta, sharePageResponse, SITE, type MetaLocale } from './og';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
/** One finding: `id` names it (the console words it), `value` and `expected` what was found and what should be. */
export interface BrandCheck {
  id: string;
  status: CheckStatus;
  value?: string | number | boolean | null;
  expected?: string | number | boolean | null;
}

/** The debuggers that fetch a page again and show (and refresh) the preview each service has cached. */
export const TOOLS = [
  { id: 'kakao', url: 'https://developers.kakao.com/tool/debugger/sharing' },
  { id: 'facebook', url: 'https://developers.facebook.com/tools/debug/' },
] as const;

/** The tags a preview needs (og.test.ts and the integration test ask for the same). */
export const REQUIRED_TAGS = [
  'description', 'og:type', 'og:site_name', 'og:locale', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:secure_url', 'og:image:type',
  'og:image:width', 'og:image:height', 'og:image:alt', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image',
] as const;

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = (tag: string) => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!.toLowerCase()] = decode(m[2]!);
  return out;
};

export interface HeadMeta {
  lang: string | null;
  titles: string[];
  /** `property` or `name` of each meta tag → its contents, in order (a key twice is a duplicate). */
  tags: Record<string, string[]>;
  /** `rel` of each link → its hrefs. */
  links: Record<string, string[]>;
}

/** The head of an HTML page as a crawler reads it: no script runs, only the tags in the first HTML count. */
export function readHead(html: string): HeadMeta {
  const end = html.search(/<\/head>/i);
  const head = end < 0 ? html : html.slice(0, end);
  const tags: Record<string, string[]> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = a.property ?? a.name;
    if (key && a.content !== undefined) (tags[key] ??= []).push(a.content);
  }
  const links: Record<string, string[]> = {};
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.rel && a.href !== undefined) (links[a.rel] ??= []).push(a.href);
  }
  return {
    lang: /<html\b[^>]*\blang="([^"]*)"/i.exec(html)?.[1] ?? null,
    titles: [...head.matchAll(/<title>([^<]*)<\/title>/gi)].map((m) => decode(m[1]!)),
    tags,
    links,
  };
}

const first = (h: HeadMeta, k: string) => h.tags[k]?.[0];

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((x, i) => b[i] !== x) || String.fromCharCode(...b.slice(12, 16)) !== 'IHDR') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export interface PageExpect {
  url: string;
  locale: MetaLocale;
  /** A page that must show only the site's default preview (a private table): nothing of its own. */
  defaultOnly?: boolean;
}

/** The preview checks of one page's head. */
export function pageChecks(h: HeadMeta, want: PageExpect): BrandCheck[] {
  const out: BrandCheck[] = [];
  const missing = REQUIRED_TAGS.filter((k) => !first(h, k));
  out.push({ id: 'tags', status: missing.length || !h.titles.length ? 'fail' : 'ok', value: [...(h.titles.length ? [] : ['title']), ...missing].join(', ') || null });
  // Two og:title tags (a second block, a tag the app adds): services pick one or the other.
  const twice = Object.entries(h.tags).filter(([k, v]) => (k.startsWith('og:') || k.startsWith('twitter:')) && v.length > 1).map(([k]) => k);
  out.push({ id: 'duplicates', status: twice.length || h.titles.length > 1 ? 'warn' : 'ok', value: twice.join(', ') || null });
  out.push({ id: 'url', status: first(h, 'og:url') === want.url ? 'ok' : 'fail', value: first(h, 'og:url') ?? null, expected: want.url });
  const canonical = h.links.canonical?.[0] ?? null;
  out.push({ id: 'canonical', status: canonical === want.url ? 'ok' : 'warn', value: canonical, expected: want.url });
  const image = first(h, 'og:image') ?? null;
  out.push({ id: 'image', status: image === OG_IMAGE ? 'ok' : image?.startsWith('https://') ? 'warn' : 'fail', value: image, expected: OG_IMAGE });
  const size = `${first(h, 'og:image:width') ?? '?'}x${first(h, 'og:image:height') ?? '?'}`;
  out.push({ id: 'imageSize', status: size === `${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}` ? 'ok' : 'warn', value: size, expected: `${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}` });
  out.push({ id: 'twitterCard', status: first(h, 'twitter:card') === 'summary_large_image' ? 'ok' : 'warn', value: first(h, 'twitter:card') ?? null, expected: 'summary_large_image' });
  out.push({ id: 'lang', status: h.lang === want.locale ? 'ok' : 'warn', value: h.lang, expected: want.locale });
  if (want.defaultOnly) {
    const def = defaultMeta(want.locale).title;
    out.push({ id: 'private', status: first(h, 'og:title') === def && h.titles[0] === def ? 'ok' : 'fail', value: first(h, 'og:title') ?? null, expected: def });
  }
  return out;
}

const PWA_DISPLAY = ['standalone', 'fullscreen', 'minimal-ui'];

interface ManifestIcon {
  src?: unknown;
  sizes?: unknown;
  type?: unknown;
  purpose?: unknown;
}

/** The install checks of the manifest's fields, against index.html's head. */
export function manifestChecks(m: Record<string, unknown> | null, index: HeadMeta): BrandCheck[] {
  if (!m) return [{ id: 'manifestJson', status: 'fail' }];
  const icons = (Array.isArray(m.icons) ? m.icons : []) as ManifestIcon[];
  const has = (px: number) => icons.some((i) => String(i.sizes ?? '').split(/\s+/).includes(`${px}x${px}`) && (i.type === undefined || i.type === 'image/png'));
  const missing = ['name', 'short_name', 'start_url'].filter((k) => typeof m[k] !== 'string' || !(m[k] as string).trim());
  const theme = first(index, 'theme-color') ?? null;
  return [
    { id: 'manifestFields', status: missing.length ? 'fail' : 'ok', value: missing.join(', ') || null },
    { id: 'display', status: PWA_DISPLAY.includes(String(m.display)) ? 'ok' : 'fail', value: typeof m.display === 'string' ? m.display : null, expected: 'standalone' },
    { id: 'icons', status: has(192) && has(512) ? 'ok' : 'fail', value: icons.map((i) => String(i.sizes ?? '?')).join(', ') || null, expected: '192x192, 512x512' },
    { id: 'maskable', status: icons.some((i) => String(i.purpose ?? '').split(/\s+/).includes('maskable')) ? 'ok' : 'info' },
    { id: 'themeColor', status: theme && m.theme_color === theme ? 'ok' : 'warn', value: typeof m.theme_color === 'string' ? m.theme_color : null, expected: theme },
    { id: 'manifestLink', status: index.links.manifest?.length ? 'ok' : 'fail', value: index.links.manifest?.[0] ?? null },
    { id: 'appleIcon', status: index.links['apple-touch-icon']?.length ? 'ok' : 'warn', value: index.links['apple-touch-icon']?.[0] ?? null },
    { id: 'https', status: SITE.startsWith('https://') ? 'ok' : 'fail', value: SITE },
    // No service worker on purpose: game, sign-in and private card data are never cached offline. Browsers that still
    // want one for their install prompt show none; the site is installed from the browser menu there.
    { id: 'serviceWorker', status: 'info', value: false },
  ];
}

const worst = (cs: BrandCheck[]): CheckStatus => (cs.some((c) => c.status === 'fail') ? 'fail' : cs.some((c) => c.status === 'warn') ? 'warn' : 'ok');

/** A static file of this deployment: status, type, size, cache and (a PNG) its pixel size. */
async function asset(assets: Fetcher, path: string) {
  try {
    const r = await assets.fetch(new Request(new URL(path, SITE)));
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { path, status: r.status, contentType: r.headers.get('content-type'), bytes: bytes.length, cacheControl: r.headers.get('cache-control'), body: bytes };
  } catch {
    return { path, status: 0, contentType: null, bytes: 0, cacheControl: null, body: new Uint8Array() };
  }
}

/** The pages a check reads: the site in both languages, a referral link, and a public table and a visible post when there are. */
async function samplePages(d1: D1Database) {
  const [table, privateTable, post] = await Promise.all([
    d1.prepare(`SELECT id FROM tables WHERE status = 'open' AND is_private = 0 AND room_type != 'tournament' ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>(),
    d1.prepare(`SELECT id FROM tables WHERE status = 'open' AND is_private = 1 ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>(),
    d1.prepare(`SELECT id FROM posts WHERE status = 'visible' ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>(),
  ]);
  const pages: { kind: string; path: string; want: PageExpect }[] = [
    { kind: 'home', path: '/', want: { url: `${SITE}/`, locale: 'ko' } },
    { kind: 'homeEn', path: '/?lang=en', want: { url: `${SITE}/?lang=en`, locale: 'en' } },
    { kind: 'register', path: '/register?ref=JC7K4P2', want: { url: `${SITE}/register?ref=JC7K4P2`, locale: 'ko' } },
  ];
  if (table) pages.push({ kind: 'table', path: `/table/${table.id}`, want: { url: `${SITE}/table/${table.id}`, locale: 'ko' } });
  if (privateTable) pages.push({ kind: 'privateTable', path: `/table/${privateTable.id}`, want: { url: `${SITE}/table/${privateTable.id}`, locale: 'ko', defaultOnly: true } });
  if (post) pages.push({ kind: 'post', path: `/board/${post.id}`, want: { url: `${SITE}/board/${post.id}`, locale: 'ko' } });
  return pages;
}

/** The whole check. `assets` absent (a worker run without the built site): only that is reported. */
export async function brandReport(assets: Fetcher | undefined, d1: D1Database) {
  const checkedAt = Date.now();
  const tools = TOOLS.map((t) => ({ ...t }));
  if (!assets) return { checkedAt, site: SITE, assets: false as const, summary: { ok: 0, warn: 0, fail: 1 }, tools };

  // The built index.html: the markers the worker writes between, and the default block it carries.
  const indexFile = await asset(assets, '/');
  const indexHtml = new TextDecoder().decode(indexFile.body);
  const a = indexHtml.indexOf('<!-- og:begin -->');
  const b = indexHtml.indexOf('<!-- og:end -->');
  const block = a >= 0 && b > a ? indexHtml.slice(a + '<!-- og:begin -->'.length, b).trim() : null;
  const indexHead = readHead(indexHtml);
  const index = {
    status: indexFile.status,
    checks: [
      { id: 'markers', status: block !== null ? 'ok' : 'fail' },
      { id: 'defaultBlock', status: block !== null && block === renderMeta(defaultMeta()).trim() ? 'ok' : 'warn' },
    ] as BrandCheck[],
  };

  const pages = await Promise.all(
    (await samplePages(d1)).map(async (p) => {
      try {
        const r = await sharePageResponse(assets, d1, new URL(p.path, SITE));
        const head = readHead(await r.text());
        const checks: BrandCheck[] = [{ id: 'status', status: r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('text/html') ? 'ok' : 'fail', value: r.status }, ...pageChecks(head, p.want)];
        return { kind: p.kind, path: p.path, status: worst(checks), title: head.tags['og:title']?.[0] ?? null, description: head.tags['og:description']?.[0] ?? null, url: head.tags['og:url']?.[0] ?? null, checks };
      } catch {
        return { kind: p.kind, path: p.path, status: 'fail' as const, title: null, description: null, url: null, checks: [{ id: 'status', status: 'fail' as const, value: 0 }] };
      }
    }),
  );

  // The image the tags name, as this deployment serves it.
  const imagePath = new URL(OG_IMAGE).pathname;
  const img = await asset(assets, imagePath);
  const px = pngSize(img.body);
  const image = {
    url: OG_IMAGE,
    path: imagePath,
    status: img.status,
    contentType: img.contentType,
    bytes: img.bytes,
    width: px?.width ?? null,
    height: px?.height ?? null,
    cacheControl: img.cacheControl,
    checks: [
      { id: 'imageStatus', status: img.status === 200 ? 'ok' : 'fail', value: img.status },
      { id: 'imageType', status: (img.contentType ?? '').startsWith('image/png') ? 'ok' : 'fail', value: img.contentType, expected: 'image/png' },
      { id: 'imagePixels', status: px?.width === OG_IMAGE_WIDTH && px.height === OG_IMAGE_HEIGHT ? 'ok' : 'fail', value: px ? `${px.width}x${px.height}` : null, expected: `${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}` },
      // Facebook takes images up to 8 MB; smaller ones are fetched (and shown) sooner by every service.
      { id: 'imageBytes', status: img.bytes > 0 && img.bytes <= 8 * 1024 * 1024 ? 'ok' : 'fail', value: img.bytes },
      { id: 'imageSameSite', status: OG_IMAGE.startsWith(`${SITE}/`) ? 'ok' : 'warn', value: OG_IMAGE },
    ] as BrandCheck[],
  };

  // Installing: the manifest, each icon it lists, and the head of index.html that points to them.
  const mf = await asset(assets, indexHead.links.manifest?.[0] ?? '/manifest.webmanifest');
  let manifest: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(mf.body));
    manifest = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    manifest = null;
  }
  const declared = (Array.isArray(manifest?.icons) ? manifest.icons : []) as ManifestIcon[];
  const icons = await Promise.all(
    declared
      .filter((i) => typeof i.src === 'string')
      .slice(0, 8)
      .map(async (i) => {
        const f = await asset(assets, i.src as string);
        const s = pngSize(f.body);
        const size = s ? `${s.width}x${s.height}` : null;
        const ok = f.status === 200 && !!s && String(i.sizes ?? '').split(/\s+/).includes(size!);
        return { src: i.src as string, sizes: String(i.sizes ?? ''), status: f.status, contentType: f.contentType, bytes: f.bytes, size, check: (ok ? 'ok' : 'fail') as CheckStatus };
      }),
  );
  const pwaChecks: BrandCheck[] = [
    { id: 'manifestStatus', status: mf.status === 200 ? 'ok' : 'fail', value: mf.status },
    { id: 'manifestType', status: (mf.contentType ?? '').startsWith('application/manifest+json') ? 'ok' : (mf.contentType ?? '').includes('json') ? 'warn' : 'fail', value: mf.contentType, expected: 'application/manifest+json' },
    ...manifestChecks(manifest, indexHead),
    { id: 'iconFiles', status: icons.length && icons.every((i) => i.check === 'ok') ? 'ok' : 'fail', value: icons.filter((i) => i.check !== 'ok').map((i) => i.src).join(', ') || null },
  ];
  const pwa = {
    manifest: manifest ? { name: manifest.name ?? null, shortName: manifest.short_name ?? null, startUrl: manifest.start_url ?? null, display: manifest.display ?? null, themeColor: manifest.theme_color ?? null, lang: manifest.lang ?? null } : null,
    icons,
    checks: pwaChecks,
  };

  const all = [...index.checks, ...pages.flatMap((p) => p.checks), ...image.checks, ...pwaChecks];
  const summary = { ok: all.filter((c) => c.status === 'ok').length, warn: all.filter((c) => c.status === 'warn').length, fail: all.filter((c) => c.status === 'fail').length };
  return { checkedAt, site: SITE, assets: true as const, summary, index, pages, image, pwa, tools };
}

/**
 * The preview image's bytes, to show it in the console (whose pages load images only from their own origin). Not cached:
 * like every /api reply it goes out `no-store` (lib/http.ts securityHeaders).
 */
export async function ogImage(assets: Fetcher | undefined): Promise<Response | null> {
  if (!assets) return null;
  const r = await assets.fetch(new Request(new URL(new URL(OG_IMAGE).pathname, SITE)));
  if (!r.ok) return null;
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') ?? 'image/png' } });
}
