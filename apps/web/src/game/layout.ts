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
  /** Where its bet lies once it folds (TablePlan's `folds`), where that is somewhere else. */
  fold?: Point;
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
  /** The plate's width less its name and stack column (avatar, gap, padding, border), and its least width. */
  plateBase: number;
  plateMin: number;
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
  full: { cardMe: 54.4, cardOther: 40, overlap: 9.6, plateH: 54, plateBase: 70, plateMin: 136, nameMax: 112, digit: 7.2, statusH: 20, overhang: 8, chip: 20, potChip: 21.6, boardMax: 56, boardMin: 44, boardGap: 6, boardPad: 8 },
  compact: { cardMe: 41.6, cardOther: 27.2, overlap: 9.6, plateH: 46, plateBase: 62, plateMin: 104, nameMax: 88, digit: 6.6, statusH: 20, overhang: 8, chip: 16, potChip: 17.6, boardMax: 40, boardMin: 33.6, boardGap: 4, boardPad: 6 },
  dense: { cardMe: 35.2, cardOther: 23.2, overlap: 8, plateH: 30, plateBase: 40, plateMin: 92, nameMax: 52, digit: 6, statusH: 16, overhang: 4, chip: 14, potChip: 16, boardMax: 34, boardMin: 28, boardGap: 4, boardPad: 6 },
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
  /** Per seat index: where its bet lies once it folds, its cards gone (foldBets); the same as `bets` mostly. */
  folds: Point[];
  /** Per seat index: the room the seat takes, from the top of what rises over its cards to its status line's bottom. */
  rooms: Rect[];
  /** The pot, the board and the status line under them. */
  block: Rect;
  /** The centre of the pot row, where chips fly to and from. */
  pot: Point;
  felt: Rect;
  /** The sizes it was laid out by: DIMS at its density, times the text size where it was drawn larger (scalePlan). */
  dims: Dims;
  /**
   * Area (px²) still drawn over something else or outside the box, and where nothing fits, a bet's area for each bet
   * nearer another seat than its own: 0 when every part has its own room.
   */
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
/** Turned further, beside the seat and a little past it: only for a bet that reads as its own nowhere nearer (placeBets). */
const WIDE = (() => {
  const out: { t: number; a: number; score: number }[] = [];
  for (let t = 0; t <= 1200; t += 4) for (const a of [1.8, -1.8, 2.1, -2.1, 2.4, -2.4]) out.push({ t, a, score: t * (1 + 0.6 * Math.abs(a)) });
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
  /** The pot, the board and the status line under them; the pot row's height and the pot's widest. */
  blk: { w: number; h: number; potRowH: number; potW: number };
  bet: { w: number; h: number };
  tpl: number[][] | null;
  /** Rows: each row's height and their sum. */
  heights: number[];
  rowsH: number;
}

function parts(p: PlanInput, way: Way): Parts {
  const d = DIMS[way.density];
  const potRowH = d.potChip + 16;
  const potW = d.potChip + 18 + p.chars.pot * MONO;
  const blk = {
    w: Math.max(5 * way.card + 4 * d.boardGap + 2 * d.boardPad, potW),
    h: potRowH + 8 + 1.4 * way.card + 2 * d.boardPad + (p.footer ? 32 : 0),
    potRowH,
    potW,
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

/** From the block's top to the middle of the board's cards (the pot's row above them). */
const cardsMid = (s: Parts) => s.blk.potRowH + 8 + (1.4 * s.way.card + 2 * s.d.boardPad) / 2;

/**
 * The block moved up or down so the board's cards lie on the box's middle (the felt is then drawn round them), as far
 * as the seats above and below it leave room, 8px kept from each; or null where it is there already. Centred between
 * those seats (or in its row), the cards lay off the middle: above it, the viewer's seat being the taller, and below it
 * where the pot's row above them was the larger part of the block (TEST_REPORT).
 */
function centred(h: number, s: Parts, q: Placed): Box | null {
  const k = q.block;
  const mid = (k.t + k.b) / 2;
  let top = 0;
  let bottom = h;
  for (const x of q.rects) {
    if (x.l >= k.r || x.r <= k.l) continue;
    if ((x.t + x.b) / 2 < mid) top = Math.max(top, x.b);
    else bottom = Math.min(bottom, x.t);
  }
  const room = bottom - top - s.blk.h;
  if (room <= 0) return null;
  const keep = Math.min(room / 2, 8);
  const t = clamp(h / 2 - cardsMid(s), top + keep, bottom - keep - s.blk.h);
  return Math.abs(t - k.t) < 0.5 ? null : { ...k, t, b: t + s.blk.h };
}

/**
 * TableScene's felt: inside the rail (1.2% of the table's width each side, then 0.6% of what is left), its line drawn 9%
 * in from its edge. Change both together.
 */
const RAIL = 0.012;
const RAIL_IN = 0.006;
const LINE = 0.09;
/** How far out the board's corners may reach on the felt's line (1: on it). */
const REACH = 0.92;

/** The half-axes of the line on a felt of half-axes fa×fb in a table w wide. */
function feltLine(w: number, fa: number, fb: number) {
  const rail = 2 * fa - 2 * RAIL * w;
  return { a: rail * (1 - 2 * RAIL_IN) * (0.5 - LINE), b: (2 * fb - 2 * RAIL * w - 2 * RAIL_IN * rail) * (0.5 - LINE) };
}

/**
 * The felt's half-axes grown (wider first, then taller, as far as the box allows) until the board, `u`×`v` from its
 * middle to its corner, lies inside its line with room to spare: where the seats alone set it, the board took nearly all
 * of a heads-up table's felt, and its corners lay over the line or past the felt (TEST_REPORT).
 */
function holdBoard(w: number, fa: number, fb: number, capA: number, capB: number, u: number, v: number) {
  const reach = () => {
    const l = feltLine(w, fa, fb);
    return Math.hypot(u / l.a, v / l.b);
  };
  // Each axis depends a little on the other (the rail's inner part is a share of the felt's width): a pass or two.
  for (let i = 0; i < 3 && reach() > REACH; i++) {
    const l = feltLine(w, fa, fb);
    if (v / l.b < REACH) {
      const need = u / Math.sqrt(REACH ** 2 - (v / l.b) ** 2);
      fa = Math.min(capA, Math.max(fa, (need / (0.5 - LINE) / (1 - 2 * RAIL_IN) + 2 * RAIL * w) / 2));
    }
    const m = feltLine(w, fa, fb);
    if (Math.hypot(u / m.a, v / m.b) > REACH && u / m.a < REACH) {
      const need = v / Math.sqrt(REACH ** 2 - (u / m.a) ** 2);
      const rail = 2 * fa - 2 * RAIL * w;
      fb = Math.min(capB, Math.max(fb, (need / (0.5 - LINE) + 2 * RAIL * w + 2 * RAIL_IN * rail) / 2));
    }
  }
  return { fa, fb };
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

/** Whether a point is nearer this seat's box (`mine`) than any other seat's: a bet there reads as this seat's. */
function nearest(x: number, y: number, mine: Box, seats: Box[], self: number) {
  const away = (b: Box) => Math.hypot(Math.max(b.l - x, 0, x - b.r), Math.max(b.t - y, 0, y - b.b));
  const d = away(mine);
  return seats.every((b, i) => i === self || away(b) > d);
}

/**
 * Where the bets may lie: `strict`, each nearer its own seat (as drawn) than any other; `firm`, so and nearer the least
 * its seat is drawn as too (placeBets) where it has such a spot; `loose`, wherever it first has room. All may lie in the
 * pot's row beside the pot, over the board's ends (the row draws only the pot, in its middle); the replay (`kept`) keeps
 * that whole row clear, as it always has.
 */
type Bets = 'firm' | 'strict' | 'loose' | 'kept';
/**
 * Where nothing fits (planTable's last resort), what a bet lying over the board's cards costs, times what it covers:
 * the board comes before the bets, so a bet lies on a seat's room (its own first) rather than on the cards, and astray
 * costs more yet. What fits costs nothing either way.
 */
const BOARD = 4;

/**
 * What of the block no bet lies on: the board's cards apart from the rest of the room kept (the pot's row middle and
 * the status line under the cards), or for `kept`, all of it.
 */
function held(q: Placed, s: Parts, mode: Bets) {
  const { blk } = s;
  const k = q.block;
  const bx = (k.l + k.r) / 2;
  const top = k.t + blk.potRowH + 8;
  const under = top + 1.4 * s.way.card + 2 * s.d.boardPad;
  const cards: Box[] = mode === 'kept' ? [] : [{ ...k, t: top, b: Math.min(k.b, under) }];
  const kept: Box[] =
    mode === 'kept'
      ? [k]
      : [{ l: bx - blk.potW / 2, r: bx + blk.potW / 2, t: k.t, b: k.t + blk.potRowH }, ...(k.b > under ? [{ ...k, t: under }] : [])];
  return { cards, kept };
}

/** The seats as drawn, without the room kept above their cards (the anchor is the centre of what is drawn). */
const drawnOf = (q: Placed): Box[] => q.rects.map((r, i) => ({ ...r, t: 2 * q.anchors[i]!.y - r.b }));

/**
 * Each bet on the way from its seat to the board, as near the seat as it has room (SPOTS), where `mode` lets it. The
 * order is the viewer's first, then clockwise. With `quick`, gives up (cost Infinity) at the first bet with no such spot.
 */
function placeBets(w: number, h: number, p: PlanInput, q: Placed, s: Parts, quick: boolean, mode: Bets) {
  const bets: Point[] = [];
  const taken: Box[] = [];
  let cost = 0;
  const { bet } = s;
  const k = q.block;
  const bx = (k.l + k.r) / 2;
  const by = (k.t + k.b) / 2;
  const { cards, kept } = held(q, s, mode);
  const strict = mode === 'strict' || mode === 'firm';
  const drawn = strict ? drawnOf(q) : [];
  for (let k = 0; k < p.n; k++) {
    const seat = (p.anchor + k) % p.n;
    const r = q.rects[seat]!;
    const sx = (r.l + r.r) / 2;
    const sy = (r.t + r.b) / 2;
    const dist = Math.hypot(bx - sx, by - sy);
    const angle = Math.atan2(by - sy, bx - sx);
    const at = (t: number, a: number) => {
      const x = sx + Math.cos(angle + a) * t;
      const y = sy + Math.sin(angle + a) * t;
      return { x, y, c: { l: x - bet.w / 2, r: x + bet.w / 2, t: y - bet.h / 2, b: y + bet.h / 2 } };
    };
    // What a spot lies over, counted until it reaches `bound`.
    const over = (c: Box, bound: number) => {
      let o = outside(c, w, h);
      for (const z of kept) o += hit(c, z);
      for (const z of cards) o += BOARD * hit(c, z);
      for (const z of q.rects) if (o < bound) o += hit(c, z);
      for (const z of taken) if (o < bound) o += hit(c, z);
      return o;
    };
    // The least this seat is drawn as: its plate as narrow as it gets (a short name and stack) with no status line, and
    // another's without its cards (folded with its bet still out; the viewer's own stay, dimmed). A bet nearer that than
    // any other seat as drawn reads as its own however they are drawn (CI: a folded seat's bet, and the viewer's by a
    // short name, read as a neighbour's by 2px). `firm` takes the first free spot that does, then one turned further
    // (WIDE), else the first free spot nearer the seat as drawn (`spare`), as `strict` does. (A folded seat's bet, where
    // no spot does, lies elsewhere once it folds: foldBets.)
    const u = drawn[seat];
    const least = mode === 'firm' && u && {
      l: q.anchors[seat]!.x - s.d.plateMin / 2,
      r: q.anchors[seat]!.x + s.d.plateMin / 2,
      t: k === 0 && p.me ? u.t : u.t + 1.4 * s.d.cardOther - s.d.overlap,
      b: u.b - s.d.statusH,
    };
    let spare: Box | null = null;
    let best: Box = { l: sx, r: sx, t: sy, b: sy };
    let bestCost = Infinity;
    for (const { t, a, score } of SPOTS) {
      if (score > dist * 1.9) break;
      if (t > dist) continue;
      const { x, y, c } = at(t, a);
      let o = over(c, bestCost);
      // Nearer another seat than its own, the bet reads as that seat's: worse than lying on anything.
      if (strict && o < bestCost && !nearest(x, y, u!, drawn, seat)) o += (BOARD + 1) * bet.w * bet.h;
      if (o < bestCost) {
        if (o === 0 && least && !nearest(x, y, least, drawn, seat)) {
          spare ??= c;
          continue;
        }
        bestCost = o;
        best = c;
        if (o === 0) break;
      }
    }
    if (least && bestCost > 0) {
      for (const { t, a, score } of WIDE) {
        if (score > dist * 1.9) break;
        if (t > dist) continue;
        const { x, y, c } = at(t, a);
        if (over(c, 1) === 0 && nearest(x, y, least, drawn, seat)) {
          bestCost = 0;
          best = c;
          break;
        }
      }
    }
    if (spare && bestCost > 0) {
      bestCost = 0;
      best = spare;
    }
    if (bestCost > 0 && quick) return { bets, cost: Infinity };
    taken.push(best);
    cost += Number.isFinite(bestCost) ? bestCost : bet.w * bet.h;
    bets[seat] = { x: (best.l + best.r) / 2, y: (best.t + best.b) / 2 };
  }
  return { bets, cost };
}

/**
 * Where each bet lies once its seat folds, the seat's cards gone and its bet still out (the viewer's own cards stay,
 * dimmed): where it lies, if that is still nearer the seat than any other seat as drawn; else the first free spot on the
 * way to the board that is, over the room the cards left (CI: nine seats on a 360×800 phone, a folded seat's bet read as
 * the neighbour's by 5px, and no way of laying them out left it a spot that did either way); else where it lies.
 */
function foldBets(w: number, h: number, p: PlanInput, q: Placed, s: Parts, bets: Point[]): Point[] {
  const { bet } = s;
  const k = q.block;
  const bx = (k.l + k.r) / 2;
  const by = (k.t + k.b) / 2;
  const { cards, kept } = held(q, s, 'strict');
  const drawn = drawnOf(q);
  const box = (x: number, y: number) => ({ l: x - bet.w / 2, r: x + bet.w / 2, t: y - bet.h / 2, b: y + bet.h / 2 });
  const taken = bets.map((b) => box(b.x, b.y));
  return bets.map((b, seat) => {
    if (p.me && seat === p.anchor) return b;
    const folded = { ...drawn[seat]!, t: drawn[seat]!.t + 1.4 * s.d.cardOther - s.d.overlap };
    if (nearest(b.x, b.y, folded, drawn, seat)) return b;
    const r = q.rects[seat]!;
    const sx = (r.l + r.r) / 2;
    const sy = (r.t + r.b) / 2;
    const dist = Math.hypot(bx - sx, by - sy);
    const angle = Math.atan2(by - sy, bx - sx);
    for (const { t, a, score } of SPOTS) {
      if (score > dist * 1.9) break;
      if (t > dist) continue;
      const x = sx + Math.cos(angle + a) * t;
      const y = sy + Math.sin(angle + a) * t;
      const c = box(x, y);
      let o = outside(c, w, h);
      for (const z of kept) o += hit(c, z);
      for (const z of cards) o += BOARD * hit(c, z);
      q.rects.forEach((z, i) => (o += hit(c, i === seat ? folded : z)));
      taken.forEach((z, i) => i !== seat && (o += hit(c, z)));
      if (o === 0 && nearest(x, y, folded, drawn, seat)) {
        taken.push(c);
        return { x, y };
      }
    }
    return b;
  });
}

function ways(n: number, densities: readonly Density[]): Way[] {
  const out: Way[] = [];
  for (const density of densities) {
    const d = DIMS[density];
    for (const family of [-1, ...(ROWS[n] ?? []).map((_, i) => i)]) for (const card of [d.boardMax, d.boardMin]) out.push({ density, family, card });
  }
  return out;
}

/**
 * The way laid out in a w×h box, or null when `quick` and something overlaps (or, `strict`, a bet lies nearer another
 * seat). `crowded` keeps the masks whose seats overlap at this size, whatever the bets: a later try skips them.
 */
function build(w: number, h: number, p: PlanInput, s: Parts, mask: number, quick: boolean, mode: Bets, crowded?: Set<number>): TablePlan | null {
  if (quick && crowded?.has(mask)) return null;
  const at = place(w, h, p, s, mask);
  const seatsAt = seatCost(w, h, at);
  if (quick && seatsAt > 0) {
    crowded?.add(mask);
    return null;
  }
  // The board's cards on the box's middle where that leaves the bets their room too; else where the seats put them
  // (where nothing fits, whichever overlaps less, the middle on a tie).
  const mid = centred(h, s, at);
  let found: { q: Placed; seats: number; bets: Point[]; cost: number } | null = null;
  for (const q of mid ? [{ ...at, block: mid }, at] : [at]) {
    const seats = q === at ? seatsAt : seatCost(w, h, q);
    if (quick && seats > 0) continue;
    const { bets, cost } = placeBets(w, h, p, q, s, quick, mode);
    if (quick && cost > 0) continue;
    if (!found || seats + cost < found.seats + found.cost) found = { q, seats, bets, cost };
    if (found.seats + found.cost === 0) break;
  }
  if (!found) return null;
  const { q, seats, cost } = found;
  let { bets } = found;
  // Laid out so, each bet then nearer the least its seat is drawn as where it has room for that (placeBets).
  if (quick && mode === 'strict') {
    const firm = placeBets(w, h, p, q, s, true, 'firm');
    if (firm.cost === 0) bets = firm.bets;
  }
  const cx = w / 2;
  // The felt round the board's cards: in the box's middle where the block could move there, else where they lie (a
  // little off the seats' middle rather than the board off the felt's). It holds the block and reaches in under the seats.
  const cy = q.block.t + cardsMid(s);
  let fa = s.blk.w / 2 + 16;
  let fb = Math.max(cy - q.block.t, q.block.b - cy) + 16;
  for (const a of q.anchors) {
    fa = Math.max(fa, 0.9 * Math.abs(a.x - cx));
    fb = Math.max(fb, 0.86 * Math.abs(a.y - cy));
  }
  // Nearly as wide for its height as the box: heads-up, one seat above the board and one below, nothing else widened it.
  fa = Math.max(fa, (0.8 * fb * w) / h);
  const capA = w / 2 - 4;
  const capB = Math.min(cy, h - cy) - 4;
  ({ fa, fb } = holdBoard(w, Math.min(fa, capA), Math.min(fb, capB), capA, capB, (5 * s.way.card + 4 * s.d.boardGap) / 2 + s.d.boardPad, 0.7 * s.way.card + s.d.boardPad));
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
    folds: mode === 'kept' ? bets : foldBets(w, h, p, q, s, bets),
    rooms: q.rects.map((r) => ({ x: r.l, y: r.t, w: r.r - r.l, h: r.b - r.t })),
    block: { x: q.block.l, y: q.block.t, w: q.block.r - q.block.l, h: q.block.b - q.block.t },
    pot: { x: cx, y: q.block.t + s.blk.potRowH / 2 },
    felt: { x: cx - fa, y: cy - fb, w: 2 * fa, h: 2 * fb },
    dims: s.d,
    overlap: seats + cost,
  };
}

/**
 * The way laid out in a w×h box with nothing overlapping (and, `strict`, every bet nearer its own seat than any
 * other), trying the gap masks of a rows template; or null.
 */
function fitBox(w: number, h: number, p: PlanInput, s: Parts, mode: Bets, crowded?: Set<number>) {
  if (!s.tpl) return build(w, h, p, s, 0, true, mode, crowded);
  const need = s.bet.h + 2 * GAP;
  for (const m of masks(s.tpl.length)) {
    if (s.rowsH + popcount(m) * need > h) continue;
    const t = build(w, h, p, s, m, true, mode, crowded);
    if (t) return t;
  }
  return null;
}

/**
 * Lays the table out in a box of a given size: the first way, largest first, with nothing overlapping and every bet
 * by its own seat; else, where it fits with some bet nearer another seat, that in a narrower box (down to `minW`, 8px at
 * a time: what fits is not monotonic in the width, the rows and the ellipse change with it, so nine seats 268px high
 * may fit so in 632px but not in 640px), or that in the full box; else the one overlapping least.
 */
export function planTable(w: number, h: number, p: PlanInput, densities: readonly Density[], minW = w): TablePlan {
  const all = ways(p.n, densities).map((way) => parts(p, way));
  // Where the seats overlap at a width they do for every way of placing the bets: each pass skips what one before found.
  const crowded = new Map<string, Set<number>>();
  const at = (x: number, i: number) => {
    const key = `${x}:${i}`;
    let c = crowded.get(key);
    if (!c) crowded.set(key, (c = new Set()));
    return c;
  };
  const first = (x: number, mode: Bets) => {
    for (const [i, s] of all.entries()) {
      const t = fitBox(x, h, p, s, mode, at(x, i));
      if (t) return t;
    }
    return null;
  };
  const strict = first(w, 'strict');
  if (strict) return strict;
  const loose = first(w, 'loose');
  // Narrower only where the seats and the bets fit in the full width, some bet astray (where they do not, a narrower box
  // has seldom been found to hold them, and seeking it costs the most).
  if (loose) {
    for (let x = w - 8; x >= minW; x -= 8) {
      const t = first(x, 'strict');
      if (t) return t;
    }
    return loose;
  }
  // Else as it always fitted, the pot's whole row clear: a bet beside the pot may take the only room of one after it.
  for (const [i, s] of all.entries()) {
    const t = fitBox(w, h, p, s, 'kept', at(w, i));
    if (t) return t;
  }
  // Else the least overlap, each bet by its own seat over its own room: one over the board's cards counts BOARD times,
  // one by another seat more than that (where no spot is free, it may lie on its own seat, or not draw clear of a
  // neighbour's, but not over the cards or across the table).
  let best: TablePlan | null = null;
  for (const s of all) {
    const t = build(w, h, p, s, 0, false, 'strict')!;
    if (!best || t.overlap < best.overlap) best = t;
  }
  return best!;
}

/** The least height (to 2px) at which this way leaves nothing overlapping, or Infinity. */
function leastHeight(w: number, p: PlanInput, s: Parts, hi: number) {
  // The replay keeps the fit it had: every part in its own room, the pot's whole row clear (not yet each bet nearest its seat).
  const fits = (h: number, m: number) => build(w, h, p, s, m, true, 'kept') !== null;
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
  const largest = all.find((s) => fitBox(w, budget, p, s, 'kept'));
  if (largest) {
    const floor = densities.indexOf(largest.way.density) + 1;
    for (const s of all) {
      if (densities.indexOf(s.way.density) > floor) break;
      const t = fitBox(w, target, p, s, 'kept');
      if (t) return t;
    }
    // Searched from the smallest seats so the bound tightens early; ties keep the larger.
    let short: { s: Parts; h: number } | null = null;
    for (const s of all.filter((x) => densities.indexOf(x.way.density) <= floor).reverse()) {
      const h = leastHeight(w, p, s, short ? short.h : budget);
      if (h <= (short ? short.h : budget)) short = { s, h };
    }
    if (short) return fitBox(w, short.h, p, short.s, 'kept')!;
  }
  // Nothing fits: the shortest table, searched from the smallest seats so the bound tightens early; ties keep the larger.
  let best: { s: Parts | null; h: number } = { s: null, h: Math.max(600, budget, 2.4 * w) };
  for (const s of [...all].reverse()) {
    const h = leastHeight(w, p, s, best.h);
    if (h <= best.h) best = { s, h };
  }
  return (best.s && fitBox(w, best.h, p, best.s, 'kept')) || planTable(w, Math.max(budget, cap), p, densities);
}

/**
 * A plan made for a 16px root font, drawn at `unit` times that (the root font over 16px: a browser's or phone's text
 * size). Seat.tsx sizes the seats in rem and DIMS gives them in px at 16px, so with the text at 125% the seats were
 * drawn up to a quarter larger than the room kept for them: over the stack under the table and past the screen's sides
 * (TEST_REPORT). Planned in a box `unit` times smaller and drawn `unit` times larger, every part keeps its room, as
 * when zoomed.
 */
export function scalePlan(plan: TablePlan, unit: number): TablePlan {
  if (unit === 1) return plan;
  const pt = (q: Point) => ({ x: q.x * unit, y: q.y * unit });
  const rect = (r: Rect) => ({ x: r.x * unit, y: r.y * unit, w: r.w * unit, h: r.h * unit });
  const dims = Object.fromEntries(Object.entries(plan.dims).map(([k, v]) => [k, v * unit])) as unknown as Dims;
  return {
    ...plan,
    w: plan.w * unit,
    h: plan.h * unit,
    board: plan.board * unit,
    potRowH: plan.potRowH * unit,
    potChip: plan.potChip * unit,
    seats: plan.seats.map(pt),
    bets: plan.bets.map(pt),
    folds: plan.folds.map(pt),
    rooms: plan.rooms.map(rect),
    block: rect(plan.block),
    pot: pt(plan.pot),
    felt: rect(plan.felt),
    dims,
    overlap: plan.overlap * unit * unit,
  };
}

/**
 * How far a plan's seats, drawn `f` times the size of their rooms about their centres, lie over the board block
 * (`board`), and that with over each other and past the table (`all`), in px².
 */
export function drawnOver(plan: TablePlan, f: number): { board: number; all: number } {
  const meet = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const table = { x: 0, y: 0, w: plan.w, h: plan.h };
  const rooms = plan.rooms.map((r, i) => {
    const s = plan.seats[i]!;
    return { x: s.x + (r.x - s.x) * f, y: s.y + (r.y - s.y) * f, w: r.w * f, h: r.h * f };
  });
  let board = 0;
  let rest = 0;
  rooms.forEach((r, i) => {
    board += meet(r, plan.block);
    rest += r.w * r.h - meet(r, table);
    for (const q of rooms.slice(i + 1)) rest += meet(r, q);
  });
  return { board, all: board + rest };
}

/**
 * The plan for the page's text at `k` times 16px, from `lay(u)`, the table laid out for text at u (scalePlan). Seat.tsx
 * sizes the seats in rem, so a plan for u draws them k / u times their rooms. Where at k the seats would reach over the
 * board (nine on a small phone at 125%: no way has room for them at that size, and the closest left them over the board
 * and past the screen), the plan for text halfway there or at 16px that costs least: what it left overlapping itself,
 * its bets too, and what its seats so drawn add over the board, each other and past the table; k where none costs less.
 * What none of them leaves clear (six seats on phones 375px wide and less, nine on a phone held on its side) is in
 * TEST_REPORT.
 */
export function planForText(k: number, lay: (u: number) => TablePlan): TablePlan {
  let plan = lay(k);
  if (k <= 1 || drawnOver(plan, 1).board === 0) return plan;
  let least = plan.overlap;
  for (const u of [(1 + k) / 2, 1]) {
    const p = lay(u);
    const over = p.overlap + drawnOver(p, k / u).all - drawnOver(p, 1).all;
    if (over < least) [plan, least] = [p, over];
  }
  return plan;
}