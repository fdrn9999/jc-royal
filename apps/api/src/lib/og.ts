/**
 * Link previews (Open Graph and Twitter cards). Crawlers read only the first HTML and do not run the app, so the tags
 * are in apps/web/index.html between the og:begin and og:end markers. For the shareable pages listed in wrangler.jsonc
 * run_worker_first the worker swaps that block for the page's own (index.ts sharePage); every other page keeps it.
 *
 * Only what a stranger may see goes in: a public table's name and blinds, a visible post's title and opening lines.
 * A private or closed table, and a hidden or deleted post, get the site's default preview. Query strings are never
 * echoed, except a well-formed referral code on /register (a code is meant to be shared).
 */
export const SITE = 'https://jc-royal.site';
/** Replacing the image: give the new file a new name (og-image-2.png) and change this, so caches fetch it again. */
export const OG_IMAGE = `${SITE}/og-image.png`;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export type MetaLocale = 'ko' | 'en';

const COPY = {
  ko: {
    title: 'JC ROYAL | No.1 마인드 스포츠',
    description: '전략과 승부가 만나는 곳. 친구와 즐기는 프리미엄 텍사스 홀덤, 혼자 즐기는 봇 플레이, 포커 아카데미까지. JC ROYAL에서 당신만의 테이블을 시작하세요.',
    alt: 'JC ROYAL — 블랙 앤 골드 텍사스 홀덤 배너',
    locale: 'ko_KR',
    table: (sb: number, bb: number, seats: number) => `텍사스 홀덤 · 블라인드 ${sb}/${bb} · ${seats}인 테이블. JC ROYAL에서 함께 플레이하세요.`,
    board: 'JC ROYAL 게시판',
  },
  en: {
    title: 'JC ROYAL | No.1 Mind Sports',
    description: "Play Smart. Play Royal. Premium Texas Hold'em with friends, solo bot games, and poker learning at JC ROYAL.",
    alt: "JC ROYAL — black and gold Texas Hold'em banner",
    locale: 'en_US',
    table: (sb: number, bb: number, seats: number) => `Texas Hold'em · ${sb}/${bb} blinds · ${seats}-max table. Play together at JC ROYAL.`,
    board: 'JC ROYAL Board',
  },
} as const;

export interface PageMeta {
  locale: MetaLocale;
  title: string;
  description: string;
  /** Absolute https address of the page (also the canonical link). */
  url: string;
}

export function defaultMeta(locale: MetaLocale = 'ko', url = `${SITE}/`): PageMeta {
  return { locale, title: COPY[locale].title, description: COPY[locale].description, url };
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One line of text at most `max` characters long: control characters and runs of white space become one space. */
export function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The block between the markers, indented as in index.html (a unit test keeps the two the same). */
export function renderMeta(m: PageMeta): string {
  const c = COPY[m.locale];
  const other = COPY[m.locale === 'ko' ? 'en' : 'ko'];
  const t = escapeAttr(m.title);
  const d = escapeAttr(m.description);
  const u = escapeAttr(m.url);
  const alt = escapeAttr(c.alt);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${u}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="JC ROYAL" />`,
    `<meta property="og:locale" content="${c.locale}" />`,
    `<meta property="og:locale:alternate" content="${other.locale}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    `<meta property="og:image:secure_url" content="${OG_IMAGE}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />`,
    `<meta property="og:image:alt" content="${alt}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`,
    `<meta name="twitter:image:alt" content="${alt}" />`,
  ]
    .map((l) => `    ${l}`)
    .join('\n');
}

const BEGIN = '<!-- og:begin -->';
const END = '<!-- og:end -->';

/** index.html with the block between the markers replaced (and the page language with it); unchanged when the markers are missing. */
export function replaceMeta(html: string, m: PageMeta): string {
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END, a);
  if (a < 0 || b < 0) return html;
  const out = `${html.slice(0, a + BEGIN.length)}\n${renderMeta(m)}\n    ${html.slice(b)}`;
  return m.locale === 'en' ? out.replace('<html lang="ko">', '<html lang="en">') : out;
}

/** English only when the link asks for it (?lang=en); the site and its crawlers' default is Korean. */
export function metaLocale(url: URL): MetaLocale {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'ko';
}

/** A referral code as members share it (JC + 5–10 letters or digits). Anything else is dropped from the preview. */
export const REFERRAL_CODE = /^JC[A-Z0-9]{5,10}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The page's address for the preview: the path, plus ?lang=en when asked for. Nothing else from the query. */
function pageUrl(path: string, locale: MetaLocale, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (locale === 'en') q.set('lang', 'en');
  const s = q.toString();
  return `${SITE}${path}${s ? `?${s}` : ''}`;
}

interface TableMetaRow {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  isPrivate: number;
  status: string;
}

interface PostMetaRow {
  title: string;
  body: string;
}

/** The preview for a page. Reads D1 only for a table or a post; a failed read leaves the default preview. */
export async function metaFor(d1: D1Database, url: URL): Promise<PageMeta> {
  const locale = metaLocale(url);
  const c = COPY[locale];
  const path = url.pathname;
  if (path === '/register') {
    const ref = (url.searchParams.get('ref') ?? '').trim().toUpperCase();
    return defaultMeta(locale, pageUrl('/register', locale, REFERRAL_CODE.test(ref) ? { ref } : {}));
  }
  const table = /^\/table\/([^/]+)\/?$/.exec(path)?.[1];
  if (table !== undefined) {
    if (!ID.test(table)) return defaultMeta(locale);
    const at = pageUrl(`/table/${table}`, locale);
    const r = await d1
      .prepare(`SELECT name, small_blind AS smallBlind, big_blind AS bigBlind, max_seats AS maxSeats, is_private AS isPrivate, status FROM tables WHERE id = ?1`)
      .bind(table)
      .first<TableMetaRow>();
    if (!r || r.isPrivate || r.status !== 'open') return defaultMeta(locale, at);
    return { locale, title: `${clip(r.name, 40)} | JC ROYAL`, description: c.table(r.smallBlind, r.bigBlind, r.maxSeats), url: at };
  }
  const post = /^\/board\/([^/]+)\/?$/.exec(path)?.[1];
  if (post !== undefined) {
    if (!ID.test(post)) return defaultMeta(locale);
    const at = pageUrl(`/board/${post}`, locale);
    const r = await d1.prepare(`SELECT title, body FROM posts WHERE id = ?1 AND status = 'visible'`).bind(post).first<PostMetaRow>();
    if (!r) return defaultMeta(locale, at);
    const summary = clip(r.body, 110);
    return { locale, title: `${clip(r.title, 60)} | ${c.board}`, description: summary || c.description, url: at };
  }
  return defaultMeta(locale, pageUrl('/', locale));
}
