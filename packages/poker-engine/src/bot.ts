/**
 * Decisions for the server's table bots (docs/STATUS.md "서버 봇"). Rule based, no solver and no outside service.
 *
 * A bot decides from a `BotView`, which `botView` builds out of what a player in that seat sees on their own screen:
 * its two cards, the board, the pot, the bets of this street, the seats still in the hand and the legal options. The
 * other players' cards and the deck never enter it, so no level can play on knowledge a person at the table would not
 * have. Hard estimates its chances by dealing random cards from the ones it cannot see — never from the real deck.
 *
 * Whatever a level wants, `decideBot` only returns one of the legal options, with amounts inside their range.
 */
import { BOT_LEVELS, type BotLevel, type Card, type HandStage, type LegalOption } from '@jc/types';
import { standardDeck } from './deck';
import { evaluateBest, rankValue } from './evaluate';
import type { ActionRequest, HandEngine } from './hand';

export { BOT_LEVELS, type BotLevel };

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

const SUIT_INDEX: Record<string, number> = { c: 0, d: 1, h: 2, s: 3 };
/** A card as rank × 4 + suit, for `quickScore`. */
export const cardCode = (card: Card) => rankValue(card) * 4 + SUIT_INDEX[card[1]!]!;

/** Top card of the highest five-card run in a rank bit mask (bit r = rank r, the ace also plays as 1), or 0. */
function straightTop(mask: number): number {
  const m = mask & (1 << 14) ? mask | 2 : mask;
  for (let hi = 14; hi >= 5; hi--) if (((m >> (hi - 4)) & 31) === 31) return hi;
  return 0;
}

const counts = new Uint8Array(15);
const suitMask = new Uint16Array(4);
const suitCount = new Uint8Array(4);

/** Ranks present in `mask` from the highest down, skipping `skip`, at most `n`. */
function topRanks(mask: number, n: number, skip1 = 0, skip2 = 0): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (mask & (1 << r) && r !== skip1 && r !== skip2) out.push(r);
  return out;
}

const packScore = (cat: number, ranks: readonly number[]) => {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ranks[i] ?? 0);
  return v;
};

/**
 * One number ordering 5–7 card hands exactly as `evaluateBest` does (higher wins, equal ties): the same categories and
 * tie-break ranks, packed in base 16. Far cheaper than trying every five-card subset, which Hard does thousands of
 * times a decision. A property test compares the two.
 */
export function quickScore(codes: readonly number[]): number {
  counts.fill(0);
  suitMask.fill(0);
  suitCount.fill(0);
  let mask = 0;
  for (const x of codes) {
    const r = x >> 2;
    const s = x & 3;
    counts[r]!++;
    suitMask[s]! |= 1 << r;
    suitCount[s]!++;
    mask |= 1 << r;
  }
  let flush = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s]! >= 5) flush = s;
  if (flush >= 0) {
    const sf = straightTop(suitMask[flush]!);
    if (sf) return packScore(8, [sf]);
  }
  let quad = 0;
  let trips1 = 0;
  let trips2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = counts[r]!;
    if (n === 4) quad = r;
    else if (n === 3) {
      if (!trips1) trips1 = r;
      else if (!trips2) trips2 = r;
    } else if (n === 2) {
      if (!pair1) pair1 = r;
      else if (!pair2) pair2 = r;
    }
  }
  if (quad) return packScore(7, [quad, ...topRanks(mask, 1, quad)]);
  if (trips1 && (trips2 || pair1)) return packScore(6, [trips1, Math.max(trips2, pair1)]);
  if (flush >= 0) return packScore(5, topRanks(suitMask[flush]!, 5));
  const st = straightTop(mask);
  if (st) return packScore(4, [st]);
  if (trips1) return packScore(3, [trips1, ...topRanks(mask, 2, trips1)]);
  if (pair1 && pair2) return packScore(2, [pair1, pair2, ...topRanks(mask, 1, pair1, pair2)]);
  if (pair1) return packScore(1, [pair1, ...topRanks(mask, 3, pair1)]);
  return packScore(0, topRanks(mask, 5));
}

