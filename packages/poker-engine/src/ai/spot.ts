/**
 * What a bot reads off its view before it decides: its seat and position, who is still in and who is left to act, the
 * hand's public action replayed (raises, callers, limpers, sizes), the effective stack, and a range of likely hands for
 * every opponent still in. Only public facts go in: the bot's own two cards, the board, stacks, bets, the action list
 * and, for the levels that adapt, statistics counted from earlier hands' public actions and showdowns.
 *
 * Views made by hand (tests, older callers) may lack the seats and the action list; the spot is then inferred from the
 * summary fields alone (`inferred`), a rougher read of the same situation.
 */
import type { BotLevel, Card, HandStage, LegalOption } from '@jc/types';
import { classOfCodes } from './classes';
import { emptyCounters, tendencies, type Counters, type Tendencies } from './profile';
import { levelParams, personaOf, type BotStyle, type LevelParams, type Persona } from './persona';
import { percentile, topRange } from './ranges';
import { cardCode } from './score';
import { bucketOf, strengthTable } from './strength';
import { find, type LegalSpot } from './act';
import { comboWeights, equityVsRanges } from './equity';
import { clamp, CONTINUE_VS_RAISE, likelihoods, openWidth, polarRange, preflopRoles, villainWeights, type Logged, type Role } from './villain';
import { seating, walk, type ActEvent, type Pos, type PubAction, type WalkState } from './walk';

/** A seat as everyone at the table sees it. */
export interface PubSeat {
  seat: number;
  stack: number;
  streetBet: number;
  /** Dealt into this hand. */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
}

/** The view fields a spot is read from (`BotView` in bot.ts). */
export interface ViewLike extends LegalSpot {
  hole: Card[];
  board: Card[];
  stage: HandStage;
  legal: LegalOption[];
  stack: number;
  bigBlind: number;
  opponents: number;
  position: number;
  aggressors: number;
  seat?: number;
  buttonSeat?: number;
  seats?: PubSeat[];
  actions?: PubAction[];
}

export type StatsInput = ReadonlyMap<number, Counters> | Readonly<Record<number, Counters>>;

export interface DecideOptions {
  style?: BotStyle;
  /** Counters per seat, from earlier hands (only the levels that adapt read them). */
  stats?: StatsInput;
  /** Told when the strategy failed and the bot fell back to checking or folding (for statistics; the move is the same). */
  onFallback?: () => void;
}

export interface Opp {
  seat: number;
  role?: Role;
  t?: Tendencies;
  allIn: boolean;
  /** Chips behind plus this street's bet. */
  total: number;
  weights: Float64Array;
}

export interface Spot {
  v: ViewLike;
  level: BotLevel;
  lp: LevelParams;
  persona: Persona;
  rand: () => number;
  hole: number[];
  board: number[];
  bb: number;
  /** Hand class (0 … 168) and where it sits among starting hands (0 best … 1 worst). */
  cls: number;
  pct: number;
  /** Chips to call (the whole stack when calling would put the bot all in). */
  toCall: number;
  /** Highest bet on this street. */
  bet: number;
  /** Raises on this street so far (blinds not counted). */
  raises: number;
  /** Players dealt in, the bot included. */
  dealt: number;
  pos?: Pos;
  /** Opponents still in the hand (all in included). */
  opps: Opp[];
  /** Players still to act after the bot on this street who can still put chips in. */
  behind: number;
  /** Players left to act behind the bot before the flop when nobody has opened (for opening ranges). */
  behindPreflop: number;
  /** Acts after every opponent still able to bet after the flop. */
  ip: boolean;
  /** Acts after the player who made the bet faced (or the last raise before the flop) once the flop is dealt. */
  ipVsRaiser: boolean;
  /** The bet faced came from a player who is now all in. */
  facingAllIn: boolean;
  /** The bet faced, as a share of the pot before it (0 when facing none). */
  facingSize: number;
  /** Seat that made the bet faced, or null. */
  aggressor: number | null;
  /** Smallest of the bot's chips and the biggest opponent's (this street's bets included). */
  eff: number;
  /** Limpers before the first raise and callers of the last raise, before the flop. */
  limpers: number;
  callers: number;
  /** The first raise before the flop: who made it and to how much. */
  opener: number | null;
  openerPos?: Pos;
  openTo: number;
  /** The bot made the last raise before the flop. */
  preflopAggressor: boolean;
  /** Who bet or raised last on the previous streets, by street. */
  streetAggressor: Partial<Record<HandStage, number | null>>;
  /** The bot's own actions on this hand. */
  mine: ActEvent[];
  log: Logged[];
  inferred: boolean;
}

