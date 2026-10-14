/**
 * Quiz model. Questions carry their own judging rule so answers are decided by
 * card data (rank/suit parsing, the hand evaluator or a real engine showdown),
 * never by comparing display strings.
 */
import { evaluateBest, judgeShowdown, rankValue } from '@jc/poker-engine';
import { handLabelKey, type Card, type HandLabelKey } from '@jc/types';
import type { L } from './content';
import type { Topic } from './progress';

export interface PickQuestion {
  kind: 'pick';
  topic: Topic;
  /** Id reported to the anonymous statistics (generated questions report their topic). */
  statId?: string;
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
  topic: Topic;
  /** Id reported to the anonymous statistics (generated questions report their topic). */
  statId?: string;
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
  topic: Topic;
  /** Id reported to the anonymous statistics (generated questions report their topic). */
  statId?: string;
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
  topic: Topic;
  /** Id reported to the anonymous statistics (generated questions report their topic). */
  statId?: string;
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

const ROLE: Record<string, (i: number) => L> = {
  pair: (i) => (i === 1 ? { ko: '페어 숫자', en: 'pair' } : { ko: `${i - 1}번째 킥커`, en: `kicker #${i - 1}` }),
  'two-pair': (i) => (i === 1 ? { ko: '높은 페어', en: 'top pair' } : i === 2 ? { ko: '낮은 페어', en: 'second pair' } : { ko: '킥커', en: 'kicker' }),
  'three-of-a-kind': (i) => (i === 1 ? { ko: '트리플 숫자', en: 'three of a kind' } : { ko: `${i - 1}번째 킥커`, en: `kicker #${i - 1}` }),
  'full-house': (i) => (i === 1 ? { ko: '트리플 숫자', en: 'three of a kind' } : { ko: '페어 숫자', en: 'pair' }),
  'four-of-a-kind': (i) => (i === 1 ? { ko: '포카드 숫자', en: 'four of a kind' } : { ko: '킥커', en: 'kicker' }),
  straight: () => ({ ko: '가장 높은 카드', en: 'top card' }),
  'straight-flush': () => ({ ko: '가장 높은 카드', en: 'top card' }),
  flush: (i) => ({ ko: `${i}번째로 높은 카드`, en: `card #${i}` }),
  'high-card': (i) => ({ ko: `${i}번째로 높은 카드`, en: `card #${i}` }),
};
const RANK_NAME = (v: number) => (v === 14 ? 'A' : v === 13 ? 'K' : v === 12 ? 'Q' : v === 11 ? 'J' : String(v));
const CLASS_KO: Record<string, string> = { 'high-card': '하이카드', pair: '원페어', 'two-pair': '투페어', 'three-of-a-kind': '트리플', straight: '스트레이트', flush: '플러시', 'full-house': '풀하우스', 'four-of-a-kind': '포카드', 'straight-flush': '스트레이트 플러시' };
const CLASS_EN: Record<string, string> = { 'high-card': 'high card', pair: 'one pair', 'two-pair': 'two pair', 'three-of-a-kind': 'three of a kind', straight: 'a straight', flush: 'a flush', 'full-house': 'a full house', 'four-of-a-kind': 'four of a kind', 'straight-flush': 'a straight flush' };

export interface CompareExplanation {
  text: L;
  /** Cards that decided it (same-class comparisons), per hand. */
  decide: { a: Card[]; b: Card[] };
}

/**
 * Why one hand beats the other, derived from the evaluator scores (which the
 * unit tests tie to the engine): a different hand class, or the first rank
 * that differs inside the same class (pair, kicker, top card …), or a tie.
 */
export function explainCompare(q: CompareQuestion, answer: CompareAnswer): CompareExplanation {
  const ea = evaluateBest([...q.a, ...q.board])!;
  const eb = evaluateBest([...q.b, ...q.board])!;
  const name = (rc: string) => ({ ko: CLASS_KO[rc]!, en: CLASS_EN[rc]! });
  if (answer === 'split') {
    return {
      text: { ko: `두 사람 모두 ${CLASS_KO[ea.rankClass]}이고, 다섯 장의 숫자가 완전히 같습니다. 문양은 비교하지 않으므로 무승부(스플릿)입니다.`, en: `Both have ${CLASS_EN[ea.rankClass]} with exactly the same five ranks. Suits never break ties, so it is a split.` },
      decide: { a: [], b: [] },
    };
  }
  const winner = answer === 'a' ? 'A' : 'B';
  if (ea.rankClass !== eb.rankClass) {
    const [w, l] = answer === 'a' ? [ea, eb] : [eb, ea];
    return {
      text: { ko: `${winner}는 ${CLASS_KO[w.rankClass]}, 상대는 ${CLASS_KO[l.rankClass]}입니다. ${name(w.rankClass).ko}가 ${name(l.rankClass).ko}보다 높은 족보입니다.`, en: `${winner} has ${CLASS_EN[w.rankClass]} against ${CLASS_EN[l.rankClass]}; ${name(w.rankClass).en} ranks higher.` },
      decide: { a: [], b: [] },
    };
  }
  const i = ea.score.findIndex((v, k) => v !== eb.score[k]);
  const role = ROLE[ea.rankClass]!(i);
  const va = ea.score[i]!;
  const vb = eb.score[i]!;
  const pick = (best: Card[], v: number) => best.filter((c) => rankValue(c) === v);
  return {
    text: {
      ko: `두 사람 모두 ${CLASS_KO[ea.rankClass]}입니다. 같은 족보에서는 ${role.ko}를 비교합니다: A ${RANK_NAME(va)} vs B ${RANK_NAME(vb)}. 더 높은 ${winner}가 이깁니다.`,
      en: `Both have ${CLASS_EN[ea.rankClass]}. Within the same hand the ${role.en} decides: A ${RANK_NAME(va)} vs B ${RANK_NAME(vb)}, so ${winner} wins.`,
    },
    decide: { a: pick(ea.bestFive, va), b: pick(eb.bestFive, vb) },
  };
}