/**
 * Share of the pot the bot's cards win against `opponents` random hands, dealt (with the rest of the board) from the
 * cards the bot cannot see. An estimate for Hard, not the real deck.
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

// ------------------------------------------------------------------ choosing a legal action

type Win = Extract<LegalOption, { min: number; max: number }>;

const find = <T extends LegalOption['type']>(legal: readonly LegalOption[], t: T) => legal.find((o) => o.type === t) as Extract<LegalOption, { type: T }> | undefined;

/** Bet or raise to about `to` (street total), kept inside the legal range; all in when that is all that is left. */
function aggress(v: BotView, to: number): ActionRequest | null {
  const win = (find(v.legal, 'raise') ?? find(v.legal, 'bet')) as Win | undefined;
  const allin = find(v.legal, 'allin');
  const target = Math.round(to);
  if (win) {
    if (allin && target >= win.max) return { type: 'allin' };
    return { type: win.type, amount: Math.min(win.max, Math.max(win.min, target)) };
  }
  // No raise left (the stack covers less than a minimum raise): all in only if that is more than a call.
  if (allin && allin.amount > v.streetBet + v.toCall) return { type: 'allin' };
  return null;
}

/** A bet of `fraction` of the pot (after calling, for a raise). */
const potSized = (v: BotView, fraction: number) => v.streetBet + v.toCall + (v.pot + v.toCall) * fraction;

const passive = (v: BotView): ActionRequest => (find(v.legal, 'check') ? { type: 'check' } : { type: 'fold' });
const callOr = (v: BotView): ActionRequest => (find(v.legal, 'check') ? { type: 'check' } : find(v.legal, 'call') ? { type: 'call' } : find(v.legal, 'allin') ? { type: 'allin' } : { type: 'fold' });

/** Turns any wish into a legal request: the request itself if the engine offers it, otherwise check, else fold. */
export function legalize(v: Pick<BotView, 'legal'>, req: ActionRequest): ActionRequest {
  const o = v.legal.find((x) => x.type === req.type);
  if (o) {
    if (o.type !== 'bet' && o.type !== 'raise') return { type: o.type };
    const amount = req.amount ?? o.min;
    if (Number.isSafeInteger(amount) && amount >= o.min && amount <= o.max) return { type: o.type, amount };
    return { type: o.type, amount: Math.min(o.max, Math.max(o.min, Math.round(amount))) };
  }
  if (find(v.legal, 'check')) return { type: 'check' };
  // A call shown as all in (the stack covers no more) is the same as calling.
  if (req.type === 'call' && find(v.legal, 'allin')) return { type: 'allin' };
  return { type: 'fold' };
}

function easy(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  if (v.stage === 'preflop') {
    const s = startingScore(v.hole);
    if (s >= 12 && rand() < 0.5) return aggress(v, Math.max(bb * 3, (v.streetBet + v.toCall) * 2.5)) ?? callOr(v);
    if (v.toCall === 0) return { type: 'check' };
    if (s >= 3 || rand() < 0.3) return v.toCall <= bb * (s >= 9 ? 15 : 6) ? callOr(v) : passive(v);
    return passive(v);
  }
  const r = readHand(v.hole, v.board);
  if (r.made === 3 && rand() < 0.5) return aggress(v, potSized(v, 0.5)) ?? callOr(v);
  if (v.toCall === 0) return { type: 'check' };
  if (r.made >= 1 || r.outs > 0) return v.toCall <= v.pot ? callOr(v) : rand() < 0.3 ? callOr(v) : passive(v);
  return v.toCall <= v.pot / 3 && rand() < 0.4 ? callOr(v) : passive(v);
}