/** The seat that made the bet the bot faces on this street, or, before the flop, the last raiser. */
function facingRaiser(log: readonly Logged[], stage: HandStage, toCall: number): number | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!.e;
    if (e.kind !== 'raise') continue;
    if (e.stage === stage && (toCall > 0 || stage === 'preflop')) return e.seat;
  }
  return null;
}

function statsOf(stats: StatsInput | undefined, seat: number): Counters | undefined {
  if (!stats) return undefined;
  if (stats instanceof Map) return stats.get(seat);
  return (stats as Record<number, Counters>)[seat];
}

/** Counters before `tendencies`, so a player with no record reads as the population average. */
const NONE = emptyCounters();

export function readSpot(level: BotLevel, v: ViewLike, rand: () => number, opts: DecideOptions = {}): Spot {
  const lp = levelParams(level);
  const persona = personaOf(opts.style);
  const hole = v.hole.map(cardCode);
  const board = v.board.map(cardCode);
  const bb = Math.max(1, v.bigBlind);
  const cls = classOfCodes(hole[0]!, hole[1]!);
  const allin = find(v.legal, 'allin');
  const facingBet = !find(v.legal, 'check');
  // With fewer chips than the call, the engine offers only fold and all in: calling costs the whole stack.
  const toCall = v.toCall > 0 ? Math.min(v.toCall, v.stack) : facingBet && allin ? Math.max(0, Math.min(v.stack, allin.amount - v.streetBet)) : 0;
  const base = {
    v,
    level,
    lp,
    persona,
    rand,
    hole,
    board,
    bb,
    cls,
    pct: percentile(cls),
    toCall,
  };
  const tendOf = (seat: number): Tendencies | undefined => (lp.adapt ? tendencies(statsOf(opts.stats, seat) ?? NONE, lp.priorWeight) : undefined);
  if (v.seats && v.actions && v.seat !== undefined && v.buttonSeat !== undefined && v.seats.some((s) => s.seat === v.seat)) return fullSpot(base, v, tendOf);
  return inferredSpot(base, v);
}

type Base = Pick<Spot, 'v' | 'level' | 'lp' | 'persona' | 'rand' | 'hole' | 'board' | 'bb' | 'cls' | 'pct' | 'toCall'>;

