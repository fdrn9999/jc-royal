/**
 * The 169 starting-hand classes (13 pairs, 78 suited, 78 offsuit) and their 1,326 two-card combinations.
 *
 * A class id is row × 13 + col on the usual grid, where rank index 0 is the ace and 12 the deuce: a pair sits on the
 * diagonal, a suited hand above it (row = the higher rank) and an offsuit hand below it (col = the higher rank). So
 * AA is 0, AKs is 1, AKo is 13 and 22 is 168.
 */
import type { Card } from '@jc/types';
import { cardCode } from './score';

export const NUM_CLASSES = 169;
export const TOTAL_COMBOS = 1326;
const RANKS = 'AKQJT98765432';

/** Rank index of a card code (ace 0 … deuce 12). */
const rankIndex = (code: number) => 14 - (code >> 2);

/** The class of two card codes. */
export function classOfCodes(a: number, b: number): number {
  const i = Math.min(rankIndex(a), rankIndex(b));
  const j = Math.max(rankIndex(a), rankIndex(b));
  if (i === j) return i * 14;
  return (a & 3) === (b & 3) ? i * 13 + j : j * 13 + i;
}

export const classOf = (hole: readonly Card[]) => classOfCodes(cardCode(hole[0]!), cardCode(hole[1]!));

export const isPair = (id: number) => Math.floor(id / 13) === id % 13;
export const isSuited = (id: number) => Math.floor(id / 13) < id % 13;

/** High and low rank (2–14) of a class. */
export function classRanks(id: number): [number, number] {
  const row = Math.floor(id / 13);
  const col = id % 13;
  return [14 - Math.min(row, col), 14 - Math.max(row, col)];
}

/** 'AA', 'AKs', 'AKo'. */
export function className(id: number): string {
  const row = Math.floor(id / 13);
  const col = id % 13;
  if (row === col) return RANKS[row]! + RANKS[row]!;
  return row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`;
}

/** The class id of a name such as 'AKs', 'T9o' or '77'. */
export function classId(name: string): number {
  const i = RANKS.indexOf(name[0]!);
  const j = RANKS.indexOf(name[1]!);
  if (i < 0 || j < 0) throw new Error(`not a hand class: ${name}`);
  if (i === j) return i * 14;
  const hi = Math.min(i, j);
  const lo = Math.max(i, j);
  if (name[2] === 's') return hi * 13 + lo;
  if (name[2] === 'o') return lo * 13 + hi;
  throw new Error(`not a hand class: ${name}`);
}

export const classCombos = (id: number) => (isPair(id) ? 6 : isSuited(id) ? 4 : 12);

/** All 1,326 two-card combinations: card codes `a` (the higher rank) and `b`, and the class of each. Built on first use. */
export interface ComboList {
  a: Uint8Array;
  b: Uint8Array;
  cls: Uint8Array;
}
let all: ComboList | null = null;
export function allCombos(): ComboList {
  if (all) return all;
  const a = new Uint8Array(TOTAL_COMBOS);
  const b = new Uint8Array(TOTAL_COMBOS);
  const cls = new Uint8Array(TOTAL_COMBOS);
  let n = 0;
  comboCodes().forEach((list, id) => {
    for (let i = 0; i < list.length; i += 2) {
      a[n] = list[i]!;
      b[n] = list[i + 1]!;
      cls[n] = id;
      n++;
    }
  });
  all = { a, b, cls };
  return all;
}

/** Combinations of every class as card code pairs [a0, b0, a1, b1, …], built on first use. */
let combos: Int8Array[] | null = null;
export function comboCodes(): Int8Array[] {
  if (combos) return combos;
  const out: Int8Array[] = [];
  for (let id = 0; id < NUM_CLASSES; id++) {
    const [hi, lo] = classRanks(id);
    const list: number[] = [];
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) {
        if (isPair(id) ? s2 <= s1 : isSuited(id) ? s1 !== s2 : s1 === s2) continue;
        list.push(hi * 4 + s1, lo * 4 + s2);
      }
    out.push(Int8Array.from(list));
  }
  combos = out;
  return out;
}
