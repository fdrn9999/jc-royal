/**
 * Draws a replay step's share image (its content from shareSnap.ts) on a 2D canvas: the app's cards, table and colours
 * drawn again at the image's own size, so it reads the same whatever the screen's resolution and nothing of the page is
 * captured (no screenshot, no other site's pixels: the logo is the site's own, the fonts are the page's). Suits are
 * drawn shapes, not text, so no font can lose or swap them. Every layout is worked out for its ratio, not stretched or
 * cropped from another. Each piece's box can be recorded (`boxes`): the tests check that nothing leaves the image or
 * lies over another piece. This module loads only when an image is made.
 */
import { VIP_COLORS, type Card, type PublicRole, type VipColor } from '@jc/types';
import { chipTier, LOGO_SRC } from '@jc/ui';
import { SHARE_SIZES, type ShareAmount, type ShareFormat, type ShareOptions, type ShareSeat, type ShareSnap } from './shareSnap';

type Ctx = CanvasRenderingContext2D;
type Stop = [at: number, color: string];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The colours the image takes from the app: the table theme, the suits (colour vision mode, four-colour deck), VIP names, chips. */
export interface SharePalette {
  bg: Stop[];
  felt: Stop[];
  feltLine: string;
  rail: Stop[];
  railInner: string;
  seat: string;
  seatBorder: string;
  accent: string;
  winner: string;
  watermark: number;
  suits: Record<'s' | 'h' | 'd' | 'c', string>;
  vip: Record<VipColor, string>;
  vipMark: string;
  chips: { base: string; face: string }[];
}

/** The Royal theme with the standard suits: where the page's own colours cannot be read (tests). */
export const DEFAULT_PALETTE: SharePalette = {
  bg: [
    [0, '#1d1a12'],
    [0.45, '#0b0b0d'],
    [1, '#050506'],
  ],
  felt: [
    [0, '#145a43'],
    [0.48, '#0c3d2e'],
    [1, '#072419'],
  ],
  feltLine: 'rgba(243, 221, 155, 0.14)',
  rail: [
    [0, '#1a1712'],
    [0.22, '#3a2f17'],
    [0.48, '#c9a227'],
    [0.7, '#6f5615'],
    [1, '#15120c'],
  ],
  railInner: '#0b0c0e',
  seat: 'rgba(10, 11, 13, 0.9)',
  seatBorder: 'rgba(212, 175, 55, 0.3)',
  accent: '#d4af37',
  winner: '#f3dd9b',
  watermark: 0.08,
  suits: { s: '#15171c', h: '#b3212b', d: '#b3212b', c: '#15171c' },
  vip: { gold: '#f2c14e', rose: '#ff8fb3', sapphire: '#82a8ff', amethyst: '#c39bff', emerald: '#4fd6a0', cyan: '#5ad7ec' },
  vipMark: '#f3d27a',
  chips: [
    { base: '#2f5c8f', face: '#4176b0' },
    { base: '#8f2622', face: '#b23a35' },
    { base: '#155a37', face: '#1f7a4b' },
    { base: '#202026', face: '#383842' },
    { base: '#6e2050', face: '#8d2f69' },
    { base: '#9c7414', face: '#c9a227' },
    { base: '#5b2f78', face: '#7b45a0' },
    { base: '#1f4f6b', face: '#2c6f93' },
    { base: '#1d1d22', face: '#3a3a44' },
  ],
};

const STOP = /(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s+(\d+(?:\.\d+)?)%/gi;
/** A CSS gradient's colour stops ("#145a43 0%, #0c3d2e 48%, …"), or `fallback` where there are not two. */
function stops(css: string, fallback: Stop[]): Stop[] {
  const out = Array.from(css.matchAll(STOP), (m): Stop => [Number(m[2]) / 100, m[1]!]);
  return out.length >= 2 ? out : fallback;
}

/** The colours the page shows now: its theme and colour vision mode (on <html>), with the four-colour deck or without. */
export function readPalette(four: boolean, root: HTMLElement = document.documentElement): SharePalette {
  const cs = getComputedStyle(root);
  const v = (k: string) => cs.getPropertyValue(k).trim();
  const color = (k: string, fallback: string) => v(k) || fallback;
  const D = DEFAULT_PALETTE;
  const red = color('--suit-red', D.suits.h);
  const black = color('--suit-black', D.suits.s);
  return {
    bg: stops(v('--t-bg'), D.bg),
    felt: stops(v('--t-felt'), D.felt),
    feltLine: color('--t-felt-line', D.feltLine),
    rail: stops(v('--t-rail'), D.rail),
    railInner: color('--t-rail-inner', D.railInner),
    seat: color('--t-seat', D.seat),
    seatBorder: color('--t-seat-border', D.seatBorder),
    accent: color('--t-accent', D.accent),
    winner: color('--t-winner', D.winner),
    watermark: Number(v('--t-watermark-opacity')) || D.watermark,
    suits: { s: black, h: red, d: four ? color('--suit-diamond', '#1f5fbf') : red, c: four ? color('--suit-club', '#1d7a3e') : black },
    vip: Object.fromEntries(VIP_COLORS.map((k) => [k, color(`--vip-${k}`, D.vip[k])])) as Record<VipColor, string>,
    vipMark: color('--vip-badge-fg', D.vipMark),
    chips: D.chips.map((c, n) => ({ base: color(`--chip-t${n}-base`, c.base), face: color(`--chip-t${n}-face`, c.face) })),
  };
}

/** A piece as drawn: text, a card (face or back) or a mark (button, chip, badge, empty board place). */
export interface ShareBox {
  id: string;
  /** Pieces of one group (a seat, the board) may lie over one another; pieces of different groups may not. */
  group: string;
  kind: 'text' | 'card' | 'mark';
  x: number;
  y: number;
  w: number;
  h: number;
  /** A card's face, or null for its back. */
  card?: Card | null;
  /** A card lit as part of a winning hand. */
  lit?: boolean;
  text?: string;
}

/** What drawing needs besides the step: the colours and the logo (none in tests). */
export interface ShareArt {
  pal: SharePalette;
  logo: { img: CanvasImageSource; ratio: number } | null;
}

interface Pen {
  ctx: Ctx;
  pal: SharePalette;
  logo: ShareArt['logo'];
  boxes: ShareBox[] | undefined;
  group: string;
  opt: ShareOptions;
  snap: ShareSnap;
}

const SANS = "'Pretendard Variable', Pretendard, 'Noto Sans KR', system-ui, sans-serif";
const DISPLAY = "Cinzel, 'Times New Roman', serif";
type Face = 'sans' | 'display';
const IVORY = '#f4efe3';
const INK_200 = '#b9bcc3';
const INK_300 = '#8d929c';
const GOLD_300 = '#f3dd9b';
const WIN = '#9fd8b6';
const ROLE_COLOR: Record<PublicRole, string> = { super_admin: '#f8e3b0', admin: '#8fd0ff' };
const M = 56;
const HEAD = 112;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function record(pen: Pen, kind: ShareBox['kind'], id: string, x: number, y: number, w: number, h: number, extra: Partial<ShareBox> = {}) {
  pen.boxes?.push({ id, group: pen.group, kind, x, y, w, h, ...extra });
}

function setFont(ctx: Ctx, size: number, weight = 600, face: Face = 'sans') {
  ctx.font = `${weight} ${Math.round(size * 10) / 10}px ${face === 'display' ? DISPLAY : SANS}`;
}
const width = (ctx: Ctx, s: string) => ctx.measureText(s).width;

/** `text` cut with an ellipsis to `maxW` in the current font: never wider, so nothing where not even "x…" fits. */
function clip(ctx: Ctx, text: string, maxW: number) {
  if (width(ctx, text) <= maxW) return text;
  const chars = Array.from(text);
  while (chars.length > 0 && width(ctx, `${chars.join('').trimEnd()}…`) > maxW) chars.pop();
  return chars.length > 0 ? `${chars.join('').trimEnd()}…` : '';
}

interface Fitted {
  text: string;
  size: number;
  w: number;
}
/** A name or a phrase at the largest size from `size` down to `min` that fits, then cut with an ellipsis at `min`. */
function fit(ctx: Ctx, text: string, maxW: number, size: number, min: number, weight = 600, face: Face = 'sans'): Fitted {
  for (let s = Math.round(size); s >= min; s--) {
    setFont(ctx, s, weight, face);
    const w = width(ctx, text);
    if (w <= maxW) return { text, size: s, w };
  }
  setFont(ctx, min, weight, face);
  const cut = clip(ctx, text, maxW);
  return { text: cut, size: min, w: width(ctx, cut) };
}
/** An amount: in full at the largest size that fits, else its short form ("1.2M"); never cut. */
function fitAmount(ctx: Ctx, a: ShareAmount, maxW: number, size: number, min: number, weight = 700): Fitted {
  for (const text of [a.full, a.short]) {
    for (let s = Math.round(size); s >= min; s--) {
      setFont(ctx, s, weight);
      const w = width(ctx, text);
      if (w <= maxW) return { text, size: s, w };
    }
  }
  setFont(ctx, min, weight);
  return { text: a.short, size: min, w: width(ctx, a.short) };
}

/** One run of text in a line: words (cut last, with an ellipsis), or an amount (shortened, never cut). */
interface Part {
  text?: string;
  amount?: ShareAmount;
  color: string | CanvasGradient;
  weight?: number;
  face?: Face;
  /** Space before it, in ems. */
  gap?: number;
}
interface FittedParts {
  size: number;
  texts: string[];
  widths: number[];
  total: number;
}
/**
 * A line of parts at one size: the largest that fits, then with short amounts, then at `min` with the words cut evenly
 * (the longest first, each to the same width) — never the amounts or a mark of a character or two ("+", "·").
 */
function fitParts(ctx: Ctx, parts: Part[], maxW: number, size: number, min: number): FittedParts {
  const measure = (s: number, short: boolean, texts?: string[]): FittedParts => {
    const t = texts ?? parts.map((p) => (p.amount ? (short ? p.amount.short : p.amount.full) : (p.text ?? '')));
    const widths = t.map((x, k) => {
      setFont(ctx, s, parts[k]!.weight ?? 600, parts[k]!.face);
      return width(ctx, x);
    });
    return { size: s, texts: t, widths, total: sum(widths) + sum(parts.map((p) => (p.gap ?? 0) * s)) };
  };
  for (const short of [false, true]) {
    for (let s = Math.round(size); s >= min; s--) {
      const m = measure(s, short);
      if (m.total <= maxW) return m;
    }
  }
  const m = measure(min, true);
  const cuts = parts.map((_, k) => k).filter((k) => !parts[k]!.amount && Array.from(m.texts[k]!).length > 2);
  const room = maxW - (m.total - sum(cuts.map((k) => m.widths[k]!)));
  // The widest a word may stay: the largest cap with the words, each at most that wide, filling the room left.
  let lo = 0;
  let hi = Math.max(0, ...cuts.map((k) => m.widths[k]!));
  for (let i = 0; i < 24; i++) {
    const cap = (lo + hi) / 2;
    if (sum(cuts.map((k) => Math.min(m.widths[k]!, cap))) <= room) lo = cap;
    else hi = cap;
  }
  const texts = [...m.texts];
  for (const k of cuts) {
    if (m.widths[k]! <= lo) continue;
    setFont(ctx, min, parts[k]!.weight ?? 600, parts[k]!.face);
    texts[k] = clip(ctx, texts[k]!, lo);
  }
  return measure(min, true, texts);
}
/** Whether a fitted line keeps every word whole (its amounts may be short). */
const whole = (parts: Part[], f: FittedParts) => parts.every((p, k) => !!p.amount || f.texts[k] === (p.text ?? ''));
/** Draws fitted parts from `x` (left, centre or right of the whole line) on the line through `cy`. */
function drawParts(pen: Pen, parts: Part[], f: FittedParts, x: number, cy: number, align: 'left' | 'center' | 'right', id: string) {
  const { ctx } = pen;
  let at = align === 'left' ? x : align === 'center' ? x - f.total / 2 : x - f.total;
  parts.forEach((p, k) => {
    at += (p.gap ?? 0) * f.size;
    const text = f.texts[k]!;
    if (text) {
      setFont(ctx, f.size, p.weight ?? 600, p.face);
      ctx.fillStyle = p.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, at, cy);
      record(pen, 'text', `${id}-${k}`, at, cy - f.size * 0.62, f.widths[k]!, f.size * 1.24, { text });
    }
    at += f.widths[k]!;
  });
}
/** A single run of fitted text. */
function put(pen: Pen, f: Fitted, x: number, cy: number, color: string | CanvasGradient, id: string, o: { align?: 'left' | 'center' | 'right'; weight?: number; face?: Face } = {}) {
  const { ctx } = pen;
  const align = o.align ?? 'left';
  setFont(ctx, f.size, o.weight ?? 600, o.face);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(f.text, x, cy);
  const left = align === 'center' ? x - f.w / 2 : align === 'right' ? x - f.w : x;
  record(pen, 'text', id, left, cy - f.size * 0.62, f.w, f.size * 1.24, { text: f.text });
}

