/**
 * Seat geometry. Inspired by Elite-Poker's usePlayerPositions (seats on an
 * ellipse around the felt, own seat fixed at the bottom), but expressed in
 * percentages of the table box so it scales from phones to desktops without
 * measuring the DOM.
 */
export interface Point {
  x: number;
  y: number;
}

export interface SeatGeometry {
  seat: Point;
  bet: Point;
  /** Where the dealer button puck sits for this seat. */
  button: Point;
}

/**
 * Rotate so `anchorSeat` (the viewer's seat, or 0 for spectators) is at the
 * bottom centre; other seats follow clockwise (to the viewer's left).
 */
export function seatLayout(maxSeats: number, anchorSeat: number, portrait: boolean, edgePct = 8): SeatGeometry[] {
  // Seat ring sits slightly outside the felt ellipse; bets sit inside it.
  const rx = portrait ? 43 : 46;
  const ry = portrait ? 40 : 41;
  const clampX = (x: number) => Math.min(100 - edgePct, Math.max(edgePct, x));
  const out: SeatGeometry[] = [];
  for (let seat = 0; seat < maxSeats; seat++) {
    const k = (seat - anchorSeat + maxSeats) % maxSeats;
    const angle = Math.PI / 2 + (k / maxSeats) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    out.push({
      seat: { x: clampX(50 + rx * cos), y: 50 + ry * sin },
      bet: { x: 50 + rx * 0.58 * cos, y: 50 + ry * 0.56 * sin },
      button: { x: 50 + rx * 0.72 * cos + (portrait ? 6 : 4) * Math.cos(angle + Math.PI / 2), y: 50 + ry * 0.72 * sin + 5 * Math.sin(angle + Math.PI / 2) },
    });
  }
  return out;
}

/*
 * The table's own layout (TableScene): every seat, bet and the board placed by the space they actually take, so
 * nothing is drawn over anything else. Seats keep the order above (the viewer at the bottom, the others clockwise),
 * either around an ellipse or, when that leaves no room, in rows; on small screens the seats get smaller first.
 */

/** How big the seats, cards and the board are drawn. */
export type Density = 'full' | 'compact' | 'dense';

/**
 * Sizes in px at each density. They follow the classes of Seat.tsx (cards, plate, status line, badges) and
 * TableScene.tsx (board, pot, bets): change both together.
 */
export interface Dims {
  /** Card widths: the viewer's own and everyone else's (a card is 1.4 times as tall). */
  cardMe: number;
  cardOther: number;
  /** How far the plate rides up over the cards. */
  overlap: number;
  plateH: number;
  /** The plate's width less its name and stack column (avatar, gap, padding, border). */
  plateBase: number;
  /** The name's width cap, and one digit of the stack. */
  nameMax: number;
  digit: number;
  /** The status line under the plate with its margin. */
  statusH: number;
  /** Badges poking out past the plate's sides (dealer, blind, host, reactions). */
  overhang: number;
  /** Chip pile widths of a bet and of the pot. */
  chip: number;
  potChip: number;
  /** Board card widths: the largest, and the smaller one tried when the larger leaves no room. */
  boardMax: number;
  boardMin: number;
  boardGap: number;
  boardPad: number;
}

export const DIMS: Record<Density, Dims> = {
  full: { cardMe: 54.4, cardOther: 40, overlap: 9.6, plateH: 54, plateBase: 70, nameMax: 112, digit: 7.2, statusH: 20, overhang: 8, chip: 20, potChip: 21.6, boardMax: 56, boardMin: 44, boardGap: 6, boardPad: 8 },
  compact: { cardMe: 41.6, cardOther: 27.2, overlap: 9.6, plateH: 46, plateBase: 62, nameMax: 88, digit: 6.6, statusH: 20, overhang: 8, chip: 16, potChip: 17.6, boardMax: 40, boardMin: 33.6, boardGap: 4, boardPad: 6 },
  dense: { cardMe: 35.2, cardOther: 23.2, overlap: 8, plateH: 30, plateBase: 40, nameMax: 52, digit: 6, statusH: 16, overhang: 4, chip: 14, potChip: 16, boardMax: 34, boardMin: 28, boardGap: 4, boardPad: 6 },
};

