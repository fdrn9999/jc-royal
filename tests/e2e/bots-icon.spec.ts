import { inflateSync } from 'node:zlib';
import type { HandDetailDto, TableView } from '@jc/types';
import { expect, type Browser, type BrowserContextOptions, type Page, type WebSocketRoute } from '@playwright/test';
import { checkOrCall, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';
import { HAND_6, HAND_9 } from './replay-hands';

/**
 * The robot mark on a table bot's name (MemberName's BotBadge, the icon set's bot): on the seats the server says a bot
 * holds and on no other, whatever a member is called; whole and the same size on every screen, inside its seat's plate,
 * clear of the avatar's timer ring, the dealer button, the blinds and the status line, and the seat as big as without
 * it; the same node through a hand (no flicker), and right again after the socket drops and after a reload. The plate's
 * button over the mark carries its title (what a pointer resting there reads) and opens the bot's card (a tap on a phone).
 */

// Phones upright (the smallest first) and on their side, a tablet, a laptop and desktops.
const SCREENS = [
  { name: '320x568', width: 320, height: 568, touch: true },
  { name: '360x640', width: 360, height: 640, touch: true },
  { name: '390x844', width: 390, height: 844, touch: true },
  { name: '430x932', width: 430, height: 932, touch: true },
  { name: '844x390', width: 844, height: 390, touch: true },
  { name: '768x1024', width: 768, height: 1024, touch: true },
  { name: '1280x720', width: 1280, height: 720, touch: false },
  { name: '1440x900', width: 1440, height: 900, touch: false },
  { name: '1920x1080', width: 1920, height: 1080, touch: false },
];

/** The bot teal (styles.css --bot-mark). */
const TEAL = 'rgb(143, 217, 203)';

/** A page's table socket, passed through: the last state the server sent, and drop()/restore() to cut it (reconnect.spec). */
async function watchSocket(page: Page) {
  let offline: Promise<void> | null = null;
  let back = () => {};
  const sockets: WebSocketRoute[] = [];
  /** How many `state` views the server sent on each connection. */
  const states: number[] = [];
  let last: TableView | null = null;
  await page.routeWebSocket(/\/ws\/tables\//, async (ws) => {
    const i = sockets.push(ws) - 1;
    states[i] = 0;
    if (offline) await offline;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      ws.send(message);
      const msg = JSON.parse(String(message)) as { t: string; state?: TableView };
      if (msg.t === 'state') {
        last = msg.state!;
        states[i]!++;
      }
    });
    ws.onMessage((message) => server.send(message));
  });
  return {
    sockets,
    states,
    state: () => last,
    drop: async () => {
      offline = new Promise((r) => (back = r));
      await sockets.at(-1)!.close({ code: 4000, reason: 'network lost' });
    },
    restore: () => {
      offline = null;
      back();
    },
  };
}

/** The points of a mark looked at, as fractions of its box: the middle and near each corner. */
const POINTS: (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
];

/**
 * Each taken seat on the table: whether it shows the robot mark, and where the mark and the seat's pieces lie. `reveal`
 * first scrolls each seat's name to the middle of what shows (the replay's table window on an upright phone, then the
 * page between its header and bottom navigation), as a player looking at that seat would, by hand: scrollIntoView would
 * also scroll the table's clipped boxes. A seat's number reveals that seat alone.
 */