/** A CSS linear-gradient(`deg`) over a box. */
function linear(ctx: Ctx, r: Rect, deg: number, s: Stop[]) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(r.w * dx) + Math.abs(r.h * dy)) / 2;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  for (const [at, c] of s) g.addColorStop(at, c);
  return g;
}
const goldText = (ctx: Ctx, y: number, h: number) => {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#f6e3a6');
  g.addColorStop(0.5, '#d4af37');
  g.addColorStop(1, '#a07c1c');
  return g;
};

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** A suit as a shape in the `k`-sized square at (x, y). */
function suit(ctx: Ctx, s: string, x: number, y: number, k: number, color: string) {
  const X = (v: number) => x + v * k;
  const Y = (v: number) => y + v * k;
  ctx.beginPath();
  if (s === 'h') {
    ctx.moveTo(X(0.5), Y(0.96));
    ctx.bezierCurveTo(X(0.2), Y(0.72), X(0), Y(0.52), X(0), Y(0.3));
    ctx.bezierCurveTo(X(0), Y(0.13), X(0.13), Y(0.03), X(0.27), Y(0.03));
    ctx.bezierCurveTo(X(0.39), Y(0.03), X(0.47), Y(0.1), X(0.5), Y(0.21));
    ctx.bezierCurveTo(X(0.53), Y(0.1), X(0.61), Y(0.03), X(0.73), Y(0.03));
    ctx.bezierCurveTo(X(0.87), Y(0.03), X(1), Y(0.13), X(1), Y(0.3));
    ctx.bezierCurveTo(X(1), Y(0.52), X(0.8), Y(0.72), X(0.5), Y(0.96));
  } else if (s === 'd') {
    ctx.moveTo(X(0.5), Y(0));
    ctx.quadraticCurveTo(X(0.68), Y(0.28), X(0.9), Y(0.5));
    ctx.quadraticCurveTo(X(0.68), Y(0.72), X(0.5), Y(1));
    ctx.quadraticCurveTo(X(0.32), Y(0.72), X(0.1), Y(0.5));
    ctx.quadraticCurveTo(X(0.32), Y(0.28), X(0.5), Y(0));
  } else if (s === 's') {
    ctx.moveTo(X(0.5), Y(0));
    ctx.bezierCurveTo(X(0.62), Y(0.17), X(1), Y(0.36), X(1), Y(0.6));
    ctx.bezierCurveTo(X(1), Y(0.76), X(0.88), Y(0.86), X(0.74), Y(0.86));
    ctx.bezierCurveTo(X(0.64), Y(0.86), X(0.57), Y(0.81), X(0.53), Y(0.74));
    ctx.quadraticCurveTo(X(0.56), Y(0.92), X(0.7), Y(1));
    ctx.lineTo(X(0.3), Y(1));
    ctx.quadraticCurveTo(X(0.44), Y(0.92), X(0.47), Y(0.74));
    ctx.bezierCurveTo(X(0.43), Y(0.81), X(0.36), Y(0.86), X(0.26), Y(0.86));
    ctx.bezierCurveTo(X(0.12), Y(0.86), X(0), Y(0.76), X(0), Y(0.6));
    ctx.bezierCurveTo(X(0), Y(0.36), X(0.38), Y(0.17), X(0.5), Y(0));
  } else {
    // Three lobes, the middle filled in, and the stem (wound the same way as the lobes, so where they meet stays filled).
    const lobe = (cx: number, cy: number, r: number) => {
      ctx.moveTo(X(cx + r), Y(cy));
      ctx.arc(X(cx), Y(cy), r * k, 0, Math.PI * 2);
    };
    lobe(0.5, 0.27, 0.22);
    lobe(0.25, 0.58, 0.22);
    lobe(0.75, 0.58, 0.22);
    lobe(0.5, 0.55, 0.13);
    ctx.moveTo(X(0.53), Y(0.6));
    ctx.quadraticCurveTo(X(0.55), Y(0.9), X(0.7), Y(1));
    ctx.lineTo(X(0.3), Y(1));
    ctx.quadraticCurveTo(X(0.45), Y(0.9), X(0.47), Y(0.6));
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * A card `w` wide at (x, y) as the app draws it: the face's rank and small suit in the corner and the big suit at the
 * bottom right, or the gold-hatched back with the logo. `highlight` rings it in gold and lifts it, `dim` darkens it.
 */
function card(pen: Pen, c: Card | null, x: number, y: number, w: number, id: string, o: { highlight?: boolean; dim?: boolean } = {}) {
  const { ctx, pal } = pen;
  const h = w * 1.4;
  const r = w * 0.12;
  const k = w / 52;
  const top = o.highlight ? y - 4 * k : y;
  const box: Rect = { x, y: top, w, h };
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 10 * k;
  ctx.shadowOffsetY = 4 * k;
  rr(ctx, x, top, w, h, r);
  ctx.fillStyle = c
    ? linear(ctx, box, 165, [
        [0, '#fffdf7'],
        [1, '#f3ecdc'],
      ])
    : linear(ctx, box, 160, [
        [0, '#15161a'],
        [1, '#070708'],
      ]);
  ctx.fill();
  ctx.restore();
  if (c) {
    ctx.save();
    rr(ctx, x, top, w, h, r);
    ctx.clip();
    ctx.fillStyle = linear(ctx, box, 160, [
      [0, 'rgba(255, 255, 255, 0.4)'],
      [0.38, 'rgba(255, 255, 255, 0)'],
    ]);
    ctx.fillRect(x, top, w, h);
    ctx.restore();
    rr(ctx, x, top, w, h, r);
    ctx.lineWidth = Math.max(1, k);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.stroke();
    const s = c[1] as keyof SharePalette['suits'];
    const color = pal.suits[s];
    const rank = c[0] === 'T' ? '10' : c[0]!;
    const size = w * 0.34;
    setFont(ctx, size, 700, 'display');
    const col = Math.max(width(ctx, rank), w * 0.24);
    const cx = x + w * 0.08 + col / 2;
    const y0 = top + h * 0.06;
    const ascent = ctx.measureText(rank).actualBoundingBoxAscent || size * 0.7;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(rank, cx, y0 + (size + ascent) / 2);
    const small = w * 0.22;
    suit(ctx, s, cx - small / 2, y0 + size + w * 0.04, small, color);
    const big = w * 0.44;
    ctx.globalAlpha = 0.92;
    suit(ctx, s, x + w - w * 0.09 - big, top + h - w * 0.09 - big, big, color);
    ctx.globalAlpha = 1;
  } else {
    ctx.save();
    rr(ctx, x, top, w, h, r);
    ctx.clip();
    ctx.fillStyle = 'rgba(212, 175, 55, 0.12)';
    ctx.beginPath();
    ctx.arc(x + w / 2, top + h / 2, 0.3 * Math.hypot(w / 2, h / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.12)';
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    for (let d = -h; d < w + h; d += 7 * k) {
      ctx.moveTo(x + d, top);
      ctx.lineTo(x + d - h, top + h);
      ctx.moveTo(x + d - h, top);
      ctx.lineTo(x + d, top + h);
    }
    ctx.stroke();
    ctx.restore();
    rr(ctx, x, top, w, h, r);
    ctx.lineWidth = Math.max(1, k);
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.55)';
    ctx.stroke();
    rr(ctx, x + 3.5 * k, top + 3.5 * k, w - 7 * k, h - 7 * k, r - 3.5 * k);
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.45)';
    ctx.stroke();
    if (pen.logo) {
      const lw = w * 0.58;
      const lh = lw / pen.logo.ratio;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 2 * k;
      ctx.shadowOffsetY = k;
      ctx.drawImage(pen.logo.img, x + (w - lw) / 2, top + (h - lh) / 2, lw, lh);
      ctx.restore();
    }
  }
  if (o.highlight) {
    ctx.save();
    ctx.shadowColor = 'rgba(230, 197, 107, 0.55)';
    ctx.shadowBlur = 18 * k;
    rr(ctx, x - k, top - k, w + 2 * k, h + 2 * k, r + k);
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = '#e6c56b';
    ctx.stroke();
    ctx.restore();
  }
  if (o.dim) {
    rr(ctx, x, top, w, h, r);
    ctx.fillStyle = 'rgba(6, 6, 8, 0.5)';
    ctx.fill();
  }
  record(pen, 'card', id, x, top, w, h, { card: c, ...(o.highlight ? { lit: true } : {}) });
}

/** A board place no card has reached yet. */
function slot(pen: Pen, x: number, y: number, w: number, id: string) {
  const { ctx } = pen;
  rr(ctx, x, y, w, w * 1.4, w * 0.12);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, w / 40);
  ctx.strokeStyle = 'rgba(243, 221, 155, 0.18)';
  ctx.stroke();
  record(pen, 'mark', id, x, y, w, w * 1.4);
}

