/**
 * Decisions for the server's table bots (docs/STATUS.md "서버 봇", "봇 AI 2.0"). Rule based, no solver and no outside
 * service: the strategy lives in ./ai (positions and ranges, equity against ranges, opponent statistics, styles).
 *
 * A bot decides from a `BotView`, which `botView` builds out of what a player in that seat sees on their own screen:
 * its two cards, the board, the pot, the stacks and bets, the hand's public action list and the legal options. The
 * other players' cards and the deck never enter it, so no level can play on knowledge a person at the table would not
 * have. Equity is estimated by dealing random cards from the ones the bot cannot see — never from the real deck.
 *
 * Whatever a level wants, `decideBot` only returns one of the legal options, with amounts inside their range.
 */
import { BOT_LEVELS, type BotLevel, type Card, type HandStage, type LegalOption } from '@jc/types';
import { find, legalize, passive } from './ai/act';
import { postflopAct } from './ai/postflop';
import { preflopAct } from './ai/preflop';
import { cardCode, quickScore } from './ai/score';
import { readSpot, type DecideOptions, type PubSeat } from './ai/spot';
import type { PubAction } from './ai/walk';
import { standardDeck } from './deck';
import { evaluateBest, rankValue } from './evaluate';
import type { ActionRequest, HandEngine, HandRecord } from './hand';
import type { HandFacts } from './ai/profile';

export { BOT_LEVELS, type BotLevel };
export { cardCode, quickScore, legalize };
export { BOT_STYLES, styleFor, type BotStyle } from './ai/persona';
export { addCounters, BIG_BET_SAMPLE, bigBetRead, emptyCounters, handCounters, packCounters, playerType, STAT_KEYS, tendencies, unpackCounters, type BigBetRead, type Counters, type HandFacts, type PlayerType, type Tendencies } from './ai/profile';
export type { DecideOptions, PubSeat } from './ai/spot';
export type { PubAction } from './ai/walk';

/** Written to logs with each bot decision batch, so a change of strategy shows up in the record. */
export const STRATEGY_VERSION = 'bot-ai-2.0';

/** Everything a bot may know when it decides. Nothing in it is hidden from the player in that seat. */
export interface BotView {
  hole: Card[];
  board: Card[];
  stage: HandStage;
  legal: LegalOption[];
  /** Chips in the middle, this street's bets included. */
  pot: number;
  /** Chips the bot has to add to call (0 when it can check). */
  toCall: number;
  /** What the bot already put in on this street. */
  streetBet: number;
  /** Chips behind. */
  stack: number;
  bigBlind: number;
  /** Players still in the hand besides the bot. */
  opponents: number;
  /** Order after the flop among the players still in: 0 acts first, 1 is the button. */
  position: number;
  /** Bets and raises the others made on this street (blinds not counted). */
  aggressors: number;
  /**
   * The table as everybody sees it: the bot's seat, the button, every seat's chips and bets, and the hand's actions so
   * far (blinds included). Views made by hand may leave these out; the bot then reads the spot from the fields above.
   */
  seat?: number;
  buttonSeat?: number;
  seats?: PubSeat[];
  actions?: PubAction[];
}

/**
 * The view for the player to act, or null when it is not their turn. Built from the hand's public projection and
 * `seatInfo(playerId)`, which fills in hole cards for that player only (others' cards are shown only after a showdown,
 * and a bot never acts then).
 */
