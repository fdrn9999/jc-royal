/**
 * What the others at the table are likely to hold, from what they did in public. Before the flop each player gets a
 * range from their position and their last action (open, 3-bet, call, all in, …), sized by how they bet and, for the
 * levels that adapt, by their own statistics. After the flop every bet, raise, call and check they made reweights each
 * combination by how likely a hand of that strength would have made it. Heuristic ranges, not solver output.
 */
import { comboWeights } from './equity';
import { PRIORS, BIG_BET, bigBetRead, OVERBET, OVERBET_SAMPLE, type Tendencies } from './profile';
import { addRange, bandRange, FULL_RANGE, topRange, type Range } from './ranges';
import { AIR, bucketOf, DRAW, MEDIUM, strengthTable, STRONG, WEAK } from './strength';
import { isStealPos, type ActEvent, type Pos, type Seating } from './walk';

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Share of starting hands opened by players left to act behind the opener (index 1: the small blind, 3+ handed). */
const OPEN_BY_BEHIND = [1, 0.4, 0.45, 0.28, 0.21, 0.17, 0.14, 0.12, 0.105, 0.095];
export function openWidth(dealt: number, behind: number): number {
  if (dealt <= 2) return 0.8;
  return OPEN_BY_BEHIND[clamp(behind, 1, OPEN_BY_BEHIND.length - 1)]!;
}

/** Share of hands shoved all in first in with `effBB` big blinds, by players left behind (about push/fold charts). */
const PUSH_BY_BEHIND = [1, 0.58, 0.4, 0.29, 0.23, 0.19, 0.16, 0.14, 0.12, 0.11];
export function pushWidth(effBB: number, behind: number): number {
  const base = PUSH_BY_BEHIND[clamp(behind, 1, PUSH_BY_BEHIND.length - 1)]!;
  return clamp(base * Math.pow(10 / Math.max(1, effBB), 0.7), 0.03, 0.95);
}

/** Share of hands a player shoves all in with when the shove is `toBB` big blinds (a first-in shove). */
const JAM_POINTS: readonly [number, number][] = [
  [10, 0.4],
  [15, 0.28],
  [25, 0.16],
  [40, 0.08],
  [100, 0.035],
];
export function jamWidth(toBB: number): number {
  if (toBB <= 10) return Math.min(0.9, 0.4 * Math.pow(10 / Math.max(1, toBB), 0.6));
  for (let i = 1; i < JAM_POINTS.length; i++) {
    const [x1, y1] = JAM_POINTS[i - 1]!;
    const [x2, y2] = JAM_POINTS[i]!;
    if (toBB <= x2) return y1 + ((y2 - y1) * Math.log(toBB / x1)) / Math.log(x2 / x1);
  }
  return 0.03;
}

/** A first raise's usual size in big blinds (the small blind raises a little bigger, plus one per limper). */
export const expectedOpen = (pos: Pos | undefined, dealt: number, limpers: number) => (dealt > 2 && pos === 'SB' ? 3 : 2.5) + limpers;

/** A 3-betting range: mostly the best hands plus a slice of suited, playable hands as bluffs. */
export const polarRange = (w: number): Range => addRange(topRange(w * 0.65), bandRange(0.2, 0.2 + w * 0.35));

export type RoleKind = 'open' | '3bet' | '4bet' | 'jam' | 'call' | 'limp' | 'complete' | 'check';

export interface Role {
  kind: RoleKind;
  /** Raises before their last action (0 none). */
  level: number;
  /** Share of starting hands the range holds, roughly. */
  width: number;
  range: Range;
  /** They made the first raise of the hand. */
  opened: boolean;
}

/** One replayed action with the street's state just before it. */
export interface Logged {
  e: ActEvent;
  /** Highest total on the street before the action. */
  betBefore: number;
  limpers: number;
  callers: number;
}

/**
 * Each player's range from their last voluntary action before the flop. Players who folded are left out; players who
 * have not acted yet (or only posted a blind) have no role. `tendOf` gives a player's statistics (levels that adapt).
 */