/**
 * The five board places `w` wide from `x`, `gap` apart: the cards dealt so far, those of a best five (`lit`: the first
 * winner's, or the hand the image is about) lit, or the rest dimmed.
 */
function board(pen: Pen, x: number, y: number, w: number, gap: number, o: { lit?: readonly Card[]; dimRest?: boolean } = {}) {
  const { snap } = pen;
  const best = new Set(o.lit ?? []);
  for (let k = 0; k < 5; k++) {
    const c = snap.board[k];
    const at = x + k * (w + gap);
    if (!c) slot(pen, at, y, w, `board-${k}`);
    else card(pen, c, at, y, w, `board-${k}`, { highlight: best.has(c), dim: !!o.dimRest && best.size > 0 && !best.has(c) });
  }
}
const boardW = (w: number, gap: number) => 5 * w + 4 * gap;

/** A chip of the colour the table gives `amount`. */
function chip(pen: Pen, amount: number, cx: number, cy: number, r: number, id: string) {
  const { ctx, pal } = pen;
  const n = Number(/t(\d)/.exec(chipTier(amount).base)?.[1] ?? 0);
  const t = pal.chips[n] ?? pal.chips[0]!;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = t.base;
  ctx.fill();
  ctx.save();
  ctx.setLineDash([r * 0.42, r * 0.36]);
  ctx.lineWidth = r * 0.26;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2);
  ctx.fillStyle = t.face;
  ctx.fill();
  record(pen, 'mark', id, cx - r, cy - r, 2 * r, 2 * r);
}

function dealer(pen: Pen, cx: number, cy: number, r: number, id: string) {
  const { ctx } = pen;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = r * 0.5;
  ctx.shadowOffsetY = r * 0.15;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = IVORY;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = 'rgba(20, 22, 26, 0.35)';
  ctx.stroke();
  setFont(ctx, r * 1.05, 700, 'display');
  ctx.fillStyle = '#14161a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('D', cx, cy + r * 0.06);
  record(pen, 'mark', id, cx - r, cy - r, 2 * r, 2 * r);
}

/** The crown (super admin) or shield (admin) of MemberName's RoleIcon, `k` square. */
function roleMark(ctx: Ctx, role: PublicRole, x: number, y: number, k: number) {
  const X = (v: number) => x + (v / 16) * k;
  const Y = (v: number) => y + (v / 16) * k;
  ctx.beginPath();
  if (role === 'super_admin') {
    ctx.moveTo(X(1.8), Y(4.6));
    ctx.lineTo(X(5), Y(7.6));
    ctx.lineTo(X(8), Y(2.4));
    ctx.lineTo(X(11), Y(7.6));
    ctx.lineTo(X(14.2), Y(4.6));
    ctx.lineTo(X(13.1), Y(11.8));
    ctx.lineTo(X(2.9), Y(11.8));
    ctx.closePath();
    ctx.fillStyle = '#efcf7e';
    ctx.fill();
    ctx.lineWidth = (0.7 / 16) * k;
    ctx.strokeStyle = '#fff1c9';
    ctx.stroke();
    rr(ctx, X(2.9), Y(12.4), (10.2 / 16) * k, (1.8 / 16) * k, (0.6 / 16) * k);
    ctx.fillStyle = '#c99a3c';
    ctx.fill();
  } else {
    ctx.moveTo(X(8), Y(1.4));
    ctx.lineTo(X(13.6), Y(3.4));
    ctx.lineTo(X(13.6), Y(7.6));
    ctx.bezierCurveTo(X(13.6), Y(10.9), X(11.2), Y(13.6), X(8), Y(14.6));
    ctx.bezierCurveTo(X(4.8), Y(13.6), X(2.4), Y(10.9), X(2.4), Y(7.6));
    ctx.lineTo(X(2.4), Y(3.4));
    ctx.closePath();
    ctx.fillStyle = '#3d8ef0';
    ctx.fill();
    ctx.lineWidth = (0.8 / 16) * k;
    ctx.strokeStyle = '#a8dcff';
    ctx.stroke();
  }
}
/** The VIP diamond, `k` square. */
function vipMark(ctx: Ctx, x: number, y: number, k: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x + 0.5 * k, y + 0.06 * k);
  ctx.lineTo(x + 0.94 * k, y + 0.4 * k);
  ctx.lineTo(x + 0.5 * k, y + 0.94 * k);
  ctx.lineTo(x + 0.06 * k, y + 0.4 * k);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** How a seat's player reads: the nickname with the staff or VIP colour and mark, or "Seat 3" with neither. */
function who(pen: Pen, seat: ShareSeat) {
  const named = pen.opt.names;
  const role = named ? seat.role : undefined;
  const vip = named && !role ? seat.vip : undefined;
  return { text: named ? seat.nickname : seat.label, role, vip, bot: seat.bot, color: role ? ROLE_COLOR[role] : vip ? pen.pal.vip[vip] : IVORY };
}

/**
 * A player's name centred on `cx` in at most `maxW`: the staff or VIP mark in front, the BOT pill after, the name
 * between, shrunk and then cut (the marks always stay whole).
 */
function nameLine(pen: Pen, seat: ShareSeat, cx: number, cy: number, maxW: number, size: number, min: number, id: string, align: 'center' | 'left' = 'center') {
  const { ctx } = pen;
  const p = who(pen, seat);
  const mark = p.role || p.vip ? size * 0.95 : 0;
  const markGap = mark ? size * 0.25 : 0;
  setFont(ctx, size * 0.6, 800);
  const botW = p.bot ? width(ctx, 'BOT') + size * 0.6 : 0;
  const botGap = p.bot ? size * 0.3 : 0;
  const f = fit(ctx, p.text, Math.max(size, maxW - mark - markGap - botW - botGap), size, min, 700);
  const total = mark + markGap + f.w + botGap + botW;
  let x = align === 'center' ? cx - total / 2 : cx;
  if (p.role) roleMark(ctx, p.role, x, cy - mark / 2, mark);
  else if (p.vip) vipMark(ctx, x, cy - mark / 2, mark, pen.pal.vipMark);
  if (mark) record(pen, 'mark', `${id}-mark`, x, cy - mark / 2, mark, mark);
  x += mark + markGap;
  put(pen, f, x, cy, p.color, id, { weight: 700 });
  x += f.w + botGap;
  if (p.bot) {
    const h = size * 0.92;
    rr(ctx, x, cy - h / 2, botW, h, h / 2);
    ctx.fillStyle = 'rgba(16, 58, 56, 0.9)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(166, 239, 226, 0.35)';
    ctx.stroke();
    setFont(ctx, size * 0.6, 800);
    ctx.fillStyle = '#a6efe2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOT', x + botW / 2, cy + size * 0.02);
    record(pen, 'mark', `${id}-bot`, x, cy - h / 2, botW, h);
  }
  return total;
}

/** A rounded panel behind a part of the summary. */
function panel(pen: Pen, r: Rect) {
  const { ctx, pal } = pen;
  rr(ctx, r.x, r.y, r.w, r.h, 28);
  ctx.fillStyle = 'rgba(10, 11, 13, 0.72)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = pal.seatBorder;
  ctx.stroke();
}

/** A small heading in the accent colour, letter-spaced. */
function heading(pen: Pen, text: string, x: number, cy: number, maxW: number, id: string, size = 22) {
  const f = fit(pen.ctx, text, maxW, size, 16, 700);
  put(pen, f, x, cy, pen.pal.accent, id, { weight: 700 });
}

// ------------------------------------------------------------------------------------------------ the frame

function background(pen: Pen, W: number, H: number) {
  const { ctx, pal, opt } = pen;
  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, W, H);
  if (opt.background === 'plain') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#111215');
    g.addColorStop(1, '#08090b');
    ctx.fillStyle = g;
  } else {
    // radial-gradient(ellipse at 50% -20%, …): its centre above the top edge, reaching the far corners.
    const cy = -0.2 * H;
    const g = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, Math.hypot(W / 2, H - cy));
    for (const [at, c] of pal.bg) g.addColorStop(at, c);
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, W, H);
}