const seatMarks = (page: Page, reveal: boolean | number = false) =>
  page.evaluate(([reveal, at]) => {
    const box = (e: Element | null | undefined) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    const show = (el: Element) => {
      const win = document.querySelector<HTMLElement>('[data-testid=replay-table][data-window="1"]');
      if (win) {
        const w = win.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        win.scrollTop += r.top + r.height / 2 - (w.top + win.clientTop + win.clientHeight / 2);
      }
      const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
      const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
      const r = el.getBoundingClientRect();
      scrollBy(0, r.top + r.height / 2 - (header + (nav?.getBoundingClientRect().top ?? innerHeight)) / 2);
    };
    const alpha = (c: string) => {
      if (c === 'transparent') return 0;
      const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)$/);
      if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1);
      const rgba = c.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
      return rgba ? parseFloat(rgba[1]!) : 1;
    };
    const filledIn = (cs: CSSStyleDeclaration) => alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none' || (cs.backdropFilter || 'none') !== 'none';
    /** Whether an element draws anything at a point of the screen: a picture, a fill, a border there, its own text there. */
    const paints = (el: Element, x: number, y: number) => {
      for (let a: Element | null = el; a; a = a.parentElement) if (parseFloat(getComputedStyle(a).opacity) === 0) return false;
      // An SVG shape is hit only where its fill or its stroke is drawn.
      if ((el instanceof SVGElement && !(el instanceof SVGSVGElement)) || /^(IMG|CANVAS|VIDEO)$/.test(el.tagName)) return true;
      const cs = getComputedStyle(el);
      // A ::before or ::after with a fill: its box is not known, so it counts wherever its element is.
      if (filledIn(cs) || ['::before', '::after'].some((k) => getComputedStyle(el, k).content !== 'none' && filledIn(getComputedStyle(el, k)))) return true;
      const b = el.getBoundingClientRect();
      const sides = [
        [x - b.left, cs.borderLeftWidth, cs.borderLeftColor],
        [b.right - x, cs.borderRightWidth, cs.borderRightColor],
        [y - b.top, cs.borderTopWidth, cs.borderTopColor],
        [b.bottom - y, cs.borderBottomWidth, cs.borderBottomColor],
      ] as const;
      if (sides.some(([d, w, c]) => d < parseFloat(w) && alpha(c) > 0)) return true;
      return Array.from(el.childNodes).some((n) => {
        if (n.nodeType !== Node.TEXT_NODE || !n.textContent!.trim()) return false;
        const r = document.createRange();
        r.selectNodeContents(n);
        return Array.from(r.getClientRects()).some((q) => x >= q.left && x < q.right && y >= q.top && y < q.bottom);
      });
    };
    /**
     * What is drawn over a mark at a point, whether a pointer reaches it or not (a chip in flight, a card, a hint): every
     * element there above the mark, pointer events forced on for the look, that paints at the point. `clipped` if the
     * mark itself is not there (cut by a box around it).
     */
    const paintedOver = (mark: Element, x: number, y: number) => {
      const out: string[] = [];
      for (const el of document.elementsFromPoint(x, y)) {
        if (mark.contains(el)) return out;
        if (paints(el, x, y)) out.push(el.closest('.jc-card') ? 'card' : (el.closest('[data-testid]')?.getAttribute('data-testid') ?? `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}`));
      }
      return ['clipped'];
    };
    const force = document.createElement('style');
    force.textContent = '* { pointer-events: auto !important; }';
    const table = document.querySelector('[data-testid=table]')!;
    return Array.from(table.querySelectorAll('[data-testid^="seat-"][data-state]'))
      .filter((s) => /^seat-\d+$/.test(s.getAttribute('data-testid')!))
      .map((seat) => {
        const i = Number(seat.getAttribute('data-testid')!.slice(5));
        const name = seat.querySelector('[data-testid=member-name]');
        if ((reveal === true || reveal === i) && name) show(name);
        const badge = seat.querySelector('[data-testid=bot-badge]');
        const icon = badge?.querySelector('svg');
        const text = name?.querySelector(':scope > .truncate');
        // The plate is the seat's first div above its name; the name's width cap is the span around it.
        const plate = name?.closest('div');
        const ic = box(icon);
        // At five points of the mark, what a pointer there reaches (the plate's button, or the mark itself: never a card or
        // a bet), and what is painted over it.
        const points = ic ? at.map(([fx, fy]) => [ic.l + ic.w * fx, ic.t + ic.h * fy] as const) : [];
        const onScreen = ([x, y]: readonly [number, number]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
        const hits = points.map((pt) => {
          if (!onScreen(pt)) return 'off-screen';
          const hit = document.elementFromPoint(...pt);
          return hit?.closest('.jc-card') ? 'card' : (hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null);
        });
        document.head.append(force);
        const covers = [...new Set(points.filter(onScreen).flatMap((pt) => paintedOver(badge!, ...pt)))];
        force.remove();
        // What cuts the mark's whole box (not only at the five points): a box around it, below the page's own, that clips
        // what overflows it; a clip or a mask on it or around it in its seat.
        const label = (a: Element) => a.getAttribute('data-testid') ?? `${a.tagName.toLowerCase()}.${a.classList[0] ?? ''}`;
        const cuts: string[] = [];
        for (let a: Element | null = icon ?? null; ic && a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const r = box(a)!;
          const clips = a !== icon && cs.display !== 'contents' && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain));
          if (clips && !(ic.l >= r.l - 0.5 && ic.r <= r.r + 0.5 && ic.t >= r.t - 0.5 && ic.b <= r.b + 0.5)) cuts.push(`${label(a)} clips it`);
          if (seat.contains(a) && (cs.clipPath !== 'none' || (cs.maskImage || 'none') !== 'none')) cuts.push(`${label(a)} ${cs.clipPath !== 'none' ? 'clip-path' : 'mask'}`);
        }
        // The robot's own strokes: each drawn, and whole inside the SVG's box, which clips what lies past it (a shifted
        // view or a moved stroke cuts the robot with the box where it was). A shape's box leaves out half its stroke,
        // put back in screen pixels.
        const art: string[] = [];
        Array.from(icon?.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon') ?? []).forEach((g, k) => {
          const cs = getComputedStyle(g);
          const id = `${g.tagName} ${k + 1}`;
          const off =
            cs.display === 'none' ? 'display'
            : cs.visibility !== 'visible' ? 'visibility'
            : parseFloat(cs.opacity) < 0.99 ? 'opacity'
            : cs.stroke === 'none' || alpha(cs.stroke) === 0 ? 'stroke'
            : parseFloat(cs.strokeOpacity) < 0.99 ? 'stroke-opacity'
            : !(parseFloat(cs.strokeWidth) > 0) ? 'stroke-width'
            : cs.clipPath !== 'none' ? 'clip-path'
            : (cs.maskImage || 'none') !== 'none' ? 'mask'
            : null;
          if (off) return void art.push(`${id} hidden (${off})`);
          const m = (g as SVGGraphicsElement).getScreenCTM();
          const half = m ? (parseFloat(cs.strokeWidth) * Math.hypot(m.a, m.b)) / 2 : 0;
          const r = g.getBoundingClientRect();
          if (ic && (r.left - half < ic.l - 0.5 || r.right + half > ic.r + 0.5 || r.top - half < ic.t - 0.5 || r.bottom + half > ic.b + 0.5))
            art.push(`${id} outside its box (${Math.round(r.left - half)}..${Math.round(r.right + half)}px of ${Math.round(ic.l)}..${Math.round(ic.r)}px)`);
        });
        // How opaque the mark is drawn against its name (a folded seat dims both alike).
        const opacity = (e: Element | null | undefined) => {
          let o = 1;
          for (let a: Element | null = e ?? null; a; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
          return o;
        };
        const fade = icon && text ? opacity(icon) / Math.max(opacity(text), 1e-6) : 1;
        // Where the plate lies on the table (the same however the page or the window is scrolled).
        const t = table.getBoundingClientRect();
        const p = box(plate);
        const pick = seat.querySelector(`[data-testid="seat-pick-${i}"]`);
        return {
          seat: i,
          bot: !!badge,
          level: badge?.getAttribute('data-level') ?? null,
          title: badge?.getAttribute('title') ?? null,
          /** The mark comes after the name's text (a seat whose start the table's edge cuts off), not in front of it. */
          after: !!(badge && text && text.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING),
          robots: seat.querySelectorAll('.lucide-bot').length,
          nickname: name?.textContent ?? '',
          icon: ic,
          color: icon ? getComputedStyle(icon).color : null,
          em: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
          name: box(name),
          cap: box(name?.parentElement),
          capMax: name?.parentElement ? parseFloat(getComputedStyle(name.parentElement).maxWidth) : 0,
          plate: p,
          vw: innerWidth,
          vh: innerHeight,
          onTable: p && { cx: (p.l + p.r) / 2 - t.left, t: p.t - t.top, b: p.b - t.top, w: p.w },
          avatar: box(plate?.firstElementChild),
          status: box(seat.querySelector(`[data-testid="seat-status-${i}"]`)),
          dealer: box(seat.querySelector('[data-testid=dealer-button]')),
          blind: box(seat.querySelector('[data-tour^="blind-"]')),
          hasPick: !!pick,
          pickTitle: pick?.getAttribute('title') ?? null,
          hits,
          covers,
          cuts,
          art,
          fade,
        };
      });
  }, [reveal, POINTS] as const);
