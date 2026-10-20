/**
 * Reading hands against a board: how strong each two-card combination is on it (as a share of all combinations it
 * beats), which draws it holds, and how wet the board is. Works on card codes (score.ts) and allocates nothing per
 * combination, since the bots read every combination of every opponent's range.
 */
import { allCombos, TOTAL_COMBOS } from './classes';
import { CATEGORY, quickScore, straightTop } from './score';

/** Draw flags of a combination. */
export const FLUSH_DRAW = 1;
export const NUT_FLUSH_DRAW = 2;
export const OPEN_ENDED = 4;
export const GUTSHOT = 8;
export const BACKDOOR_FLUSH = 16;
/** Two overcards to the board. */
export const OVERCARDS = 32;

/** A strong draw: a flush draw or an open-ended straight draw (about eight or more outs). */
export const isStrongDraw = (flags: number) => (flags & (FLUSH_DRAW | OPEN_ENDED)) !== 0;

const suitCnt = new Uint8Array(4);

/** Draws of hole cards `a`, `b` on a flop or turn (none on the river: nothing is left to come). */
export function drawFlags(a: number, b: number, board: readonly number[]): number {
  if (board.length < 3 || board.length >= 5) return 0;
  let flags = 0;
  suitCnt.fill(0);
  let boardMask = 0;
  let boardTop = 0;
  for (const x of board) {
    suitCnt[x & 3]!++;
    boardMask |= 1 << (x >> 2);
    if (x >> 2 > boardTop) boardTop = x >> 2;
  }
  const sa = a & 3;
  const sb = b & 3;
  const flushNeed = (s: number) => suitCnt[s]! + (sa === s ? 1 : 0) + (sb === s ? 1 : 0);
  for (const s of sa === sb ? [sa] : [sa, sb]) {
    const n = flushNeed(s);
    if (n === 4) {
      flags |= FLUSH_DRAW;
      // Nut draw: the hole card of the suit is the best rank of that suit not on the board.
      let best = 14;
      while (board.some((x) => (x & 3) === s && x >> 2 === best)) best--;
      if ((sa === s && a >> 2 === best) || (sb === s && b >> 2 === best)) flags |= NUT_FLUSH_DRAW;
    } else if (n === 3 && board.length === 3 && (sa === s || sb === s)) flags |= BACKDOOR_FLUSH;
  }
  const mask = boardMask | (1 << (a >> 2)) | (1 << (b >> 2));
  if (!straightTop(mask)) {
    let outs = 0;
    for (let r = 2; r <= 14; r++) {
      if (mask & (1 << r)) continue;
      if (straightTop(mask | (1 << r)) && !straightTop(boardMask | (1 << r))) outs++;
    }
    if (outs >= 2) flags |= OPEN_ENDED;
    else if (outs === 1) flags |= GUTSHOT;
  }
  if (a >> 2 > boardTop && b >> 2 > boardTop) flags |= OVERCARDS;
  return flags;
}

/** For a board: each combination's strength (share of the other live combinations it beats, ties half) and draws. */
export interface StrengthTable {
  /** −1 where a card of the combination is on the board. */
  hs: Float32Array;
  draws: Uint8Array;
  /** Hand category (0 high card … 8 straight flush) of the board alone, for telling a board pair from a real one. */
  boardCategory: number;
  /** Each combination's hand score on the board (0 where a card of it is on the board). */
  scores: Float64Array;
}

const cache = new Map<string, StrengthTable>();

export function strengthTable(board: readonly number[]): StrengthTable {
  const key = board.join(',');
  const hit = cache.get(key);
  if (hit) return hit;
  const { a, b } = allCombos();
  const hs = new Float32Array(TOTAL_COMBOS).fill(-1);
  const draws = new Uint8Array(TOTAL_COMBOS);
  const scores = new Float64Array(TOTAL_COMBOS);
  const live: number[] = [];
  const hand: number[] = [...board, 0, 0];
  const n = board.length;
  for (let i = 0; i < TOTAL_COMBOS; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (board.includes(x) || board.includes(y)) continue;
    hand[n] = x;
    hand[n + 1] = y;
    scores[i] = quickScore(hand);
    draws[i] = drawFlags(x, y, board);
    live.push(i);
  }
  live.sort((p, q) => scores[p]! - scores[q]!);
  // Ties share the middle of their run.
  const total = live.length;
  for (let i = 0; i < total; ) {
    let j = i;
    while (j + 1 < total && scores[live[j + 1]!] === scores[live[i]!]) j++;
    const v = total > 1 ? (i + j) / 2 / (total - 1) : 0.5;
    for (let k = i; k <= j; k++) hs[live[k]!] = v;
    i = j + 1;
  }
  const boardCategory = board.length >= 3 ? Math.floor(quickScore(board) / CATEGORY) : 0;
  const table = { hs, draws, boardCategory, scores };
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, table);
  return table;
}

/**
 * On the river: whether no combination left (none holding a card of the board or of `x`, `y`) beats the combination
 * `ci` = (`x`, `y`). Such a hand can at worst split the pot — a board that plays a royal flush reads as a share of a
 * half all the same.
 */
export function unbeaten(table: StrengthTable, ci: number, x: number, y: number): boolean {
  const { a, b } = allCombos();
  const mine = table.scores[ci]!;
  for (let i = 0; i < TOTAL_COMBOS; i++) {
    if (table.hs[i]! < 0 || table.scores[i]! <= mine) continue;
    if (a[i] === x || a[i] === y || b[i] === x || b[i] === y) continue;
    return false;
  }
  return true;
}

/** Strength classes the bots reason with: 0 air, 1 weak made hand, 2 draw, 3 medium, 4 strong. */
export const AIR = 0;
export const WEAK = 1;
export const DRAW = 2;
export const MEDIUM = 3;
export const STRONG = 4;
export type Bucket = 0 | 1 | 2 | 3 | 4;

/** The bucket of a combination from its strength and draws; strong draws count as draws unless the hand is already good. */
export function bucketOf(hs: number, draws: number): Bucket {
  if (hs >= 0.85) return STRONG;
  if (hs >= 0.62) return isStrongDraw(draws) ? DRAW : MEDIUM;
  if (isStrongDraw(draws)) return DRAW;
  return hs >= 0.38 ? WEAK : AIR;
}

/** How wet a board is, 0 (dry: rainbow, unconnected) … 1 (monotone or very connected). */
export function wetness(board: readonly number[]): number {
  const flop = board.slice(0, Math.max(3, board.length));
  const suits = [0, 0, 0, 0];
  let mask = 0;
  for (const x of flop) {
    suits[x & 3]!++;
    mask |= 1 << (x >> 2);
  }
  const maxSuit = Math.max(...suits);
  let w = maxSuit >= 3 ? 0.6 : maxSuit === 2 ? 0.25 : 0;
  // Ranks that would leave a straight possible: count two-card windows of five that hold three board cards.
  const m = mask & (1 << 14) ? mask | 2 : mask;
  let windows = 0;
  for (let lo = 1; lo <= 10; lo++) {
    let c = 0;
    for (let k = 0; k < 5; k++) if (m & (1 << (lo + k))) c++;
    if (c >= 3) windows++;
  }
  w += Math.min(0.4, windows * 0.13);
  const ranks = new Set(flop.map((x) => x >> 2));
  if (ranks.size < flop.length) w -= 0.1;
  return Math.max(0, Math.min(1, w));
}
