// ------------------------------------------------------------------ challenges (GET /api/me/challenges)

/**
 * Challenges (docs/CHALLENGES.md): daily and weekly goals the server judges from what it recorded (hand_players,
 * tournament_entries), never from anything a client says. Not achievements (ACHIEVEMENTS, once and for good): a
 * challenge comes back every Korean day, or every week from Monday, and each completion is kept once per member, code
 * and period (challenge_completions). Its points are a progress figure: never chips, never the ledger. Table bots
 * have none. The Academy is not counted: its progress is what a browser reports, which the server cannot check.
 */
export const CHALLENGE_PERIODS = ['day', 'week'] as const;
export type ChallengePeriod = (typeof CHALLENGE_PERIODS)[number];

/** What a challenge counts in its period: recorded hands, hands taken to showdown, days with a hand, public tournaments played. */
export type ChallengeCounts = 'hands' | 'showdowns' | 'days' | 'tournaments';

export interface ChallengeDef {
  code: string;
  period: ChallengePeriod;
  counts: ChallengeCounts;
  target: number;
  points: number;
}

export const CHALLENGES = [
  { code: 'd_hands_10', period: 'day', counts: 'hands', target: 10, points: 1 },
  { code: 'd_hands_30', period: 'day', counts: 'hands', target: 30, points: 2 },
  { code: 'd_showdown_3', period: 'day', counts: 'showdowns', target: 3, points: 1 },
  { code: 'w_hands_100', period: 'week', counts: 'hands', target: 100, points: 3 },
  { code: 'w_days_3', period: 'week', counts: 'days', target: 3, points: 3 },
  { code: 'w_tournaments_2', period: 'week', counts: 'tournaments', target: 2, points: 3 },
] as const satisfies readonly ChallengeDef[];
export type ChallengeCode = (typeof CHALLENGES)[number]['code'];

/** Completions in all that give the `challenges_10` achievement. */
export const CHALLENGE_ACHIEVEMENT_AT = 10;

export interface ChallengeDto {
  code: ChallengeCode;
  period: ChallengePeriod;
  target: number;
  /** Counted in this period, never above `target`. */
  progress: number;
  done: boolean;
  /** When the target was reached (the time of the event that reached it). */
  completedAt: number | null;
  points: number;
}

export interface ChallengePeriodDto {
  period: ChallengePeriod;
  /** The Korean day or week (from Monday) it is, as numbered on the server. */
  key: number;
  startsAt: number;
  endsAt: number;
}

export interface ChallengeCompletionDto {
  code: ChallengeCode;
  period: ChallengePeriod;
  completedAt: number;
  points: number;
}

export interface ChallengesDto {
  periods: ChallengePeriodDto[];
  /** This day's and this week's, in CHALLENGES order. */
  items: ChallengeDto[];
  /** Every completion kept (earlier periods too). */
  points: number;
  completed: number;
  /** The latest completions, newest first (at most 10). */
  recent: ChallengeCompletionDto[];
}

/** On a member's card, behind the same choice as achievements. */
export interface ChallengeSummaryDto {
  points: number;
  completed: number;
}
