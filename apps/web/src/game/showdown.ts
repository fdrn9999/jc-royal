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

type Shown = Result['showdown'][number];

/** How strong the winning hand is, for the banner's effect: only the three rarest get one of their own. */
export type WinTier = 'quads' | 'straight-flush' | 'royal' | null;
export function winTier(hand: Pick<Shown, 'rankClass' | 'bestFive'> | null | undefined): WinTier {
  if (!hand) return null;
  if (hand.rankClass === 'four-of-a-kind') return 'quads';
  if (hand.rankClass !== 'straight-flush') return null;
  return hand.bestFive.some((c) => c.startsWith('A')) && hand.bestFive.some((c) => c.startsWith('K')) ? 'royal' : 'straight-flush';
}

/**
 * The result as the winner's banner says it: who won what (`won`: the result's winners without chips handed back,
 * won.ts), the hand of the one who won most when the showdown turned it over, and whether a pot was shared.
 */
export interface WinBanner {
  winners: { seatIndex: number; amount: number }[];
  /** The first winner's hand as the server judged it (null: won by a fold, never shown). */
  hand: Shown | null;
  /** Two winners or more of one same pot. */
  split: boolean;
}
export function winBanner(result: Result | null | undefined, won: Result['winners']): WinBanner | null {
  if (!result || !won.length) return null;
  const winners = [...won].sort((a, b) => b.amount - a.amount || a.seatIndex - b.seatIndex);
  const pots = new Map<string, number>();
  for (const w of won) for (const id of w.potIds) pots.set(id, (pots.get(id) ?? 0) + 1);
  return {
    winners: winners.map((w) => ({ seatIndex: w.seatIndex, amount: w.amount })),
    hand: result.showdown.find((x) => x.seatIndex === winners[0]!.seatIndex) ?? null,
    split: [...pots.values()].some((n) => n > 1),
  };
}

/**
 * Why the hand ended as it did for the player at `seat`, said after the result. Only worded from the server's result:
 * the hand names and the winners are the server's (nothing is compared again here), and a hand the showdown did not
 * turn over (kept face down, or folded) is never named.
 *  - `lost`: my hand went to the showdown and won nothing. `mine`: my hand when it was turned over (null: kept face
 *    down). `sameRank`: the winner's hand has the same name as mine, so higher cards decided. The winner named is the
 *    main pot's (the pot every hand of the showdown played for, mine too), not a side pot's I had no part in, however
 *    large.
 *  - `folded`: I had folded; `hand` is the winner's when a showdown showed it (null: nobody saw it).
 *  - `split`: I share a pot with another winner. `side`: I won a pot and another player won another.
 * Null: I won it all, or I was not in the hand.
 */
/** The engine's id of the main pot (its side pots are `side-N`). */
const MAIN_POT = 'main';
export type Outcome =
  | { kind: 'lost'; winner: number; hand: Shown | null; mine: Shown | null; sameRank: boolean }
  | { kind: 'folded'; winner: number; hand: Shown | null }
  | { kind: 'split' | 'side'; amount: number; others: number[] };
export function outcomeFor(result: Result | null | undefined, won: Result['winners'], seat: number | null, state: string | undefined): Outcome | null {
  const b = winBanner(result, won);
  if (!b || seat === null || !result) return null;
  const mineWon = won.find((w) => w.seatIndex === seat);
  if (mineWon) {
    const others = won.filter((w) => w.seatIndex !== seat);
    if (!others.length) return null;
    const shared = others.some((w) => w.potIds.some((id) => mineWon.potIds.includes(id)));
    return { kind: shared ? 'split' : 'side', amount: mineWon.amount, others: others.map((w) => w.seatIndex) };
  }
  const top = (b.winners.find((w) => won.some((x) => x.seatIndex === w.seatIndex && x.potIds.includes(MAIN_POT))) ?? b.winners[0]!).seatIndex;
  const hand = result.showdown.find((x) => x.seatIndex === top) ?? null;
  if (state === 'folded') return { kind: 'folded', winner: top, hand };
  if (state !== 'active' && state !== 'allin') return null;
  const mine = result.showdown.find((x) => x.seatIndex === seat) ?? null;
  return { kind: 'lost', winner: top, hand, mine, sameRank: !!mine && !!hand && mine.rankClass === hand.rankClass };
}