/** "JC ROYAL" with the logo, `size` tall, from (x, cy). Returns its width. */
function brand(pen: Pen, x: number, cy: number, size: number) {
  const { ctx } = pen;
  let at = x;
  if (pen.logo) {
    const lw = size * pen.logo.ratio;
    ctx.drawImage(pen.logo.img, at, cy - size / 2, lw, size);
    record(pen, 'mark', 'brand-logo', at, cy - size / 2, lw, size);
    at += lw + size * 0.26;
  }
  const fs = size * 0.5;
  setFont(ctx, fs, 700, 'display');
  ctx.fillStyle = goldText(ctx, cy - fs / 2, fs);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const start = at;
  // Letter-spaced by hand (0.22em): canvas letterSpacing is not everywhere yet.
  for (const ch of 'JC ROYAL') {
    ctx.fillText(ch, at, cy);
    at += width(ctx, ch) + fs * 0.22;
  }
  at -= fs * 0.22;
  record(pen, 'text', 'brand', start, cy - fs * 0.62, at - start, fs * 1.24, { text: 'JC ROYAL' });
  return at - x;
}

/** The phase as a gold-rimmed pill; returns its width. */
function phasePill(pen: Pen, text: string, right: number, cy: number, size: number, id: string) {
  const { ctx, pal } = pen;
  setFont(ctx, size, 700);
  const w = width(ctx, text) + size * 1.2;
  const h = size * 1.6;
  rr(ctx, right - w, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(212, 175, 55, 0.12)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = pal.accent;
  ctx.stroke();
  put(pen, { text, size, w: w - size * 1.2 }, right - w / 2, cy, GOLD_300, id, { align: 'center', weight: 700 });
  return w;
}

/** The brand at the left; the hand's number, its blinds and the phase at the right; a gold rule under them. */
function header(pen: Pen, W: number) {
  const { ctx, snap, pal } = pen;
  pen.group = 'head';
  const bw = brand(pen, M, 56, 64);
  const room = W - 2 * M - bw - 32;
  const right = W - M;
  const hand = fit(ctx, snap.text.hand, room, 30, 20, 700);
  put(pen, hand, right, 40, IVORY, 'head-hand', { align: 'right', weight: 700 });
  const pill = phasePill(pen, snap.phaseLabel, right, 80, 19, 'head-phase');
  if (snap.blinds) {
    const b = fit(ctx, snap.blinds, room - pill - 14, 20, 15, 500);
    put(pen, b, right - pill - 14, 80, INK_200, 'head-blinds', { align: 'right', weight: 500 });
  }
  const g = ctx.createLinearGradient(M, 0, W - M, 0);
  g.addColorStop(0, 'rgba(212, 175, 55, 0)');
  g.addColorStop(0.5, pal.accent);
  g.addColorStop(1, 'rgba(212, 175, 55, 0)');
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = g;
  ctx.fillRect(M, HEAD - 2, W - 2 * M, 1.5);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------------ what was done

const SEP = ' · ';
/**
 * Items ("A raises to 800") run into lines no wider than `maxW` in the current font, whole items only, at most
 * `maxLines`: the latest kept, "… " in front where earlier ones are left out.
 */
function wrap(ctx: Ctx, items: string[], maxW: number, maxLines: number): string[] {
  if (items.length === 0 || maxLines <= 0) return [];
  const lay = (from: number) => {
    const lines: string[] = [];
    let cur = '';
    for (let i = from; i < items.length; i++) {
      const it = items[i]!;
      const next = cur ? `${cur}${SEP}${it}` : `${i === from && from > 0 ? '… ' : ''}${it}`;
      if (!cur || width(ctx, next) <= maxW) cur = next;
      else {
        lines.push(cur);
        cur = it;
      }
    }
    if (cur) lines.push(cur);
    return lines.map((l) => clip(ctx, l, maxW));
  };
  for (let from = 0; from < items.length; from++) {
    const l = lay(from);
    if (l.length <= maxLines) return l;
  }
  return lay(items.length - 1).slice(0, maxLines);
}

const lineOf = (pen: Pen, l: { named: string; anon: string }) => (pen.opt.names ? l.named : l.anon);

/** The streets the image's log shows: the step's own street (the last betting street's at the showdown and payout). */
function streetLog(snap: ShareSnap) {
  const bet = snap.log.filter((e) => e.phase !== 'showdown' && e.phase !== 'result');
  return bet.find((e) => e.phase === snap.phase) ?? (snap.phase === 'showdown' || snap.phase === 'result' ? bet.at(-1) : undefined);
}

/**
 * The log street by street in `r`: each street's name, then its items in lines; when they do not all fit, each street
 * keeps fewer lines (its latest), then the earliest streets go. Returns the height used.
 */
function drawLog(pen: Pen, entries: ShareSnap['log'], r: Rect, size: number, id: string) {
  const { ctx } = pen;
  const lh = size * 1.42;
  const hh = size * 1.3;
  setFont(ctx, size, 500);
  const full = entries.map((e) => ({ e, lines: wrap(ctx, e.lines.map((l) => lineOf(pen, l)), r.w, 99) }));
  const height = (xs: { lines: string[] }[]) => sum(xs.map((x) => hh + x.lines.length * lh + size * 0.5));
  let shown = full;
  for (let cap = 4; cap >= 1 && height(shown) > r.h; cap--) {
    setFont(ctx, size, 500);
    shown = full.map(({ e, lines }) => ({ e, lines: lines.length > cap ? wrap(ctx, e.lines.map((l) => lineOf(pen, l)), r.w, cap) : lines }));
  }
  while (shown.length > 1 && height(shown) > r.h) shown = shown.slice(1);
  let y = r.y;
  for (const [k, { e, lines }] of shown.entries()) {
    if (y + hh > r.y + r.h + 0.5) break;
    heading(pen, e.label, r.x, y + hh / 2, r.w, `${id}-${k}`, size * 0.9);
    y += hh;
    setFont(ctx, size, 500);
    for (const [j, l] of lines.entries()) {
      if (y + lh > r.y + r.h + 0.5) break;
      put(pen, { text: l, size, w: width(ctx, l) }, r.x, y + lh / 2, IVORY, `${id}-${k}-${j}`, { weight: 500 });
      y += lh;
    }
    y += size * 0.5;
  }
  return y - r.y;
}

/** Who won what: "Won  A +1,200 · Full house" (or the split pot's winners), each winner's parts in one line. */
function winnerParts(pen: Pen, seat: ShareSeat, o: { rank?: boolean } = {}): Part[] {
  const p = who(pen, seat);
  const parts: Part[] = [{ text: p.text, color: p.color, weight: 700 }];
  if (pen.opt.winAmount && seat.win) parts.push({ text: '+', color: WIN, weight: 800, gap: 0.45 }, { amount: seat.win, color: WIN, weight: 800 });
  if (o.rank !== false && seat.rank) parts.push({ text: seat.rank, color: GOLD_300, weight: 600, gap: 0.5 });
  return parts;
}

const seatOf = (snap: ShareSnap, n: number) => snap.seats.find((s) => s.seat === n);
const winnersOf = (snap: ShareSnap) => snap.winners.map((n) => seatOf(snap, n)).filter((s): s is ShareSeat => !!s);
/** The cards a hand lights: its best five once it has won (each winner's own at a split pot). */
const litOf = (snap: ShareSnap, s: ShareSeat | undefined) => new Set<Card>(snap.phase === 'result' && s?.win ? s.best : []);

interface WinnerLine {
  parts: Part[];
  f: FittedParts;
}
/**
 * The payout's winners (the split pot's label first, where `label`) in as few lines as hold them whole at a fair size,
 * up to `maxLines` (cut evenly only at that), each line `maxW` at most; none before the payout.
 */
function winnerLines(pen: Pen, maxW: number, size: number, maxLines: number, o: { rank?: boolean; label?: boolean; tail?: Part } = {}): WinnerLine[] {
  const { ctx, snap } = pen;
  const ws = winnersOf(snap);
  if (snap.phase !== 'result' || ws.length === 0) return [];
  const min = Math.round(size * 0.62);
  const fair = Math.round(size * 0.75);
  const line = (group: ShareSeat[], first: boolean, last: boolean): Part[] => {
    const parts: Part[] = first && o.label !== false ? [{ text: ws.length > 1 ? snap.text.split : snap.text.winner, color: pen.pal.accent, weight: 800 }] : [];
    group.forEach((w, k) => {
      if (k > 0) parts.push({ text: SEP.trim(), color: INK_300, weight: 600, gap: 0.5 });
      const p = winnerParts(pen, w, { rank: o.rank });
      p[0] = { ...p[0]!, gap: k > 0 ? 0.5 : parts.length > 0 ? 0.7 : 0 };
      parts.push(...p);
    });
    if (last && o.tail) parts.push(o.tail);
    return parts;
  };
  let out: WinnerLine[] = [];
  const most = Math.max(1, Math.min(maxLines, ws.length));
  for (let rows = 1; rows <= most; rows++) {
    const per = Math.ceil(ws.length / rows);
    const groups = Array.from({ length: Math.ceil(ws.length / per) }, (_, k) => ws.slice(k * per, (k + 1) * per));
    const lines = groups.map((g, k) => line(g, k === 0, k === groups.length - 1));
    out = lines.map((parts) => ({ parts, f: fitParts(ctx, parts, maxW, size, min) }));
    if (out.every((l) => whole(l.parts, l.f) && l.f.size >= fair)) break;
  }
  // One size for all the lines: the smallest of them.
  const s = Math.min(...out.map((l) => l.f.size));
  return out.map((l) => ({ parts: l.parts, f: l.f.size === s ? l.f : fitParts(ctx, l.parts, maxW, s, Math.min(s, min)) }));
}
const linesHeight = (lines: WinnerLine[]) => (lines.length ? lines[0]!.f.size * 1.42 * lines.length : 0);
/** Draws winner lines from the top `y`, from `x` (or centred on it); returns their height. */
function drawLines(pen: Pen, lines: WinnerLine[], x: number, y: number, align: 'left' | 'center', id: string) {
  lines.forEach((l, k) => drawParts(pen, l.parts, l.f, x, y + l.f.size * 1.42 * (k + 0.5), align, `${id}-${k}`));
  return linesHeight(lines);
}

// ------------------------------------------------------------------------------------------------ classic table

const seatSize = (s: number) => ({ w: 216 * s, h: 178 * s });
const CENTER = { w: 430, h: 214 };
const hit = (a: Rect, b: Rect, pad: number) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Where the seats go round a table in `T`: on an oval, each at its place clockwise from the bottom, as large as they can
 * be with none touching another or the pot and board in the middle.
 */
function tableGeometry(T: Rect, places: number[]) {
  const cx = T.x + T.w / 2;
  const cy = T.y + T.h / 2;
  let best: { s: number; rx: number; ry: number; seats: Rect[]; center: Rect } | null = null;
  for (let s = 1.25; s >= 0.5; s -= 0.025) {
    const b = seatSize(s);
    const rx = (T.w - b.w) / 2;
    const ry = (T.h - b.h) / 2;
    if (rx <= 0 || ry <= 0) continue;
    const seats = places.map((f) => {
      const a = Math.PI / 2 + f * 2 * Math.PI;
      return { x: cx + rx * Math.cos(a) - b.w / 2, y: cy + ry * Math.sin(a) - b.h / 2, w: b.w, h: b.h };
    });
    const cs = Math.min(1.2, s * 1.05);
    const center = { x: cx - (CENTER.w * cs) / 2, y: cy - (CENTER.h * cs) / 2, w: CENTER.w * cs, h: CENTER.h * cs };
    const fx = rx - 26 * s;
    const fy = ry - 26 * s;
    const inFelt = (center.w / 2) ** 2 / fx ** 2 + (center.h / 2) ** 2 / fy ** 2 <= 1;
    const ok = inFelt && seats.every((p, i) => !hit(p, center, 8 * s) && seats.every((q, j) => j <= i || !hit(p, q, 6 * s)));
    best = { s, rx, ry, seats, center };
    if (ok) break;
  }
  return { cx, cy, ...best! };
}

/** The table's rail and felt, an oval of radii (rx, ry) round (cx, cy), with the logo faint in its middle. */
function tableOval(pen: Pen, cx: number, cy: number, rx: number, ry: number, s: number) {
  const { ctx, pal } = pen;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = linear(ctx, { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, 160, pal.rail);
  ctx.fill();
  ctx.restore();
  const t = 20 * s;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - t, ry - t, 0, 0, Math.PI * 2);
  ctx.fillStyle = pal.railInner;
  ctx.fill();
  const fx = rx - t - 4 * s;
  const fy = ry - t - 4 * s;
  ctx.save();
  ctx.translate(cx, cy - fy * 0.16);
  ctx.scale(fx, fy);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.2);
  for (const [at, c] of pal.felt) g.addColorStop(at, c);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, fx, fy, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy - fy * 0.16);
  ctx.scale(fx, fy);
  ctx.fillStyle = g;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(cx, cy, fx - 18 * s, fy - 18 * s, 0, 0, Math.PI * 2);
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = pal.feltLine;
  ctx.stroke();
  if (pen.logo) {
    const lw = Math.min(fx, fy) * 0.9;
    ctx.globalAlpha = pal.watermark;
    ctx.drawImage(pen.logo.img, cx - lw / 2, cy - lw / pen.logo.ratio / 2, lw, lw / pen.logo.ratio);
    ctx.globalAlpha = 1;
  }
}