type Mark = Awaited<ReturnType<typeof seatMarks>>[number];
type Box = NonNullable<Mark['icon']>;

/** Seats where the page and the server disagree on who is a bot (the server's `bot`, never the nickname). */
async function misMarked(page: Page, state: TableView | null) {
  if (!state) return ['no state yet'];
  const shown = await seatMarks(page);
  const out: string[] = [];
  for (const s of state.seats) {
    if (!s.userId) continue;
    const seen = shown.find((x) => x.seat === s.seatIndex);
    if (!seen) {
      out.push(`seat ${s.seatIndex} not drawn`);
      continue;
    }
    if (seen.bot !== !!s.bot) out.push(`seat ${s.seatIndex} (${s.nickname}): the server's bot ${String(s.bot ?? false)}, the page's mark ${seen.bot}`);
    if (s.bot && s.bot !== true && seen.level !== s.bot) out.push(`seat ${s.seatIndex}: level ${seen.level}, not ${s.bot}`);
    if (!s.bot && seen.robots) out.push(`seat ${s.seatIndex} (${s.nickname}): a robot on a member's seat`);
  }
  return out;
}

const inside = (a: Box, b: Box) => a.l >= b.l - 0.5 && a.r <= b.r + 0.5 && a.t >= b.t - 0.5 && a.b <= b.b + 0.5;
const meets = (a: Box, b: Box | null, pad = 0) => !!b && a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;

/**
 * Where a bot's mark is drawn wrong: cut, squeezed, too small, over or under another piece of its seat, off the teal,
 * any part of it off the screen (even on a seat the layout lays across the screen's side), after the name where the
 * seat's start is on the screen.
 */