/** Rows of seats top to bottom: each entry is a seat's place clockwise from the bottom seat (0), or -1 for the board. */
const ROWS: Record<number, number[][][]> = {
  2: [[[1], [-1], [0]]],
  3: [[[1, 2], [-1], [0]]],
  4: [
    [[2], [1, -1, 3], [0]],
    [[2], [-1], [1, 0, 3]],
    [[1, 2, 3], [-1], [0]],
  ],
  5: [
    [[2, 3], [1, -1, 4], [0]],
    [[2, 3], [-1], [1, 0, 4]],
    [[2, 3], [1, 4], [-1], [0]],
  ],
  6: [
    [[3], [2, 4], [-1], [1, 5], [0]],
    [[2, 3, 4], [-1], [1, 0, 5]],
    [[2, 3, 4], [1, -1, 5], [0]],
    [[3], [2, -1, 4], [1, 0, 5]],
  ],
  7: [
    [[3, 4], [2, -1, 5], [1, 0, 6]],
    [[3, 4], [2, 5], [-1], [1, 6], [0]],
    [[3, 4], [2, 5], [-1], [1, 0, 6]],
  ],
  8: [
    [[3, 4, 5], [2, -1, 6], [1, 0, 7]],
    [[3, 4, 5], [2, 6], [-1], [1, 0, 7]],
    [[4], [3, 5], [2, 6], [-1], [1, 7], [0]],
  ],
  9: [
    [[4, 5], [3, 6], [-1], [2, 7], [1, 0, 8]],
    [[3, 4, 5, 6], [2, -1, 7], [1, 0, 8]],
    [[4, 5], [3, 6], [2, -1, 7], [1, 0, 8]],
    [[3, 4, 5, 6], [2, 7], [-1], [1, 0, 8]],
    [[4, 5], [3, 6], [2, 7], [-1], [1, 8], [0]],
  ],
};

/** What the layout needs to know about a table. */
export interface PlanInput {
  n: number;
  /** The seat drawn at the bottom centre: the viewer's, or 0. */
  anchor: number;
  /** The bottom seat is the viewer's own, drawn with bigger cards. */
  me: boolean;
  /** Room kept above the viewer's cards (the real table's show-card buttons). */
  meTop: number;
  /** Longest labels expected, in characters: a stack, a bet, the pot. */
  chars: { stack: number; bet: number; pot: number };
  /** A status line under the board (the real table's next-hand and side-pot text). */
  footer: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TablePlan {
  density: Density;
  /** 'ring', or 'rows' and the template's number. */
  family: string;
  w: number;
  h: number;
  /** Board card width, the pot row's height and its chip size (px). */
  board: number;
  potRowH: number;
  potChip: number;
  /** Per seat index: where the seat is centred and where its bet is centred (px). */
  seats: Point[];
  bets: Point[];
  /** The pot, the board and the status line under them. */
  block: Rect;
  /** The centre of the pot row, where chips fly to and from. */
  pot: Point;
  felt: Rect;
  /** Area (px²) still drawn over something else or outside the box: 0 when every part has its own room. */
  overlap: number;
}

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}
interface SeatBox {
  w: number;
  /** From the top of the cards to the bottom of the status line: the seat is centred on this. */
  h: number;
  /** Room above that: a highlighted card rises 4px, others' cards are turned, the show-card buttons. */
  top: number;
}

/** One digit of a chip stack's 11px label. */
const MONO = 6.6;
/** The least room left between two parts. */
const GAP = 2;
/**
 * Where a bet is tried, nearest first: along the line from its seat to the board, then turned either way up to
 * nearly square to it (beside the seat), a turned spot counting as farther away.
 */
