import { z } from 'zod';
import type { StatRatio } from './api';
import type { PublicUserDto } from './social';

// ------------------------------------------------------------------ achievements

/**
 * Achievements: decorative marks the server gives from what it recorded (user_badges, `play:` codes, written by
 * packages/db/src/achievements.ts), never claimed by a client and never linked to chips or the ledger. A made hand
 * counts only when its cards were face up for the table, so a mucked hand never shows through one.
 */
export const ACHIEVEMENTS = ['first_hand', 'first_win', 'full_house', 'quads', 'straight_flush', 'hands_100', 'tournament_win', 'streak_7'] as const;
export type AchievementCode = (typeof ACHIEVEMENTS)[number];
/** The namespace of these codes in user_badges (the academy's badges have their own). */
export const ACHIEVEMENT_PREFIX = 'play:';

export interface AchievementDto {
  code: AchievementCode;
  at: number;
}

// ------------------------------------------------------------------ profile card (GET /api/players/:id/card)

/** What a member lets other players see (users columns, saved with PATCH /api/friends/settings). */
export interface PrivacySettingsDto {
  /** Achievements on my card (default on). */
  showAchievements: boolean;
  /** Hands played, VPIP, PFR, WTSD and W$SD on my card (default off). */
  showStats: boolean;
  /** Tell my friends when I sit at a public table (default on; never while invisible, never a private table). */
  shareTable: boolean;
  /** Appear on the season leaderboard (default on). */
  showRanking: boolean;
}

export const PRIVACY_DEFAULTS: PrivacySettingsDto = { showAchievements: true, showStats: false, shareTable: true, showRanking: true };

export interface PlayerCardStatsDto {
  hands: number;
  vpip: StatRatio;
  pfr: StatRatio;
  wtsd: StatRatio;
  wsd: StatRatio;
  tournamentWins: number;
}

/**
 * Another member's card, or my own. Name, picture, badge (staff or VIP, as everywhere) and the month they joined
 * (never the day); achievements and statistics only as the member chose. A member who blocked me or whom I blocked, a
 * suspended or withdrawn member and a table bot all read as not found.
 */
export interface PlayerCardDto {
  user: PublicUserDto;
  /** 'YYYY-MM', Korean time. */
  joinedMonth: string;
  self: boolean;
  /** Null: the member keeps them to themselves (on my own card: always there, with `privacy` telling who else sees them). */
  achievements: AchievementDto[] | null;
  stats: PlayerCardStatsDto | null;
  /** My own card only. */
  privacy?: PrivacySettingsDto;
}

// ------------------------------------------------------------------ season leaderboard (GET /api/leaderboard)

/**
 * A season is a calendar month, Korean time. The board ranks finished free tournaments only, never chips won or time
 * played: a tournament counts when at least `minHumans` members finished it, and a member is ranked from
 * `minTournaments` such tournaments. The score is the share of the other finishers they finished ahead of, pulled
 * toward one half by `weight` imaginary tournaments' worth of finishers, so a few lucky wins cannot top the board and
 * playing more only makes the score surer, not higher. Members who chose not to appear, bots, and suspended or
 * withdrawn accounts are left out.
 */
export const LEADERBOARD = { minTournaments: 3, minHumans: 3, prior: 0.5, weight: 10, top: 50 } as const;

export const SeasonSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const KST_MS = 9 * 60 * 60_000;

/** The season (month, Korean time) of a moment. */
export function seasonOf(ms: number): string {
  return new Date(ms + KST_MS).toISOString().slice(0, 7);
}

/** The season's first moment and the next season's. */
export function seasonRange(season: string): { from: number; to: number } {
  const [y, m] = season.split('-').map(Number) as [number, number];
  return { from: Date.UTC(y, m - 1, 1) - KST_MS, to: Date.UTC(y, m, 1) - KST_MS };
}

/** The season before `season`. */
export function previousSeason(season: string): string {
  return seasonOf(seasonRange(season).from - 1);
}

/** Score in thousandths (0–1000). */
export function leaderboardScore(beaten: number, possible: number): number {
  return Math.round((1000 * (beaten + LEADERBOARD.prior * LEADERBOARD.weight)) / (possible + LEADERBOARD.weight));
}

export interface LeaderboardRowDto {
  /** Null: not ranked yet (fewer than `minTournaments`; my own row only). */
  rank: number | null;
  user: PublicUserDto;
  tournaments: number;
  wins: number;
  /** Thousandths, see leaderboardScore. */
  score: number;
}

export interface LeaderboardDto {
  season: string;
  from: number;
  to: number;
  rows: LeaderboardRowDto[];
  /** Members ranked in the season (rows holds the first LEADERBOARD.top). */
  ranked: number;
  /** My row: null when I finished no counted tournament, or chose not to appear. */
  me: LeaderboardRowDto | null;
  /** I chose not to appear. */
  hidden: boolean;
}