function fullSpot(base: Base, v: ViewLike, tendOf: (seat: number) => Tendencies | undefined): Spot {
  const me = v.seat!;
  const seats = v.seats!.filter((s) => s.inHand);
  const bySeat = new Map(seats.map((s) => [s.seat, s]));
  const seat0 = seating(
    seats.map((s) => s.seat),
    v.buttonSeat!,
  );
  // Chips at the start of the hand: what is left plus everything put in.
  const start = new Map<number, number>();
  for (const s of seats) start.set(s.seat, s.stack);
  for (const a of v.actions!) if (start.has(a.seat)) start.set(a.seat, start.get(a.seat)! + Math.max(0, a.amount));
  const log: Logged[] = [];
  const mine: ActEvent[] = [];
  const streetAggressor: Partial<Record<HandStage, number | null>> = {};
  let opener: number | null = null;
  let openTo = 0;
  const st: WalkState = walk(start, v.actions!, (e, s) => {
    log.push({ e, betBefore: s.bet, limpers: s.limpers.length, callers: s.callers.length });
    if (e.seat === me) mine.push(e);
    if (e.kind === 'raise') streetAggressor[e.stage] = e.seat;
    if (e.stage === 'preflop' && e.kind === 'raise' && e.level === 0) {
      opener = e.seat;
      openTo = e.to;
    }
  });
  const sameStreet = st.stage === v.stage;
  const bet = sameStreet ? st.bet : 0;
  const level = sameStreet ? st.level : 0;
  const roles = preflopRoles(seat0, log, base.bb, tendOf);
  const dead = [...base.hole, ...base.board];
  const live = seats.filter((s) => s.seat !== me && !s.folded);
  const opps: Opp[] = live.map((s) => {
    const t = tendOf(s.seat);
    const role = roles.get(s.seat);
    const reads = base.lp.reads ? log : [];
    return { seat: s.seat, role, t, allIn: s.allIn, total: s.stack + s.streetBet, weights: villainWeights(role, s.seat, reads, base.board, dead, t) };
  });
  // Who still acts after the bot on this street.
  const order = v.stage === 'preflop' ? seat0.preflop : seat0.postflop;
  const acted = new Set(log.filter((l) => l.e.stage === v.stage).map((l) => l.e.seat));
  const idx = order.indexOf(me);
  let behind = 0;
  for (let i = idx + 1; i < order.length; i++) {
    const s = bySeat.get(order[i]!);
    if (s && !s.folded && !s.allIn && !acted.has(s.seat)) behind++;
  }
  // The blinds have posted but not acted: before the flop they still count as behind.
  const behindPreflop = Math.max(0, seat0.preflop.length - 1 - seat0.preflop.indexOf(me));
  const able = seat0.postflop.filter((s) => s !== me && bySeat.get(s) && !bySeat.get(s)!.folded && !bySeat.get(s)!.allIn);
  const myPost = seat0.postflop.indexOf(me);
  const ip = able.every((s) => seat0.postflop.indexOf(s) < myPost);
  const raiser = facingRaiser(log, v.stage, base.toCall);
  const ipVsRaiser = raiser === null || seat0.postflop.indexOf(raiser) < myPost;
  const facing = sameStreet && base.toCall > 0 ? log.filter((l) => l.e.stage === v.stage && l.e.kind === 'raise').at(-1) : undefined;
  const aggressor = facing?.e.seat ?? null;
  const myTotal = v.stack + v.streetBet;
  const biggest = Math.max(0, ...opps.map((o) => o.total));
  return {
    ...base,
    bet,
    raises: level,
    dealt: seats.length,
    pos: seat0.pos.get(me),
    opps,
    behind,
    behindPreflop,
    ip,
    ipVsRaiser,
    facingAllIn: aggressor !== null && (bySeat.get(aggressor)?.allIn ?? false),
    facingSize: facing ? facing.e.size : 0,
    aggressor,
    eff: Math.min(myTotal, biggest),
    limpers: st.limpers.length,
    callers: st.callers.length,
    opener,
    openerPos: opener !== null ? seat0.pos.get(opener) : undefined,
    openTo,
    preflopAggressor: st.preflopAggressor === me,
    streetAggressor,
    mine,
    log,
    inferred: false,
  };
}

/** A position label from the summary `position` (postflop order 0 … 1, 1 the button). */
function inferPos(v: ViewLike): { pos: Pos; behind: number } {
  const n = v.opponents + 1;
  if (n <= 2) return { pos: 'BTN', behind: 1 };
  if (v.position >= 0.8) return { pos: 'BTN', behind: 2 };
  if (v.position >= 0.6) return { pos: 'CO', behind: Math.min(3, n - 1) };
  return { pos: 'MP', behind: Math.min(5, n - 1) };
}