const SPREAD = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.5, -1.5];
const SPOTS = (() => {
  const out: { t: number; a: number; score: number }[] = [];
  for (let t = 0; t <= 1200; t += 4) for (const a of SPREAD) out.push({ t, a, score: t * (1 + 0.6 * Math.abs(a)) });
  return out.sort((x, y) => x.score - y.score);
})();

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const hit = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l) + GAP) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t) + GAP);
const outside = (a: Box, w: number, h: number) => (Math.max(0, -a.l) + Math.max(0, a.r - w)) * (a.b - a.t) + (Math.max(0, -a.t) + Math.max(0, a.b - h)) * (a.r - a.l);

function seatBox(d: Dims, p: PlanInput, mine: boolean): SeatBox {
  const card = mine ? d.cardMe : d.cardOther;
  return {
    w: d.plateBase + Math.max(d.nameMax, p.chars.stack * d.digit) + 2 * d.overhang,
    h: 1.4 * card - d.overlap + d.plateH + d.statusH,
    top: mine ? Math.max(4, p.meTop) : 6,
  };
}

/** One way of laying the table out: a density, a family (-1 the ring, else a rows template) and a board card size. */
interface Way {
  density: Density;
  family: number;
  card: number;
}

/** Everything about a way that does not depend on the box. */
interface Parts {
  way: Way;
  d: Dims;
  other: SeatBox;
  mine: SeatBox;
  blk: { w: number; h: number; potRowH: number };
  bet: { w: number; h: number };
  tpl: number[][] | null;
  /** Rows: each row's height and their sum. */
  heights: number[];
  rowsH: number;
}

function parts(p: PlanInput, way: Way): Parts {
  const d = DIMS[way.density];
  const potRowH = d.potChip + 16;
  const blk = {
    w: Math.max(5 * way.card + 4 * d.boardGap + 2 * d.boardPad, d.potChip + 18 + p.chars.pot * MONO),
    h: potRowH + 8 + 1.4 * way.card + 2 * d.boardPad + (p.footer ? 32 : 0),
    potRowH,
  };
  const other = seatBox(d, p, false);
  const mine = seatBox(d, p, true);
  const tpl = way.family < 0 ? null : ROWS[p.n]![way.family]!;
  const heights = tpl ? tpl.map((row) => Math.max(...row.map((k) => (k < 0 ? blk.h : k === 0 && p.me ? mine.h + mine.top : other.h + other.top)))) : [];
  return { way, d, other, mine, blk, bet: { w: d.chip + 18 + p.chars.bet * MONO, h: Math.max(d.chip + 16, 21) }, tpl, heights, rowsH: heights.reduce((s, x) => s + x, 0) };
}

interface Placed {
  rects: Box[];
  anchors: Point[];
  block: Box;
}

/** Seats around an ellipse inside the box, the board between the seats above and below it. */
function ring(w: number, h: number, p: PlanInput, s: Parts): Placed {
  const a = (w - s.other.w) / 2;
  const b = (h - s.other.h - s.other.top) / 2;
  const rects: Box[] = [];
  const anchors: Point[] = [];
  for (let seat = 0; seat < p.n; seat++) {
    const k = (seat - p.anchor + p.n) % p.n;
    const box = k === 0 && p.me ? s.mine : s.other;
    const angle = Math.PI / 2 + (k / p.n) * Math.PI * 2;
    const rh = box.h + box.top;
    const cx = clamp(w / 2 + a * Math.cos(angle), box.w / 2, w - box.w / 2);
    const cy = clamp(h / 2 + b * Math.sin(angle), rh / 2, h - rh / 2);
    const r = { l: cx - box.w / 2, r: cx + box.w / 2, t: cy - rh / 2, b: cy + rh / 2 };
    rects[seat] = r;
    anchors[seat] = { x: cx, y: r.t + box.top + box.h / 2 };
  }
  const l = w / 2 - s.blk.w / 2;
  const r = w / 2 + s.blk.w / 2;
  let top = 0;
  let bottom = h;
  for (const x of rects) {
    if (x.l >= r || x.r <= l) continue;
    if ((x.t + x.b) / 2 < h / 2) top = Math.max(top, x.b);
    else bottom = Math.min(bottom, x.t);
  }
  const cy = (top + bottom) / 2;
  return { rects, anchors, block: { l, r, t: cy - s.blk.h / 2, b: cy + s.blk.h / 2 } };
}

