/**
 * Best-five hand evaluator for 5–7 known cards.
 *
 * poker-engine-ts only evaluates at showdown (its evaluator is not exported),
 * but beginners need "what do I have right now?" on the flop and turn. This
 * evaluator uses the engine's rank-class names and tie-break order; a property
 * test (test/evaluate.test.ts) runs random spots through HandEngine showdowns
 * and requires identical rank classes and winners. It never decides real pots.
 */
import type { Card, HandRankClass } from '@jc/types';

const RANK_VALUE: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const CLASSES: HandRankClass[] = ['high-card', 'pair', 'two-pair', 'three-of-a-kind', 'straight', 'flush', 'full-house', 'four-of-a-kind', 'straight-flush'];

export function rankValue(card: Card | string): number {
  const v = RANK_VALUE[card[0]!];
  if (!v) throw new Error(`bad card ${card}`);
  return v;
}

export interface Evaluation {
  rankClass: HandRankClass;
  /** [category, ...tie-break ranks]; compare lexicographically. */
  score: number[];
  /** The five cards that make the hand, the defining group first. */
  bestFive: Card[];
}

/** Highest straight top card among the distinct values (A plays low in A-2-3-4-5), or 0. */
function straightHigh(values: number[]): number {
  const set = new Set(values);
  if (set.has(14)) set.add(1);
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) if (!set.has(hi - k)) ok = false;
    if (ok) return hi;
  }
  return 0;
}

function evaluateFive(cards: Card[]): Evaluation {
  const vals = cards.map(rankValue);
  const flush = cards.every((c) => c[1] === cards[0]![1]);
  const sHigh = straightHigh(vals);
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Groups ordered by size, then rank: e.g. full house [[K,3],[7,2]].
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = (order: number[]) => {
    const rest = [...cards];
    const out: Card[] = [];
    for (const v of order) {
      const i = rest.findIndex((c) => rankValue(c) === v);
      out.push(rest.splice(i, 1)[0]!);
    }
    return out;
  };
  const groupOrder = groups.flatMap(([v, n]) => Array<number>(n).fill(v));
  if (sHigh && flush) {
    const order = sHigh === 5 ? [5, 4, 3, 2, 14] : [sHigh, sHigh - 1, sHigh - 2, sHigh - 3, sHigh - 4];
    return { rankClass: 'straight-flush', score: [8, sHigh], bestFive: byGroup(order) };
  }
  const shape = groups.map((g) => g[1]).join('');
  if (shape === '41') return { rankClass: 'four-of-a-kind', score: [7, groups[0]![0], groups[1]![0]], bestFive: byGroup(groupOrder) };
  if (shape === '32') return { rankClass: 'full-house', score: [6, groups[0]![0], groups[1]![0]], bestFive: byGroup(groupOrder) };
  const desc = [...vals].sort((a, b) => b - a);
  if (flush) return { rankClass: 'flush', score: [5, ...desc], bestFive: byGroup(desc) };
  if (sHigh) {
    const order = sHigh === 5 ? [5, 4, 3, 2, 14] : [sHigh, sHigh - 1, sHigh - 2, sHigh - 3, sHigh - 4];
    return { rankClass: 'straight', score: [4, sHigh], bestFive: byGroup(order) };
  }
  const tb = groups.map((g) => g[0]);
  if (shape === '311') return { rankClass: 'three-of-a-kind', score: [3, ...tb], bestFive: byGroup(groupOrder) };
  if (shape === '221') return { rankClass: 'two-pair', score: [2, ...tb], bestFive: byGroup(groupOrder) };
  if (shape === '2111') return { rankClass: 'pair', score: [1, ...tb], bestFive: byGroup(groupOrder) };
  return { rankClass: 'high-card', score: [0, ...desc], bestFive: byGroup(desc) };
}

export function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Best five-card hand out of 5–7 distinct cards; null with fewer than five. */
export function evaluateBest(cards: readonly Card[]): Evaluation | null {
  if (new Set(cards).size !== cards.length) throw new Error('duplicate cards');
  if (cards.length < 5) return null;
  if (cards.length > 7) throw new Error('at most 7 cards');
  let best: Evaluation | null = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const ev = evaluateFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || compareScores(ev.score, best.score) > 0) best = ev;
          }
  return best;
}

/** Rank class index (0 = high card … 8 = straight flush). */
export function rankClassIndex(rankClass: HandRankClass): number {
  return CLASSES.indexOf(rankClass);
}

/**
 * What a holder has right now: two hole cards preflop (pocket pair or high
 * card), otherwise the best five of the known cards.
 */
export function evaluateKnown(cards: readonly Card[]): Evaluation | null {
  if (cards.length >= 5) return evaluateBest(cards);
  if (cards.length !== 2) return null;
  const [x, y] = [...cards].sort((a, b) => rankValue(b) - rankValue(a)) as [Card, Card];
  if (rankValue(x) === rankValue(y)) return { rankClass: 'pair', score: [1, rankValue(x)], bestFive: [x, y] };
  return { rankClass: 'high-card', score: [0, rankValue(x), rankValue(y)], bestFive: [x, y] };
}
