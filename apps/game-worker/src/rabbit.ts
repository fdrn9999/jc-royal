/**
 * Rabbit hunting after the next deal (room.ts `rabbit`). A hand's rabbit hunt is read from the hand itself while it is
 * the one on the table. The room deals the next hand on its own clock, and a request sent in the last moment (or held
 * up on the way) arrives after that deal: the player pressed in time and would be told nothing. So the hand that goes
 * leaves its rabbit hunt behind for a short while, and such a request is still answered: the game waits for nobody.
 *
 * What is kept is what `HandEngine.rabbitHunt()` answered for that hand, read once from its own deck as it left: no new
 * shuffle, no card of the hand played now (which has a deck of its own), nobody's hole cards, no burn card. Nothing
 * reads it but the `rabbit` command, for the players that hand dealt in.
 */
import type { HandEngine } from '@jc/poker-engine';
import type { Card } from '@jc/types';

/** How long after the next deal the hand before it still answers a rabbit hunt. */
export const RABBIT_KEEP_MS = 20_000;

export interface KeptRabbit {
  handId: string;
  /** The cards that would have completed its board, in deck order. */
  cards: Card[];
  /** The players it dealt in, and the seat each was dealt at. */
  seats: Record<string, number>;
  /** Not answered from this time on. */
  until: number;
}

/** What the settled hand `h` leaves behind as the next is dealt at `now`; null where it has no rabbit hunt (a full board). */
export function keepRabbit(h: HandEngine, now: number): KeptRabbit | null {
  const cards = h.rabbitHunt();
  if (!cards) return null;
  const seats: Record<string, number> = {};
  for (const p of h.startingSeats) if (h.holeCardsOf(p.playerId)) seats[p.playerId] = p.seatIndex;
  return { handId: h.handId, cards, seats, until: now + RABBIT_KEEP_MS };
}

/** The kept rabbit hunt if it is hand `handId`'s and still answered at `now`. */
export function keptRabbitFor(kept: KeptRabbit | null | undefined, handId: string, now: number): KeptRabbit | null {
  return kept && kept.handId === handId && now < kept.until ? kept : null;
}