function inferredSpot(base: Base, v: ViewLike): Spot {
  const { bb, toCall } = base;
  const dead = [...base.hole, ...base.board];
  const n = Math.max(1, v.opponents);
  const { pos, behind } = inferPos(v);
  const bet = v.streetBet + toCall;
  const preflop = v.stage === 'preflop';
  const raised = preflop ? bet > bb : toCall > 0;
  const level = raised ? Math.max(1, v.aggressors) : 0;
  const opps: Opp[] = [];
  const dealt = n + 1;
  for (let i = 0; i < n; i++) {
    let range = topRange(0.6);
    let role: Role | undefined;
    if (preflop) {
      if (raised && i === 0) {
        const toBB = bet / bb;
        const w = level >= 3 ? 0.03 : level === 2 ? 0.09 : clamp(openWidth(Math.max(dealt, 6), 3) / (1 + 0.3 * Math.log2(Math.max(1, toBB / 2.5))), 0.03, 0.6);
        range = level === 2 ? polarRange(w) : topRange(w);
        role = { kind: level >= 3 ? '4bet' : level === 2 ? '3bet' : 'open', level: level - 1, width: w, range, opened: level === 1 };
      } else range = topRange(raised ? 0.3 : 0.6);
    }
    let weights = comboWeights(range, dead);
    if (!preflop && raised && i === 0) {
      // The bet faced, read against hands that would make it on this board.
      const size = v.pot > toCall ? toCall / Math.max(1, v.pot - toCall) : 1;
      const e = { kind: 'raise', toCall: 0, size, facingSize: 0, rivals: n } as ActEvent;
      weights = reweight(weights, base.board, likelihoods(e));
    }
    opps.push({ seat: -1 - i, role, allIn: false, total: v.stack + v.streetBet, weights });
  }
  return {
    ...base,
    bet,
    raises: level,
    dealt,
    pos,
    opps,
    behind: preflop && !raised ? behind : 0,
    behindPreflop: behind,
    ip: v.position >= 0.99,
    ipVsRaiser: v.position >= 0.99,
    facingAllIn: false,
    facingSize: raised && v.pot > toCall ? toCall / Math.max(1, v.pot - toCall) : 0,
    aggressor: raised ? -1 : null,
    eff: v.stack + v.streetBet,
    limpers: 0,
    callers: 0,
    opener: preflop && raised ? -1 : null,
    openTo: preflop && raised && level === 1 ? bet : 0,
    preflopAggressor: false,
    streetAggressor: {},
    mine: [],
    log: [],
    inferred: true,
  };
}

function reweight(w: Float64Array, board: readonly number[], l: readonly number[]): Float64Array {
  if (board.length < 3) return w;
  const table = strengthTable(board);
  const out = new Float64Array(w.length);
  let sum = 0;
  for (let i = 0; i < w.length; i++) {
    const hs = table.hs[i]!;
    if (!w[i] || hs < 0) continue;
    out[i] = w[i]! * l[bucketOf(hs, table.draws[i]!)]!;
    sum += out[i]!;
  }
  return sum > 0 ? out : w;
}

/** The number of opponents a pot is contested by, for "fair share" thresholds. */
export const contested = (s: Spot) => Math.max(1, s.opps.length);

/** Monte Carlo deals for a decision: fewer per opponent when several share the pot (each deal scores them all). */
export const iterationsFor = (s: Spot, opponents: number) => Math.max(80, Math.round(s.lp.iterations * (opponents >= 3 ? 0.65 : opponents === 2 ? 0.8 : 1)));

/**
 * The bot's share of the pot against these opponents' weighted hands. Levels differ in what goes in (how far the ranges
 * are narrowed, how many deals), never by an error added to the result.
 */
export function equityOf(s: Spot, opps: readonly Opp[]): number {
  return equityVsRanges(s.hole, s.board, opps.map((o) => o.weights), iterationsFor(s, opps.length), s.rand);
}

/**
 * The bot's share against only the hands that would go on if it raised now. A bluff-catcher does well against a range
 * full of bluffs, but a raise folds those bluffs and is called by the hands that beat it.
 */
export function equityIfRaised(s: Spot): number {
  if (s.board.length < 3) return equityOf(s, s.opps);
  return equityOf(
    s,
    s.opps.map((o) => ({ ...o, weights: reweight(o.weights, s.board, CONTINUE_VS_RAISE) })),
  );
}

/** A soft threshold: about 0 well below `edge`, 1/2 at it, about 1 well above, over a band of `width`. */
export const soft = (x: number, edge: number, width: number) => 1 / (1 + Math.exp(-(x - edge) / Math.max(1e-4, width)));