function placement(marks: Mark[], where: string, opts: { hit: 'pick' | 'badge' }) {
  const out: string[] = [];
  for (const m of marks.filter((x) => x.bot)) {
    const id = `${where} seat ${m.seat}`;
    const ic = m.icon!;
    const want = m.em * 1.15;
    if (Math.abs(ic.w - want) > 0.6 || Math.abs(ic.h - want) > 0.6) out.push(`${id}: the mark ${ic.w.toFixed(1)}x${ic.h.toFixed(1)}, not ${want.toFixed(1)} square`);
    if (ic.w < 11) out.push(`${id}: the mark ${ic.w.toFixed(1)}px, too small to tell`);
    if (!inside(ic, m.name!)) out.push(`${id}: the mark cut by its name's box`);
    if (!inside(ic, m.plate!)) out.push(`${id}: the mark outside its plate`);
    // The timer ring lies 3px around the avatar.
    if (meets(ic, m.avatar, 3)) out.push(`${id}: the mark on the avatar's timer ring`);
    for (const [k, b] of [['status line', m.status], ['dealer button', m.dealer], ['blind', m.blind]] as const) if (meets(ic, b)) out.push(`${id}: the mark under the ${k}`);
    if (m.cap!.w > m.capMax + 0.5) out.push(`${id}: the name ${m.cap!.w}px past its cap ${m.capMax}px`);
    const at = `(plate ${Math.round(m.plate!.l)}..${Math.round(m.plate!.r)}px, mark ${Math.round(ic.l)}..${Math.round(ic.r)}px of ${m.vw})`;
    if (ic.l < -0.5 || ic.t < -0.5 || ic.r > m.vw + 0.5 || ic.b > m.vh + 0.5) out.push(`${id}: the mark off the screen ${at}`);
    if (m.cuts.length) out.push(`${id}: the mark cut (${m.cuts.join(', ')})`);
    if (m.art.length) out.push(`${id}: the robot's ${m.art.join(', ')}`);
    if (m.fade < 0.99) out.push(`${id}: the mark drawn ${m.fade.toFixed(2)} as opaque as its name`);
    // After the name only where the table's left edge cuts the plate's start off (TableScene's startCut).
    if (m.after && m.onTable!.cx - m.onTable!.w / 2 >= -0.5) out.push(`${id}: the mark after the name on a whole plate ${at}`);
    // The cards ride under the plate's top edge (their box reaches the name's line): what counts is what lies on top.
    const hit = opts.hit === 'pick' ? `seat-pick-${m.seat}` : 'bot-badge';
    const over = [...new Set(m.hits.filter((h) => h !== hit && h !== 'off-screen'))];
    if (over.length) out.push(`${id}: ${over.join(', ')} over the mark, not ${hit}`);
    if (m.covers.length) out.push(`${id}: ${m.covers.join(', ')} painted over the mark`);
    if (m.color !== TEAL) out.push(`${id}: the mark ${m.color}, not the bot teal`);
  }
  // A bot's name line no taller than a member's: every plate the same height.
  const heights = [...new Set(marks.map((m) => Math.round(m.plate!.h * 2) / 2))];
  if (heights.length > 1) out.push(`${where}: plates ${heights.join(', ')}px high`);
  return out;
}

/** Lays a layer no pointer reaches over a seat's mark: opaque, or clear. */
const cover = (p: Page, b: Box, fill: string) =>
  p.evaluate(
    ([b, fill]) => {
      const d = document.createElement('div');
      d.dataset.testid = 'probe-cover';
      Object.assign(d.style, { position: 'fixed', left: `${b.l - 2}px`, top: `${b.t - 2}px`, width: `${b.w + 4}px`, height: `${b.h + 4}px`, background: fill, pointerEvents: 'none', zIndex: '1000' });
      document.body.append(d);
    },
    [b, fill] as const,
  );

/** A PNG's pixels, as Chromium writes its screenshots: 8 bits a channel, RGB or RGBA, not interlaced. */
function pixels(png: Buffer) {
  let w = 0;
  let h = 0;
  let n = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      n = ({ 2: 3, 6: 4 } as Record<number, number>)[body[9]!] ?? 0;
      if (body[8] !== 8 || body[12] || !n) throw new Error(`a PNG not read here: depth ${body[8]}, color ${body[9]}, interlace ${body[12]}`);
    } else if (kind === 'IDAT') data.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(data));
  const row = w * n;
  const px = Buffer.alloc(h * row);
  // Each row's filter undone against the bytes left of it (a), above it (b) and above-left (c).
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)]!;
    for (let x = 0; x < row; x++) {
      const a = x >= n ? px[y * row + x - n]! : 0;
      const b = y ? px[(y - 1) * row + x]! : 0;
      const c = x >= n && y ? px[(y - 1) * row + x - n]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * row + x] = (raw[y * (row + 1) + 1 + x]! + [0, a, b, (a + b) >> 1, paeth][f]!) & 255;
    }
  }
  return { w, h, n, px };
}

/** The least share of its box a robot's teal strokes cover: 27–44% on every screen measured, 0 made clear, 12% cut to its right 40%. */
const INK = 0.15;

/**
 * Where a bot's robot cannot be seen, whatever its box, class and color say (made clear, faded, its strokes gone,
 * covered, cut): its box as the screen shows it, shot with the robot and again with the robot hidden. The pixels that
 * change are what the robot paints, and they must turn toward the teal over at least INK of the box. `reveal` brings
 * each bot's seat into view first (seatMarks).
 */
async function inkless(p: Page, where: string, reveal = false) {
  const out: string[] = [];
  const ink: number[] = [];
  for (const seat of (await seatMarks(p)).filter((x) => x.bot).map((x) => x.seat)) {
    const m = (await seatMarks(p, reveal && seat)).find((x) => x.seat === seat)!;
    const ic = m.icon!;
    const x = Math.max(0, Math.floor(ic.l));
    const y = Math.max(0, Math.floor(ic.t));
    const clip = { x, y, width: Math.min(m.vw, Math.ceil(ic.r)) - x, height: Math.min(m.vh, Math.ceil(ic.b)) - y };
    if (clip.width < 1 || clip.height < 1) {
      out.push(`${where} seat ${seat}: the robot not on the screen to be seen`);
      continue;
    }
    const svg = p.locator(`[data-testid=table] [data-testid=seat-${seat}][data-state] [data-testid=bot-badge] svg`);
    const shown = pixels(await p.screenshot({ clip }));
    await svg.evaluate((e: SVGElement) => e.style.setProperty('visibility', 'hidden', 'important'));
    const hidden = pixels(await p.screenshot({ clip }));
    await svg.evaluate((e: SVGElement) => e.style.removeProperty('visibility'));
    let teal = 0;
    for (let i = 0; i < shown.px.length; i += shown.n) {
      const [dr, dg, db] = [0, 1, 2].map((k) => shown.px[i + k]! - hidden.px[i + k]!) as [number, number, number];
      if (dg >= 24 && db >= 20 && dg > dr && db > dr) teal++;
    }
    const share = teal / (shown.w * shown.h);
    ink.push(share);
    if (share < INK) out.push(`${where} seat ${seat}: the robot's teal on ${(share * 100).toFixed(0)}% of its box, under ${INK * 100}%`);
  }
  if (ink.length) console.log(`robot ink ${where}: ${ink.map((s) => `${(s * 100).toFixed(0)}%`).join(' ')}`);
  return out;
}