/**
 * Seats in rows (a template above), spread like an ellipse where a row has room; the board in its own row's middle.
 * The height left over goes first to the gaps in `mask` (room for a row of bets each), the rest evenly.
 */
function rows(w: number, h: number, p: PlanInput, s: Parts, mask: number): Placed {
  const tpl = s.tpl!;
  const boxOf = (k: number) => (k === 0 && p.me ? s.mine : s.other);
  const need = s.bet.h + 2 * GAP;
  const gaps = tpl.length - 1;
  const set = popcount(mask);
  const even = gaps > 0 ? (h - s.rowsH - set * need) / gaps : 0;
  const rects: Box[] = [];
  const anchors: Point[] = [];
  let block: Box = { l: 0, t: 0, r: 0, b: 0 };
  const put = (k: number, cx: number, cy: number) => {
    const box = boxOf(k);
    const seat = (p.anchor + k) % p.n;
    const rh = box.h + box.top;
    rects[seat] = { l: cx - box.w / 2, r: cx + box.w / 2, t: cy - rh / 2, b: cy + rh / 2 };
    anchors[seat] = { x: cx, y: cy - rh / 2 + box.top + box.h / 2 };
  };
  let y = gaps > 0 ? 0 : (h - s.rowsH) / 2;
  tpl.forEach((row, i) => {
    const rh = s.heights[i]!;
    const cy = y + rh / 2;
    const at = row.indexOf(-1);
    if (at >= 0) {
      block = { l: w / 2 - s.blk.w / 2, r: w / 2 + s.blk.w / 2, t: cy - s.blk.h / 2, b: cy + s.blk.h / 2 };
      let x = 0;
      for (const k of row.slice(0, at)) {
        put(k, x + boxOf(k).w / 2, cy);
        x += boxOf(k).w + GAP;
      }
      x = w;
      for (const k of row.slice(at + 1).reverse()) {
        put(k, x - boxOf(k).w / 2, cy);
        x -= boxOf(k).w + GAP;
      }
    } else if (row.length === 1) {
      put(row[0]!, w / 2, cy);
    } else {
      const bw = Math.max(...row.map((k) => boxOf(k).w));
      const m = row.length;
      const ellipse = (w - bw) * Math.sqrt(Math.max(0, 1 - ((cy - h / 2) / (h / 2)) ** 2));
      const span = Math.max((m - 1) * (bw + GAP), Math.min(w - bw, ellipse));
      row.forEach((k, j) => put(k, w / 2 - span / 2 + (j * span) / (m - 1), cy));
    }
    y += rh + even + (mask >> i & 1 ? need : 0);
  });
  return { rects, anchors, block };
}