function normal(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  const facing = v.toCall;
  if (v.stage === 'preflop') {
    const s = startingScore(v.hole);
    const raised = v.streetBet + facing > bb;
    const late = v.position >= 0.6;
    if (s >= 12) {
      if (facing >= v.stack * 0.3) return callOr(v);
      return aggress(v, raised ? (v.streetBet + facing) * 3 : bb * 3 + bb * Math.max(0, v.opponents - 2) * 0.5) ?? callOr(v);
    }
    if (s >= 9) {
      if (!raised) return aggress(v, bb * 3) ?? callOr(v);
      return facing <= bb * 4 || facing <= v.stack * 0.08 ? callOr(v) : passive(v);
    }
    if (s >= 7) {
      if (!raised) return late && rand() < 0.6 ? (aggress(v, bb * 2.5) ?? callOr(v)) : callOr(v);
      return facing <= bb * 2.5 ? callOr(v) : passive(v);
    }
    if (s >= 5 && !raised) return late || facing === 0 ? callOr(v) : facing <= bb / 2 ? callOr(v) : passive(v);
    return passive(v);
  }
  const r = readHand(v.hole, v.board);
  const odds = facing / (v.pot + facing);
  const streetsLeft = v.stage === 'flop' ? 2 : v.stage === 'turn' ? 1 : 0;
  const drawChance = Math.min(0.6, (r.outs * (streetsLeft === 2 ? 4 : 2)) / 100);
  if (r.made === 3) {
    if (facing === 0) return aggress(v, potSized(v, 0.66)) ?? { type: 'check' };
    return rand() < 0.55 ? (aggress(v, potSized(v, 0.8)) ?? callOr(v)) : callOr(v);
  }
  if (r.made === 2) {
    if (facing === 0) return rand() < 0.75 ? (aggress(v, potSized(v, 0.5)) ?? { type: 'check' }) : { type: 'check' };
    if (facing <= v.pot * 0.75 || facing <= v.stack * 0.15) return callOr(v);
    return v.aggressors >= 2 ? passive(v) : facing <= v.pot ? callOr(v) : passive(v);
  }
  if (r.made === 1) {
    if (facing === 0) return v.position >= 0.6 && v.opponents <= 2 && rand() < 0.3 ? (aggress(v, potSized(v, 0.4)) ?? { type: 'check' }) : { type: 'check' };
    return facing <= v.pot * 0.4 ? callOr(v) : passive(v);
  }
  if (r.outs > 0) {
    if (facing === 0) return rand() < 0.3 ? (aggress(v, potSized(v, 0.55)) ?? { type: 'check' }) : { type: 'check' };
    return drawChance >= odds ? callOr(v) : passive(v);
  }
  if (facing === 0) return v.position >= 0.6 && v.opponents === 1 && rand() < 0.15 ? (aggress(v, potSized(v, 0.5)) ?? { type: 'check' }) : { type: 'check' };
  return passive(v);
}

/** Hands scored per decision, shared by the opponents (each simulated deal scores the bot's hand and theirs). */
const HARD_EVALS = 3000;

function hard(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  const facing = v.toCall;
  const opp = Math.max(1, v.opponents);
  const iterations = Math.max(60, Math.floor(HARD_EVALS / (Math.min(opp, 5) + 1)));
  let equity = estimateEquity(v.hole, v.board, opp, iterations, rand);
  // Random hands are weaker than the hands people bet with: each bet faced on this street asks for more.
  if (facing > 0 && v.aggressors > 0) equity -= 0.06 * Math.min(2, v.aggressors);
  const odds = facing / (v.pot + facing);
  const fair = 1 / (opp + 1);
  const strong = equity >= Math.min(0.8, fair + 0.3);
  const good = equity >= Math.min(0.65, fair + 0.15);
  if (v.stage === 'preflop') {
    const raised = v.streetBet + facing > bb;
    if (strong) return aggress(v, raised ? (v.streetBet + facing) * 3 : bb * 3) ?? callOr(v);
    if (good) {
      if (!raised) return aggress(v, bb * (v.position >= 0.6 ? 2.5 : 3)) ?? callOr(v);
      return equity >= odds + 0.05 && facing <= v.stack * 0.25 ? callOr(v) : passive(v);
    }
    if (facing === 0) return { type: 'check' };
    return equity >= odds + 0.08 && facing <= bb * 3 ? callOr(v) : passive(v);
  }
  const r = readHand(v.hole, v.board);
  if (strong) {
    // Short stack against the pot: get it all in.
    if (v.stack <= v.pot * 0.7) return aggress(v, v.stack + v.streetBet) ?? callOr(v);
    return aggress(v, potSized(v, facing === 0 ? 0.7 : 0.9)) ?? callOr(v);
  }
  if (good) {
    if (facing === 0) return aggress(v, potSized(v, 0.5)) ?? { type: 'check' };
    return equity >= odds ? callOr(v) : passive(v);
  }
  if (facing === 0) {
    // Semi-bluff a draw; on the river, bluff now and then from late position against one player.
    if (r.outs >= 8 && rand() < 0.4) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    if (v.stage === 'river' && v.opponents === 1 && v.position >= 0.6 && rand() < 0.15) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    return { type: 'check' };
  }
  return equity >= odds + 0.02 ? callOr(v) : passive(v);
}

/** The action a bot of this level takes. `rand` gives numbers in [0, 1) (tests pass a seeded one). */
export function decideBot(level: BotLevel, v: BotView, rand: () => number = Math.random): ActionRequest {
  const want = level === 'easy' ? easy(v, rand) : level === 'hard' ? hard(v, rand) : normal(v, rand);
  return legalize(v, want);
}
