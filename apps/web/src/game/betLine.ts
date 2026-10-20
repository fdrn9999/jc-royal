/**
 * A hand's betting line, read off its stored record only: every action street by street, what it was (fold, check,
 * call, bet, raise, 3-bet …, all-in) and its amount, each street's board and pot, the showdown and the payout. What an
 * action was comes from the amounts, the way a dealer would call it, not from the word the record stored: a call that
 * puts a player's last chips in is an all-in, and a raise is a raise by how much it went over the street's price.
 *
 * Amounts follow the replay's line (replay.ts): a bet, raise or all-in to its total on the street ("raises to 300"),
 * a blind or a call by what it put in ("calls 200"); `added` is always what it put in.
 */
import type { Card, HandStage } from '@jc/types';
import { seatPositions } from './positions';
import type { ReplayAction, ReplayInput, ReplayStep } from './replay';

export type BetStage = 'preflop' | 'flop' | 'turn' | 'river';
export type BetKind = 'sb' | 'bb' | 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface BetAct {
  seat: number;
  stage: BetStage;
  kind: BetKind;
  /**
   * How many bets the street's price had come to with it: 1 for a bet (and preflop the big blind), 2 a raise, 3 a
   * 3-bet, 4 a 4-bet… An all-in that raised less than a full raise leaves it where it was.
   */
  level: number;
  /** Whether it raised the street's price (a bet, a raise, an all-in over the price). */
  raised: boolean;
  /** What is said with it: a bet, raise or all-in to its street total, a blind or call by what it put in; none for a fold or check. */
  amount: number | null;
  /** The chips it put in. */
  added: number;
  /** Its player had no chips left behind after it. */
  allIn: boolean;
  /** A raise worth pointing out: a 3-bet or more, or a bet or raise after the flop of at least the pot. */
  big: boolean;
  /** The clock acted for the player (a time-out fold or check). */
  timeout: boolean;
}

const BLIND_KIND: Record<string, BetKind> = { 'post-sb': 'sb', 'post-bb': 'bb' };
const FOLDS = new Set(['fold', 'timeout-fold']);
const TIMEOUTS = new Set(['timeout-fold', 'timeout-check']);
const STAGES: readonly string[] = ['preflop', 'flop', 'turn', 'river'];

/**
 * The actions `actions` (the hand's own, or the first of them) as a betting line: each one read only from those before
 * it and the stacks the players started with, so a prefix of the record never reads anything from later in the hand.
 */
export function betActs(h: { bigBlind: number | null; players: readonly { seatIndex: number; stackStart: number }[] }, actions: readonly ReplayAction[]): BetAct[] {
  const start = new Map(h.players.map((p) => [p.seatIndex, p.stackStart]));
  const bb = h.bigBlind && h.bigBlind > 0 ? h.bigBlind : null;
  const put = new Map<number, number>();
  const street = new Map<number, number>();
  let stage = '';
  let top = 0;
  let lastRaise = 0;
  let level = 0;
  let pot = 0;
  const out: BetAct[] = [];
  for (const a of actions) {
    if (!STAGES.includes(a.stage)) continue;
    if (a.stage !== stage) {
      stage = a.stage;
      street.clear();
      // Preflop the big blind is the first bet and its size the smallest raise; after it a bet is at least a big blind.
      top = 0;
      lastRaise = bb ?? 0;
      level = 0;
    }
    const added = Math.max(0, a.amount);
    const total = (put.get(a.seatIndex) ?? 0) + added;
    const on = (street.get(a.seatIndex) ?? 0) + added;
    put.set(a.seatIndex, total);
    street.set(a.seatIndex, on);
    const s = start.get(a.seatIndex) ?? 0;
    const allIn = a.type === 'allin' || (s > 0 && total >= s);
    const before = pot;
    pot += added;
    const base = { seat: a.seatIndex, stage: a.stage as BetStage, added, allIn, big: false, timeout: TIMEOUTS.has(a.type), raised: false };
    const blind = BLIND_KIND[a.type];
    if (blind) {
      // A blind sets the price as posted, or the big blind's size where a short stack posted less.
      top = Math.max(top, on, blind === 'bb' ? (bb ?? 0) : 0);
      if (blind === 'bb') level = 1;
      out.push({ ...base, kind: blind, level, amount: added });
      continue;
    }
    if (stage === 'preflop' && level === 0 && top > 0) level = 1;
    if (FOLDS.has(a.type)) {
      out.push({ ...base, kind: 'fold', level, amount: null, allIn: false });
      continue;
    }
    if (added === 0) {
      out.push({ ...base, kind: 'check', level, amount: null, allIn: false });
      continue;
    }
    if (on > top) {
      const inc = on - top;
      const full = inc >= lastRaise;
      const opened = top === 0;
      if (opened) level = 1;
      else if (full || !allIn) level += 1;
      if (full) lastRaise = inc;
      top = on;
      const big = level >= 3 || (stage !== 'preflop' && added >= before);
      out.push({ ...base, kind: allIn ? 'allin' : opened ? 'bet' : 'raise', level, raised: true, amount: on, big });
      continue;
    }
    out.push({ ...base, kind: allIn ? 'allin' : 'call', level, amount: allIn ? on : added });
  }
  return out;
}

