import { REACTION_BURST, REACTION_COOLDOWN_MS, REACTION_EMOJI, REACTIONS, reactionRulesOf, reactionWait, shownRole, SOCIAL_DEFAULTS, toSocialPolicy } from '@jc/types';
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

  it('applies the rules the social policy sets instead of the defaults', () => {
    const rules = { cooldownMs: 500, burstMax: 2, burstWindowMs: 10_000 };
    expect(reactionWait([1_000], 1_200, rules)).toBe(300);
    // Two inside the window: the third waits for the oldest to age out, not for the (shorter) cooldown.
    expect(reactionWait([1_000, 2_000], 2_600, rules)).toBe(1_000 + 10_000 - 2_600);
    expect(reactionWait([1_000, 2_000], 11_000, rules)).toBe(0);
    // A longer cooldown than the default holds the next one longer.
    expect(reactionWait([0], 2_500, { ...rules, cooldownMs: 5_000 })).toBe(2_500);
  });
});

describe('social policy', () => {
  const row = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 3, reactionsEnabled: 1, cooldownMs: 1_000, burstMax: 4, burstWindowMs: 20_000, showSuperAdmin: 0, showAdmin: 1, ...over });

  it('reads a stored version, and refuses one this build cannot read (the defaults then apply)', () => {
    expect(toSocialPolicy(row())).toEqual({ version: 3, reactionsEnabled: true, cooldownMs: 1_000, burstMax: 4, burstWindowMs: 20_000, showSuperAdmin: false, showAdmin: true });
    expect(toSocialPolicy(null)).toBeNull();
    expect(toSocialPolicy('not json')).toBeNull();
    // Out of the limits, not whole, or no version: never half-applied.
    expect(toSocialPolicy(row({ cooldownMs: 100 }))).toBeNull();
    expect(toSocialPolicy(row({ burstMax: 21 }))).toBeNull();
    expect(toSocialPolicy(row({ burstWindowMs: 5_000.5 }))).toBeNull();
    expect(toSocialPolicy(row({ version: null }))).toBeNull();
  });

  it('gives a table no reaction rules when reactions are off, and the defaults without a policy', () => {
    expect(reactionRulesOf(null)).toEqual({ cooldownMs: REACTION_COOLDOWN_MS, burstMax: REACTION_BURST.max, burstWindowMs: REACTION_BURST.windowMs });
    expect(reactionRulesOf({ ...SOCIAL_DEFAULTS, reactionsEnabled: false })).toBeNull();
    expect(reactionRulesOf({ ...SOCIAL_DEFAULTS, cooldownMs: 700 })).toMatchObject({ cooldownMs: 700 });
  });

  it('shows a staff badge only where the policy shows that role, and never for a member', () => {
    const hideSuper = { showSuperAdmin: false, showAdmin: true };
    expect(shownRole('super_admin', null)).toBe('super_admin');
    expect(shownRole('super_admin', hideSuper)).toBeUndefined();
    expect(shownRole('admin', hideSuper)).toBe('admin');
    expect(shownRole('admin', { showSuperAdmin: true, showAdmin: false })).toBeUndefined();
    expect(shownRole('user', { showSuperAdmin: true, showAdmin: true })).toBeUndefined();
    expect(shownRole(null, null)).toBeUndefined();
  });
});

describe('REACTIONS', () => {
  it('has an emoji for each, all different', () => {
    expect(REACTIONS.map((r) => REACTION_EMOJI[r]).every(Boolean)).toBe(true);
    expect(new Set(Object.values(REACTION_EMOJI)).size).toBe(REACTIONS.length);
  });
});