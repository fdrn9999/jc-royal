import type { BotLevel } from '@jc/types';

/**
 * What the balance simulation measured for each bot level (docs/BOT_AI.md §11, `sim/balance-sim.ts --exp field`): the
 * bots' own play against the same opponents, decks and seats, as rates (AF as bets and raises over calls after the
 * flop). The bots page sets a level's live play beside these. They are what the heuristics did in the simulation, not
 * GTO answers or targets: live tables differ in players, sizes and stacks, so a difference is a place to look, not a
 * defect. Measured again with the commands in docs/BOT_AI.md §11 whenever the strategy changes (`STRATEGY_VERSION`).
 */
export const BOT_EXPECT_SOURCE = { date: '2026-11-04', hands: 518_400, strategy: 'bot-ai-2.1' } as const;

export const TENDENCIES = ['vpip', 'pfr', 'threeBet', 'foldTo3Bet', 'cbet', 'foldToCbet', 'wtsd', 'af'] as const;
export type Tendency = (typeof TENDENCIES)[number];

export const BOT_EXPECT: Record<BotLevel, Record<Tendency, number>> = {
  easy: { vpip: 0.297, pfr: 0.142, threeBet: 0.022, foldTo3Bet: 0.431, cbet: 0.425, foldToCbet: 0.388, wtsd: 0.563, af: 0.95 },
  normal: { vpip: 0.255, pfr: 0.155, threeBet: 0.038, foldTo3Bet: 0.45, cbet: 0.461, foldToCbet: 0.541, wtsd: 0.452, af: 2.2 },
  hard: { vpip: 0.26, pfr: 0.159, threeBet: 0.047, foldTo3Bet: 0.406, cbet: 0.474, foldToCbet: 0.537, wtsd: 0.454, af: 2.14 },
  expert: { vpip: 0.259, pfr: 0.161, threeBet: 0.052, foldTo3Bet: 0.386, cbet: 0.503, foldToCbet: 0.519, wtsd: 0.451, af: 2.42 },
};

/** Fewer chances than this leave a rate unjudged. */
export const TENDENCY_MIN = 100;
/** A rate is marked only this many percentage points or more from the simulation's... */
export const TENDENCY_PP = 5;
/** ...and beyond this many standard errors of a sample its size (hands of one table are not independent, hence 3). */
export const TENDENCY_Z = 3;
/** AF is marked this share or more above or below the simulation's. */
export const TENDENCY_AF_SHARE = 0.3;

export type Judged = 'few' | 'near' | 'high' | 'low';

/**
 * A live figure against the simulation's: `n` over `of` chances (for AF, bets and raises over calls, `of` being both
 * together). Unjudged below TENDENCY_MIN chances; marked only when the difference is both large and beyond chance.
 */
export function judge(k: Tendency, n: number, of: number, expected: number, calls = 0): Judged {
  if (of < TENDENCY_MIN) return 'few';
  if (k === 'af') {
    if (calls <= 0 || expected <= 0) return 'few';
    const af = n / calls;
    return af >= expected * (1 + TENDENCY_AF_SHARE) ? 'high' : af <= expected * (1 - TENDENCY_AF_SHARE) ? 'low' : 'near';
  }
  const p = n / of;
  const d = p - expected;
  const se = Math.sqrt(Math.max(expected * (1 - expected), 1e-6) / of);
  if (Math.abs(d) * 100 < TENDENCY_PP || Math.abs(d) < TENDENCY_Z * se) return 'near';
  return d > 0 ? 'high' : 'low';
}
