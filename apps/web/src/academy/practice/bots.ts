/**
 * Rule-based practice opponents for the free practice table. Deliberately
 * simple (no solver, no equity): a preflop hand score and the made-hand class
 * after the flop, with a "tight" and a "loose" temperament. They only choose
 * among the legal options the engine offers, so they can never break a rule.
 */
import { evaluateKnown, rankValue } from '@jc/poker-engine/evaluate';
import type { ActionType, Card, LegalOption } from '@jc/types';

export type BotStyle = 'tight' | 'loose';

/** Rough preflop strength 0–30 (pairs, high cards, suited, connected). */
export function preflopScore(hole: readonly Card[]): number {
  const [a, b] = [rankValue(hole[0]!), rankValue(hole[1]!)].sort((x, y) => y - x) as [number, number];
  let s = a + b / 2;
  if (a === b) s = Math.max(16, a * 2 + 2);
  if (hole[0]![1] === hole[1]![1]) s += 2;
  if (a !== b && a - b === 1) s += 1;
  return s;
}

export interface BotContext {
  hole: Card[];
  board: Card[];
  legal: LegalOption[];
  pot: number;
  bigBlind: number;
  /** 0..1 random draw (injected for tests). */
  rand: number;
}

const has = (legal: LegalOption[], t: ActionType) => legal.find((o) => o.type === t);

function sized(legal: LegalOption[], target: number): { type: ActionType; amount?: number } | null {
  const w = (has(legal, 'raise') ?? has(legal, 'bet')) as Extract<LegalOption, { min: number; max: number }> | undefined;
  if (!w) return null;
  return { type: w.type, amount: Math.min(w.max, Math.max(w.min, Math.round(target))) };
}

export function decideBot(style: BotStyle, c: BotContext): { type: ActionType; amount?: number } {
  const check = has(c.legal, 'check');
  const call = has(c.legal, 'call') as Extract<LegalOption, { type: 'call' }> | undefined;
  const toCall = call?.amount ?? 0;
  const passive = () => (check ? { type: 'check' as const } : { type: 'fold' as const });
  const tight = style === 'tight';

  if (c.board.length === 0) {
    const s = preflopScore(c.hole);
    const raiseAt = tight ? 22 : 18;
    const playAt = tight ? 15 : 10;
    if (s >= raiseAt && c.rand < 0.8) return sized(c.legal, Math.max(c.bigBlind * 3, toCall * 3)) ?? (call ? { type: 'call' } : passive());
    if (s >= playAt || (!tight && toCall <= c.bigBlind * 2)) return call ? (toCall <= c.bigBlind * (tight ? 4 : 8) ? { type: 'call' } : passive()) : passive();
    return passive();
  }

  const made = evaluateKnown([...c.hole, ...c.board])!;
  const cls = ['high-card', 'pair', 'two-pair', 'three-of-a-kind', 'straight', 'flush', 'full-house', 'four-of-a-kind', 'straight-flush'].indexOf(made.rankClass);
  const bluff = c.rand < (tight ? 0.08 : 0.22);
  if (cls >= 2 || (cls === 1 && !tight && c.rand < 0.5)) {
    const bet = sized(c.legal, (call ? toCall : 0) + c.pot * (cls >= 4 ? 0.8 : 0.6));
    if (bet && (check || c.rand < 0.6)) return bet;
    if (call) return { type: 'call' };
    return passive();
  }
  if (cls === 1) {
    if (call) return toCall <= c.pot * (tight ? 0.5 : 0.9) ? { type: 'call' } : { type: 'fold' };
    return check && bluff ? (sized(c.legal, c.pot * 0.5) ?? passive()) : passive();
  }
  if (check) return bluff ? (sized(c.legal, c.pot * 0.5) ?? passive()) : passive();
  return call && !tight && toCall <= c.pot * 0.25 ? { type: 'call' } : { type: 'fold' };
}
