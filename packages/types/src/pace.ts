/**
 * The pace of a hand's end, in one place for the room and the scene. The room deals the next hand a fixed time after a
 * hand settles (game-worker muck.ts `afterHandMs`); a showdown gets the time its scene takes on a screen (`sceneMs`,
 * which the web's staging.ts never exceeds) and then the time its result stays to be read (`resultHoldMs`). The room
 * never waits on a client: these are its own clock, the same for everybody at the table, and a screen that plays a
 * shorter scene (a setting, reduced motion, a tab that was hidden) only reads the result for longer.
 */

/** How a hand ended, as far as its pace goes. Counted by the room from the hand itself, never from a client. */
export interface HandEnding {
  /** The hands compared at the showdown (fewer than two: the pot was won by a fold). */
  hands: number;
  /** How many of them were all in. */
  allIn: number;
  /** Board cards came after the betting was over (an all-in run-out). */
  runout: boolean;
  /** A player lost their last chip. */
  bust: boolean;
}

/** The longest a hand's end plays on a screen. */
export const SCENE_MS = { plain: 3_300, showdown: 3_800, runout: 5_500 } as const;

/** How long a result stays readable once its scene is over. */
export const RESULT_HOLD_MS = { fold: 2_000, showdown: 4_000, allIn: 5_000, multiway: 6_000, bust: 6_000 } as const;

export const wentToShowdown = (e: HandEnding) => e.hands > 1;

export function sceneMs(e: HandEnding): number {
  return !wentToShowdown(e) ? SCENE_MS.plain : e.runout ? SCENE_MS.runout : SCENE_MS.showdown;
}

export function resultHoldMs(e: HandEnding): number {
  if (!wentToShowdown(e)) return RESULT_HOLD_MS.fold;
  if (e.bust) return RESULT_HOLD_MS.bust;
  if (e.allIn > 0) return e.hands > 2 ? RESULT_HOLD_MS.multiway : RESULT_HOLD_MS.allIn;
  return RESULT_HOLD_MS.showdown;
}

/** From a showdown settling to the next deal: its scene, then its result held. */
export const showdownGapMs = (e: HandEnding) => sceneMs(e) + resultHoldMs(e);
