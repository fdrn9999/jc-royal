/**
 * The viewer's own decisions in a finished hand, and what can honestly be said about each one beside the replay (its
 * decision review, StrategyPanel). Built from the stored record alone, as the replay is: the actions, the stacks and
 * the viewer's own cards; never a card the record does not already show the viewer, and only for finished hands.
 *
 * Strategy comes in two kinds kept apart, so one never passes for the other:
 *  - solver: how often each choice is played (and its EV, where given) from a provider holding real solver output for
 *    the spot, always shown with the provider's source. None ships with the app (SOLVER_PROVIDERS is empty), so for
 *    now every spot reads as unsupported there;
 *  - educational: plain arithmetic of the moment (pot odds, the size of the bet faced, the stack-to-pot ratio) and, in
 *    the one spot they were drawn for, the academy's illustrative opening ranges. A teaching picture, not a verdict.
 */
import type { Card } from '@jc/types';
import { MATRIX_RANKS, OPEN_RANGES, parseRange, spr, type HandClass, type OpenSeat } from '../academy/gto/math';
import { seatPositions } from './positions';
import { potOddsFor, type PotOdds } from './potOdds';
import type { ReplayInput, ReplayStep } from './replay';

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type DecisionStage = (typeof STREETS)[number];
/** What a player can choose; an all-in is the call, bet or raise it amounts to. */
export type Choice = 'fold' | 'check' | 'call' | 'bet' | 'raise';

const BLINDS = new Set(['post-sb', 'post-bb']);
const FOLDS = new Set(['fold', 'timeout-fold']);
const TIMEOUTS = new Set(['timeout-fold', 'timeout-check']);

export interface Decision {
  /** The replay step that shows it, and its index among the hand's actions. */
  step: number;
  action: number;
  stage: DecisionStage;
  /** BTN, SB, CO …; null where the record does not say it plainly (see seatPositions). */
  position: string | null;
  /** Players dealt in, and those still in the hand when it came to the viewer (the viewer included). */
  dealt: number;
  live: number;
  /** Chips in the middle when it came to the viewer, every bet so far included. */
  pot: number;
  /** What a call cost, no more than the viewer had left; 0 with nothing to call. */
  toCall: number;
  /** The viewer's chips behind then. */
  stack: number;
  /** The viewer's stack against the deepest other player still in: preflop as dealt, later as the street began. */
  effective: number;
  /** The pot as the street began. */
  streetPot: number;
  /** The last bet or raise of the street the viewer faced (to its total on the street), the pot before it, and how many there were. */
  facing: { kind: 'bet' | 'raise'; to: number; potBefore: number; raises: number } | null;
  /** Preflop, nobody had put chips in but the blinds. */
  unopened: boolean;
  options: Choice[];
  /** What the viewer did, whether that was every chip, and whether the clock chose it. */
  did: Choice;
  allIn: boolean;
  timedOut: boolean;
  /** A bet or raise to this total on the street; a call by what it added; 0 otherwise. */
  amount: number;
  /** The viewer's cards, from the record. */
  cards: Card[] | null;
  board: Card[];
  /** Pot odds where the record makes them certain (the same as the hand page's, potOddsFor). */
  odds: PotOdds | null;
}

const BOARD_AT: Record<DecisionStage, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const sum = (xs: Iterable<number>) => [...xs].reduce((a, b) => a + b, 0);

