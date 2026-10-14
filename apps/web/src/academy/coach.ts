/**
 * First real hands coaching: one short tip on the player's turn, picked from
 * the legal options and the current made hand. Only facts about the viewer's
 * own spot (no odds, no reads on opponents). Engine-free (main bundle).
 */
import type { TableView } from '@jc/types';
import { currentHand } from './content';
import { isDone, LESSON_IDS, type Progress } from './progress';

/** Real hands that get coaching tips after finishing a lesson. */
export const COACH_HANDS = 5;

export function coachActive(p: Progress, seated: boolean): boolean {
  return seated && !p.coach.off && p.coach.hands < COACH_HANDS && LESSON_IDS.some((id) => isDone(p, id));
}

export type CoachTip =
  | { key: 'coach.preflop' }
  | { key: 'coach.check' }
  | { key: 'coach.call'; amount: number; pot: number }
  | { key: 'coach.strong'; rankClass: string }
  | { key: 'coach.weak' };

const STRONG = ['two-pair', 'three-of-a-kind', 'straight', 'flush', 'full-house', 'four-of-a-kind', 'straight-flush'];

export function coachTip(s: TableView): CoachTip | null {
  const hand = s.hand;
  if (!hand || s.you.legal.length === 0) return null;
  const mine = s.seats.find((x) => x.seatIndex === s.you.seatIndex);
  const ev = currentHand(mine?.holeCards, hand.board);
  if (ev && hand.board.length > 0 && STRONG.includes(ev.rankClass)) return { key: 'coach.strong', rankClass: ev.rankClass };
  const call = s.you.legal.find((o) => o.type === 'call');
  if (call && 'amount' in call) {
    if (hand.board.length > 0 && ev && ev.rankClass === 'high-card') return { key: 'coach.weak' };
    return { key: 'coach.call', amount: call.amount, pot: hand.potTotal };
  }
  if (s.you.legal.some((o) => o.type === 'check')) return hand.board.length === 0 ? { key: 'coach.preflop' } : { key: 'coach.check' };
  return hand.board.length === 0 ? { key: 'coach.preflop' } : null;
}