export function botView(h: HandEngine, playerId: string, bigBlind: number): BotView | null {
  if (h.actorId() !== playerId || h.isStalled()) return null;
  const legal = h.legalOptions(playerId);
  const seat = h.seatOf(playerId);
  if (!legal.length || seat === null) return null;
  const info = h.seatInfo(playerId);
  const me = info.get(seat);
  if (!me?.holeCards || me.holeCards.length !== 2) return null;
  const hv = h.handView();
  const live = [...info.entries()].filter(([, s]) => s.inHand && !s.folded).map(([i]) => i);
  const order = [...live.filter((i) => i > hv.buttonSeat).sort((a, b) => a - b), ...live.filter((i) => i <= hv.buttonSeat).sort((a, b) => a - b)];
  const call = legal.find((o) => o.type === 'call');
  let aggressors = 0;
  for (const [i, s] of info) if (i !== seat && s.inHand && s.lastAction && ['bet', 'raise', 'allin'].includes(s.lastAction.type)) aggressors++;
  const seats: PubSeat[] = [];
  for (const [i, s] of info) if (s.inHand) seats.push({ seat: i, stack: s.stack, streetBet: s.streetBet, inHand: true, folded: s.folded, allIn: s.allIn });
  return {
    hole: [...me.holeCards],
    board: [...hv.board],
    stage: hv.stage,
    legal,
    pot: hv.potTotal,
    toCall: call?.type === 'call' ? call.amount : 0,
    streetBet: me.streetBet,
    stack: me.stack,
    bigBlind,
    opponents: Math.max(0, live.length - 1),
    position: order.length > 1 ? order.indexOf(seat) / (order.length - 1) : 1,
    aggressors,
    seat,
    buttonSeat: hv.buttonSeat,
    seats,
    actions: h.publicActions().map((a) => ({ seat: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
  };
}

/**
 * What `handCounters` counts from a finished hand: the public actions, the board, and the cards the table saw shown
 * (`record`'s `shown`, after automatic mucking) — never a folded or mucked hand's cards.
 */
export function handFactsOf(rec: HandRecord, bigBlind: number): HandFacts {
  return {
    bigBlind,
    buttonSeat: rec.buttonSeat,
    seats: rec.players.map((p) => ({ seat: p.seatIndex, stack: p.stackStart })),
    actions: rec.actions.map((a) => ({ seat: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
    board: [...rec.board],
    shown: rec.players.filter((p) => p.shown).map((p) => ({ seat: p.seatIndex, hole: [...p.holeCards] })),
    showdown: rec.players.filter((p) => p.wentToShowdown).map((p) => p.seatIndex),
  };
}

// ------------------------------------------------------------------ hand reading

/** Chen-style starting-hand score: about -1 (7-2 offsuit) to 20 (aces). */
export function startingScore(hole: readonly Card[]): number {
  const [hi, lo] = [rankValue(hole[0]!), rankValue(hole[1]!)].sort((a, b) => b - a) as [number, number];
  const points = (v: number) => (v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  if (hi === lo) return Math.max(5, points(hi) * 2);
  let s = points(hi);
  if (hole[0]![1] === hole[1]![1]) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}

/** How the bot's cards play with the board, from its own two cards and the board only. */
export interface Reading {
  /** 0 nothing, 1 weak pair, 2 good pair (top pair or overpair), 3 two pair or better made with a hole card. */
  made: 0 | 1 | 2 | 3;
  /** Cards that would likely complete a flush or straight (0 on the river). */
  outs: number;
}

/** Rank class of the board alone (0 high card … 8 straight flush); with fewer than five cards only pairs and sets count. */
function boardClass(board: readonly Card[]): number {
  if (board.length >= 5) return evaluateBest(board)!.score[0]!;
  const counts = new Map<number, number>();
  for (const c of board) counts.set(rankValue(c), (counts.get(rankValue(c)) ?? 0) + 1);
  const n = [...counts.values()].sort((a, b) => b - a);
  return n[0] === 4 ? 7 : n[0] === 3 ? 3 : n[0] === 2 ? (n[1] === 2 ? 2 : 1) : 0;
}

export function readHand(hole: readonly Card[], board: readonly Card[]): Reading {
  if (board.length < 3) return { made: 0, outs: 0 };
  const all = [...hole, ...board];
  const best = evaluateBest(all)!;
  const cls = best.score[0]!;
  const holeVals = hole.map(rankValue);
  const boardTop = Math.max(...board.map(rankValue));
  const pocket = holeVals[0] === holeVals[1];
  // A pair counts as good when it is an overpair or pairs the board's top card.
  const pairRate = (p: number): 1 | 2 => ((pocket && p > boardTop) || (!pocket && p === boardTop) ? 2 : 1);
  let made: Reading['made'] = 0;
  // What the board makes on its own is everybody's hand, not the bot's.
  if (cls > boardClass(board)) {
    if (cls >= 3) made = 3;
    else if (cls === 2) {
      const own = [best.score[1]!, best.score[2]!].filter((p) => holeVals.includes(p));
      made = own.length === 2 ? 3 : own.length === 1 ? pairRate(own[0]!) : 1;
    } else made = pairRate(best.score[1]!);
  }
  let outs = 0;
  if (board.length < 5) {
    const suits = new Map<string, number>();
    for (const c of all) suits.set(c[1]!, (suits.get(c[1]!) ?? 0) + 1);
    const flushDraw = cls < 5 && [...suits.entries()].some(([s, n]) => n === 4 && hole.some((c) => c[1] === s));
    if (flushDraw) outs += 9;
    if (cls < 4) {
      // Ranks that would complete a five-card run using at least one hole card (the ace plays high and low).
      const vals = new Set(all.map(rankValue));
      if (vals.has(14)) vals.add(1);
      const holeLow = new Set(holeVals.flatMap((v) => (v === 14 ? [14, 1] : [v])));
      const completing = new Set<number>();
      for (let lo = 1; lo <= 10; lo++) {
        const run = [0, 1, 2, 3, 4].map((k) => lo + k);
        const missing = run.filter((x) => !vals.has(x));
        if (missing.length === 1 && run.some((x) => holeLow.has(x))) completing.add(missing[0] === 1 ? 14 : missing[0]!);
      }
      const straightOuts = Math.min(8, completing.size * 4);
      outs += flushDraw && straightOuts ? straightOuts - 2 : straightOuts;
    }
  }
  return { made, outs };
}

/**
 * Share of the pot the bot's cards win against `opponents` random hands, dealt (with the rest of the board) from the
 * cards the bot cannot see. An estimate against random hands, not the real deck (the bots themselves now play
 * against ranges: ./ai/equity).
 */
export function estimateEquity(hole: readonly Card[], board: readonly Card[], opponents: number, iterations: number, rand: () => number): number {
  const known = new Set<string>([...hole, ...board]);
  const rest = standardDeck()
    .filter((c) => !known.has(c))
    .map(cardCode);
  const holeCodes = hole.map(cardCode);
  const boardCodes = board.map(cardCode);
  const missing = 5 - board.length;
  const opp = Math.max(1, Math.min(opponents, 5));
  const need = missing + opp * 2;
  const mine: number[] = [...holeCodes, ...boardCodes];
  const theirs: number[] = [0, 0, ...boardCodes];
  let won = 0;
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher–Yates: the first `need` cards of `rest` become a random draw.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rand() * (rest.length - i));
      const t = rest[i]!;
      rest[i] = rest[j]!;
      rest[j] = t;
    }
    mine.length = 2 + boardCodes.length;
    theirs.length = 2 + boardCodes.length;
    for (let i = 0; i < missing; i++) {
      mine.push(rest[i]!);
      theirs.push(rest[i]!);
    }
    const my = quickScore(mine);
    let ties = 0;
    let lost = false;
    for (let o = 0; o < opp && !lost; o++) {
      theirs[0] = rest[missing + o * 2]!;
      theirs[1] = rest[missing + o * 2 + 1]!;
      const their = quickScore(theirs);
      if (their > my) lost = true;
      else if (their === my) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / iterations;
}

// ------------------------------------------------------------------ deciding

/**
 * The action a bot of this level takes. `rand` gives numbers in [0, 1) (tests pass a seeded one). `opts.style` sets
 * how it plays (tight, loose, aggressive, passive …); `opts.stats` gives each seat's counters from earlier hands, which
 * the levels that adapt read. Should anything in the strategy fail, the bot checks, or folds when it cannot.
 */
export function decideBot(level: BotLevel, v: BotView, rand: () => number = Math.random, opts: DecideOptions = {}): ActionRequest {
  let want: ActionRequest;
  try {
    const spot = readSpot(level, v, rand, opts);
    want = v.stage === 'preflop' ? preflopAct(spot) : postflopAct(spot);
  } catch {
    want = passive(v);
  }
  const req = legalize(v, want);
  // Folding when checking is free is never right.
  return req.type === 'fold' && find(v.legal, 'check') ? { type: 'check' } : req;
}