/** Checks, else folds (table-text.spec). */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
}

const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');

/** Opens a context of `state` at a screen, its socket watched, at `url`. */
async function open(browser: Browser, state: BrowserContextOptions['storageState'], sc: (typeof SCREENS)[number], url: string) {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: sc.touch, hasTouch: sc.touch, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  const sock = await watchSocket(p);
  await p.goto(url);
  return { ctx, p, sock };
}

/** Taps or clicks the first bot's mark: its card opens, says what it is, and closes. */
async function openCardFromMark(p: Page, touch: boolean, level: string, where: string) {
  const bot = (await seatMarks(p)).find((m) => m.bot && !m.hits.includes('off-screen'))!;
  const x = (bot.icon!.l + bot.icon!.r) / 2;
  const y = (bot.icon!.t + bot.icon!.b) / 2;
  if (touch) await p.touchscreen.tap(x, y);
  else await p.mouse.click(x, y);
  const card = p.getByTestId('bot-card');
  await expect(card, where).toBeVisible();
  await expect(card.getByTestId('bot-card-kind')).toHaveText('AI 봇 플레이어');
  await expect(card.getByTestId('bot-card-level')).toHaveText(`난이도 ${level}`);
  await expect(card.getByTestId('bot-badge')).toHaveAttribute('title', `AI 봇 플레이어 · ${level}`);
  // The sheet is on the screen with the name, its mark and what it is at the top; a card taller than a small phone
  // scrolls inside it (Modal, max-h 92dvh) to its last button.
  await expect(p.getByRole('dialog').locator('.jc-panel')).toBeInViewport({ ratio: 1 });
  for (const id of ['bot-badge', 'bot-card-kind']) await expect(card.getByTestId(id), `${where} ${id}`).toBeInViewport({ ratio: 1 });
  await p.screenshot({ path: test.info().outputPath(`card-${where}.png`) });
  const close = card.getByRole('button', { name: '닫기' });
  await close.scrollIntoViewIfNeeded();
  await expect(close, `${where}: the card's end`).toBeInViewport({ ratio: 1 });
  await p.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
}