/** What a hand came to: its win (the amount, or "Won" where amounts are left out) and the hand it showed. */
function handResult(pen: Pen, seat: ShareSeat): Part[] {
  const parts: Part[] = [];
  if (seat.win) {
    if (pen.opt.winAmount) parts.push({ text: '+', color: WIN, weight: 800 }, { amount: seat.win, color: WIN, weight: 800 });
    else parts.push({ text: pen.snap.text.winner, color: WIN, weight: 800 });
  }
  if (seat.rank) parts.push({ text: seat.rank, color: GOLD_300, weight: 600, gap: parts.length ? 0.4 : 0 });
  return parts;
}

/** What a seat's line under its plate says: its win and hand, its shown hand, its fold, or its action and bet. */
function seatStatus(pen: Pen, seat: ShareSeat): Part[] {
  const { snap } = pen;
  if (seat.win) return handResult(pen, seat);
  if (seat.rank) return [{ text: seat.rank, color: GOLD_300, weight: 700 }];
  if (seat.folded) return [{ text: snap.text.folded, color: INK_300, weight: 600 }];
  const parts: Part[] = [];
  if (seat.allIn) parts.push({ text: snap.text.allIn, color: '#ff9c8a', weight: 800 });
  else if (seat.action) parts.push({ text: seat.action, color: INK_200, weight: 700 });
  if (seat.bet) parts.push({ amount: seat.bet, color: GOLD_300, weight: 800, gap: parts.length ? 1.6 : 1.1 });
  return parts;
}

function drawSeat(pen: Pen, seat: ShareSeat, box: Rect, s: number, lit: boolean) {
  const { ctx, pal } = pen;
  pen.group = `seat-${seat.seat}`;
  const cx = box.x + box.w / 2;
  const cw = 64 * s;
  const ch = cw * 1.4;
  const pw = 200 * s;
  const ph = 66 * s;
  const px = cx - pw / 2;
  const plateTop = box.y + ch - 20 * s;
  const best = new Set(seat.best);
  const won = !!seat.win;
  if (seat.cards.length > 0) {
    const off = cw * 0.64;
    const total = cw + off * (seat.cards.length - 1);
    seat.cards.forEach((c, k) => card(pen, c, cx - total / 2 + k * off, box.y + 4 * s, cw, `card-${seat.seat}-${k}`, { highlight: lit && won && !!c && best.has(c) }));
  }
  ctx.save();
  if (seat.folded) ctx.globalAlpha = 0.62;
  ctx.save();
  if (won) {
    ctx.shadowColor = 'rgba(243, 221, 155, 0.45)';
    ctx.shadowBlur = 22 * s;
  }
  rr(ctx, px, plateTop, pw, ph, 16 * s);
  ctx.fillStyle = pal.seat;
  ctx.fill();
  ctx.restore();
  rr(ctx, px, plateTop, pw, ph, 16 * s);
  ctx.lineWidth = (won ? 2.5 : seat.hero ? 2 : 1.5) * s;
  ctx.strokeStyle = won ? pal.winner : seat.hero ? pal.accent : pal.seatBorder;
  ctx.stroke();
  nameLine(pen, seat, cx, plateTop + ph * 0.32, pw - 24 * s, 24 * s, 15 * s, `name-${seat.seat}`);
  const st = fitAmount(ctx, seat.stack, pw - 28 * s, 24 * s, 14 * s);
  put(pen, st, cx, plateTop + ph * 0.72, GOLD_300, `stack-${seat.seat}`, { align: 'center', weight: 700 });
  ctx.restore();
  if (seat.button) dealer(pen, cx - cw * 0.82 - 22 * s, plateTop - 18 * s, 15 * s, `dealer-${seat.seat}`);
  const parts = seatStatus(pen, seat);
  if (parts.length > 0) {
    const size = 21 * s;
    const lineY = plateTop + ph + 8 * s + 15 * s;
    const chipR = seat.bet && !seat.win ? 10 * s : 0;
    const f = fitParts(ctx, parts, box.w - 28 * s - chipR * 2.4, size, 13 * s);
    const pillW = f.total + 24 * s + chipR * 2.4;
    const h = f.size * 1.5;
    rr(ctx, cx - pillW / 2, lineY - h / 2, pillW, h, h / 2);
    ctx.fillStyle = won ? 'rgba(20, 52, 36, 0.86)' : 'rgba(0, 0, 0, 0.6)';
    ctx.fill();
    if (won) {
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = 'rgba(159, 216, 182, 0.5)';
      ctx.stroke();
    }
    const x0 = cx - pillW / 2 + 12 * s;
    if (chipR) {
      // The chip goes in front of the amount, after the action's word.
      const before = f.widths.slice(0, parts.length - 1).reduce((a, b) => a + b, 0) + sum(parts.slice(0, parts.length - 1).map((p) => (p.gap ?? 0) * f.size));
      const at = x0 + before + (parts.length > 1 ? f.size * 0.45 : 0) + chipR;
      chip(pen, seat.bet!.n, at, lineY, chipR, `chip-${seat.seat}`);
      drawParts(pen, parts.slice(0, parts.length - 1), { ...f, texts: f.texts.slice(0, -1), widths: f.widths.slice(0, -1), total: before }, x0, lineY, 'left', `status-${seat.seat}`);
      const last = parts.length - 1;
      drawParts(pen, [{ ...parts[last]!, gap: 0 }], { size: f.size, texts: [f.texts[last]!], widths: [f.widths[last]!], total: f.widths[last]! }, at + chipR + f.size * 0.3, lineY, 'left', `status-${seat.seat}-bet`);
    } else drawParts(pen, parts, f, x0, lineY, 'left', `status-${seat.seat}`);
  }
}
/**
 * The seats the table shows: all of them, or on a tall story image with more than six players, the six that matter most
 * (the viewer, the winners, the hands shown, those still in) and how many more there were.
 */
function featured(snap: ShareSnap, max: number) {
  if (snap.seats.length <= max) return { seats: snap.seats, places: snap.seats.map((s) => s.place / snap.maxSeats), more: 0 };
  const score = (s: ShareSeat) => (s.hero ? 0 : snap.winners.includes(s.seat) ? 1 : s.rank ? 2 : !s.folded ? 3 : 4);
  const pick = [...snap.seats].sort((a, b) => score(a) - score(b) || a.place - b.place).slice(0, max);
  pick.sort((a, b) => a.place - b.place);
  return { seats: pick, places: pick.map((_, k) => k / pick.length), more: snap.seats.length - pick.length };
}

