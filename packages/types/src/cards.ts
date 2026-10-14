import { z } from 'zod';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
/** Card notation shared with poker-engine-ts, e.g. "As", "Td". */
export type Card = `${Rank}${Suit}`;

export const CardSchema = z
  .string()
  .regex(/^[2-9TJQKA][cdhs]$/) as unknown as z.ZodType<Card>;

/**
 * Hand rank classes produced by the engine evaluator, weakest first.
 * The engine has no separate royal flush class; `handLabelKey` derives it
 * from an ace-high straight flush for display only.
 */
export const HAND_RANK_CLASSES = [
  'high-card',
  'pair',
  'two-pair',
  'three-of-a-kind',
  'straight',
  'flush',
  'full-house',
  'four-of-a-kind',
  'straight-flush',
] as const;
export type HandRankClass = (typeof HAND_RANK_CLASSES)[number];

export type HandLabelKey = HandRankClass | 'royal-flush';

export function handLabelKey(rankClass: string, bestFive: readonly string[]): HandLabelKey {
  if (rankClass === 'straight-flush' && bestFive.some((c) => c.startsWith('A')) && bestFive.some((c) => c.startsWith('K'))) {
    return 'royal-flush';
  }
  return (HAND_RANK_CLASSES as readonly string[]).includes(rankClass) ? (rankClass as HandRankClass) : 'high-card';
}
