/**
 * Quiz model. Questions carry their own judging rule so answers are decided by
 * card data (rank/suit parsing, the hand evaluator or a real engine showdown),
 * never by comparing display strings.
 */
import { evaluateBest, judgeShowdown, rankValue } from '@jc/poker-engine';
import { handLabelKey, type Card, type HandLabelKey } from '@jc/types';
import type { L } from './content';

export interface PickQuestion {
  kind: 'pick';
  id: string;
  prompt: L;
  cards: Card[];
  isCorrect: (c: Card) => boolean;
  /** Why a wrong pick is wrong (shown before retrying). */
  why: (c: Card) => L;
  explain: L;
}

export interface ChoiceQuestion {
  kind: 'choice';
  id: string;
  prompt: L;
  cards?: Card[];
  options: { id: string; label: L }[];
  answer: string;
  why: L;
  explain: L;
}

export interface SortQuestion {
  kind: 'sort';
  id: string;
  prompt: L;
  /** Items (a single card, or a 5-card hand) in the shuffled display order. */
  items: Card[][];
  /** Strength of an item; the answer is strongest first (equal items may go either way). */
  strength: (item: Card[]) => number;
  explain: L;
}

/** Two holdem hands on one board; the engine decides the winner. */
export interface CompareQuestion {
  kind: 'compare';
  id: string;
  prompt: L;
  board: Card[];
  a: Card[];
  b: Card[];
  explain: L;
}

export type Question = PickQuestion | ChoiceQuestion | SortQuestion | CompareQuestion;

export const rankOf = (c: Card) => rankValue(c);
export const suitOf = (c: Card) => c[1] as 's' | 'h' | 'd' | 'c';

export function judgePick(q: PickQuestion, c: Card): boolean {
  return q.cards.includes(c) && q.isCorrect(c);
}

export function judgeChoice(q: ChoiceQuestion, id: string): boolean {
  return id === q.answer;
}

/** `order` holds item indexes; correct when each item is at least as strong as the next. */
export function judgeSort(q: SortQuestion, order: readonly number[]): boolean {
  if (order.length !== q.items.length || new Set(order).size !== order.length || order.some((i) => !q.items[i])) return false;
  for (let k = 1; k < order.length; k++) if (q.strength(q.items[order[k - 1]!]!) < q.strength(q.items[order[k]!]!)) return false;
  return true;
}

/** Single number for an evaluator score (category, then tie-break ranks). */
export function scoreNumber(score: readonly number[]): number {
  return score.reduce((acc, v, i) => acc + v * 15 ** (6 - i), 0);
}

export const handStrength = (cards: Card[]) => (cards.length === 1 ? rankValue(cards[0]!) : scoreNumber(evaluateBest(cards)!.score));

export type CompareAnswer = 'a' | 'b' | 'split';

export interface CompareResult {
  answer: CompareAnswer;
  a: { label: HandLabelKey; bestFive: Card[] };
  b: { label: HandLabelKey; bestFive: Card[] };
}

/** Runs the spot through HandEngine (seat 0 = A, seat 1 = B) and reads the payouts. */
export async function judgeCompare(q: CompareQuestion): Promise<CompareResult> {
  const out = await judgeShowdown([q.a, q.b], q.board);
  const answer: CompareAnswer = out.winners.length > 1 ? 'split' : out.winners[0] === 0 ? 'a' : 'b';
  const pick = (seat: number) => {
    const h = out.hands.find((x) => x.seatIndex === seat);
    if (h) return { label: h.label, bestFive: h.bestFive };
    const ev = evaluateBest([...(seat === 0 ? q.a : q.b), ...q.board])!;
    return { label: handLabelKey(ev.rankClass, ev.bestFive), bestFive: ev.bestFive };
  };
  return { answer, a: pick(0), b: pick(1) };
}

/** Rank class of five cards, for "name this hand" questions. */
export function handLabelOf(cards: readonly Card[]): HandLabelKey {
  const ev = evaluateBest(cards)!;
  return handLabelKey(ev.rankClass, ev.bestFive);
}