/** The pot over the board, and under it the winning hand (or how many more players there were). */
function center(pen: Pen, r: Rect, s: number, more: number) {
  const { ctx, snap } = pen;
  pen.group = 'center';
  const cx = r.x + r.w / 2;
  const potH = 46 * s;
  const potParts: Part[] = [
    { text: snap.text.pot, color: INK_200, weight: 600 },
    { amount: snap.pot, color: GOLD_300, weight: 800, gap: 0.5 },
  ];
  const f = fitParts(ctx, potParts, r.w - 60 * s, 26 * s, 16 * s);
  const pw = f.total + 40 * s + 30 * s;
  rr(ctx, cx - pw / 2, r.y, pw, potH, potH / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  ctx.lineWidth = 1.5 * s;
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.35)';
  ctx.stroke();
  chip(pen, snap.pot.n, cx - pw / 2 + 26 * s, r.y + potH / 2, 11 * s, 'pot-chip');
  drawParts(pen, potParts, f, cx - pw / 2 + 46 * s, r.y + potH / 2, 'left', 'pot');
  const bw = 76 * s;
  const gap = 10 * s;
  const by = r.y + potH + 14 * s;
  board(pen, cx - boardW(bw, gap) / 2, by, bw, gap, { lit: snap.best });
  const below = by + bw * 1.4 + 12 * s + 17 * s;
  const firstWinner = snap.winners[0] === undefined ? undefined : seatOf(snap, snap.winners[0]);
  const text =
    snap.phase === 'result' && snap.winners.length > 0
      ? snap.winners.length > 1
        ? snap.text.split
        : (firstWinner?.rank ?? snap.text.noShowdown)
      : more > 0
        ? snap.text.more.replace('{n}', String(more))
        : '';
  if (text) {
    const t = fit(ctx, text, r.w, 26 * s, 16 * s, 700);
    put(pen, t, cx, below, snap.phase === 'result' ? GOLD_300 : INK_200, 'center-note', { align: 'center', weight: 700 });
  }
}

function classicTable(pen: Pen, T: Rect, maxSeats: number) {
  const { snap } = pen;
  const f = featured(snap, maxSeats);
  const g = tableGeometry(T, f.places);
  tableOval(pen, g.cx, g.cy, g.rx, g.ry, g.s);
  center(pen, g.center, Math.min(1.2, g.s * 1.05), f.more);
  f.seats.forEach((seat, k) => drawSeat(pen, seat, g.seats[k]!, g.s, snap.phase === 'result'));
}

function drawClassic(pen: Pen, W: number, H: number) {
  const { ctx, snap, opt } = pen;
  header(pen, W);
  const log = opt.log ? streetLog(snap) : undefined;
  const wide = opt.ratio === '16:9';
  if (wide) {
    // The table at the left; at the right the step (who won what, at the payout) and what was done.
    const side = 520;
    const T = { x: M - 8, y: HEAD + 16, w: W - 2 * M - side - 40 + 16, h: H - HEAD - 16 - M + 24 };
    classicTable(pen, T, snap.maxSeats);
    pen.group = 'side';
    const sx = W - M - side;
    let y = HEAD + 44;
    heading(pen, snap.phaseLabel, sx, y, side, 'side-phase', 26);
    y += 24;
    // The seats show each winner's hand: here who won what, a winner a line where they do not fit in fewer.
    const won = winnerLines(pen, side, 28, 4, { rank: false });
    if (won.length > 0) y += drawLines(pen, won, sx, y, 'left', 'winners');
    else {
      y += 16;
      setFont(ctx, 26, 600);
      for (const [k, l] of wrap(ctx, lineOf(pen, snap.stepLine).split(SEP).filter(Boolean), side, 3).entries()) {
        put(pen, { text: l, size: 26, w: width(ctx, l) }, sx, y, IVORY, `side-step-${k}`);
        y += 38;
      }
    }
    y += 24;
    pen.group = 'side-log';
    if (opt.log && snap.log.length > 0) drawLog(pen, snap.log.filter((e) => e.phase !== 'result'), { x: sx, y, w: side, h: H - M - y }, 23, 'side-log');
    return;
  }
  const won = winnerLines(pen, W - 2 * M, 32, 2, { rank: false });
  const wonH = linesHeight(won);
  const footH = (wonH ? wonH + 12 : 0) + (log ? 30 + 2 * 36 + 8 : 0);
  const T = { x: M - 12, y: HEAD + 14, w: W - 2 * M + 24, h: H - HEAD - 14 - M - footH - (footH ? 14 : 0) };
  classicTable(pen, T, opt.ratio === '9:16' ? 6 : snap.maxSeats);
  pen.group = 'foot';
  let y = H - M - footH;
  if (log) {
    heading(pen, log.label, M, y + 15, W - 2 * M, 'foot-phase');
    y += 30;
    setFont(ctx, 25, 500);
    for (const [k, l] of wrap(ctx, log.lines.map((x) => lineOf(pen, x)), W - 2 * M, 2).entries()) {
      put(pen, { text: l, size: 25, w: width(ctx, l) }, M, y + 18, IVORY, `foot-log-${k}`, { weight: 500 });
      y += 36;
    }
    y += 8;
  }
  if (won.length > 0) drawLines(pen, won, M, y + 12, 'left', 'winners');
}

// ------------------------------------------------------------------------------------------------ hand summary

/** A row of cards `w` wide from `x`, `gap` apart, those in `lit` lit. */
function cards(pen: Pen, cs: (Card | null)[], x: number, y: number, w: number, gap: number, id: string, lit?: Set<Card>) {
  cs.forEach((c, k) => card(pen, c, x + k * (w + gap), y, w, `${id}-${k}`, { highlight: !!c && !!lit?.has(c) }));
  return cs.length * w + Math.max(0, cs.length - 1) * gap;
}

function drawSummary(pen: Pen, W: number, H: number) {
  const { ctx, snap, opt } = pen;
  header(pen, W);
  const wide = opt.ratio === '16:9';
  const z = opt.ratio === '9:16' ? 1.25 : opt.ratio === '4:5' ? 1.1 : 1;
  const hero = snap.seats.find((s) => s.hero && s.cards.some((c) => c));
  const shown = snap.seats.filter((s) => !s.hero && s.cards.some((c) => c));
  const G = 22;
  const colW = wide ? (W - 2 * M - G) / 2 : W - 2 * M;
  const left = M;
  const right = wide ? M + colW + G : M;
  let yl = HEAD + 22;

  // The board.
  pen.group = 'board';
  const bw = Math.min(wide ? 132 : 112 * z, (colW - 64 - 4 * 14) / 5);
  const boardH = 22 + 32 + 12 + bw * 1.4 + 26;
  panel(pen, { x: left, y: yl, w: colW, h: boardH });
  heading(pen, snap.text.board, left + 32, yl + 22 + 16, colW - 64, 'board-title');
  board(pen, left + (colW - boardW(bw, 14)) / 2, yl + 22 + 32 + 12, bw, 14, { lit: snap.best });
  yl += boardH + G;

  // The viewer's hand and the hands shown.
  if (hero || shown.length > 0) {
    pen.group = 'hands';
    const hw = Math.round((wide ? 108 : 92 * z) * 1);
    const both = !!hero && shown.length > 0;
    const heroW = hero ? Math.max(2 * hw + 14, 220) : 0;
    const rowH = 30 + 10 + 58 * z + 12;
    const rows = Math.max(1, Math.min(shown.length, both ? 3 : 4));
    const heroH = 22 + 32 + 10 + hw * 1.4 + 12 + 34 + 22;
    const shownH = 22 + 32 + 10 + rows * rowH + 10;
    const h = Math.max(hero ? heroH : 0, shown.length ? shownH : 0);
    panel(pen, { x: left, y: yl, w: colW, h });
    let x = left + 32;
    if (hero) {
      heading(pen, snap.text.myHand, x, yl + 38, heroW, 'hero-title');
      cards(pen, hero.cards, x, yl + 64, hw, 14, 'hero', litOf(snap, hero));
      if (hero.rank) put(pen, fit(ctx, hero.rank, heroW, 28, 18, 700), x, yl + 64 + hw * 1.4 + 12 + 17, GOLD_300, 'hero-rank', { weight: 700 });
      x += heroW + 40;
    }
    if (shown.length > 0) {
      const w = left + colW - 32 - x;
      heading(pen, snap.text.shown, x, yl + 38, w, 'shown-title');
      const cw = 58 * z * 0.72;
      shown.slice(0, rows).forEach((s, k) => {
        const y = yl + 64 + k * rowH;
        pen.group = `shown-${s.seat}`;
        const cardsW = cards(pen, s.cards, x, y + 6, cw, 8, `shown-${s.seat}`, litOf(snap, s));
        nameLine(pen, s, x + cardsW + 18, y + 6 + (cw * 1.4) / 2 - 15, w - cardsW - 18, 24, 15, `shown-name-${s.seat}`, 'left');
        if (s.rank) put(pen, fit(ctx, s.rank, w - cardsW - 18, 21, 15, 600), x + cardsW + 18, y + 6 + (cw * 1.4) / 2 + 17, GOLD_300, `shown-rank-${s.seat}`);
      });
      if (shown.length > rows) {
        pen.group = 'shown-more';
        put(pen, fit(ctx, snap.text.more.replace('{n}', String(shown.length - rows)), w, 20, 14, 600), x, yl + 64 + rows * rowH - 4, INK_300, 'shown-more');
      }
    }
    yl += h + G;
  }

  // The outcome (or the step) and the pot.
  let yr = wide ? HEAD + 22 : yl;
  pen.group = 'result';
  const ws = winnersOf(snap);
  const won = winnerLines(pen, colW - 64, 36, 2, { rank: false, label: false });
  const topH = won.length > 0 ? linesHeight(won) : 44;
  const resH = 26 + topH + 12 + 34 + 26;
  panel(pen, { x: right, y: yr, w: colW, h: resH });
  if (won.length > 0) {
    drawLines(pen, won, right + 32, yr + 26, 'left', 'result-win');
    const rank = ws.length > 1 ? snap.text.split : (ws[0]!.rank ?? snap.text.noShowdown);
    const sub: Part[] = [
      { text: rank, color: GOLD_300, weight: 700 },
      { text: `${SEP.trim()} ${snap.text.pot}`, color: INK_200, weight: 600, gap: 0.5 },
      { amount: snap.pot, color: GOLD_300, weight: 700, gap: 0.35 },
    ];
    drawParts(pen, sub, fitParts(ctx, sub, colW - 64, 26, 16), right + 32, yr + 26 + topH + 12 + 17, 'left', 'result-sub');
  } else {
    const top: Part[] = [
      { text: snap.phaseLabel, color: GOLD_300, weight: 800 },
      { text: lineOf(pen, snap.stepLine), color: IVORY, weight: 600, gap: 0.6 },
    ];
    drawParts(pen, top, fitParts(ctx, top, colW - 64, 32, 18), right + 32, yr + 26 + 22, 'left', 'result-step');
    const sub: Part[] = [
      { text: snap.text.pot, color: INK_200, weight: 600 },
      { amount: snap.pot, color: GOLD_300, weight: 700, gap: 0.35 },
      ...(snap.blinds ? [{ text: `${SEP.trim()} ${snap.blinds}`, color: INK_200, weight: 500, gap: 0.5 } as Part] : []),
    ];
    drawParts(pen, sub, fitParts(ctx, sub, colW - 64, 26, 16), right + 32, yr + 26 + 44 + 12 + 17, 'left', 'result-sub');
  }
  yr += resH + G;

  // What was done, street by street, in the room left.
  const y0 = wide ? yr : Math.max(yr, yl);
  const room = H - M - y0;
  if (opt.log && snap.log.length > 0 && room > 120) {
    pen.group = 'log';
    panel(pen, { x: right, y: y0, w: colW, h: room });
    heading(pen, snap.text.actions, right + 32, y0 + 22 + 16, colW - 64, 'log-title');
    drawLog(pen, snap.log.filter((e) => e.phase !== 'result'), { x: right + 32, y: y0 + 22 + 32 + 10, w: colW - 64, h: room - 22 - 32 - 10 - 22 }, wide ? 23 : 22 * Math.min(z, 1.15), 'log');
  }
}

