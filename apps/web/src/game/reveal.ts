/**
 * Where a winner's cards shown after the hand come to rest: they slide from the seat towards the board and stop by it,
 * at about the board's card size, clear of the board, the status line, every seat and the table's edge (the pot's row is
 * empty by then), and nearer their own seat than any other (so they read as that player's). Worked out from the plan the table is drawn
 * by (layout.ts), so the spot is where the seats and the board really are at any size; nowhere that clear, the cards
 * turn where they lie, as they did before.
 */
import type { Point, Rect, TablePlan } from './layout';

/** The move from the middle of the seat's cards to their resting spot (px), and the size they rest at (a scale). */
export interface RevealSpot {
  x: number;
  y: number;
  s: number;
}

/** The least room left round the cards at rest. */
const GAP = 4;
/** The gap between the two cards (Seat.tsx draws them `gap-1`). */
const PAIR_GAP = 4;
/** How far the cards may go, in shares of the way from the seat to the board's middle (past it only turned aside). */
const ALONG = Array.from({ length: 53 }, (_, k) => 0.3 + k * 0.025);
/** That way turned either way (radians): beside the board, where the seat is right under or over it. */
const TURNS = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2];
/** What turning the way costs against going further from the board (px per radian): straight on, if as near. */
const TURN_COST = 20;

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}
const box = (r: Rect): Box => ({ l: r.x, t: r.y, r: r.x + r.w, b: r.y + r.h });
const overlaps = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > -GAP && Math.min(a.b, b.b) - Math.max(a.t, b.t) > -GAP;
const away = (b: Box, p: Point) => Math.hypot(Math.max(b.l - p.x, 0, p.x - b.r), Math.max(b.t - p.y, 0, p.y - b.b));
const apart = (a: Box, b: Box) => Math.hypot(Math.max(b.l - a.r, 0, a.l - b.r), Math.max(b.t - a.b, 0, a.t - b.b));

/** The middle of a seat's two cards as Seat.tsx draws them (the seat is centred from its cards' top to its status line). */
export function cardsCentre(plan: TablePlan, seat: number, mine: boolean): Point | null {
  const a = plan.seats[seat];
  if (!a) return null;
  const d = plan.dims;
  const card = mine ? d.cardMe : d.cardOther;
  const h = 1.4 * card - d.overlap + d.plateH + d.statusH;
  return { x: a.x, y: a.y - h / 2 + 0.7 * card };
}

/**
 * Resting spots for the winners' shown cards, one after another (two winners never rest on each other): per seat the
 * move and the scale, or nothing where no spot is clear.
 */
export function revealSpots(plan: TablePlan, seats: readonly { seat: number; mine: boolean }[]): Map<number, RevealSpot> {
  const out = new Map<number, RevealSpot>();
  const d = plan.dims;
  // The board and the status line under it. The pot's row above them is empty once the hand is over (its chips paid
  // out), and free to rest in.
  const k = plan.block;
  const board = { l: k.x, t: k.y + plan.potRowH + 8, r: k.x + k.w, b: k.y + k.h };
  const to = { x: (board.l + board.r) / 2, y: (board.t + board.b) / 2 };
  const rooms = plan.rooms.map(box);
  const taken: Box[] = [board, ...rooms];
  for (const { seat, mine } of seats) {
    const from = cardsCentre(plan, seat, mine);
    const own = rooms[seat];
    if (!from || !own) continue;
    const card = mine ? d.cardMe : d.cardOther;
    // As large as the board's cards where there is room (another player's cards are drawn smaller), never smaller
    // than seven tenths of the seat's.
    const big = Math.min(1.5, Math.max(1, plan.board / card));
    const scales = [...new Set([big, (big + 1) / 2, 1, 0.85, 0.7].map((s) => Math.round(s * 100) / 100))].filter((s) => s <= big).sort((a, b) => b - a);
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    // The largest size with a clear spot, and there the spot nearest the board.
    let best = null as { r: Box; spot: RevealSpot; cost: number } | null;
    for (const s of scales) {
      const w = s * (2 * card + PAIR_GAP);
      const h = s * 1.4 * card;
      for (const t of ALONG)
        for (const a of TURNS) {
          const x = from.x + t * (vx * Math.cos(a) - vy * Math.sin(a));
          const y = from.y + t * (vx * Math.sin(a) + vy * Math.cos(a));
          const r = { l: x - w / 2, t: y - h / 2, r: x + w / 2, b: y + h / 2 };
          if (r.l < GAP || r.t < GAP || r.r > plan.w - GAP || r.b > plan.h - GAP) continue;
          if (taken.some((b) => overlaps(r, b))) continue;
          const mid = { x, y };
          if (rooms.some((b, i) => i !== seat && away(b, mid) <= away(own, mid))) continue;
          const cost = apart(r, board) + TURN_COST * Math.abs(a);
          if (!best || cost < best.cost) best = { r, spot: { x: x - from.x, y: y - from.y, s }, cost };
        }
      if (best) break;
    }
    if (best) {
      out.set(seat, best.spot);
      taken.push(best.r);
    }
  }
  return out;
}
