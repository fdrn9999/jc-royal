/**
 * Time bank: time a player adds to their own turn, on purpose, on top of the table's turn time (the `timeBank` command).
 * The room keeps each member's bank and the deadline; the policy (time_bank_policies, newest version) is a super admin's.
 *
 * - A member gets `initialMs` the first hand they are dealt at a table, and keeps what is left while they stay (also when
 *   they reconnect, stand up and sit down again within a few hours, or the room restarts). Leaving and coming back never
 *   gives a new bank.
 * - Each use adds `unitMs` (or what is left, if less) to the current turn only; time added and not used is gone.
 * - Every `refillHands` hands dealt in, `refillMs` is added, never past `maxMs`.
 * - Table bots have no bank: they never use or get one. A member's refill counts the hands they are dealt, one each,
 *   whoever else sits at the table.
 * - A policy change applies to each table from its next hand: the hand being played, and the deadline of the turn being
 *   played, keep the rules they were dealt with.
 */

/** What a time bank policy sets (times in ms, whole seconds). */
export interface TimeBankSettings {
  /** On for official tables. */
  enabled: boolean;
  /** Also on in member rooms (when `enabled`). */
  memberRooms: boolean;
  initialMs: number;
  maxMs: number;
  unitMs: number;
  refillHands: number;
  refillMs: number;
}

/** A version of the policy (time_bank_policies). */
export interface TimeBankPolicy extends TimeBankSettings {
  version: number;
}

/** The rules a table's hand was dealt with: a policy version that applies to it. */
export interface TimeBankRules {
  version: number;
  initialMs: number;
  maxMs: number;
  unitMs: number;
  refillHands: number;
  refillMs: number;
}

/** What a policy may hold. Every time is a whole number of seconds. */
export const TIME_BANK_LIMITS = {
  initialMs: { min: 0, max: 120_000 },
  maxMs: { min: 5_000, max: 300_000 },
  unitMs: { min: 5_000, max: 60_000 },
  refillHands: { min: 1, max: 100 },
  refillMs: { min: 0, max: 60_000 },
} as const;

/** A bank with less than this left cannot be used: a turn never gets a sliver of time. */
export const TIME_BANK_MIN_USE_MS = 1_000;

/** The rules `policy` gives a table (null: no time bank there). */
export function timeBankRulesFor(policy: TimeBankPolicy | null, roomType: 'official' | 'member'): TimeBankRules | null {
  if (!policy?.enabled || (roomType === 'member' && !policy.memberRooms)) return null;
  const { version, initialMs, maxMs, unitMs, refillHands, refillMs } = policy;
  return { version, initialMs, maxMs, unitMs, refillHands, refillMs };
}

/** Why a policy's values do not hold together (beyond each one's own range), or null. */
export function timeBankProblem(p: Omit<TimeBankSettings, 'enabled' | 'memberRooms'>): 'initial_over_max' | 'unit_over_max' | 'whole_seconds' | null {
  if ([p.initialMs, p.maxMs, p.unitMs, p.refillMs].some((ms) => ms % 1_000 !== 0)) return 'whole_seconds';
  if (p.initialMs > p.maxMs) return 'initial_over_max';
  if (p.unitMs > p.maxMs) return 'unit_over_max';
  return null;
}
