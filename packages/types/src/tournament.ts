/**
 * 6-seat Sit & Go tournaments: free entry, no prize (docs/TOURNAMENT.md). The api keeps templates, tournaments and
 * entries in D1; the tournament's table room plays it with tournament chips that never touch a wallet or the ledger.
 *
 * - Blinds rise with a level clock that runs only while the table can deal (a pause or a maintenance stops it); a level
 *   applies from the next hand dealt, never to a hand being played.
 * - Players busting in the same hand: the bigger stack at the start of that hand places higher; equal stacks share the
 *   higher place.
 */
import { z } from 'zod';
import { TIME_BANK_LIMITS, timeBankProblem, type TimeBankRules } from './timebank';
import type { VipColor } from './vip';

export const TOURNAMENT_STATUSES = ['registering', 'closed', 'running', 'finished', 'cancelled', 'aborted'] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];
/** A tournament still to be played or being played: a member takes part in at most one at a time. */
export const ACTIVE_TOURNAMENT_STATUSES = ['registering', 'closed', 'running'] as const satisfies readonly TournamentStatus[];

export const ENTRY_STATUSES = ['registered', 'unregistered', 'dropped', 'playing', 'eliminated', 'won', 'stopped'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export interface BlindLevel {
  sb: number;
  bb: number;
}

/** A tournament's own time bank (copied from its template; the service policy never applies to tournaments). */
export interface TournamentTimeBank {
  enabled: boolean;
  initialMs: number;
  maxMs: number;
  unitMs: number;
  refillHands: number;
  refillMs: number;
}

/** What a template sets, and a tournament copies when it is opened. */
export interface TournamentStructure {
  name: string;
  capacity: number;
  /** The fewest eligible players an operator's start needs. */
  minPlayers: number;
  startStack: number;
  levels: BlindLevel[];
  levelMinutes: number;
  turnSeconds: number;
  timeBank: TournamentTimeBank;
  /** Registration conditions: hands played at any table, and a verified email. */
  minHands: number;
  requireVerified: boolean;
  /** Starts by itself when the last seat is taken (when every registered player is still eligible). */
  autoStart: boolean;
}

export const TOURNAMENT_LIMITS = {
  name: { min: 2, max: 40 },
  capacity: { min: 2, max: 6 },
  startStack: { min: 100, max: 1_000_000 },
  levels: { min: 1, max: 30 },
  blind: { max: 1_000_000 },
  levelMinutes: { min: 1, max: 60 },
  turnSeconds: { min: 10, max: 120 },
  minHands: { min: 0, max: 1_000 },
} as const;

/** A starting stack is at least this many big blinds of the first level. */
export const TOURNAMENT_MIN_START_BB = 10;
/** How long a finished tournament's table shows the result before it closes. */
export const TOURNAMENT_FINISH_LINGER_MS = 60_000;

const L = TOURNAMENT_LIMITS;
const T = TIME_BANK_LIMITS;

export const BlindLevelSchema = z.object({ sb: z.number().int().min(1).max(L.blind.max), bb: z.number().int().min(2).max(L.blind.max) });

export const TournamentTimeBankSchema = z.object({
  enabled: z.boolean(),
  initialMs: z.number().int().min(T.initialMs.min).max(T.initialMs.max),
  maxMs: z.number().int().min(T.maxMs.min).max(T.maxMs.max),
  unitMs: z.number().int().min(T.unitMs.min).max(T.unitMs.max),
  refillHands: z.number().int().min(T.refillHands.min).max(T.refillHands.max),
  refillMs: z.number().int().min(T.refillMs.min).max(T.refillMs.max),
});

export const TournamentStructureSchema = z.object({
  name: z.string().trim().min(L.name.min).max(L.name.max),
  capacity: z.number().int().min(L.capacity.min).max(L.capacity.max),
  minPlayers: z.number().int().min(L.capacity.min).max(L.capacity.max),
  startStack: z.number().int().min(L.startStack.min).max(L.startStack.max),
  levels: z.array(BlindLevelSchema).min(L.levels.min).max(L.levels.max),
  levelMinutes: z.number().int().min(L.levelMinutes.min).max(L.levelMinutes.max),
  turnSeconds: z.number().int().min(L.turnSeconds.min).max(L.turnSeconds.max),
  timeBank: TournamentTimeBankSchema,
  minHands: z.number().int().min(L.minHands.min).max(L.minHands.max),
  requireVerified: z.boolean(),
  autoStart: z.boolean(),
});

export type TournamentStructureProblem =
  | 'min_players_over_capacity'
  | 'small_blind_not_below_big'
  | 'levels_decrease'
  | 'start_stack_too_small'
  | 'initial_over_max'
  | 'unit_over_max'
  | 'whole_seconds';

/** Why a structure's values do not hold together (beyond each one's own range), or null. */
export function tournamentStructureProblem(s: TournamentStructure): TournamentStructureProblem | null {
  if (s.minPlayers > s.capacity) return 'min_players_over_capacity';
  if (s.levels.some((l) => l.sb >= l.bb)) return 'small_blind_not_below_big';
  if (s.levels.some((l, i) => i > 0 && (l.sb < s.levels[i - 1]!.sb || l.bb < s.levels[i - 1]!.bb))) return 'levels_decrease';
  if (s.startStack < s.levels[0]!.bb * TOURNAMENT_MIN_START_BB) return 'start_stack_too_small';
  return s.timeBank.enabled ? timeBankProblem(s.timeBank) : null;
}

/** The blinds of level `index` (0-based); past the last level, the last. */
export function blindsAt(levels: readonly BlindLevel[], index: number): BlindLevel {
  return levels[Math.max(0, Math.min(index, levels.length - 1))]!;
}

/**
 * The level clock at `now`: every level whose end has passed is left behind, up to the last level (which has no end).
 * `levelEndsAt` null: the last level, or a stopped clock (whose remaining time is kept apart).
 */
export function advanceLevel(clock: { level: number; levelEndsAt: number | null }, levelCount: number, levelMs: number, now: number): { level: number; levelEndsAt: number | null } {
  let { level, levelEndsAt } = clock;
  while (levelEndsAt !== null && now >= levelEndsAt && level < levelCount - 1) {
    level += 1;
    levelEndsAt += levelMs;
  }
  if (level >= levelCount - 1) return { level: levelCount - 1, levelEndsAt: null };
  return { level, levelEndsAt };
}

/**
 * Places for the players who busted in one hand. `before`: players with chips when the hand was dealt. The bigger stack
 * at the start of the hand places higher; equal stacks share the higher of their places.
 */
export function rankBusts<T extends { startStack: number }>(before: number, busts: readonly T[]): (T & { place: number })[] {
  const sorted = [...busts].sort((a, b) => a.startStack - b.startStack);
  return sorted.map((b, i) => {
    let last = i;
    while (last + 1 < sorted.length && sorted[last + 1]!.startStack === b.startStack) last += 1;
    return { ...b, place: Math.max(1, before - last) };
  });
}

/** The time bank rules a tournament's hands are dealt with (version 0: the tournament's own, not a policy version). */
export function tournamentTimeBankRules(tb: TournamentTimeBank | null): TimeBankRules | null {
  if (!tb?.enabled) return null;
  const { initialMs, maxMs, unitMs, refillHands, refillMs } = tb;
  return { version: 0, initialMs, maxMs, unitMs, refillHands, refillMs };
}

/** Why a member may not register (the api's answer to them). */
export type TournamentIneligible = 'suspended' | 'bot' | 'unverified' | 'min_hands';

export interface TournamentEntryView {
  nickname: string;
  /** The member's VIP name color (a look only: it changes nothing in the tournament). */
  vip?: VipColor;
  status: EntryStatus;
  place: number | null;
  /** Tournament chips as the table last reported them (running tournaments). */
  stack: number | null;
  /** The viewer's own entry. */
  me?: boolean;
}

/** A tournament in the list (members' page). */
export interface TournamentSummaryDto {
  id: string;
  name: string;
  status: TournamentStatus;
  capacity: number;
  minPlayers: number;
  registered: number;
  startStack: number;
  levelMinutes: number;
  turnSeconds: number;
  firstLevel: BlindLevel;
  levelCount: number;
  /** Level index (0-based) and players left, as the table last reported them (running and ended tournaments). */
  level: number;
  playersLeft: number | null;
  autoStart: boolean;
  minHands: number;
  requireVerified: boolean;
  tableId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  winner: string | null;
  /** The winner's VIP name color, when they have one. */
  winnerVip?: VipColor;
  /** The viewer's entry, if any. */
  me: { status: EntryStatus; place: number | null } | null;
}

export interface TournamentDetailDto extends TournamentSummaryDto {
  levels: BlindLevel[];
  timeBank: TournamentTimeBank;
  /** The next level's time (running clock) or the time left in this level (stopped clock); both null at the last level. */
  levelEndsAt: number | null;
  levelLeftMs: number | null;
  paused: boolean;
  entries: TournamentEntryView[];
  /** Whether the viewer could register now, and if not, why (null when registration is not open). */
  eligibility: { ok: true } | { ok: false; reason: TournamentIneligible | 'active_elsewhere' | 'full'; handsLeft?: number } | null;
  now: number;
}

/**
 * When a tournament is shown to operators as needing recovery (docs/TOURNAMENT.md "복구 필요 표시"). Shown only:
 * nothing is changed by it.
 */
export const TOURNAMENT_RECOVERY_MS = {
  /** A running room with its clock running that has not written for this long. */
  silent: 15 * 60_000,
  /** No write from the room this long after the start. */
  firstWrite: 2 * 60_000,
  /** A pause asked for this long ago, and the clock still running. */
  pauseStuck: 10 * 60_000,
  /** A resume asked for this long ago, and the clock still stopped. */
  resumeStuck: 2 * 60_000,
  /** Ended this long ago, and the table still not closed. */
  tableOpen: 10 * 60_000,
  /** An automatic start with every seat taken this long ago, and still registering. */
  startStuck: 2 * 60_000,
  /** No operator's pause, and the clock stopped this long ago (everyone still in away, or a long maintenance). */
  stalled: 15 * 60_000,
} as const;

export const TOURNAMENT_RECOVERY_CODES = ['room_silent', 'pause_stuck', 'resume_stuck', 'stalled', 'table_open', 'start_stuck'] as const;
export type TournamentRecoveryCode = (typeof TOURNAMENT_RECOVERY_CODES)[number];

export interface TournamentRecoveryInput {
  status: TournamentStatus;
  pauseRequested: boolean;
  pauseChangedAt: number | null;
  /** When the level clock stopped (null: running). */
  pausedAt: number | null;
  roomSeenAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The tournament table's status (null: no table). */
  tableStatus: string | null;
  autoStart: boolean;
  registered: number;
  capacity: number;
  updatedAt: number;
}

/** Why a tournament needs an operator now (the same rules as the admin list's SQL filter). */
export function tournamentRecovery(t: TournamentRecoveryInput, now: number): TournamentRecoveryCode[] {
  const R = TOURNAMENT_RECOVERY_MS;
  const codes: TournamentRecoveryCode[] = [];
  if (t.status === 'running') {
    if (
      !t.pauseRequested &&
      ((t.roomSeenAt === null && t.startedAt !== null && t.startedAt < now - R.firstWrite) || (t.roomSeenAt !== null && t.pausedAt === null && t.roomSeenAt < now - R.silent))
    )
      codes.push('room_silent');
    if (t.pauseRequested && t.pauseChangedAt !== null && t.pauseChangedAt < now - R.pauseStuck && t.pausedAt === null) codes.push('pause_stuck');
    if (!t.pauseRequested && t.pauseChangedAt !== null && t.pauseChangedAt < now - R.resumeStuck && t.pausedAt !== null) codes.push('resume_stuck');
    if (!t.pauseRequested && t.roomSeenAt !== null && t.pausedAt !== null && t.pausedAt < now - R.stalled) codes.push('stalled');
  }
  if ((t.status === 'finished' || t.status === 'aborted') && t.endedAt !== null && t.endedAt < now - R.tableOpen && t.tableStatus !== null && t.tableStatus !== 'closed')
    codes.push('table_open');
  if (t.status === 'registering' && t.autoStart && t.registered >= t.capacity && t.updatedAt < now - R.startStuck) codes.push('start_stuck');
  return codes;
}

/** A template as the console lists it. */
export interface TournamentTemplateDto extends TournamentStructure {
  id: string;
  status: 'active' | 'archived';
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
}

/** A tournament in the console's list. */
export interface AdminTournamentRow {
  id: string;
  name: string;
  status: TournamentStatus;
  templateId: string | null;
  capacity: number;
  minPlayers: number;
  registered: number;
  startStack: number;
  autoStart: boolean;
  levelCount: number;
  level: number;
  smallBlind: number;
  bigBlind: number;
  levelEndsAt: number | null;
  levelLeftMs: number | null;
  pauseRequested: boolean;
  /** When the level clock stopped (a pause, a maintenance, or before the first deal); null while it runs. */
  clockStoppedAt: number | null;
  playersLeft: number | null;
  hands: number;
  roomSeenAt: number | null;
  tableId: string | null;
  tableStatus: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endReason: 'completed' | 'cancelled' | 'aborted' | null;
  winner: string | null;
  version: number;
  roster: number;
  recovery: TournamentRecoveryCode[];
}

/** The tournament as its table shows it (TableView.tournament). */
export interface TournamentTableView {
  id: string;
  name: string;
  status: 'running' | 'finished' | 'aborted';
  /** Current level (0-based) and how many there are. */
  level: number;
  levelCount: number;
  smallBlind: number;
  bigBlind: number;
  next: BlindLevel | null;
  /** Running clock: when the next level starts. Stopped clock: the time left in this level. Null at the last level. */
  levelEndsAt: number | null;
  levelLeftMs: number | null;
  /** An operator paused the tournament (from the next hand). */
  paused: boolean;
  playersLeft: number;
  entrants: number;
  startStack: number;
  /** Places decided so far, best first (with the VIP color the member's name shows; looks only). */
  places: { nickname: string; place: number; vip?: VipColor }[];
  /** The viewer: still playing, out (with place), the winner, stopped by an abort, or watching. */
  you: { status: 'playing' | 'eliminated' | 'won' | 'stopped' | 'watching'; place: number | null };
}
