/**
 * Replays a hand's public action list (blinds, folds, checks, calls, bets, raises and all-ins with the chips each put
 * in) and reports every voluntary action with the situation the player faced: what it cost to call, the pot, how many
 * raises came before on that street, whether the bet came from a player all in and how big it was. Shared by the bots
 * (to read the hand so far) and by the opponent statistics (to count opportunities exactly).
 */
import type { HandStage } from '@jc/types';

/** Table positions, in the order players act before the flop. */
export type Pos = 'UTG' | 'EP' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

const NAMES: Record<number, Pos[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  7: ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'EP', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'EP', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  10: ['UTG', 'EP', 'EP', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};

export interface Seating {
  /** Seats dealt in, in preflop acting order (first to act … big blind). */
  preflop: number[];
  /** The same seats in postflop acting order (small blind … button; heads-up: big blind, then button). */
  postflop: number[];
  pos: Map<number, Pos>;
}

/** Positions of the seats dealt in, from the button (seats go round in increasing index). */
export function seating(dealt: readonly number[], buttonSeat: number): Seating {
  const sorted = [...dealt].sort((x, y) => x - y);
  const clockwise = [...sorted.filter((s) => s > buttonSeat), ...sorted.filter((s) => s <= buttonSeat)];
  const n = clockwise.length;
  const pos = new Map<number, Pos>();
  if (n < 2) return { preflop: clockwise, postflop: clockwise, pos };
  // Heads-up the button posts the small blind and acts first before the flop, last after it.
  const preflop = n === 2 ? [clockwise[1]!, clockwise[0]!] : [...clockwise.slice(2), clockwise[0]!, clockwise[1]!];
  const postflop = n === 2 ? [clockwise[0]!, clockwise[1]!] : clockwise;
  const names = NAMES[Math.min(n, 10)]!;
  preflop.forEach((s, i) => pos.set(s, names[i] ?? 'EP'));
  return { preflop, postflop, pos };
}

export const isStealPos = (p: Pos | undefined) => p === 'CO' || p === 'BTN' || p === 'SB';

export interface PubAction {
  seat: number;
  stage: HandStage;
  type: string;
  /** Chips put in by the action. */
  amount: number;
}

export type Kind = 'fold' | 'check' | 'call' | 'raise';

export interface ActEvent {
  seat: number;
  stage: HandStage;
  kind: Kind;
  /** The action put the player's last chip in. */
  allIn: boolean;
  /** Chips they needed to call. */
  toCall: number;
  /** Their total on this street after the action. */
  to: number;
  /** Chips in the middle before the action, all streets. */
  potBefore: number;
  /** A bet or raise's size above the call as a share of the pot after calling (0 for the rest). */
  size: number;
  /** Bets and raises on this street before this action (before the flop the blinds are not counted). */
  level: number;
  /** Size of the bet or raise they face, as for `size` (0 when facing none). */
  facingSize: number;
  /** The bet they face came from a player who is now all in. */
  facingAllIn: boolean;
  /** Who made the bet they face, or null. */
  aggressor: number | null;
  /** Their first action on this street. */
  first: boolean;
  /** Other players still in the hand when they acted (all in included). */
  rivals: number;
}

export interface WalkState {
  stage: HandStage;
  pot: number;
  /** Highest total on this street. */
  bet: number;
  /** Largest raise on this street (blinds not counted): what the next raise must add, as the engine rules it. */
  raiseSize: number;
  /** The street's highest total just after each player's last action on it. */
  actedAt: Map<number, number>;
  level: number;
  aggressor: number | null;
  aggressorSize: number;
  put: Map<number, number>;
  stack: Map<number, number>;
  committed: Map<number, number>;
  folded: Set<number>;
  /** Before the flop: the raises in order (seat and street total) and who called at each step. */
  raises: { seat: number; to: number }[];
  /** Players who called the last raise (or limped when there is none), in order. */
  callers: number[];
  /** Players who limped before the first raise. */
  limpers: number[];
  /** Last player to bet or raise before the flop. */
  preflopAggressor: number | null;
}

const STAGES: HandStage[] = ['preflop', 'flop', 'turn', 'river'];

/**
 * Replays `actions` for seats starting with `stacks` (chips at the start of the hand). `onEvent` sees each voluntary
 * action with the state just before it was applied.
 */
export function walk(stacks: ReadonlyMap<number, number>, actions: readonly PubAction[], onEvent?: (e: ActEvent, st: WalkState) => void): WalkState {
  const st: WalkState = {
    stage: 'preflop',
    pot: 0,
    bet: 0,
    raiseSize: 0,
    actedAt: new Map(),
    level: 0,
    aggressor: null,
    aggressorSize: 0,
    put: new Map(),
    stack: new Map(stacks),
    committed: new Map(),
    folded: new Set(),
    raises: [],
    callers: [],
    limpers: [],
    preflopAggressor: null,
  };
  const acted = new Set<number>();
  let live = stacks.size;
  for (const a of actions) {
    if (a.stage !== st.stage && STAGES.indexOf(a.stage) > STAGES.indexOf(st.stage)) {
      st.stage = a.stage;
      st.put.clear();
      st.bet = 0;
      st.raiseSize = 0;
      st.actedAt.clear();
      st.level = 0;
      st.aggressor = null;
      st.aggressorSize = 0;
      acted.clear();
    }
    const seat = a.seat;
    const amount = Math.max(0, a.amount);
    const put = st.put.get(seat) ?? 0;
    const stack = st.stack.get(seat) ?? 0;
    const add = (n: number) => {
      st.put.set(seat, put + n);
      st.stack.set(seat, Math.max(0, stack - n));
      st.committed.set(seat, (st.committed.get(seat) ?? 0) + n);
      st.pot += n;
    };
    if (a.type === 'post-sb' || a.type === 'post-bb') {
      add(amount);
      st.bet = Math.max(st.bet, put + amount);
      continue;
    }
    const toCall = Math.max(0, st.bet - put);
    const to = put + amount;
    let kind: Kind;
    if (a.type === 'fold' || a.type === 'timeout-fold') kind = 'fold';
    else if (a.type === 'check' || a.type === 'timeout-check') kind = 'check';
    else if (a.type === 'call') kind = 'call';
    else if (a.type === 'bet' || a.type === 'raise') kind = 'raise';
    else if (a.type === 'allin') kind = to > st.bet ? 'raise' : 'call';
    else continue;
    const afterCall = st.pot + toCall;
    const size = kind === 'raise' && afterCall > 0 ? (to - st.bet) / afterCall : 0;
    const e: ActEvent = {
      seat,
      stage: st.stage,
      kind,
      allIn: amount > 0 && amount >= stack,
      toCall,
      to,
      potBefore: st.pot,
      size,
      level: st.level,
      facingSize: toCall > 0 ? st.aggressorSize : 0,
      facingAllIn: toCall > 0 && st.aggressor !== null && (st.stack.get(st.aggressor) ?? 0) === 0,
      aggressor: toCall > 0 ? st.aggressor : null,
      first: !acted.has(seat),
      rivals: Math.max(0, live - 1),
    };
    onEvent?.(e, st);
    acted.add(seat);
    if (kind === 'fold') {
      if (!st.folded.has(seat)) live--;
      st.folded.add(seat);
      continue;
    }
    add(amount);
    if (kind === 'raise') {
      // A short all-in raises by less than the largest raise and leaves that size in place.
      st.raiseSize = Math.max(st.raiseSize, to - st.bet);
      st.bet = to;
      st.level++;
      st.aggressor = seat;
      st.aggressorSize = size;
      if (st.stage === 'preflop') {
        st.raises.push({ seat, to });
        st.callers = [];
        st.preflopAggressor = seat;
      }
    } else if (kind === 'call' && st.stage === 'preflop') {
      st.callers.push(seat);
      if (!st.raises.length) st.limpers.push(seat);
    }
    st.actedAt.set(seat, st.bet);
  }
  return st;
}