export function preflopRoles(seats: Seating, log: readonly Logged[], bb: number, tendOf: (seat: number) => Tendencies | undefined): Map<number, Role> {
  const dealt = seats.preflop.length;
  const roles = new Map<number, Role>();
  let openW = 0.25;
  let jamW = 0.1;
  for (const { e, betBefore, limpers } of log) {
    if (e.stage !== 'preflop') continue;
    if (e.kind === 'fold') {
      roles.delete(e.seat);
      continue;
    }
    const t = tendOf(e.seat);
    const pos = seats.pos.get(e.seat);
    const idx = seats.preflop.indexOf(e.seat);
    const behind = idx < 0 ? 2 : dealt - 1 - idx;
    const toBB = e.to / bb;
    const opened = roles.get(e.seat)?.opened ?? false;
    const vpipAdj = t ? clamp(t.vpip / PRIORS.vpip, 0.6, 2.5) : 1;
    let role: Role;
    if (e.kind === 'raise' && e.allIn && toBB > 1) {
      let w = jamWidth(toBB) * (e.level === 0 ? 1 : e.level === 1 ? 0.6 : 0.45);
      // A player who shoves often shoves wide: their share of all-in raises per hand is a floor on the range.
      if (t) w = Math.max(w, Math.min(0.9, t.jam * 1.1));
      w = clamp(w, 0.02, 0.95);
      jamW = w;
      if (e.level === 0) openW = w;
      role = { kind: 'jam', level: e.level, width: w, range: topRange(w), opened: opened || e.level === 0 };
    } else if (e.kind === 'raise' && e.level === 0) {
      let w = openWidth(dealt, behind) * (limpers ? 0.6 : 1);
      if (t) w *= isStealPos(pos) && !limpers ? clamp(t.steal / PRIORS.steal, 0.4, 2.3) : clamp(t.pfr / PRIORS.pfr, 0.35, 3);
      // A bigger open than usual means a stronger range, unless this player opens big all the time.
      const ratio = toBB / expectedOpen(pos, dealt, limpers);
      if (ratio > 1.15) {
        const tight = 1 / (1 + 0.3 * Math.log2(ratio));
        const relax = t ? clamp((t.bigOpen - PRIORS.bigOpen) / 0.45, 0, 1) : 0;
        w *= tight + (1 - tight) * relax;
      }
      w = clamp(w, 0.025, 0.95);
      openW = w;
      role = { kind: 'open', level: 0, width: w, range: topRange(w), opened: true };
    } else if (e.kind === 'raise' && e.level === 1) {
      let w = clamp(0.03 + 0.2 * openW, 0.04, 0.14);
      if (t) w *= clamp(t.threeBet / PRIORS.threeBet, 0.5, 3);
      const ratio = e.to / Math.max(1, betBefore);
      if (ratio > 4.5) w /= 1 + 0.25 * Math.log2(ratio / 4.5);
      w = clamp(w, 0.025, 0.45);
      role = { kind: '3bet', level: 1, width: w, range: polarRange(w), opened };
    } else if (e.kind === 'raise') {
      let w = e.level === 2 ? 0.03 : 0.02;
      if (t) w *= clamp(t.fourBet / PRIORS.fourBet, 0.6, 3);
      w = clamp(w, 0.015, 0.2);
      role = { kind: '4bet', level: e.level, width: w, range: topRange(w), opened };
    } else if (e.kind === 'call' && e.facingAllIn) {
      const w = clamp(jamW * 0.55, 0.02, 0.6);
      role = { kind: 'call', level: e.level, width: w, range: topRange(w), opened };
    } else if (e.kind === 'call' && e.level === 0) {
      if (dealt > 2 && pos === 'SB') role = { kind: 'complete', level: 0, width: 0.62, range: bandRange(0.08, Math.min(1, 0.7 * vpipAdj), 0.3), opened };
      else {
        const to = Math.min(1, 0.45 * vpipAdj);
        role = { kind: 'limp', level: 0, width: to - 0.03, range: bandRange(0.03, to, 0.3), opened };
      }
    } else if (e.kind === 'call' && e.level === 1) {
      const to = Math.min(0.95, (pos === 'BB' ? openW + 0.35 : pos === 'SB' ? openW + 0.1 : openW * 0.8 + 0.06) * vpipAdj);
      const from = pos === 'BB' ? 0.05 : 0.04;
      role = { kind: 'call', level: 1, width: to - from, range: bandRange(from, to, pos === 'BB' ? 0.25 : 0.3), opened };
    } else if (e.kind === 'call' && e.level === 2) {
      const to = opened ? clamp(openW * 0.55 + 0.02, 0.05, 0.35) : 0.07;
      role = { kind: 'call', level: 2, width: to - 0.02, range: bandRange(0.02, to, 0.35), opened };
    } else if (e.kind === 'call') {
      role = { kind: 'call', level: e.level, width: 0.032, range: bandRange(0.008, 0.04, 0.6), opened };
    } else {
      // The big blind checking its option: anything but most of its best hands.
      role = { kind: 'check', level: 0, width: 0.88, range: bandRange(0.12, 1, 0.35), opened };
    }
    roles.set(e.seat, role);
  }
  return roles;
}

// --------------------------------------------------------------------------------------- after the flop

/** How likely a hand of each bucket (air, weak, draw, medium, strong) is to bet: up to 0.6 pot, up to a pot, more. */
const BET = [
  [0.3, 0.2, 0.14],
  [0.2, 0.12, 0.06],
  [0.45, 0.45, 0.3],
  [0.5, 0.35, 0.15],
  [0.85, 0.85, 0.8],
];
const RAISE = [0.06, 0.03, 0.2, 0.1, 0.55];
const CHECK = [0.75, 0.8, 0.55, 0.55, 0.25];
/** Calling a bet of up to 0.4 pot, up to 0.8, more. */
const CALL = [
  [0.08, 0.06, 0.04],
  [0.5, 0.3, 0.12],
  [0.75, 0.75, 0.5],
  [0.8, 0.8, 0.55],
  [0.45, 0.45, 0.45],
];