// ------------------------------------------------------------------------------------------------ showdown highlight

/** A part of a layout laid out top to bottom: its height, and how to draw it from its top. */
interface Block {
  h: number;
  draw: (y: number) => void;
}
/**
 * Lays out columns of blocks in `r` (one, or two side by side): the blocks at the largest scale from `zMax` down at
 * which every column holds them, each column centred with even gaps between its blocks (no gaps wider than 72·z).
 */
function stack(r: Rect, zMax: number, columns: (z: number) => Block[][]) {
  const gapOf = (z: number) => 30 * z;
  const need = (col: Block[], z: number) => sum(col.map((b) => b.h)) + gapOf(z) * Math.max(0, col.length - 1);
  let z = zMax;
  let cols = columns(z);
  while (z > 0.6 && cols.some((col) => need(col, z) > r.h)) {
    z = Math.round((z - 0.05) * 100) / 100;
    cols = columns(z);
  }
  for (const col of cols) {
    const used = sum(col.map((b) => b.h));
    const gap = col.length > 1 ? Math.min(72 * z, Math.max(gapOf(z), (r.h - used) / (col.length + 1))) : 0;
    let y = r.y + Math.max(0, (r.h - used - gap * (col.length - 1)) / 2);
    for (const b of col) {
      b.draw(y);
      y += b.h + gap;
    }
  }
}

function drawHighlight(pen: Pen, W: number, H: number) {
  const { ctx, snap, opt } = pen;
  header(pen, W);
  const wide = opt.ratio === '16:9';
  const ws = winnersOf(snap);
  const paid = snap.phase === 'result' && ws.length > 0;
  const hero = snap.seats.find((s) => s.hero && s.cards.length > 0);
  // The hands up front: the winners' at the payout, else the viewer's.
  const main = paid ? ws.slice(0, 3) : hero ? [hero] : [];
  const others = snap.seats.filter((s) => s.cards.length > 0 && !main.includes(s));
  const top = HEAD + 24;
  const area: Rect = { x: M, y: top, w: W - 2 * M, h: H - top - M };
  const colL: Rect = wide ? { ...area, w: area.w * 0.46 } : area;
  const colR: Rect = wide ? { ...area, x: M + area.w * 0.5, w: area.w * 0.5 } : area;
  const title = paid ? (ws.length > 1 ? snap.text.split : (ws[0]!.rank ?? snap.text.noShowdown)) : snap.phaseLabel;

  const blocks = (z: number) => {
    const left: Block[] = [];
    const right: Block[] = [];

    // The title: the winning hand (the split pot, or no showdown), or the phase before the payout; who won under it.
    const tf = fit(ctx, title, colL.w, Math.min(76 * z, 104), 36, 800);
    const subParts: Part[] | null = paid ? (ws.length === 1 ? winnerParts(pen, ws[0]!, { rank: false }) : null) : lineOf(pen, snap.stepLine) ? [{ text: lineOf(pen, snap.stepLine), color: IVORY, weight: 600 }] : null;
    const sub = subParts ? fitParts(ctx, subParts, colL.w, (paid ? 38 : 30) * z, paid ? 22 : 18) : null;
    left.push({
      h: tf.size * 1.24 + (sub ? 16 * z + sub.size * 1.24 : 0),
      draw: (y) => {
        pen.group = 'title';
        const cx = colL.x + colL.w / 2;
        const cy = y + tf.size * 0.62;
        put(pen, tf, cx, cy, goldText(ctx, cy - tf.size / 2, tf.size), 'title', { align: 'center', weight: 800 });
        if (subParts && sub) drawParts(pen, subParts, sub, cx, y + tf.size * 1.24 + 16 * z + sub.size * 0.62, 'center', paid ? 'title-win' : 'title-step');
      },
    });

    // The hands up front, large, each lit with its own best five; at a split pot each winner's name, win and hand under theirs.
    if (main.length > 0) {
      const each = Math.min(colL.w / main.length, 420 * z);
      const cw = Math.min((each - 40 - 16) / 2, (main.length === 1 ? 168 : 120) * z);
      const nameSize = 26 * z;
      const results = main.length > 1 ? main.map((s) => handResult(pen, s)).map((parts) => ({ parts, f: fitParts(ctx, parts, each - 24, 24 * z, 14) })) : [];
      const resultSize = Math.max(0, ...results.map((r) => r.f.size));
      const under = main.length > 1 ? 14 * z + nameSize * 1.24 + (resultSize ? 6 * z + resultSize * 1.24 : 0) : 0;
      left.push({
        h: 12 + cw * 1.4 + under,
        draw: (y) =>
          main.forEach((s, k) => {
            pen.group = `main-${s.seat}`;
            const mx = colL.x + (colL.w - each * main.length) / 2 + each * k + each / 2;
            cards(pen, s.cards, mx - (2 * cw + 16) / 2, y + 6, cw, 16, `main-${s.seat}`, litOf(snap, s));
            if (main.length < 2) return;
            const ny = y + 12 + cw * 1.4 + 14 * z;
            nameLine(pen, s, mx, ny + nameSize * 0.62, each - 24, nameSize, Math.round(nameSize * 0.78), `main-name-${s.seat}`);
            const r = results[k]!;
            if (r.parts.length > 0) drawParts(pen, r.parts, r.f, mx, ny + nameSize * 1.24 + 6 * z + r.f.size * 0.62, 'center', `main-win-${s.seat}`);
          }),
      });
    }

    // The board: the (first) winner's best five lit, the rest dimmed.
    const bw = Math.min(124 * z, (colR.w - 4 * 14) / 5);
    right.push({
      h: bw * 1.4,
      draw: (y) => {
        pen.group = 'board';
        board(pen, colR.x + (colR.w - boardW(bw, 14)) / 2, y, bw, 14, { lit: snap.best, dimRest: paid });
      },
    });

    // The other hands still in: shown ones face up with what they came to, the rest face down.
    if (others.length > 0) {
      const n = Math.min(others.length, 4);
      const each = colR.w / n;
      const cw = Math.min(70 * z, (each - 30) / 2);
      const nameSize = 22 * z;
      const results = others.slice(0, n).map((s) => {
        const parts = handResult(pen, s);
        return { parts, f: fitParts(ctx, parts, each - 16, 20 * z, 13) };
      });
      const resultSize = Math.max(0, ...results.map((r) => (r.parts.length ? r.f.size : 0)));
      const more = others.length > n;
      const h = nameSize * 1.24 + 8 * z + cw * 1.4 + (resultSize ? 10 * z + resultSize * 1.24 : 0) + (more ? 12 * z + 20 * 1.24 : 0);
      right.push({
        h,
        draw: (y) => {
          others.slice(0, n).forEach((s, k) => {
            pen.group = `other-${s.seat}`;
            const ox = colR.x + each * k + each / 2;
            nameLine(pen, s, ox, y + nameSize * 0.62, each - 16, nameSize, Math.round(nameSize * 0.78), `other-name-${s.seat}`);
            const cy = y + nameSize * 1.24 + 8 * z;
            cards(pen, s.cards, ox - (2 * cw + 8) / 2, cy, cw, 8, `other-${s.seat}`, litOf(snap, s));
            const r = results[k]!;
            if (r.parts.length > 0) drawParts(pen, r.parts, r.f, ox, cy + cw * 1.4 + 10 * z + r.f.size * 0.62, 'center', `other-rank-${s.seat}`);
          });
          if (more) {
            pen.group = 'others-more';
            put(pen, fit(ctx, snap.text.more.replace('{n}', String(others.length - n)), colR.w, 20, 14, 600), colR.x + colR.w / 2, y + h - 20 * 0.62, INK_300, 'others-more', { align: 'center' });
          }
        },
      });
    }

    // The pot.
    const pot: Part[] = [
      { text: snap.text.pot, color: INK_200, weight: 600 },
      { amount: snap.pot, color: GOLD_300, weight: 800, gap: 0.45 },
    ];
    const pf = fitParts(ctx, pot, colR.w, 34 * z, 20);
    right.push({
      h: pf.size * 1.24,
      draw: (y) => {
        pen.group = 'pot';
        drawParts(pen, pot, pf, colR.x + colR.w / 2, y + pf.size * 0.62, 'center', 'pot');
      },
    });
    return wide ? [left, right] : [[...left, ...right]];
  };
  stack(area, opt.ratio === '9:16' ? 1.6 : opt.ratio === '4:5' ? 1.25 : wide ? 1.35 : 1.05, blocks);
}

