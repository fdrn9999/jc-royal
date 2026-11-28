// After the hand (muck.ts): auto-muck always applies, and a player shows their first card, their second or both. These
// replace the tests of the pushed auto-muck setting (takePushedMuck, muckRevParam), removed with the setting at the
// owner's request (2026-10-19): the room no longer holds a setting to push.
import { describe, expect, it } from 'vitest';
import { addShown, afterHandMs, BETWEEN_HANDS_MS, SHOW_DECISION_MS } from './muck';

describe('showing cards after the hand', () => {
  it('adds the first, the second or both cards, in order', () => {
    expect(addShown([], 0)).toEqual([0]);
    expect(addShown([], 1)).toEqual([1]);
    expect(addShown([], 'both')).toEqual([0, 1]);
    expect(addShown([1], 0)).toEqual([0, 1]);
    expect(addShown([0], 'both')).toEqual([0, 1]);
  });

  it('changes nothing for a card already shown: the same list comes back', () => {
    for (const [shown, choice] of [
      [[0], 0],
      [[1], 1],
      [[0, 1], 'both'],
      [[0, 1], 0],
      [[0, 1], 1],
    ] as const) {
      expect(addShown(shown, choice)).toBe(shown);
    }
  });
});

describe('time between hands', () => {
  it('gives the members of a hand 1.5 s more to decide whether to show', () => {
    expect(SHOW_DECISION_MS).toBe(1_500);
    expect(afterHandMs(true)).toBe(BETWEEN_HANDS_MS + 1_500);
    // A hand of table bots only: nobody to decide.
    expect(afterHandMs(false)).toBe(BETWEEN_HANDS_MS);
  });

  it('a pot won by a fold keeps that pace; a showdown gets its scene and then its result held to be read', () => {
    const end = { hands: 2, allIn: 0, runout: false, bust: false };
    expect(afterHandMs(true, { ...end, hands: 1 })).toBe(BETWEEN_HANDS_MS + 1_500);
    expect(afterHandMs(true, null)).toBe(BETWEEN_HANDS_MS + 1_500);
    // Scene 3.8 s + result 4 s; all in 5 s; an all-in run-out's scene is 5.5 s; three hands or a player out of chips 6 s.
    expect(afterHandMs(true, end)).toBe(7_800);
    expect(afterHandMs(false, end)).toBe(7_800);
    expect(afterHandMs(true, { ...end, allIn: 1 })).toBe(8_800);
    expect(afterHandMs(true, { ...end, allIn: 2, runout: true })).toBe(10_500);
    expect(afterHandMs(true, { ...end, hands: 3, allIn: 2, runout: true })).toBe(11_500);
    expect(afterHandMs(true, { ...end, allIn: 2, runout: true, bust: true })).toBe(11_500);
  });
});
