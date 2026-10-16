import { REACTION_BURST, REACTION_COOLDOWN_MS, REACTION_EMOJI, REACTIONS, reactionWait } from '@jc/types';
import { describe, expect, it } from 'vitest';

describe('reactionWait', () => {
  it('lets the first one go and holds the next for the cooldown', () => {
    expect(reactionWait([], 1_000)).toBe(0);
    expect(reactionWait([1_000], 1_000)).toBe(REACTION_COOLDOWN_MS);
    expect(reactionWait([1_000], 1_500)).toBe(REACTION_COOLDOWN_MS - 500);
    expect(reactionWait([1_000], 1_000 + REACTION_COOLDOWN_MS)).toBe(0);
  });

  it('holds the one past the burst limit until the oldest of the window ages out', () => {
    const step = REACTION_COOLDOWN_MS + 1_000;
    const times = Array.from({ length: REACTION_BURST.max }, (_, i) => i * step);
    const now = times[times.length - 1]! + REACTION_COOLDOWN_MS;
    expect(reactionWait(times, now)).toBe(REACTION_BURST.windowMs - now);
    expect(reactionWait(times, REACTION_BURST.windowMs)).toBe(0);
    // One fewer than the limit: only the cooldown counts.
    expect(reactionWait(times.slice(1), now)).toBe(0);
  });

  it('forgets reactions older than the window', () => {
    expect(reactionWait([0, 1, 2, 3, 4], REACTION_BURST.windowMs + 10)).toBe(0);
  });
});

describe('REACTIONS', () => {
  it('has an emoji for each, all different', () => {
    expect(REACTIONS.map((r) => REACTION_EMOJI[r]).every(Boolean)).toBe(true);
    expect(new Set(Object.values(REACTION_EMOJI)).size).toBe(REACTIONS.length);
  });
});