// ------------------------------------------------------------------------------------------------ minimal

function drawMinimal(pen: Pen, W: number, H: number) {
  const { ctx, snap, opt } = pen;
  const wide = opt.ratio === '16:9';
  const z = opt.ratio === '9:16' ? 1.55 : opt.ratio === '4:5' ? 1.15 : wide ? 1.35 : 1;
  const ws = winnersOf(snap);
  const hero = snap.seats.find((s) => s.hero && s.cards.length > 0);
  // The viewer's hand, else (at the payout) the winner's.
  const shown = hero ?? (snap.phase === 'result' ? ws[0] : undefined);
  const bw = wide ? 132 * z : Math.min(112 * z, (W - 2 * M - 4 * 14) / 5);
  const hw = wide ? 150 * z : 132 * z;
  const handW = shown ? 2 * hw + 16 : 0;
  const apart = 80 * z;
  // Upright: the hand over the board; wide: side by side.
  const blockW = wide ? handW + (shown ? apart : 0) + boardW(bw, 14) : Math.max(handW, boardW(bw, 14));
  const blockH = wide ? Math.max(hw, bw) * 1.4 : (shown ? hw * 1.4 + 56 * z : 0) + bw * 1.4;

  // What happened (who won what, a winner a line where they do not fit in fewer; or the step), then the pot.
  const won = winnerLines(pen, W - 2 * M, 38 * z, opt.ratio === '9:16' ? 4 : 2, {
    label: false,
    tail: ws.length === 1 && !ws[0]!.rank ? { text: snap.text.noShowdown, color: INK_200, weight: 600, gap: 0.5 } : undefined,
  });
  const step: Part[] = [
    { text: snap.phaseLabel, color: GOLD_300, weight: 800 },
    { text: lineOf(pen, snap.stepLine), color: IVORY, weight: 600, gap: 0.5 },
  ];
  const sf = fitParts(ctx, step, W - 2 * M, 34 * z, 18);
  const pot: Part[] = [
    { text: snap.text.pot, color: INK_200, weight: 600 },
    { amount: snap.pot, color: GOLD_300, weight: 800, gap: 0.4 },
  ];
  const pf = fitParts(ctx, pot, W - 2 * M, 28 * z, 18);
  const textH = (won.length > 0 ? linesHeight(won) : sf.size * 1.42) + 16 * z + pf.size * 1.42;
  // Centred between the top and the brand at the foot.
  const gap = 60 * z;
  const foot = 64;
  const top = M + Math.max(0, (H - 2 * M - foot - blockH - gap - textH) / 2);
  const x0 = (W - blockW) / 2;
  if (shown) {
    pen.group = 'hand';
    const hy = wide ? top + (blockH - hw * 1.4) / 2 : top;
    cards(pen, shown.cards, wide ? x0 : (W - handW) / 2, hy, hw, 16, 'hand', litOf(snap, shown));
  }
  pen.group = 'board';
  const by = wide ? top + (blockH - bw * 1.4) / 2 : top + (shown ? hw * 1.4 + 56 * z : 0);
  // The board lights the hand's best five where it won, else the (first) winner's.
  board(pen, wide ? x0 + handW + (shown ? apart : 0) : (W - boardW(bw, 14)) / 2, by, bw, 14, { lit: shown?.win && snap.phase === 'result' ? shown.best : snap.best });

  pen.group = 'text';
  let y = top + blockH + gap;
  if (won.length > 0) y += drawLines(pen, won, W / 2, y, 'center', 'result');
  else {
    drawParts(pen, step, sf, W / 2, y + sf.size * 0.71, 'center', 'step');
    y += sf.size * 1.42;
  }
  y += 16 * z;
  drawParts(pen, pot, pf, W / 2, y + pf.size * 0.71, 'center', 'pot');

  // A small brand and the hand's number at the foot.
  pen.group = 'foot';
  const fy = H - M + 4;
  brand(pen, M, fy - 18, 36);
  put(pen, fit(ctx, snap.text.hand, W / 2 - M, 22, 15, 600), W - M, fy - 18, INK_300, 'foot-hand', { align: 'right' });
}

// ------------------------------------------------------------------------------------------------ entry points

/** Draws the image for `snap` with `opt` on `ctx`, whose units are the image's own pixels at the standard resolution. */
export function drawShare(ctx: Ctx, snap: ShareSnap, opt: ShareOptions, art: ShareArt, boxes?: ShareBox[]) {
  const { w: W, h: H } = SHARE_SIZES[opt.ratio];
  const pen: Pen = { ctx, pal: art.pal, logo: art.logo, boxes, group: 'bg', opt, snap };
  ctx.save();
  background(pen, W, H);
  if (opt.template === 'classic') drawClassic(pen, W, H);
  else if (opt.template === 'summary') drawSummary(pen, W, H);
  else if (opt.template === 'highlight') drawHighlight(pen, W, H);
  else drawMinimal(pen, W, H);
  ctx.restore();
}

/** Every word the image can show, so the fonts' parts for them load before drawing. */
function shareText(snap: ShareSnap) {
  const seats = snap.seats.flatMap((s) => [s.nickname, s.label, s.action ?? '', s.rank ?? '', s.stack.full, s.stack.short, s.bet?.full ?? '', s.win?.full ?? '']);
  const log = snap.log.flatMap((e) => [e.label, ...e.lines.flatMap((l) => [l.named, l.anon])]);
  return [...seats, ...log, snap.stepLine.named, snap.stepLine.anon, snap.phaseLabel, snap.blinds ?? '', snap.pot.full, snap.pot.short, ...Object.values(snap.text), '+0123456789·…'].join(' ');
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The page's colours, its logo and fonts for `snap`'s words, loaded (the fonts given at most `timeoutMs`; a font that
 * is not there by then is drawn in the next one its stack names).
 */
export async function shareArt(snap: ShareSnap, fourColor: boolean, timeoutMs = 3000): Promise<ShareArt> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  const text = shareText(snap);
  const loads = fonts
    ? Promise.allSettled([fonts.load(`700 40px "Pretendard Variable"`, text), fonts.load(`700 40px Cinzel`, 'JC ROYAL AKQJ1098765432D'), fonts.load(`800 40px Cinzel`, 'D')])
    : Promise.resolve();
  const logo = new Promise<ShareArt['logo']>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, ratio: img.naturalWidth / img.naturalHeight || 1 });
    img.onerror = () => resolve(null);
    img.src = LOGO_SRC.medium;
  });
  const [, l] = await Promise.all([Promise.race([loads, wait(timeoutMs)]), Promise.race([logo, wait(timeoutMs).then(() => null)])]);
  return { pal: readPalette(fourColor), logo: l };
}

/** Sizes `canvas` for `opt` (its resolution) and draws the image on it. */
export function paintShare(canvas: HTMLCanvasElement, snap: ShareSnap, opt: ShareOptions, art: ShareArt) {
  const { w, h } = SHARE_SIZES[opt.ratio];
  canvas.width = w * opt.scale;
  canvas.height = h * opt.scale;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('canvas');
  ctx.setTransform(opt.scale, 0, 0, opt.scale, 0, 0);
  drawShare(ctx, snap, opt, art);
}

/** The image for `snap` as a file, made on a canvas of its own (a quick save, with no preview). */
export async function makeShare(snap: ShareSnap, opt: ShareOptions, fourColor: boolean): Promise<{ blob: Blob; format: ShareFormat }> {
  return renderShare(snap, opt, await shareArt(snap, fourColor));
}

/**
 * The image as a file at `opt`'s resolution, drawn on a canvas of its own: the same drawing as the preview's at the
 * standard one, only scaled, so what is saved is what the preview showed.
 */
export async function renderShare(snap: ShareSnap, opt: ShareOptions, art: ShareArt): Promise<{ blob: Blob; format: ShareFormat }> {
  const canvas = document.createElement('canvas');
  try {
    paintShare(canvas, snap, opt, art);
    return await encodeShare(canvas, opt.format);
  } finally {
    // Its pixels let go at once rather than when it is collected (phones have little room for canvases).
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Saves `blob` as `name` with the browser's download. */
export function downloadShare(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Whether the device's share sheet takes image files (phones: saving to Photos from there). */
export function canShareFiles() {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/** Hands `blob` to the share sheet: true when shared, false when the sheet was closed without it. */
export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  try {
    await navigator.share({ files: [new File([blob], name, { type: blob.type })] });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    throw e;
  }
}

/** The canvas as a file: WebP where the browser can make one (else PNG, said by the format returned), or PNG. */
export function encodeShare(canvas: HTMLCanvasElement, format: ShareFormat): Promise<{ blob: Blob; format: ShareFormat }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('encode'));
        resolve({ blob, format: format === 'webp' && blob.type === 'image/webp' ? 'webp' : 'png' });
      },
      format === 'webp' ? 'image/webp' : 'image/png',
      0.95,
    );
  });
}
