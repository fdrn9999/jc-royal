/**
 * The viewer's own decisions in a finished hand, and what can honestly be said about each one beside the replay (its
 * decision review, StrategyPanel). Built from the stored record alone, as the replay is: the actions, the stacks and
 * the viewer's own cards; never a card the record does not already show the viewer, and only for finished hands.
 *
 * What is said comes in kinds kept apart (AnalysisKind), so one never passes for another:
 *  - math: plain arithmetic of the moment (pot odds, the size of the bet faced, the stack-to-pot ratio, the effective
 *    stack) and what the viewer's cards made and drew to with the board then (handNow);
 *  - heuristic: in the one spot they were drawn for, the academy's illustrative opening ranges. A teaching picture,
 *    not a verdict;
 *  - solver: how often each choice is played (and its EV, where given) from a provider holding real solver output for
 *    the spot (SolverProvider, asked only what the viewer knew: requestOf), always shown with its source;
 *  - unavailable: no solver is connected (SOLVER_PROVIDERS is empty, so for now every spot reads so), none covers the
 *    spot, or the analysis failed. Never a guessed frequency in its place.
 */
import { BACKDOOR_FLUSH, cardCode, drawFlags, FLUSH_DRAW, GUTSHOT, NUT_FLUSH_DRAW, OPEN_ENDED, OVERCARDS } from '@jc/poker-engine/draws';
import { evaluateKnown, rankClassIndex, rankValue, type Evaluation } from '@jc/poker-engine/evaluate';
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
  // The street's largest raise (blinds not counted) and its highest total just after each player's last action on it:
  // what decides, as the engine rules it, whether raising is still open to a player who already acted.
  let raiseSize = 0;
  const actedAt = new Map<number, number>();
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
      raiseSize = 0;
      actedAt.clear();
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
      // After acting, the viewer may raise again only once the bet has grown by a full raise: an all-in short of one
      // leaves them to call or fold. Facing a lone all-in the table still offers a raise, and so does this.
      const acted = actedAt.get(me.seatIndex);
      const reopened = acted === undefined || top - acted >= Math.max(raiseSize, bb);
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
        options: owed === 0 ? ['check', top > 0 ? 'raise' : 'bet'] : left > owed && reopened ? ['fold', 'call', 'raise'] : ['fold', 'call'],
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
      raiseSize = Math.max(raiseSize, on - top);
      top = on;
    }
    actedAt.set(a.seatIndex, top);
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
/**
 * The solver's part of a decision: real output, or why there is none: no solver connected, none covering the spot, a
 * position the record does not settle, or an analysis that failed (an error, or no answer in time).
 */
export type SolverAnswer = SolverStrategy | { kind: 'unsupported'; reason: 'noSolver' | 'noData' | 'noPosition' } | { kind: 'failed' };

/**
 * What a solver is asked about one decision: only what the viewer knew as it came to them. Their own two cards, the
 * board as far as it had come, the chips (every stack is on the table for all to see) and the actions before it, which
 * the whole table saw. No other player's cards (even ones shown later at showdown), no card still to come, nothing that
 * happened after.
 */
export interface SolverRequest {
  stage: DecisionStage;
  position: string;
  heroSeat: number;
  buttonSeat: number | null;
  bigBlind: number | null;
  dealt: number;
  live: number;
  pot: number;
  toCall: number;
  stack: number;
  effective: number;
  streetPot: number;
  cards: Card[] | null;
  board: Card[];
  options: Choice[];
  /** Each player's chips as the hand was dealt. */
  stacks: { seat: number; chips: number }[];
  /** The hand's actions before the decision, in order (chips each added). */
  line: { stage: string; seat: number; type: string; amount: number }[];
}

export type SolverStatus = 'queued' | 'running' | 'done' | 'failed' | 'unsupported';

/**
 * A source of real solver output, which may take its time: `analyze` starts an analysis of the spot (null: a spot it
 * does not cover), `getStatus` follows it, `getResult` reads it once done. It works on a finished hand's record only,
 * from the replay, so nothing about it touches a table being played.
 */
export interface SolverProvider {
  id: string;
  analyze(req: SolverRequest): Promise<string | null>;
  getStatus(job: string): Promise<SolverStatus>;
  getResult(job: string): Promise<Omit<SolverStrategy, 'kind'> | null>;
}

/** The solvers the app has: none yet. A provider added here must hold real solver output and name its source. */
export const SOLVER_PROVIDERS: readonly SolverProvider[] = [];

