/**
 * What a showdown's scene (staging.ts `cine`, drawn by TableScene) lights up. Pure, and read only from what the server
 * already sent everybody: the hands its showdown turned over (`result.showdown`, never a hand a loser kept face down)
 * and who won each pot. Nothing here asks for, or shows, a card the server did not.
 */
import type { HandView } from '@jc/types';
import type { CinePhase } from './staging';

type Result = NonNullable<HandView['result']>;

/** The seats whose hands the showdown turned over for everybody. */
export function showdownSeats(result: Result | null | undefined): ReadonlySet<number> {
  return new Set((result?.showdown ?? []).map((x) => x.seatIndex));
}

/**
 * The cards of every winner's best five: each pot's winners (the main pot's and every side pot's, both halves of a
 * split), not one of them only. A winner whose hand was not shown (none at a showdown) adds nothing.
 */
export function winningCards(result: Result | null | undefined, winners: Iterable<number>): string[] {
  const five = new Map((result?.showdown ?? []).map((x) => [x.seatIndex, x.bestFive]));
  const out = new Set<string>();
  for (const seat of winners) for (const c of five.get(seat) ?? []) out.add(c);
  return [...out];
}

/**
 * How a seat stands in the scene: 'out' is grey (everybody while the table dims and the title shows; from then on
 * whoever is not in the showdown), 'in' keeps its cards in colour. Null: no scene, or its colour is coming back.
 */
export function seatSpot(phase: CinePhase | null, inShowdown: boolean): 'in' | 'out' | null {
  if (!phase || phase === 'restore') return null;
  return inShowdown && phase !== 'dimming' && phase !== 'title' ? 'in' : 'out';
}
