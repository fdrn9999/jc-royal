import type { HandStage, PreActionKind, TableView } from '@jc/types';

/** Streets a pre-action can be chosen on. */
export type BettingStage = Exclude<HandStage, 'showdown' | 'settled'>;

/** Where the viewer could choose a pre-action now: the hand, street and amount to call the room checks it against. */
export interface PreActionSpot {
  handId: string;
  stage: BettingStage;
  toCall: number;
  choices: PreActionKind[];
}

/**
 * The pre-actions to offer while someone else is to act: Check/Fold and Check when nothing is to call, Fold against a
 * bet. None on the viewer's own turn, once they folded or are all in, between streets, or for a spectator. Calls,
 * raises and all-ins are never offered in advance.
 */
export function preActionSpot(s: TableView): PreActionSpot | null {
  const h = s.hand;
  const mine = s.seats.find((x) => x.seatIndex === s.you.seatIndex);
  if (!h || !mine || s.you.seatIndex === null || mine.state !== 'active') return null;
  if (h.stage === 'showdown' || h.stage === 'settled' || h.actorSeat === null || h.actorSeat === s.you.seatIndex) return null;
  const toCall = Math.max(0, ...s.seats.map((x) => x.streetBet)) - mine.streetBet;
  return { handId: h.id, stage: h.stage, toCall, choices: toCall > 0 ? ['fold'] : ['checkFold', 'check'] };
}