export interface BetStreet {
  stage: BetStage;
  /** The cards this street dealt (none preflop). */
  cards: Card[];
  /** The board as it stood on this street. */
  board: Card[];
  /** The pot as the street began (preflop nothing: the blinds are its first actions). */
  pot: number;
  acts: BetAct[];
}

export interface BetShow {
  seat: number;
  /** It went in face down at the showdown. */
  muck: boolean;
  /** The cards it showed (none for a muck). */
  cards: Card[] | null;
  rankClass: string | null;
  bestFive: Card[];
}

export interface BetLine {
  streets: BetStreet[];
  /** The hands at the showdown, once the line reaches it; null for a hand over before one. */
  showdown: BetShow[] | null;
  /** The payout, once the line reaches it. */
  result: {
    /** Who won chips from the contested pots, main pot first. */
    winners: { seat: number; amount: number }[];
    pot: number;
    /** The contested pots, main pot first, with who won each; null for hands recorded before pots were stored. */
    pots: { amount: number; winners: { seat: number; amount: number }[] }[] | null;
    /** The bet nobody called, handed back. */
    returned: { seat: number; amount: number } | null;
    /** The viewer's own result: what they won less what they put in; null for a spectator. */
    heroNet: number | null;
  } | null;
  /** Each dealt seat's position (BTN, SB, BB, UTG …), empty where the record does not say it plainly. */
  positions: Map<number, string>;
  /** The line runs to the end of the hand. */
  complete: boolean;
}

/**
 * The betting line up to step `index` of the replay `steps` of `hand`: only what those steps show (the board dealt by
 * then, the actions taken by then, the hands shown and the payout only once reached), so an image of a step never says
 * what came after it.
 */
export function betLine(hand: ReplayInput, steps: readonly ReplayStep[], index: number, heroSeat: number | null): BetLine {
  const upTo = Math.max(0, Math.min(index, steps.length - 1));
  const shown = steps.slice(0, upTo + 1);
  const taken = shown.reduce((n, s) => n + s.actions.length, 0);
  const acts = betActs(hand, hand.actions.slice(0, taken));
  const streets: BetStreet[] = [];
  let next = 0;
  let showdown: BetShow[] | null = null;
  let result: BetLine['result'] = null;
  for (const s of shown) {
    if (s.kind === 'deal') streets.push({ stage: 'preflop', cards: [], board: [], pot: 0, acts: [] });
    else if (s.kind === 'street' && STAGES.includes(s.stage)) {
      const dealt = s.line.find((x) => x.kind === 'board');
      streets.push({ stage: s.stage as BetStage, cards: dealt?.kind === 'board' ? dealt.cards : [], board: (s.view.hand?.board ?? []) as Card[], pot: s.view.hand?.potTotal ?? 0, acts: [] });
    } else if (s.kind === 'showdown') {
      showdown = s.line.flatMap((x): BetShow[] => {
        if (x.kind === 'shows') return [{ seat: x.seat, muck: false, cards: (s.view.seats[x.seat]?.holeCards ?? null) as Card[] | null, rankClass: x.rankClass, bestFive: x.bestFive }];
        if (x.kind === 'mucks') return [{ seat: x.seat, muck: true, cards: null, rankClass: null, bestFive: [] }];
        return [];
      });
    } else if (s.kind === 'result') {
      const hero = heroSeat === null ? undefined : hand.players.find((p) => p.seatIndex === heroSeat);
      result = {
        winners: s.line.flatMap((x) => (x.kind === 'wins' ? [{ seat: x.seat, amount: x.amount }] : [])),
        pot: s.view.hand?.potTotal ?? hand.potTotal,
        pots: hand.pots ? hand.pots.filter((p) => !p.uncalled).map((p) => ({ amount: p.amount, winners: p.winners.map((w) => ({ seat: w.seatIndex, amount: w.amount })) })) : null,
        returned: hand.returned ? { seat: hand.returned.seatIndex, amount: hand.returned.amount } : null,
        heroNet: hero ? hero.net : null,
      };
    }
    // The replay deals a street before its first action, so each action goes on the street last dealt.
    for (let k = 0; k < s.actions.length && next < acts.length; k++) streets.at(-1)?.acts.push(acts[next++]!);
  }
  return {
    streets,
    showdown,
    result,
    // The blinds are posted on the deal, the first step: they say nothing of later ones.
    positions: seatPositions(
      hand.players.map((p) => p.seatIndex),
      hand.buttonSeat,
      hand.actions.filter((a) => a.stage === ('preflop' satisfies HandStage)),
    ),
    complete: upTo >= steps.length - 1,
  };
}

/** The word for an act: "Fold", "Call", "Raise", "3-Bet", "All-in" … (the caller's words for each kind). */
export function betWord(act: Pick<BetAct, 'kind' | 'level'>, words: { [K in BetKind]: string } & { nbet: (n: number) => string }) {
  if (act.kind === 'raise' && act.level >= 3) return words.nbet(act.level);
  return words[act.kind];
}