/** Every decision the viewer (`heroSeat`) made in the hand, blinds aside, in order. */
export function decisionsOf(hand: ReplayInput, steps: readonly ReplayStep[], heroSeat: number | null): Decision[] {
  const me = heroSeat === null ? undefined : hand.players.find((p) => p.seatIndex === heroSeat);
  if (!me) return [];
  const startOf = new Map(hand.players.map((p) => [p.seatIndex, p.stackStart]));
  const positions = seatPositions(
    hand.players.map((p) => p.seatIndex),
    hand.buttonSeat,
    hand.actions.filter((a) => a.stage === 'preflop'),
  );
  const odds = potOddsFor({ actions: hand.actions, players: hand.players.map((p) => ({ seatIndex: p.seatIndex, isYou: p.seatIndex === me.seatIndex, stackStart: p.stackStart })) });
  const bb = hand.bigBlind ?? 0;
  const put = new Map<number, number>();
  const street = new Map<number, number>();
  const folded = new Set<number>();
  const behind = (s: number) => (startOf.get(s) ?? 0) - (put.get(s) ?? 0);
  let stage = '';
  let top = 0;
  let facing: Decision['facing'] = null;
  let raises = 0;
  let streetPot = 0;
  let streetBehind = new Map<number, number>();
  let voluntary = false;
  const out: Decision[] = [];

  hand.actions.forEach((a, k) => {
    if (a.stage !== stage) {
      stage = a.stage;
      street.clear();
      top = 0;
      facing = null;
      raises = 0;
      streetPot = sum(put.values());
      streetBehind = new Map(hand.players.map((p) => [p.seatIndex, behind(p.seatIndex)]));
    }
    const added = Math.max(0, a.amount);
    const at = STREETS.indexOf(a.stage as DecisionStage);
    if (a.seatIndex === me.seatIndex && at >= 0 && !BLINDS.has(a.type)) {
      const s = STREETS[at]!;
      const left = behind(me.seatIndex);
      const owed = Math.max(0, top - (street.get(me.seatIndex) ?? 0));
      const others = hand.players.filter((p) => p.seatIndex !== me.seatIndex && !folded.has(p.seatIndex));
      const depth = (seat: number) => (s === 'preflop' ? (startOf.get(seat) ?? 0) : (streetBehind.get(seat) ?? 0));
      const on = (street.get(me.seatIndex) ?? 0) + added;
      const allIn = a.type === 'allin' || (left > 0 && added >= left);
      const did: Choice = FOLDS.has(a.type) ? 'fold' : added === 0 ? 'check' : on <= top ? 'call' : top === 0 ? 'bet' : 'raise';
      out.push({
        step: steps.findIndex((x) => x.kind === 'action' && x.actions[0] === a),
        action: k,
        stage: s,
        position: positions.get(me.seatIndex) ?? null,
        dealt: hand.players.length,
        live: others.length + 1,
        pot: sum(put.values()),
        toCall: Math.min(owed, left),
        stack: left,
        effective: Math.min(depth(me.seatIndex), Math.max(0, ...others.map((p) => depth(p.seatIndex)))),
        streetPot,
        facing: owed > 0 ? facing : null,
        unopened: s === 'preflop' && !voluntary,
        options: owed === 0 ? ['check', top > 0 ? 'raise' : 'bet'] : left > owed ? ['fold', 'call', 'raise'] : ['fold', 'call'],
        did,
        allIn,
        timedOut: TIMEOUTS.has(a.type),
        amount: did === 'call' ? added : did === 'bet' || did === 'raise' ? on : 0,
        cards: (me.holeCards as Card[] | null) ?? null,
        board: (hand.board as Card[]).slice(0, BOARD_AT[s]),
        odds: odds.get(k) ?? null,
      });
    }
    const potBefore = sum(put.values());
    put.set(a.seatIndex, (put.get(a.seatIndex) ?? 0) + added);
    const on = (street.get(a.seatIndex) ?? 0) + added;
    street.set(a.seatIndex, on);
    if (FOLDS.has(a.type)) folded.add(a.seatIndex);
    if (BLINDS.has(a.type)) {
      // A blind sets the price as posted, or the big blind's size where a short stack posted less.
      top = Math.max(top, on, a.type === 'post-bb' ? bb : 0);
      return;
    }
    if (on > top) {
      raises += 1;
      facing = { kind: top === 0 ? 'bet' : 'raise', to: on, potBefore, raises };
      top = on;
    }
    if (added > 0) voluntary = true;
  });
  return out;
}

/** The class of two hole cards: "AA", "AKs", "AKo" (the higher rank first); null for anything else. */
export function handClass(cards: readonly Card[] | null): HandClass | null {
  if (cards?.length !== 2) return null;
  const [x, y] = cards as [Card, Card];
  const ix = MATRIX_RANKS.indexOf(x[0] as (typeof MATRIX_RANKS)[number]);
  const iy = MATRIX_RANKS.indexOf(y[0] as (typeof MATRIX_RANKS)[number]);
  if (ix < 0 || iy < 0) return null;
  if (ix === iy) return `${x[0]}${y[0]}`;
  const [hi, lo] = ix < iy ? [x[0], y[0]] : [y[0], x[0]];
  return `${hi}${lo}${x[1] === y[1] ? 's' : 'o'}`;
}