test('bot mark, live: only on the seats the server says are bots, named like one or not; its title and card; no flicker through a hand; right after a reconnect, a reload and to a spectator; whole on every screen', async ({ browser }) => {
  test.setTimeout(600_000);
  // Members named like bots: the name says nothing, the server's flag does.
  const a = await signUp(browser, { nick: 'PokerBot' });
  const b = await signUp(browser, { nick: 'BotLongN' });
  const sockA = await watchSocket(a.page);
  const sockB = await watchSocket(b.page);
  await sitWith(a.page, 'e2e-boticon', 1000);
  // Seven bots join first (the buy-in opens on the first free seat, which a bot joining meanwhile takes), then B fills
  // the table to nine.
  await expect(filled(a.page)).toHaveCount(8, { timeout: 120_000 });
  await sitWith(b.page, 'e2e-boticon', 1000);
  await expect(filled(a.page)).toHaveCount(9, { timeout: 30_000 });
  await expect.poll(() => misMarked(a.page, sockA.state()), { timeout: 30_000 }).toEqual([]);
  await expect.poll(() => misMarked(b.page, sockB.state()), { timeout: 30_000 }).toEqual([]);
  const marks = await seatMarks(a.page);
  expect(marks.filter((m) => m.bot)).toHaveLength(7);
  for (const m of marks.filter((x) => !x.bot)) expect([a.nickname, b.nickname], `seat ${m.seat}`).toContain(m.nickname);
  // The mark's title, and the plate's button over it (what a pointer resting there reads): the level and the style.
  for (const m of marks) {
    if (m.bot) {
      expect(m.title).toBe('AI 봇 플레이어 · 보통');
      expect(m.pickTitle, `seat ${m.seat}`).toMatch(/^AI 봇 플레이어 · 보통 · (균형형|타이트 어그레시브|루즈 어그레시브|타이트 패시브|루즈 패시브|캐주얼)$/);
    } else expect(m.pickTitle, `seat ${m.seat}`).toBeNull();
  }
  expect(placement(marks, 'live 1440x900', { hit: 'pick' })).toEqual([]);
  // The checker itself: a layer over a mark that no pointer reaches is told when it paints, not when it is clear.
  const probe = marks.find((m) => m.bot)!;
  for (const [fill, told] of [
    ['rgb(0, 0, 0)', true],
    ['transparent', false],
  ] as const) {
    await cover(a.page, probe.icon!, fill);
    const said = placement(await seatMarks(a.page), 'probe', { hit: 'pick' });
    await a.page.evaluate(() => document.querySelector('[data-testid=probe-cover]')!.remove());
    expect(said.some((x) => x.startsWith(`probe seat ${probe.seat}:`) && x.includes('probe-cover') && x.endsWith('painted over the mark')), `a ${fill} layer over seat ${probe.seat}'s mark: ${said.join('; ')}`).toBe(told);
  }
  // Every robot paints its strokes; and one made to paint nothing, its box, class and color as they were, is told by
  // its pixels (and a clear one by its opacity too), one cut by a clip by its style.
  expect(await inkless(a.page, 'live 1440x900')).toEqual([]);
  const robot = a.page.locator(`[data-testid=table] [data-testid=seat-${probe.seat}][data-state] [data-testid=bot-badge] svg`);
  for (const [style, by] of [
    ['opacity: 0', ['teal on', 'as opaque as']],
    ['stroke: transparent', ['teal on']],
    ['clip-path: inset(0 0 0 60%)', ['clip-path']],
  ] as const) {
    await robot.evaluate((e: SVGElement, s) => (e.style.cssText += s), style);
    const said = [...(await inkless(a.page, 'probe')), ...placement(await seatMarks(a.page), 'probe', { hit: 'pick' })].filter((x) => x.startsWith(`probe seat ${probe.seat}:`));
    await robot.evaluate((e: SVGElement) => e.removeAttribute('style'));
    for (const k of by) expect(said.some((x) => x.includes(k)), `${style} on seat ${probe.seat}'s robot, told by '${k}': ${said.join('; ')}`).toBe(true);
  }
  // Cut inside its own box, which stays where it was (Codex): the SVG's view shifted off the robot's left, its strokes
  // moved, one stroke hidden. Each leaves 26–32% of its box teal, past the ink's floor: the strokes' own check tells them.
  const missed: string[] = [];
  for (const [how, by] of [
    ['viewBox="6 0 24 24"', 'outside its box'],
    ['translate(-6 0) on its strokes', 'outside its box'],
    ['visibility: hidden on a stroke', 'hidden'],
  ] as const) {
    await robot.evaluate((e: SVGSVGElement, how) => {
      if (how.startsWith('viewBox')) e.setAttribute('viewBox', '6 0 24 24');
      else if (how.startsWith('translate')) for (const g of Array.from(e.children)) g.setAttribute('transform', 'translate(-6 0)');
      else (e.lastElementChild as SVGElement).style.visibility = 'hidden';
    }, how);
    const said = [...(await inkless(a.page, 'probe')), ...placement(await seatMarks(a.page), 'probe', { hit: 'pick' })].filter((x) => x.startsWith(`probe seat ${probe.seat}:`));
    await robot.evaluate((e: SVGSVGElement) => {
      e.setAttribute('viewBox', '0 0 24 24');
      for (const g of Array.from(e.children)) {
        g.removeAttribute('transform');
        g.removeAttribute('style');
      }
    });
    if (!said.some((x) => x.includes(by))) missed.push(`${how} on seat ${probe.seat}'s robot, not told by '${by}': ${said.join('; ') || 'nothing said'}`);
  }
  expect(missed).toEqual([]);
  expect(await inkless(a.page, 'probe, restored')).toEqual([]);
  await a.page.screenshot({ path: test.info().outputPath('live-1440x900.png') });
  await openCardFromMark(a.page, false, '보통', 'live-1440x900');

  // Through a hand to its end and the next deal: every bot's mark stays the same node where it was.
  const bots = () => new Map((sockA.state()?.seats ?? []).filter((s) => s.bot).map((s) => [s.seatIndex, s.userId]));
  const before = bots();
  await a.page.evaluate(() => {
    const w = window as unknown as { __marks: [string, Element][]; __ended: boolean };
    w.__marks = Array.from(document.querySelectorAll('[data-testid=table] [data-testid=bot-badge]')).map((x) => [x.closest('[data-state]')!.getAttribute('data-testid')!, x]);
    w.__ended = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid=table] .jc-winner')) w.__ended = true;
    }).observe(document.querySelector('[data-testid=table]')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const ended = () => a.page.evaluate(() => (window as unknown as { __ended: boolean }).__ended);
  await expect(async () => {
    await act(a.page);
    await act(b.page);
    expect(await ended()).toBe(true);
  }).toPass({ timeout: 240_000 });
  await expect(async () => {
    await act(a.page);
    await act(b.page);
    await expect(a.page.locator('[data-testid=table] .jc-winner')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 120_000 });
  const after = bots();
  const kept = [...before].filter(([seat, user]) => after.get(seat) === user).map(([seat]) => `seat-${seat}`);
  expect(kept.length, 'bots that stayed through the hand').toBeGreaterThan(0);
  const moved = await a.page.evaluate((kept) => {
    const w = window as unknown as { __marks: [string, Element][] };
    return w.__marks.filter(([seat, el]) => kept.includes(seat) && (!el.isConnected || document.querySelector(`[data-testid=table] [data-testid=${seat}] [data-testid=bot-badge]`) !== el)).map(([seat]) => seat);
  }, kept);
  expect(moved, 'marks drawn again during the hand').toEqual([]);

  // The socket drops and comes back: the marks are right again; and again after a reload.
  const dropped = sockA.sockets.length - 1;
  await sockA.drop();
  await a.page.waitForTimeout(1_500);
  sockA.restore();
  // The page's retry may have opened while the network was down (and hung there): what counts is that a connection
  // after the dropped one gets the server's state.
  await expect.poll(() => sockA.states.slice(dropped + 1).some((n) => n > 0), { message: 'reconnected', timeout: 30_000 }).toBe(true);
  await expect.poll(() => misMarked(a.page, sockA.state()), { timeout: 30_000 }).toEqual([]);
  expect(placement(await seatMarks(a.page), 'reconnected', { hit: 'pick' })).toEqual([]);
  expect(await inkless(a.page, 'reconnected')).toEqual([]);
  await a.page.reload();
  await expect(filled(a.page)).toHaveCount(9, { timeout: 30_000 });
  await expect.poll(() => misMarked(a.page, sockA.state()), { timeout: 30_000 }).toEqual([]);

  // A spectator sees the same marks.
  const c = await signUp(browser, { nick: 'watcher' });
  const sockC = await watchSocket(c.page);
  await c.page.goto('/table/e2e-boticon');
  await expect(filled(c.page)).toHaveCount(9, { timeout: 30_000 });
  await expect.poll(() => misMarked(c.page, sockC.state()), { timeout: 30_000 }).toEqual([]);
  expect(placement(await seatMarks(c.page), 'spectator', { hit: 'pick' })).toEqual([]);
  expect(await inkless(c.page, 'spectator')).toEqual([]);
  await c.page.screenshot({ path: test.info().outputPath('spectator-1440x900.png') });

  // Every screen, one page of A's at the table at a time.
  const state = await a.page.context().storageState();
  await a.page.goto('/');
  const found: string[] = [];
  for (const sc of SCREENS) {
    const { ctx, p, sock } = await open(browser, state, sc, '/table/e2e-boticon');
    await expect(filled(p)).toHaveCount(9, { timeout: 30_000 });
    await expect.poll(() => misMarked(p, sock.state()), { message: sc.name, timeout: 30_000 }).toEqual([]);
    // The table takes its size from the screen first.
    await p.waitForTimeout(600);
    const seen = await seatMarks(p);
    found.push(...placement(seen, sc.name, { hit: 'pick' }), ...(await inkless(p, sc.name)));
    // Nine seats on a 320px-wide phone: the layout's four seats along the top (layout.ts rows) need 4 × 100px, so the
    // corner seats lie half across the screen's sides, avatar and all (STATUS, 9인 320×568). The left one's start is
    // what is cut: its mark goes after its name, on the screen (placement() says where it is not). Asserted to happen,
    // else this proves nothing.
    if (sc.name === '320x568') expect(seen.filter((m) => m.bot && m.after && m.plate!.l < 0).map((m) => m.seat), `${sc.name}: a bot's plate cut at its start, its mark after the name`).not.toEqual([]);
    if (await widerThanDevice(p)) found.push(`${sc.name}: page wider than the screen`);
    await p.screenshot({ path: test.info().outputPath(`live-${sc.name}.png`) });
    if (sc.name === '320x568' || sc.name === '844x390' || sc.name === '1280x720') await openCardFromMark(p, sc.touch, '보통', sc.name);
    await ctx.close();
  }
  expect(found).toEqual([]);

  await a.page.goto('/table/e2e-boticon');
  await expect(filled(a.page)).toHaveCount(9, { timeout: 30_000 });
  await standUp(a.page);
  await standUp(b.page);
});

test('bot mark, six seats of expert bots: only on the bots, its level in the title and on the card, whole on a phone, a tablet and a desktop', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser, { nick: 'robotbot' });
  await sitWith(a.page, 'e2e-boticon6', 1000);
  await expect(filled(a.page)).toHaveCount(6, { timeout: 120_000 });
  const state = await a.page.context().storageState();
  await a.page.goto('/');
  const found: string[] = [];
  for (const sc of SCREENS.filter((x) => ['360x640', '768x1024', '1920x1080'].includes(x.name))) {
    const { ctx, p, sock } = await open(browser, state, sc, '/table/e2e-boticon6');
    await expect(filled(p)).toHaveCount(6, { timeout: 30_000 });
    await expect.poll(() => misMarked(p, sock.state()), { message: sc.name, timeout: 30_000 }).toEqual([]);
    await p.waitForTimeout(600);
    const marks = await seatMarks(p);
    expect(marks.filter((m) => m.bot)).toHaveLength(5);
    for (const m of marks.filter((x) => x.bot)) expect(m.pickTitle).toMatch(/^AI 봇 플레이어 · 전문가 · .+$/);
    found.push(...placement(marks, `six ${sc.name}`, { hit: 'pick' }), ...(await inkless(p, `six ${sc.name}`)));
    await p.screenshot({ path: test.info().outputPath(`six-${sc.name}.png`) });
    await openCardFromMark(p, sc.touch, '전문가', `six-${sc.name}`);
    await ctx.close();
  }
  expect(found).toEqual([]);
  await a.page.goto('/table/e2e-boticon6');
  await expect(filled(a.page)).toHaveCount(6, { timeout: 30_000 });
  await standUp(a.page);
});

