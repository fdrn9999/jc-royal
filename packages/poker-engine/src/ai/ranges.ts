/**
 * Ranges: a weight from 0 to 1 for each of the 169 starting-hand classes (the share of that class's combinations in the
 * range). Default ranges are the best X% of all 1,326 combinations in `PLAY_ORDER`; the class at the edge is taken in
 * part, so a range grows smoothly with X.
 *
 * `PLAY_ORDER` blends each class's equity against one random hand with its equity against three (equity-table.ts) and
 * adds a little for pairs, suited hands and connectors, which make strong hands more often after the flop than their
 * all-in equity shows. These are heuristic ranges written for the table bots, not solver output.
 */
import { classCombos, classRanks, isPair, isSuited, NUM_CLASSES, TOTAL_COMBOS } from './classes';
import { EQUITY_VS_ONE, EQUITY_VS_THREE } from './equity-table';

export type Range = Float64Array;

function score(id: number): number {
  const [hi, lo] = classRanks(id);
  const gap = hi - lo - 1;
  let s = 0.4 * (EQUITY_VS_ONE[id]! / 5000) + 0.6 * (EQUITY_VS_THREE[id]! / 2500);
  if (isPair(id)) s += 0.12;
  else if (gap <= 2) s += 0.06 * (gap === 0 ? 1 : gap === 1 ? 0.6 : 0.3);
  if (isSuited(id)) s += 0.04;
  return s;
}

/** Class ids from the best to the worst. */
export const PLAY_ORDER: readonly number[] = Array.from({ length: NUM_CLASSES }, (_, i) => i).sort((a, b) => score(b) - score(a) || a - b);

/** Share of all combinations ranked above each class, and including it: a class fills (start, end] of the order. */
const START = new Float64Array(NUM_CLASSES);
const END = new Float64Array(NUM_CLASSES);
{
  let acc = 0;
  for (const id of PLAY_ORDER) {
    START[id] = acc / TOTAL_COMBOS;
    acc += classCombos(id);
    END[id] = acc / TOTAL_COMBOS;
  }
}

/** Where a class sits in the order: the share of combinations ranked above it plus half its own (0 best … 1 worst). */
export const percentile = (id: number) => (START[id]! + END[id]!) / 2;

/** How much of a class the best `fraction` of all combinations takes (0 … 1). */
export function weightInTop(id: number, fraction: number): number {
  if (fraction <= START[id]!) return 0;
  if (fraction >= END[id]!) return 1;
  return (fraction - START[id]!) / (END[id]! - START[id]!);
}

/** The best `fraction` (0 … 1) of all starting hands. */
export function topRange(fraction: number): Range {
  const r = new Float64Array(NUM_CLASSES);
  const f = Math.max(0, Math.min(1, fraction));
  for (let id = 0; id < NUM_CLASSES; id++) r[id] = weightInTop(id, f);
  return r;
}

/** Hands between the best `from` and the best `to` (for example a calling range below a raising range). */
export function bandRange(from: number, to: number, keepTop = 0): Range {
  const r = topRange(to);
  for (let id = 0; id < NUM_CLASSES; id++) r[id] = Math.max(0, r[id]! - weightInTop(id, from) * (1 - keepTop));
  return r;
}

/** Combinations a range holds (weighted). */
export function rangeCombos(r: Range): number {
  let n = 0;
  for (let id = 0; id < NUM_CLASSES; id++) n += r[id]! * classCombos(id);
  return n;
}

export const rangeShare = (r: Range) => rangeCombos(r) / TOTAL_COMBOS;

/** A range plus another, each class capped at 1. */
export function addRange(a: Range, b: Range, bWeight = 1): Range {
  const r = new Float64Array(NUM_CLASSES);
  for (let id = 0; id < NUM_CLASSES; id++) r[id] = Math.min(1, a[id]! + b[id]! * bWeight);
  return r;
}

export const FULL_RANGE: Range = topRange(1);