/** The question put to a solver about `d`, from what the viewer knew then (see SolverRequest). */
export function requestOf(d: Decision, hand: ReplayInput, heroSeat: number): SolverRequest {
  return {
    stage: d.stage,
    position: d.position ?? '',
    heroSeat,
    buttonSeat: hand.buttonSeat,
    bigBlind: hand.bigBlind ?? null,
    dealt: d.dealt,
    live: d.live,
    pot: d.pot,
    toCall: d.toCall,
    stack: d.stack,
    effective: d.effective,
    streetPot: d.streetPot,
    cards: d.cards ? [...d.cards] : null,
    board: d.board.slice(0, BOARD_AT[d.stage]),
    options: [...d.options],
    stacks: hand.players.map((p) => ({ seat: p.seatIndex, chips: p.stackStart })),
    line: hand.actions.slice(0, d.action).map((a) => ({ stage: a.stage, seat: a.seatIndex, type: a.type, amount: a.amount })),
  };
}

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

/** Why there can be no solver answer for `d` without asking any solver; null when one may be asked. */
export function solverUnavailable(d: Decision, providers: readonly SolverProvider[] = SOLVER_PROVIDERS): SolverAnswer | null {
  if (providers.length === 0) return { kind: 'unsupported', reason: 'noSolver' };
  if (!d.position) return { kind: 'unsupported', reason: 'noPosition' };
  return null;
}

export interface SolverWait {
  /** Stops following the analysis (the review closed, another decision picked). */
  signal?: AbortSignal;
  /** How long between looks at its status, and how long it may take in all before it counts as failed. */
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** What `call` comes back with, or a failure once `ms` have gone by or `signal` stops it: a call that never answers holds nothing up. */
function bounded<T>(call: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((done, fail) => {
    const end = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      end();
      fail(new Error('stopped'));
    };
    const timer = setTimeout(stop, Math.max(0, ms));
    signal?.addEventListener('abort', stop, { once: true });
    call.then(
      (v) => {
        end();
        done(v);
      },
      (e: unknown) => {
        end();
        fail(e);
      },
    );
  });
}

/**
 * The first provider's usable answer for the decision, or why there is none. A provider that covers no such spot, or
 * answers with something unusable, passes it on to the next; one that fails (an error, a failed status, no answer in
 * time) too, and the decision reads as failed if no other answers.
 */
export async function solverFor(d: Decision, hand: ReplayInput, heroSeat: number, providers: readonly SolverProvider[] = SOLVER_PROVIDERS, wait: SolverWait = {}): Promise<SolverAnswer> {
  const now = solverUnavailable(d, providers);
  if (now) return now;
  const { signal, pollMs = 1000, timeoutMs = 60_000, sleep = pause } = wait;
  const req = requestOf(d, hand, heroSeat);
  let failed = false;
  for (const p of providers) {
    if (signal?.aborted) return { kind: 'failed' };
    // Each call too: one that never comes back fails once the provider's time is out (or the review closes).
    const until = Date.now() + timeoutMs;
    const ask = <T>(call: () => Promise<T>) => bounded(call(), until - Date.now(), signal);
    try {
      const job = await ask(() => p.analyze(req));
      if (job === null) continue;
      let status = await ask(() => p.getStatus(job));
      for (let waited = 0; status === 'queued' || status === 'running'; waited += pollMs) {
        if (signal?.aborted) return { kind: 'failed' };
        if (waited >= timeoutMs) {
          status = 'failed';
          break;
        }
        await sleep(pollMs);
        status = await ask(() => p.getStatus(job));
      }
      if (status === 'failed') failed = true;
      if (status !== 'done') continue;
      const r = await ask(() => p.getResult(job));
      if (r && usable(r, d)) return { kind: 'solver', ...r };
    } catch {
      failed = true;
    }
  }
  return failed ? { kind: 'failed' } : { kind: 'unsupported', reason: 'noData' };
}

/**
 * Which kind of analysis a part of the review is, each marked as such so none passes for another: plain arithmetic of
 * the moment (math), a rule of thumb such as the academy's example ranges (heuristic), real solver output (solver), or
 * none to give (unavailable).
 */
export type AnalysisKind = 'math' | 'heuristic' | 'solver' | 'unavailable';

/** The study notes' kinds: the arithmetic is math, the academy's example range a heuristic. */
export const NOTE_KINDS: Record<EducationalNote['kind'], AnalysisKind> = { potOdds: 'math', betSize: 'math', spr: 'math', openRange: 'heuristic' };

/** How the viewer's pair ranks against the board: over it, pairing its top, second or a lower card, a pocket pair under its top card, or the board's own pair. */
export type PairKind = 'over' | 'top' | 'second' | 'low' | 'pocket' | 'board';
/** A draw the viewer held, as the bots read draws (@jc/poker-engine/draws). */
export type DrawKind = 'nutFlush' | 'flush' | 'straight' | 'gutshot' | 'backdoorFlush' | 'overcards';

