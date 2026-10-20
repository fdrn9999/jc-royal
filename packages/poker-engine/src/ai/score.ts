/**
 * Cards as small numbers and a fast 5–7 card score, for the bots' simulations (thousands of deals a decision). A card
 * code is rank × 4 + suit: rank 2–14 (the ace is 14), suit c 0, d 1, h 2, s 3.
 */
import type { Card } from '@jc/types';
import { rankValue } from '../evaluate';

const SUIT_INDEX: Record<string, number> = { c: 0, d: 1, h: 2, s: 3 };
/** A card as rank × 4 + suit, for `quickScore`. */
export const cardCode = (card: Card) => rankValue(card) * 4 + SUIT_INDEX[card[1]!]!;

/** Every card code of a 52-card deck. */
export const DECK_CODES: readonly number[] = Array.from({ length: 52 }, (_, i) => (2 + (i >> 2)) * 4 + (i & 3));

/** Top card of the highest five-card run in a rank bit mask (bit r = rank r, the ace also plays as 1), or 0. */
export function straightTop(mask: number): number {
  const m = mask & (1 << 14) ? mask | 2 : mask;
  for (let hi = 14; hi >= 5; hi--) if (((m >> (hi - 4)) & 31) === 31) return hi;
  return 0;
}

const counts = new Uint8Array(15);
const suitMask = new Uint16Array(4);
const suitCount = new Uint8Array(4);

/** Ranks present in `mask` from the highest down, skipping `skip`, at most `n`. */
function topRanks(mask: number, n: number, skip1 = 0, skip2 = 0): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (mask & (1 << r) && r !== skip1 && r !== skip2) out.push(r);
  return out;
}

const packScore = (cat: number, ranks: readonly number[]) => {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ranks[i] ?? 0);
  return v;
};

/** What `quickScore` multiplies the hand category by: category = Math.floor(score / CATEGORY). */
export const CATEGORY = 16 ** 5;

/**
 * One number ordering 5–7 card hands exactly as `evaluateBest` does (higher wins, equal ties): the same categories and
 * tie-break ranks, packed in base 16. Far cheaper than trying every five-card subset, which the bots do thousands of
 * times a decision. A property test compares the two. With fewer than five cards it still ranks pairs, two pairs,
 * trips and quads (no straight or flush can exist).
 */
export function quickScore(codes: readonly number[]): number {
  counts.fill(0);
  suitMask.fill(0);
  suitCount.fill(0);
  let mask = 0;
  for (const x of codes) {
    const r = x >> 2;
    const s = x & 3;
    counts[r]!++;
    suitMask[s]! |= 1 << r;
    suitCount[s]!++;
    mask |= 1 << r;
  }
  let flush = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s]! >= 5) flush = s;
  if (flush >= 0) {
    const sf = straightTop(suitMask[flush]!);
    if (sf) return packScore(8, [sf]);
  }
  let quad = 0;
  let trips1 = 0;
  let trips2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = counts[r]!;
    if (n === 4) quad = r;
    else if (n === 3) {
      if (!trips1) trips1 = r;
      else if (!trips2) trips2 = r;
    } else if (n === 2) {
      if (!pair1) pair1 = r;
      else if (!pair2) pair2 = r;
    }
  }
  if (quad) return packScore(7, [quad, ...topRanks(mask, 1, quad)]);
  if (trips1 && (trips2 || pair1)) return packScore(6, [trips1, Math.max(trips2, pair1)]);
  if (flush >= 0) return packScore(5, topRanks(suitMask[flush]!, 5));
  const st = straightTop(mask);
  if (st) return packScore(4, [st]);
  if (trips1) return packScore(3, [trips1, ...topRanks(mask, 2, trips1)]);
  if (pair1 && pair2) return packScore(2, [pair1, pair2, ...topRanks(mask, 1, pair1, pair2)]);
  if (pair1) return packScore(1, [pair1, ...topRanks(mask, 3, pair1)]);
  return packScore(0, topRanks(mask, 5));
}