/** Real solver output for a spot: who computed it and how (shown with it), and how often each choice is played. */
export interface SolverStrategy {
  kind: 'solver';
  source: string;
  /** Share of each choice, 0..1, adding up to 1. */
  freqs: { choice: Choice; share: number }[];
  /** Expected value of each choice in big blinds, where the data has it. */
  ev?: { choice: Choice; bb: number }[];
}
export type SolverAnswer = SolverStrategy | { kind: 'unsupported'; reason: 'noData' | 'noPosition' };

/** A source of real solver output: what it holds for a decision, or null for a spot it does not cover. */
export interface StrategyProvider {
  id: string;
  lookup(d: Decision, hand: ReplayInput): Omit<SolverStrategy, 'kind'> | null;
}

/** The solver data the app has: none yet. A provider added here must hold real solver output and name its source. */
export const SOLVER_PROVIDERS: readonly StrategyProvider[] = [];

/** Frequencies a provider gave that can stand as an answer: its own source named, the decision's own choices, adding to 1. */
function usable(r: Omit<SolverStrategy, 'kind'>, d: Decision): boolean {
  const ok = (c: Choice) => d.options.includes(c);
  const total = sum(r.freqs.map((f) => f.share));
  return (
    r.source.trim().length > 0 &&
    r.freqs.length > 0 &&
    r.freqs.every((f) => ok(f.choice) && Number.isFinite(f.share) && f.share >= 0 && f.share <= 1) &&
    Math.abs(total - 1) <= 0.02 &&
    (r.ev ?? []).every((e) => ok(e.choice) && Number.isFinite(e.bb))
  );
}

/** The first provider's answer for the decision, or why there is none. */
export function solverFor(d: Decision, hand: ReplayInput, providers: readonly StrategyProvider[] = SOLVER_PROVIDERS): SolverAnswer {
  if (!d.position) return { kind: 'unsupported', reason: 'noPosition' };
  for (const p of providers) {
    const r = p.lookup(d, hand);
    if (r && usable(r, d)) return { kind: 'solver', ...r };
  }
  return { kind: 'unsupported', reason: 'noData' };
}

/** The academy's picture the opening ranges were drawn for (math.ts OPEN_RANGES): six dealt in, about 100 big blinds deep. */
export const OPEN_SPOT = { players: 6, minBb: 80, maxBb: 125 } as const;
const OPEN_SETS = new Map(Object.entries(OPEN_RANGES).map(([seat, text]) => [seat, parseRange(text)]));

export type EducationalNote =
  | { kind: 'potOdds'; odds: PotOdds }
  | { kind: 'betSize'; to: number; potBefore: number; share: number }
  | { kind: 'spr'; ratio: number; effective: number; pot: number }
  | { kind: 'openRange'; seat: OpenSeat; hand: HandClass; inRange: boolean; opened: boolean };

/** The plain arithmetic of the decision, and the academy's example range where the spot is the one it was drawn for. */
export function educationalFor(d: Decision, bigBlind: number | null): EducationalNote[] {
  const out: EducationalNote[] = [];
  if (d.odds) out.push({ kind: 'potOdds', odds: d.odds });
  if (d.stage !== 'preflop' && d.facing?.kind === 'bet' && d.facing.potBefore > 0) {
    out.push({ kind: 'betSize', to: d.facing.to, potBefore: d.facing.potBefore, share: d.facing.to / d.facing.potBefore });
  }
  if (d.stage !== 'preflop' && d.streetPot > 0) out.push({ kind: 'spr', ratio: spr(d.streetPot, d.effective), effective: d.effective, pot: d.streetPot });
  const cls = handClass(d.cards);
  const range = d.position ? OPEN_SETS.get(d.position) : undefined;
  const deep = bigBlind && bigBlind > 0 ? d.effective / bigBlind : 0;
  if (d.stage === 'preflop' && d.unopened && range && cls && d.dealt === OPEN_SPOT.players && deep >= OPEN_SPOT.minBb && deep <= OPEN_SPOT.maxBb) {
    out.push({ kind: 'openRange', seat: d.position as OpenSeat, hand: cls, inRange: range.has(cls), opened: d.did === 'raise' || d.did === 'bet' });
  }
  return out;
}
