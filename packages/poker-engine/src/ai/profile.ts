/**
 * Opponent statistics from public play only: what each player did and the chances they had to do it, counted from the
 * hand's public action list, and their cards only when the table saw them at showdown. Every rate keeps its own
 * denominator (the opportunities), so a small sample can be pulled toward a population average (`tendencies`).
 *
 * The same counting serves the table bots (which adapt to these numbers) and the simulations (which report them).
 */
import type { Card } from '@jc/types';
import { allCombos } from './classes';
import { cardCode } from './score';
import { strengthTable } from './strength';
import { isStealPos, seating, walk, type PubAction, type WalkState } from './walk';

export const STAT_KEYS = [
  'hands',
  'vpipOpp',
  'vpip',
  'pfr',
  'threeBetOpp',
  'threeBet',
  'fourBetOpp',
  'fourBet',
  'foldTo3BetOpp',
  'foldTo3Bet',
  'stealOpp',
  'steal',
  'bbStealOpp',
  'bbFoldToSteal',
  'cbetOpp',
  'cbet',
  'foldToCbetOpp',
  'foldToCbet',
  'postBets',
  'postCalls',
  'sawFlop',
  'showdowns',
  'overbets',
  'foldToOverbetOpp',
  'foldToOverbet',
  'jams',
  'allinCallOpp',
  'allinCall',
  'opens',
  'bigOpens',
  'bigBetsShown',
  'bigBetBluffsShown',
  /** Turns after the flop where the player could bet or raise (the denominator of the overbet frequency). */
  'postBetOpp',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Counters = Record<StatKey, number>;

export const emptyCounters = (): Counters => Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Counters;

export function addCounters(into: Counters, add: Partial<Counters>): Counters {
  for (const k of STAT_KEYS) into[k] = (into[k] ?? 0) + (add[k] ?? 0);
  return into;
}

/** Counters as a fixed-order array (for compact storage) and back. */
export const packCounters = (c: Counters): number[] => STAT_KEYS.map((k) => c[k] ?? 0);
export function unpackCounters(a: readonly unknown[]): Counters {
  const c = emptyCounters();
  STAT_KEYS.forEach((k, i) => {
    const v = a[i];
    c[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  });
  return c;
}

/** One finished hand, public parts only. */
export interface HandFacts {
  bigBlind: number;
  buttonSeat: number;
  /** Seats dealt in and their chips at the start of the hand. */
  seats: { seat: number; stack: number }[];
  actions: readonly PubAction[];
  board: readonly Card[];
  /** Hole cards the table saw at showdown. */
  shown: { seat: number; hole: readonly Card[] }[];
  /** Seats that went to a showdown. */
  showdown: readonly number[];
}

/** A bet or raise bigger than the pot. */
export const OVERBET = 1.0;
/** A bet counted as big for reading big bets at showdown. */
export const BIG_BET = 0.9;

/** What a finished hand adds to each dealt seat's counters. */
export function handCounters(f: HandFacts): Map<number, Counters> {
  const out = new Map<number, Counters>();
  for (const s of f.seats) out.set(s.seat, { ...emptyCounters(), hands: 1 });
  const seats = seating(
    f.seats.map((s) => s.seat),
    f.buttonSeat,
  );
  const bbSeat = seats.preflop.at(-1);
  const vpip = new Set<number>();
  const pfr = new Set<number>();
  const faced = new Set<string>();
  const once = (seat: number, key: string) => {
    const k = `${seat}:${key}`;
    if (faced.has(k)) return false;
    faced.add(k);
    return true;
  };
  let opener: number | null = null;
  let steal = false;
  let cbettor: number | null = null;
  const bigBet = new Set<number>();
  walk(new Map(f.seats.map((s) => [s.seat, s.stack])), f.actions, (e, st) => {
    const c = out.get(e.seat);
    if (!c) return;
    if (e.stage === 'preflop') {
      if (e.first) c.vpipOpp++;
      if (e.kind === 'raise' || e.kind === 'call') vpip.add(e.seat);
      if (e.kind === 'raise') pfr.add(e.seat);
      if (e.level === 0) {
        if (!st.limpers.length && isStealPos(seats.pos.get(e.seat)) && once(e.seat, 'steal')) {
          c.stealOpp++;
          if (e.kind === 'raise') c.steal++;
        }
        if (e.kind === 'raise') {
          c.opens++;
          if (e.to >= f.bigBlind * 5) c.bigOpens++;
          opener = e.seat;
          steal = !st.limpers.length && isStealPos(seats.pos.get(e.seat));
        }
      } else if (e.level === 1 && once(e.seat, 'l1')) {
        if (couldRaise(e.seat, e.toCall, st, f.bigBlind)) {
          c.threeBetOpp++;
          if (e.kind === 'raise') c.threeBet++;
        }
        if (e.seat === bbSeat && steal && !st.callers.length) {
          c.bbStealOpp++;
          if (e.kind === 'fold') c.bbFoldToSteal++;
        }
      } else if (e.level === 2 && once(e.seat, 'l2')) {
        if (couldRaise(e.seat, e.toCall, st, f.bigBlind)) {
          c.fourBetOpp++;
          if (e.kind === 'raise') c.fourBet++;
        }
        if (e.seat === opener) {
          c.foldTo3BetOpp++;
          if (e.kind === 'fold') c.foldTo3Bet++;
        }
      }
      if (e.kind === 'raise' && e.allIn) c.jams++;
    } else {
      if (!e.facingAllIn && (st.stack.get(e.seat) ?? 0) > e.toCall) c.postBetOpp++;
      if (e.kind === 'raise') {
        c.postBets++;
        if (e.size > OVERBET) c.overbets++;
        if (e.size >= BIG_BET) bigBet.add(e.seat);
      } else if (e.kind === 'call') c.postCalls++;
      if (e.facingSize > OVERBET && once(e.seat, `ob:${e.stage}:${st.level}`)) {
        c.foldToOverbetOpp++;
        if (e.kind === 'fold') c.foldToOverbet++;
      }
      if (e.stage === 'flop') {
        if (e.seat === st.preflopAggressor && e.level === 0 && once(e.seat, 'cbet')) {
          c.cbetOpp++;
          if (e.kind === 'raise') {
            c.cbet++;
            cbettor = e.seat;
          }
        }
        if (cbettor !== null && e.aggressor === cbettor && e.level === 1 && e.seat !== cbettor && once(e.seat, 'fcb')) {
          c.foldToCbetOpp++;
          if (e.kind === 'fold') c.foldToCbet++;
        }
      }
    }
    if (e.facingAllIn && once(e.seat, 'allin')) {
      c.allinCallOpp++;
      if (e.kind === 'call') c.allinCall++;
    }
  });
  for (const s of vpip) out.get(s)!.vpip++;
  for (const s of pfr) out.get(s)!.pfr++;
  if (f.board.length >= 3) for (const s of f.seats) if (!preflopFolded(f.actions, s.seat)) out.get(s.seat)!.sawFlop++;
  for (const s of f.showdown) {
    const c = out.get(s);
    if (c) c.showdowns++;
  }
  // Big bets the table saw the cards of: a "bluff" is a hand that loses to most hands on the final board.
  if (f.board.length === 5) {
    const table = strengthTable(f.board.map(cardCode));
    for (const sh of f.shown) {
      const c = out.get(sh.seat);
      if (!c || !bigBet.has(sh.seat) || sh.hole.length !== 2) continue;
      c.bigBetsShown++;
      if (handStrength(table, sh.hole) < 0.5) c.bigBetBluffsShown++;
    }
  }
  return out;
}

/**
 * A player could re-raise: chips beyond the call, raising still open to them (the engine's rule: after they acted, the
 * bet must have grown by a full raise — at least the largest raise on the street and a big blind), and another player
 * still in with chips to answer it.
 */
function couldRaise(seat: number, toCall: number, st: WalkState, bigBlind: number): boolean {
  if ((st.stack.get(seat) ?? 0) <= toCall) return false;
  const acted = st.actedAt.get(seat);
  if (acted !== undefined && st.bet - acted < Math.max(st.raiseSize, bigBlind)) return false;
  for (const [s, chips] of st.stack) if (s !== seat && chips > 0 && !st.folded.has(s)) return true;
  return false;
}

function preflopFolded(actions: readonly PubAction[], seat: number): boolean {
  return actions.some((a) => a.seat === seat && a.stage === 'preflop' && (a.type === 'fold' || a.type === 'timeout-fold'));
}

/** Strength of two hole cards on a board table (share of other combinations beaten). */
export function handStrength(table: ReturnType<typeof strengthTable>, hole: readonly Card[]): number {
  const x = cardCode(hole[0]!);
  const y = cardCode(hole[1]!);
  return comboStrength(table, x, y);
}

export function comboStrength(table: ReturnType<typeof strengthTable>, x: number, y: number): number {
  const index = comboIndex(x, y);
  return index < 0 ? 0 : Math.max(0, table.hs[index]!);
}

let indexOf: Int16Array | null = null;
/** Index of a two-card combination in `allCombos()` (either card order), or −1. */
export function comboIndex(x: number, y: number): number {
  if (!indexOf) {
    indexOf = new Int16Array(64 * 64).fill(-1);
    const { a, b } = allCombos();
    for (let i = 0; i < a.length; i++) {
      indexOf[a[i]! * 64 + b[i]!] = i;
      indexOf[b[i]! * 64 + a[i]!] = i;
    }
  }
  return indexOf[x * 64 + y]!;
}

// ---------------------------------------------------------------------------------------------- tendencies

export type PlayerType = 'unknown' | 'TP' | 'TAG' | 'LP' | 'LAG';

export interface Tendencies {
  hands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  fourBet: number;
  foldTo3Bet: number;
  steal: number;
  foldBBToSteal: number;
  cbet: number;
  foldToCbet: number;
  /** Postflop bets and raises per call. */
  af: number;
  /** Showdowns per flop seen. */
  wtsd: number;
  /** Bets and raises bigger than the pot per turn after the flop where the player could bet or raise. */
  overbet: number;
  /** Weight of the evidence behind `overbet` (turns after the flop where the player could bet or raise). */
  overbetChances: number;
  foldToOverbet: number;
  /** Preflop all-in raises per hand played. */
  jam: number;
  allinCall: number;
  /** Share of opens of five big blinds or more. */
  bigOpen: number;
  /** Share of big bets shown down with a hand that loses to most hands. */
  bigBetBluff: number;
  /** Weight of the evidence behind `bigBetBluff` (big bets shown). */
  bigBetsShown: number;
  type: PlayerType;
}

/** Population averages every rate starts from. */
export const PRIORS = {
  vpip: 0.26,
  pfr: 0.18,
  threeBet: 0.07,
  fourBet: 0.06,
  foldTo3Bet: 0.55,
  steal: 0.38,
  foldBBToSteal: 0.45,
  cbet: 0.6,
  foldToCbet: 0.45,
  af: 1.5,
  wtsd: 0.28,
  overbet: 0.02,
  foldToOverbet: 0.55,
  jam: 0.015,
  allinCall: 0.3,
  bigOpen: 0.05,
  bigBetBluff: 0.3,
} as const;

const smooth = (x: number, n: number, prior: number, k: number) => (x + prior * k) / (n + k);

/**
 * Rates from counters, each pulled toward its population average by `k` imagined opportunities (bigger k, slower to
 * believe a small sample). Big bets shown at showdown are rarer, so they use half of k (at least 15): one or two
 * hands shown move the read little. Overbets are rare too (about one chance in fifty), so their rate uses six times
 * k (at least 150): three overbets in a row do not make a player an overbettor.
 */
export function tendencies(c: Counters, k: number): Tendencies {
  const ks = Math.max(15, k / 2);
  const ko = Math.max(150, 6 * k);
  const vpip = smooth(c.vpip, c.vpipOpp, PRIORS.vpip, k);
  const pfr = smooth(c.pfr, c.vpipOpp, PRIORS.pfr, k);
  const ka = Math.max(10, k);
  const af = (c.postBets + PRIORS.af * ka) / (c.postCalls + ka);
  const t: Tendencies = {
    hands: c.hands,
    vpip,
    pfr,
    threeBet: smooth(c.threeBet, c.threeBetOpp, PRIORS.threeBet, k),
    fourBet: smooth(c.fourBet, c.fourBetOpp, PRIORS.fourBet, k),
    foldTo3Bet: smooth(c.foldTo3Bet, c.foldTo3BetOpp, PRIORS.foldTo3Bet, k),
    steal: smooth(c.steal, c.stealOpp, PRIORS.steal, k),
    foldBBToSteal: smooth(c.bbFoldToSteal, c.bbStealOpp, PRIORS.foldBBToSteal, k),
    cbet: smooth(c.cbet, c.cbetOpp, PRIORS.cbet, k),
    foldToCbet: smooth(c.foldToCbet, c.foldToCbetOpp, PRIORS.foldToCbet, k),
    af,
    wtsd: smooth(c.showdowns, c.sawFlop, PRIORS.wtsd, k),
    overbet: smooth(c.overbets, c.postBetOpp, PRIORS.overbet, ko),
    overbetChances: c.postBetOpp,
    foldToOverbet: smooth(c.foldToOverbet, c.foldToOverbetOpp, PRIORS.foldToOverbet, k),
    jam: smooth(c.jams, c.vpipOpp, PRIORS.jam, k),
    allinCall: smooth(c.allinCall, c.allinCallOpp, PRIORS.allinCall, k),
    bigOpen: smooth(c.bigOpens, c.opens, PRIORS.bigOpen, k),
    bigBetBluff: smooth(c.bigBetBluffsShown, c.bigBetsShown, PRIORS.bigBetBluff, ks),
    bigBetsShown: c.bigBetsShown,
    type: 'unknown',
  };
  t.type = playerType(t);
  return t;
}

/** Tight or loose by how many hands they play, passive or aggressive by how they play them. */
export function playerType(t: Pick<Tendencies, 'hands' | 'vpip' | 'pfr' | 'af'>): PlayerType {
  if (t.hands < 20) return 'unknown';
  const loose = t.vpip >= 0.32;
  const aggressive = t.pfr / Math.max(0.01, t.vpip) >= 0.55 || t.af >= 2.2;
  return loose ? (aggressive ? 'LAG' : 'LP') : aggressive ? 'TAG' : 'TP';
}

export type BigBetRead = 'unknown' | 'value-heavy' | 'balanced' | 'bluff-heavy';

/** Big bets shown before a player's big bets are read as value-heavy or bluff-heavy at all. */
export const BIG_BET_SAMPLE = 6;
/** Chances to bet after the flop before a player's overbet frequency counts in full (fewer count proportionally less). */
export const OVERBET_SAMPLE = 60;

/**
 * What a player's big bets have turned out to be, from the ones the table saw at showdown only: hands nobody saw are
 * neither bluffs nor value. Too few shown reads as `unknown` (the population average is used).
 */
export function bigBetRead(t: Pick<Tendencies, 'bigBetBluff' | 'bigBetsShown'>): BigBetRead {
  if (t.bigBetsShown < BIG_BET_SAMPLE) return 'unknown';
  if (t.bigBetBluff >= 0.42) return 'bluff-heavy';
  if (t.bigBetBluff <= 0.2) return 'value-heavy';
  return 'balanced';
}

/** Default rates for a player nobody has data on. */
export const unknownTendencies = (): Tendencies => tendencies(emptyCounters(), 1);

