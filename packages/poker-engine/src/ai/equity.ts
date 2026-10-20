/**
 * Equity against ranges, by Monte Carlo. Each opponent is a weight for every one of the 1,326 combinations (zero for
 * combinations holding a card the bot can see); a deal draws one combination per opponent in proportion to those
 * weights, skips combinations that clash with cards already dealt, completes the board with random unseen cards and
 * scores everybody. The cards come from the bot's own random numbers, never from the real deck.
 */
import { allCombos, NUM_CLASSES, TOTAL_COMBOS } from './classes';
import type { Range } from './ranges';
import { quickScore } from './score';

/** Weights over all combinations for a range of classes, zero where a card of the combination is in `dead`. */
export function comboWeights(range: Range, dead: readonly number[]): Float64Array {
  const { a, b, cls } = allCombos();
  const w = new Float64Array(TOTAL_COMBOS);
  for (let i = 0; i < TOTAL_COMBOS; i++) {
    if (dead.includes(a[i]!) || dead.includes(b[i]!)) continue;
    w[i] = range[cls[i]!]!;
  }
  return w;
}

/** Class weights back from combination weights (the share of each class's live combinations kept). */
export function classWeights(w: Float64Array): Range {
  const { cls } = allCombos();
  const sum = new Float64Array(NUM_CLASSES);
  const n = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < TOTAL_COMBOS; i++) {
    const k = cls[i]!;
    sum[k] = sum[k]! + w[i]!;
    n[k] = n[k]! + 1;
  }
  const r = new Float64Array(NUM_CLASSES);
  for (let id = 0; id < NUM_CLASSES; id++) r[id] = n[id] ? sum[id]! / n[id]! : 0;
  return r;
}

const stamp = new Int32Array(64);
let tick = 0;

function cumulative(w: Float64Array): Float64Array {
  const c = new Float64Array(TOTAL_COMBOS);
  let acc = 0;
  for (let i = 0; i < TOTAL_COMBOS; i++) {
    acc += w[i]!;
    c[i] = acc;
  }
  return c;
}

function pick(cum: Float64Array, u: number): number {
  const target = u * cum[TOTAL_COMBOS - 1]!;
  let lo = 0;
  let hi = TOTAL_COMBOS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Share of the pot `hole` wins against one hand from each of `opponents` (combination weights) with `board` completed
 * at random, over `iterations` deals. Opponents whose weights are all zero are left out; with none left, 1.
 */
export function equityVsRanges(hole: readonly number[], board: readonly number[], opponents: readonly Float64Array[], iterations: number, rand: () => number): number {
  const { a, b } = allCombos();
  const cums = opponents.map(cumulative).filter((c) => c[TOTAL_COMBOS - 1]! > 0);
  if (!cums.length) return 1;
  const missing = 5 - board.length;
  const mine: number[] = [...hole, ...board];
  const theirs: number[] = [0, 0, ...board];
  const runout: number[] = [];
  const their: number[] = [];
  let won = 0;
  let dealt = 0;
  for (let it = 0; it < iterations; it++) {
    tick++;
    if (tick > 2_000_000_000) {
      stamp.fill(0);
      tick = 1;
    }
    for (const x of hole) stamp[x] = tick;
    for (const x of board) stamp[x] = tick;
    their.length = 0;
    let ok = true;
    for (const cum of cums) {
      let got = -1;
      for (let tries = 0; tries < 12 && got < 0; tries++) {
        const i = pick(cum, rand());
        if (stamp[a[i]!] !== tick && stamp[b[i]!] !== tick) got = i;
      }
      if (got < 0) {
        ok = false;
        break;
      }
      stamp[a[got]!] = tick;
      stamp[b[got]!] = tick;
      their.push(got);
    }
    if (!ok) continue;
    runout.length = 0;
    while (runout.length < missing) {
      const x = (2 + Math.floor(rand() * 13)) * 4 + Math.floor(rand() * 4);
      if (stamp[x] === tick) continue;
      stamp[x] = tick;
      runout.push(x);
    }
    mine.length = hole.length + board.length;
    for (const x of runout) mine.push(x);
    const my = quickScore(mine);
    let ties = 0;
    let lost = false;
    theirs.length = 2 + board.length;
    for (const x of runout) theirs.push(x);
    for (let o = 0; o < their.length && !lost; o++) {
      theirs[0] = a[their[o]!]!;
      theirs[1] = b[their[o]!]!;
      const s = quickScore(theirs);
      if (s > my) lost = true;
      else if (s === my) ties++;
    }
    dealt++;
    if (!lost) won += 1 / (ties + 1);
  }
  return dealt ? won / dealt : 0.5;
}
