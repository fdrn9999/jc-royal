/**
 * What happens to the players' cards once a hand ends (room.ts). Auto-muck always applies: a losing showdown hand stays
 * face down where the rules allow it, while winning and all-in hands are turned over (packages/poker-engine hand.ts
 * revealedHands). Until the next deal, a player dealt in whose cards the showdown did not turn over (folded, won
 * uncontested, or lost and kept them face down) may show their first card, their second or both: a card once shown
 * stays shown.
 */

/** What the `show` command asks for: the first card, the second, or both. */
export type ShowChoice = 0 | 1 | 'both';

/**
 * The card positions shown once `choice` is added to those already shown (`shown`, ascending). The same array when it
 * adds nothing, so a repeated request changes nothing.
 */
export function addShown(shown: readonly number[], choice: ShowChoice): readonly number[] {
  const add = (choice === 'both' ? [0, 1] : [choice]).filter((i) => !shown.includes(i));
  return add.length ? [...shown, ...add].sort((x, y) => x - y) : shown;
}

/** From a hand settling to the next deal. */
export const BETWEEN_HANDS_MS = 4_000;
/** Added after a hand a member was dealt in: time to decide whether to show their cards. Table bots never show. */
export const SHOW_DECISION_MS = 1_500;

/** How long after a hand settles the next one is dealt. */
export const afterHandMs = (memberDealtIn: boolean) => BETWEEN_HANDS_MS + (memberDealtIn ? SHOW_DECISION_MS : 0);