/**
 * How likely a hand of each bucket is to call or re-raise if the bot raises: mostly strong hands, some medium hands
 * and draws, almost no air (bluffs give up against a raise).
 */
export const CONTINUE_VS_RAISE = [0.02, 0.06, 0.3, 0.35, 1];

/** Per bucket, how likely a hand there was to take this action (relative weights). */
export function likelihoods(e: ActEvent, t?: Tendencies): number[] {
  if (e.kind === 'check') return CHECK.slice();
  if (e.kind === 'call') {
    const k = e.facingSize <= 0.4 ? 0 : e.facingSize <= 0.8 ? 1 : 2;
    const l = CALL.map((row) => row[k]!);
    if (t) {
      // Players who go to showdown a lot call with weaker hands.
      const m = clamp(t.wtsd / PRIORS.wtsd, 0.7, 2.5);
      l[AIR]! *= m;
      l[WEAK]! *= m;
    }
    return l;
  }
  if (e.kind !== 'raise') return [1, 1, 1, 1, 1];
  const l = e.toCall > 0 ? RAISE.slice() : BET.map((row) => row[e.size <= 0.6 ? 0 : e.size <= 1 ? 1 : 2]!);
  if (e.toCall === 0 && e.rivals > 1) {
    // A bet into several players is seldom a bluff or a thin bet: more of them can call (the bots' own continuation
    // bets shrink the same way).
    const k = e.rivals - 1;
    l[AIR]! *= Math.pow(0.45, k);
    l[WEAK]! *= Math.pow(0.45, k);
    l[MEDIUM]! *= Math.pow(0.7, k);
    l[DRAW]! *= Math.pow(0.8, k);
  }
  if (t) {
    if (e.size >= BIG_BET) {
      if (e.size > OVERBET) {
        // A player who overbets at many of their chances cannot be doing it only with strong hands: the more often,
        // the closer their overbets come to their whole range. The rate is smoothed toward the population's and counts
        // in full only after enough chances, so a few overbets in a row move it little.
        const sure = clamp(t.overbetChances / OVERBET_SAMPLE, 0, 1);
        const m = clamp((t.overbet - PRIORS.overbet) / 0.15, 0, 0.85) * sure;
        for (let b = 0; b < l.length; b++) l[b] = l[b]! * (1 - m) + l[STRONG]! * m;
      }
      // Big bets shown down: how often they turned out to be bluffs, against the usual three in ten. Too few shown
      // reads as unknown, and the population's mix stands.
      if (bigBetRead(t) !== 'unknown') {
        const r = clamp(t.bigBetBluff, 0.02, 0.95);
        const bluffs = clamp(r / (1 - r) / (0.3 / 0.7), 0.5, 3.5);
        l[AIR]! *= bluffs;
        l[WEAK]! *= bluffs;
      }
    } else {
      const m = clamp(t.af / PRIORS.af, 0.6, 2);
      l[AIR]! *= m;
      l[DRAW]! *= m;
    }
  }
  return l;
}

const STAGE_CARDS = { flop: 3, turn: 4, river: 5 } as const;

/**
 * A player's combinations after their actions on the flop, turn and river: each action multiplies every combination
 * by how likely a hand of its strength on that street's board was to take it. Never empties the range: an action that
 * would leave nothing (a line no model predicts) is ignored.
 */
export function narrow(weights: Float64Array, seat: number, log: readonly Logged[], board: readonly number[], t?: Tendencies): Float64Array {
  const w = weights.slice();
  const next = new Float64Array(w.length);
  for (const { e } of log) {
    if (e.seat !== seat || e.stage === 'preflop' || e.kind === 'fold') continue;
    const cards = STAGE_CARDS[e.stage as keyof typeof STAGE_CARDS];
    if (!cards || board.length < cards) continue;
    const table = strengthTable(board.slice(0, cards));
    const l = likelihoods(e, t);
    let sum = 0;
    for (let i = 0; i < w.length; i++) {
      const x = w[i]!;
      const hs = table.hs[i]!;
      if (!x || hs < 0) {
        next[i] = 0;
        continue;
      }
      const v = x * l[bucketOf(hs, table.draws[i]!)]!;
      next[i] = v;
      sum += v;
    }
    if (sum > 0) w.set(next);
  }
  return w;
}

/** Combination weights for a player: their preflop range (or any two cards), narrowed by what they did after it. */
export function villainWeights(role: Role | undefined, seat: number, log: readonly Logged[], board: readonly number[], dead: readonly number[], t?: Tendencies): Float64Array {
  const base = comboWeights(role?.range ?? FULL_RANGE, dead);
  return board.length >= 3 ? narrow(base, seat, log, board, t) : base;
}

export { STRONG };
