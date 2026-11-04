import { z } from 'zod';
import type { StatRatio } from './api';
import type { ChallengeSummaryDto } from './challenges';
import type { PublicUserDto } from './social';

// ------------------------------------------------------------------ achievements

/**
 * Achievements: decorative marks the server gives from what it recorded (user_badges, `play:` codes, written by
 * packages/db/src/achievements.ts), never claimed by a client and never linked to chips or the ledger. A made hand
 * counts only when its cards were face up for the table, so a mucked hand never shows through one. `challenges_10`: ten
 * challenges completed (CHALLENGES in ./challenges), once.
 */
export const ACHIEVEMENTS = ['first_hand', 'first_win', 'full_house', 'quads', 'straight_flush', 'hands_100', 'tournament_win', 'streak_7', 'challenges_10'] as const;
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
  /** Hands played, VPIP, PFR, WTSD and W$SD on my card, and the table HUD's figures (default off). */
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
  /** Challenges completed and their points, behind the same choice as `achievements`. */
  challenges: ChallengeSummaryDto | null;
  stats: PlayerCardStatsDto | null;
  /** My own card only. */
  privacy?: PrivacySettingsDto;
}

// ------------------------------------------------------------------ table HUD (GET /api/players/:id/hud)

/**
 * Which tables a seat's HUD counts: the ordinary ones (official and member rooms) or the tournament ones, the kind of
 * table it is opened at. Practice hands are never recorded, so a practice table's HUD counts that session in the
 * browser only.
 */
export const HUD_SCOPES = ['cash', 'tournament'] as const;
export type HudScope = (typeof HUD_SCOPES)[number];
/** A HUD counts the player's latest hands of its scope: at most HUD_HANDS of them, from the last HUD_DAYS days. */
export const HUD_HANDS = 1000;
export const HUD_DAYS = 90;

/** The card's figures and the later ones /api/me/stats has, by the same counting (each ratio over its chances). */
export interface HudStatsDto {
  hands: number;
  vpip: StatRatio;
  pfr: StatRatio;
  wtsd: StatRatio;
  wsd: StatRatio;
  /** Of `hands`, those the 3-bet, c-bet and AF figures count (recorded since they were added). */
  counted: number;
  threeBet: StatRatio;
  foldTo3Bet: StatRatio;
  cbet: StatRatio;
  foldToCbet: StatRatio;
  /** Bets and raises, and calls, after the flop. */
  aggression: { bets: number; calls: number };
}

/**
 * A seat's HUD: a member's statistics only as their card shows them (shown, or my own), a table bot's always and
 * marked as a bot's. Not found the way the card is (no such player, a withdrawn or suspended member, a block).
 */
export interface PlayerHudDto {
  bot: boolean;
  scope: HudScope;
  /** Null: the member keeps their statistics to themselves. */
  stats: HudStatsDto | null;
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