/** A finished hand with these seats played by bots, the 16-letter names kept. */
function withBots(hand: HandDetailDto, seats: number[], id: string): HandDetailDto {
  return { ...hand, id, players: hand.players.map((p) => (seats.includes(p.seatIndex) ? { ...p, bot: true as const } : { ...p, bot: undefined })) };
}

test('bot mark, replay: 16-letter bot names cut short with the mark whole, and every seat as big as with no bots, on every screen', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  const found: string[] = [];
  for (const [hand, seats] of [
    [HAND_6, [1, 3, 5]],
    [HAND_9, [1, 5, 6, 7, 8]],
  ] as const) {
    const bots = withBots(hand, [...seats], `${hand.id}-bots`);
    const none = withBots(hand, [], `${hand.id}-none`);
    for (const sc of SCREENS) {
      const where = `${hand.maxSeats} seats ${sc.name}`;
      const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: sc.touch, hasTouch: sc.touch, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      for (const h of [bots, none]) await p.route(`**/api/me/hands/${h.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h) }));
      const look = async (h: HandDetailDto) => {
        await p.goto(`/me/hands/${h.id}`);
        await expect(p.getByTestId('replay-index')).toHaveText(/^1\//);
        await expect(filled(p)).toHaveCount(h.players.length);
        await p.waitForTimeout(600);
        return seatMarks(p, true);
      };
      const withMarks = await look(bots);
      found.push(...(await inkless(p, where, true)));
      await p.screenshot({ path: test.info().outputPath(`replay-${hand.maxSeats}-${sc.name}.png`) });
      const plain = await look(none);
      const marked = withMarks.filter((m) => m.bot).map((m) => m.seat);
      if (JSON.stringify(marked) !== JSON.stringify([...seats].sort((x, y) => x - y))) found.push(`${where}: marks on ${marked}, not ${seats}`);
      if (plain.some((m) => m.bot || m.robots)) found.push(`${where}: a mark with no bot`);
      // A past hand knows only that the seat was a bot.
      for (const m of withMarks.filter((x) => x.bot)) if (m.title !== 'AI 봇 플레이어' || m.level !== null) found.push(`${where} seat ${m.seat}: ${m.title} ${m.level}`);
      found.push(...placement(withMarks, where, { hit: 'badge' }));
      // The mark lies inside the name's width cap (placement), so a seat is never wider than the room layout.ts keeps for
      // it, nor taller, nor moved: as with any name, its plate is as wide as the name and the mark are, up to that cap.
      // Where the name is already cut short at the cap (the phones), the plate is the very same box.
      for (const m of withMarks) {
        const q = plain.find((x) => x.seat === m.seat)!;
        const a = m.onTable!;
        const b = q.onTable!;
        const d = Math.max(Math.abs(a.cx - b.cx), Math.abs(a.t - b.t), Math.abs(a.b - b.b));
        if (d > 0.5) found.push(`${where} seat ${m.seat}: the plate moved or grew taller ${d.toFixed(1)}px with the mark`);
        if (q.cap!.w >= q.capMax - 0.5 && Math.abs(a.w - b.w) > 0.5) found.push(`${where} seat ${m.seat}: a name cut at its cap, and the plate ${(a.w - b.w).toFixed(1)}px wider with the mark`);
      }
      await ctx.close();
    }
  }
  expect(found).toEqual([]);
});

test("bot mark, share image: the robot drawn in the bot teal by a bot's name in each template, and nowhere in a hand with no bots", async ({ browser }) => {
  test.setTimeout(180_000);
  const { page: p } = await signUp(browser);
  const bots = withBots(HAND_9, [1, 5, 6, 7, 8], `${HAND_9.id}-share-bots`);
  const none = withBots(HAND_9, [], `${HAND_9.id}-share-none`);
  for (const h of [bots, none]) await p.route(`**/api/me/hands/${h.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h) }));
  // Pixels of the preview within a few levels of the bot teal (the mark's strokes; its edges blend into the felt).
  const teal = () =>
    p.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=share-preview]')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 143) + Math.abs(d[i + 1]! - 217) + Math.abs(d[i + 2]! - 203) <= 12) n++;
      return n;
    });
  const counts: Record<string, [number, number]> = {};
  for (const [k, h] of [[0, bots], [1, none]] as const) {
    await p.goto(`/me/hands/${h.id}`);
    await expect(p.getByTestId('replay-index')).toHaveText(/^1\//);
    await p.getByTestId('replay-last').click();
    await p.getByTestId('replay-share-open').click();
    await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1', { timeout: 15_000 });
    for (const tpl of ['betline', 'summary', 'highlight', 'classic', 'minimal']) {
      // The preview stops reading as drawn in the very render that chooses the template (replay-share.spec).
      await p.getByTestId(`share-template-${tpl}`).click();
      await expect(p.getByTestId(`share-template-${tpl}`)).toHaveAttribute('aria-pressed', 'true');
      await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1');
      (counts[tpl] ??= [0, 0])[k] = await teal();
      if (k === 0) await p.getByTestId('share-preview').screenshot({ path: test.info().outputPath(`share-bots-${tpl}.png`) });
    }
  }
  // The table and the hand's lines name the bots; the minimal card names nobody but the viewer, and the summary's
  // and the highlight's lines may leave them out. No teal at all where nobody was a bot.
  for (const tpl of ['betline', 'classic']) expect(counts[tpl]![0], tpl).toBeGreaterThan(20);
  for (const [tpl, [, n]] of Object.entries(counts)) expect(n, `${tpl} with no bots`).toBe(0);
});