function popcount(x: number) {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

/** The gap masks tried for a template, fewest gaps first. */
function masks(rowCount: number) {
  const out: number[] = [];
  for (let m = 0; m < 1 << (rowCount - 1); m++) out.push(m);
  return out.sort((a, b) => popcount(a) - popcount(b) || a - b);
}

function place(w: number, h: number, p: PlanInput, s: Parts, mask: number) {
  return s.tpl ? rows(w, h, p, s, mask) : ring(w, h, p, s);
}

/** Overlap of the seats and the board with each other and the box's edges. */
function seatCost(w: number, h: number, q: Placed) {
  let cost = outside(q.block, w, h);
  for (let i = 0; i < q.rects.length; i++) {
    const a = q.rects[i]!;
    cost += outside(a, w, h) + hit(a, q.block);
    for (let j = i + 1; j < q.rects.length; j++) cost += hit(a, q.rects[j]!);
  }
  return cost;
}

/**
 * Each bet on the way from its seat to the board, as near the seat as it has room (SPOTS). The order is the viewer's
 * first, then clockwise. With `quick`, gives up (cost Infinity) at the first bet with no free spot.
 */
function placeBets(w: number, h: number, p: PlanInput, q: Placed, bet: { w: number; h: number }, quick: boolean) {
  const bets: Point[] = [];
  const taken: Box[] = [];
  let cost = 0;
  const bx = (q.block.l + q.block.r) / 2;
  const by = (q.block.t + q.block.b) / 2;
  for (let k = 0; k < p.n; k++) {
    const seat = (p.anchor + k) % p.n;
    const r = q.rects[seat]!;
    const sx = (r.l + r.r) / 2;
    const sy = (r.t + r.b) / 2;
    const dist = Math.hypot(bx - sx, by - sy);
    const angle = Math.atan2(by - sy, bx - sx);
    let best: Box = { l: sx, r: sx, t: sy, b: sy };
    let bestCost = Infinity;
    for (const { t, a, score } of SPOTS) {
      if (score > dist * 1.9) break;
      if (t > dist) continue;
      const x = sx + Math.cos(angle + a) * t;
      const y = sy + Math.sin(angle + a) * t;
      const c = { l: x - bet.w / 2, r: x + bet.w / 2, t: y - bet.h / 2, b: y + bet.h / 2 };
      let o = outside(c, w, h) + hit(c, q.block);
      for (const z of q.rects) if (o < bestCost) o += hit(c, z);
      for (const z of taken) if (o < bestCost) o += hit(c, z);
      if (o < bestCost) {
        bestCost = o;
        best = c;
        if (o === 0) break;
      }
    }
    if (bestCost > 0 && quick) return { bets, cost: Infinity };
    taken.push(best);
    cost += Number.isFinite(bestCost) ? bestCost : bet.w * bet.h;
    bets[seat] = { x: (best.l + best.r) / 2, y: (best.t + best.b) / 2 };
  }
  return { bets, cost };
}

function ways(n: number, densities: readonly Density[]): Way[] {
  const out: Way[] = [];
  for (const density of densities) {
    const d = DIMS[density];
    for (const family of [-1, ...(ROWS[n] ?? []).map((_, i) => i)]) for (const card of [d.boardMax, d.boardMin]) out.push({ density, family, card });
  }
  return out;
}

/** The way laid out in a w×h box, or null when `quick` and something overlaps. */
function build(w: number, h: number, p: PlanInput, s: Parts, mask: number, quick: boolean): TablePlan | null {
  const q = place(w, h, p, s, mask);
  const seats = seatCost(w, h, q);
  if (quick && seats > 0) return null;
  const { bets, cost } = placeBets(w, h, p, q, s.bet, quick);
  if (quick && cost > 0) return null;
  const cx = w / 2;
  const cy = h / 2;
  let fa = s.blk.w / 2 + 16;
  let fb = s.blk.h / 2 + 16;
  for (const a of q.anchors) {
    fa = Math.max(fa, 0.9 * Math.abs(a.x - cx));
    fb = Math.max(fb, 0.86 * Math.abs(a.y - cy));
  }
  fa = Math.min(fa, w / 2 - 4);
  fb = Math.min(fb, h / 2 - 4);
  return {
    density: s.way.density,
    family: s.tpl ? `rows${s.way.family}` : 'ring',
    w,
    h,
    board: s.way.card,
    potRowH: s.blk.potRowH,
    potChip: s.d.potChip,
    seats: q.anchors,
    bets,
    block: { x: q.block.l, y: q.block.t, w: q.block.r - q.block.l, h: q.block.b - q.block.t },
    pot: { x: cx, y: q.block.t + s.blk.potRowH / 2 },
    felt: { x: cx - fa, y: cy - fb, w: 2 * fa, h: 2 * fb },
    overlap: seats + cost,
  };
}

/** The way laid out in a w×h box with nothing overlapping, trying the gap masks of a rows template; or null. */
function fitBox(w: number, h: number, p: PlanInput, s: Parts) {
  if (!s.tpl) return build(w, h, p, s, 0, true);
  const need = s.bet.h + 2 * GAP;
  for (const m of masks(s.tpl.length)) {
    if (s.rowsH + popcount(m) * need > h) continue;
    const t = build(w, h, p, s, m, true);
    if (t) return t;
  }
  return null;
}

/** Lays the table out in a box of a given size: the first way, largest first, with nothing overlapping, else the one overlapping least. */
export function planTable(w: number, h: number, p: PlanInput, densities: readonly Density[]): TablePlan {
  const all = ways(p.n, densities).map((way) => parts(p, way));
  for (const s of all) {
    const t = fitBox(w, h, p, s);
    if (t) return t;
  }
  let best: TablePlan | null = null;
  for (const s of all) {
    const t = build(w, h, p, s, 0, false)!;
    if (!best || t.overlap < best.overlap) best = t;
  }
  return best!;
}

/** The least height (to 2px) at which this way leaves nothing overlapping, or Infinity. */
function leastHeight(w: number, p: PlanInput, s: Parts, hi: number) {
  const fits = (h: number, m: number) => build(w, h, p, s, m, true) !== null;
  if (!s.tpl) {
    for (let h = Math.ceil(s.blk.h + s.mine.h + s.mine.top); h <= hi; h += 8) {
      if (!fits(h, 0)) continue;
      let least = h;
      for (let x = h - 2; x > h - 8 && fits(x, 0); x -= 2) least = x;
      return least;
    }
    return Infinity;
  }
  // Rows: the seats need the rows' heights, and each gap in the mask a row of bets; a little more may still help.
  const need = s.bet.h + 2 * GAP;
  let least = Infinity;
  for (const m of masks(s.tpl.length)) {
    const h0 = Math.ceil(s.rowsH + popcount(m) * need);
    for (let h = h0; h < Math.min(least, h0 + 48, hi + 1); h += 2) {
      if (fits(h, m)) {
        least = h;
        break;
      }
    }
  }
  return least;
}

/**
 * Lays the table out at the given width with the height free (the replay): the largest seats whose table fits in
 * `budget`, around an ellipse when that fits too, as tall as `cap` allows (what keeps the controls on screen as the
 * replay opens), the seats one size smaller where that is what fits within it, else the shortest of those tables, so
 * the cap is passed by as little as it can be (the largest seats' least height could pass it by a third of a phone's
 * table, where the smaller seats needed a few px more); if nothing fits, the shortest table.
 */
export function planHeight(w: number, budget: number, cap: number, p: PlanInput, densities: readonly Density[]): TablePlan {
  const all = ways(p.n, densities).map((way) => parts(p, way));
  const target = Math.min(budget, cap);
  const largest = all.find((s) => fitBox(w, budget, p, s));
  if (largest) {
    const floor = densities.indexOf(largest.way.density) + 1;
    for (const s of all) {
      if (densities.indexOf(s.way.density) > floor) break;
      const t = fitBox(w, target, p, s);
      if (t) return t;
    }
    // Searched from the smallest seats so the bound tightens early; ties keep the larger.
    let short: { s: Parts; h: number } | null = null;
    for (const s of all.filter((x) => densities.indexOf(x.way.density) <= floor).reverse()) {
      const h = leastHeight(w, p, s, short ? short.h : budget);
      if (h <= (short ? short.h : budget)) short = { s, h };
    }
    if (short) return fitBox(w, short.h, p, short.s)!;
  }
  // Nothing fits: the shortest table, searched from the smallest seats so the bound tightens early; ties keep the larger.
  let best: { s: Parts | null; h: number } = { s: null, h: Math.max(600, budget, 2.4 * w) };
  for (const s of [...all].reverse()) {
    const h = leastHeight(w, p, s, best.h);
    if (h <= best.h) best = { s, h };
  }
  return (best.s && fitBox(w, best.h, p, best.s)) || planTable(w, Math.max(budget, cap), p, densities);
}