export interface HandNow {
  /** The best hand of the viewer's cards and the board then (preflop, the two cards alone). */
  made: Evaluation;
  /** For one pair after the flop: how it ranks against the board. */
  pair: PairKind | null;
  /** On the flop and the turn: what more could come, only where it would beat what is made. */
  draws: DrawKind[];
}

const FLUSH_AND_UP = rankClassIndex('flush');
const STRAIGHT = rankClassIndex('straight');

/** What the viewer's two cards made at the decision with the board as it stood, and what they drew to: no card still to come. */
export function handNow(d: Decision): HandNow | null {
  if (d.cards?.length !== 2) return null;
  const board = d.board.slice(0, BOARD_AT[d.stage]);
  const made = evaluateKnown([...d.cards, ...board]);
  if (!made) return null;
  let pair: PairKind | null = null;
  if (made.rankClass === 'pair' && board.length > 0) {
    const p = made.score[1]!;
    const [x, y] = d.cards.map(rankValue) as [number, number];
    const ranks = [...new Set(board.map(rankValue))].sort((a, b) => b - a);
    if (x === y && x === p) pair = p > ranks[0]! ? 'over' : 'pocket';
    else if (x === p || y === p) pair = p === ranks[0] ? 'top' : p === ranks[1] ? 'second' : 'low';
    else pair = 'board';
  }
  const flags = drawFlags(cardCode(d.cards[0]!), cardCode(d.cards[1]!), board.map(cardCode));
  const rank = rankClassIndex(made.rankClass);
  let draws: DrawKind[] = [];
  if (flags & NUT_FLUSH_DRAW) draws.push('nutFlush');
  else if (flags & FLUSH_DRAW) draws.push('flush');
  else if (flags & BACKDOOR_FLUSH) draws.push('backdoorFlush');
  if (flags & OPEN_ENDED) draws.push('straight');
  else if (flags & GUTSHOT) draws.push('gutshot');
  // Two overcards matter while nothing of the viewer's own is made (the board's own pair is everyone's).
  if (flags & OVERCARDS && (made.rankClass === 'high-card' || pair === 'board')) draws.push('overcards');
  // A draw to less than what is made is no draw: nothing beats a made flush here, a straight still draws to a flush.
  if (rank >= FLUSH_AND_UP) draws = [];
  else if (rank === STRAIGHT) draws = draws.filter((k) => k === 'nutFlush' || k === 'flush' || k === 'backdoorFlush');
  return { made, pair, draws };
}
/**
 * What a call cost at the decision, as pot odds: where the viewer called or folded, the certain ones the hand page shows
 * (potOddsFor); where they raised a bet they could have called in full, what that call would have cost. Null with
 * nothing to call, and where the record leaves it uncertain (a call short of the bet plays for part of the pot only).
 */
export function callPrice(d: Decision): PotOdds | null {
  if (d.toCall <= 0) return null;
  if (d.did !== 'raise') return d.odds;
  if (d.toCall >= d.stack) return null;
  return { toCall: d.toCall, pot: d.pot, need: Math.round((d.toCall / (d.pot + d.toCall)) * 100) };
}

/** The stack-to-pot ratio as the street began, from the flop on (null preflop, where it is not yet counted). */
export function sprOf(d: Decision): number | null {
  return d.stage !== 'preflop' && d.streetPot > 0 ? spr(d.streetPot, d.effective) : null;
}

/** Indexes of the actions on the decision's street before it, the blinds included preflop: what the viewer had seen. */
export function beforeOnStreet(hand: ReplayInput, d: Decision): number[] {
  const out: number[] = [];
  hand.actions.forEach((a, k) => {
    if (k < d.action && a.stage === d.stage) out.push(k);
  });
  return out;
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
  const ratio = sprOf(d);
  if (ratio !== null) out.push({ kind: 'spr', ratio, effective: d.effective, pot: d.streetPot });
  const cls = handClass(d.cards);
  const range = d.position ? OPEN_SETS.get(d.position) : undefined;
  const deep = bigBlind && bigBlind > 0 ? d.effective / bigBlind : 0;
  if (d.stage === 'preflop' && d.unopened && range && cls && d.dealt === OPEN_SPOT.players && deep >= OPEN_SPOT.minBb && deep <= OPEN_SPOT.maxBb) {
    out.push({ kind: 'openRange', seat: d.position as OpenSeat, hand: cls, inRange: range.has(cls), opened: d.did === 'raise' || d.did === 'bet' });
  }
  return out;
}
