/**
 * What a free-practice session shows of the hero's play (FreePracticePage "연습 결과"): the decisions of the chosen
 * topic with the arithmetic of the moment, the habits that came back more than once, and each seat's HUD over this
 * session. Read from the engine's record of each practice hand with the hero's own cards only, through the replay's
 * decision review (game/strategy.ts); a spot is named with the engine counters the bots and the HUD count with. Kept
 * in the page's memory and never sent anywhere: practice is never a hand history, a statistic or a ledger entry.
 */
import { evaluateKnown, handCounters, handFactsOf, rankClassIndex, type Counters, type HandRecord } from '@jc/poker-engine';
import type { HudStatsDto } from '@jc/types';
import type { ReplayInput } from '../../game/replay';
import { callPrice, decisionsOf, handNow, type Decision } from '../../game/strategy';

export const PRACTICE_TOPICS = ['free', 'preflop', 'threeBet', 'bbDefense', 'cbet', 'turn', 'river', 'shortStack', 'headsUp'] as const;
export type PracticeTopic = (typeof PRACTICE_TOPICS)[number];

/** The short-stack topic deals the hero this many big blinds each hand; a decision this deep or shallower is one. */
export const SHORT_STACK_BB = 20;

/**
 * Habits worth a second look, each a rule of thumb on the arithmetic and the hero's own cards, never a verdict: no
 * solver says what was right. Shown once one comes back (REPEAT times).
 *  - cheapFold: a fold where a call needed CHEAP_FOLD_NEED% of the final pot or less;
 *  - openLimp: first in preflop with a call, at a table of three or more, not from a blind;
 *  - drawFold: a flop fold holding a flush or open-ended straight draw where a call needed DRAW_FOLD_NEED% or less;
 *  - riverCallNoPair: a river call with no pair at all;
 *  - riverCheckStrong: the river checked back, last to act, with trips or better the board alone does not make.
 */
export const PATTERNS = ['cheapFold', 'openLimp', 'drawFold', 'riverCallNoPair', 'riverCheckStrong'] as const;
export type PatternId = (typeof PATTERNS)[number];
export const CHEAP_FOLD_NEED = 20;
export const DRAW_FOLD_NEED = 30;
export const REPEAT = 2;

export interface PracticeDecision {
  /** The practice hand's number. */
  hand: number;
  bigBlind: number;
  d: Decision;
  /** The topics it is a decision of ('free' always). */
  topics: PracticeTopic[];
  patterns: PatternId[];
}

/** The hand as the hero's replay would read it: every action, the stacks, and no card but the hero's own. */
export function replayOf(rec: HandRecord, hero: number, number: number, maxSeats: number): ReplayInput {
  return {
    id: rec.handId,
    tableName: '',
    handNumber: number,
    board: [...rec.board],
    potTotal: rec.potTotal,
    smallBlind: rec.blinds.sb,
    bigBlind: rec.blinds.bb,
    maxSeats,
    buttonSeat: rec.buttonSeat,
    pots: null,
    returned: null,
    actions: rec.actions.map((a) => ({ seatIndex: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
    players: rec.players.map((p) => ({ seatIndex: p.seatIndex, nickname: '', holeCards: p.seatIndex === hero ? [...p.holeCards] : null, stackStart: p.stackStart, net: p.net, won: p.won, rankClass: p.rankClass, bestFive: null })),
  };
}

const DRAWS_WORTH = new Set(['nutFlush', 'flush', 'straight']);
const TRIPS = rankClassIndex('three-of-a-kind');

function patternsOf(d: Decision, hand: ReplayInput): PatternId[] {
  const out: PatternId[] = [];
  const price = callPrice(d);
  const now = handNow(d);
  const drawFold = d.stage === 'flop' && d.did === 'fold' && !!price && price.need <= DRAW_FOLD_NEED && !!now?.draws.some((k) => DRAWS_WORTH.has(k));
  if (drawFold) out.push('drawFold');
  else if (d.did === 'fold' && price && price.need <= CHEAP_FOLD_NEED) out.push('cheapFold');
  if (d.stage === 'preflop' && d.unopened && d.did === 'call' && d.dealt > 2 && d.position !== 'SB') out.push('openLimp');
  if (d.stage === 'river' && d.did === 'call' && now?.made.rankClass === 'high-card') out.push('riverCallNoPair');
  if (d.stage === 'river' && d.did === 'check' && now && rankClassIndex(now.made.rankClass) >= TRIPS) {
    const lastToAct = !hand.actions.some((a, k) => k > d.action && a.stage === 'river');
    const board = evaluateKnown(d.board);
    if (lastToAct && (!board || rankClassIndex(board.rankClass) < rankClassIndex(now.made.rankClass))) out.push('riverCheckStrong');
  }
  return out;
}

/** The hero's decisions in a settled practice hand, each with its topics and the habits it shows. */
export function reviewHand(rec: HandRecord, hero: number, number: number, maxSeats: number): PracticeDecision[] {
  const bb = rec.blinds.bb;
  const hand = replayOf(rec, hero, number, maxSeats);
  // The spots as the bots and the HUD count them: the hero's open raised again, a c-bet the hero faced.
  const c = handCounters(handFactsOf(rec, bb)).get(hero);
  return decisionsOf(hand, [], hero).map((d) => {
    const topics: PracticeTopic[] = ['free'];
    if (d.stage === 'preflop') topics.push('preflop');
    if (d.stage === 'preflop' && c && c.foldTo3BetOpp > 0 && d.facing?.raises === 2) topics.push('threeBet');
    if (d.stage === 'preflop' && d.position === 'BB' && d.facing?.kind === 'raise' && d.facing.raises === 1) topics.push('bbDefense');
    if (d.stage === 'flop' && c && c.foldToCbetOpp > 0 && d.facing?.kind === 'bet' && d.facing.raises === 1) topics.push('cbet');
    if (d.stage === 'turn') topics.push('turn');
    if (d.stage === 'river') topics.push('river');
    if (bb > 0 && d.effective <= SHORT_STACK_BB * bb) topics.push('shortStack');
    if (d.dealt === 2) topics.push('headsUp');
    return { hand: number, bigBlind: bb, d, topics, patterns: patternsOf(d, hand) };
  });
}

/** The habits that came back at least REPEAT times, the most frequent first, with the hands they came in. */
export function repeatedPatterns(decisions: readonly PracticeDecision[]): { id: PatternId; count: number; hands: number[] }[] {
  return PATTERNS.map((id) => {
    const seen = decisions.filter((x) => x.patterns.includes(id));
    return { id, count: seen.length, hands: [...new Set(seen.map((x) => x.hand))] };
  })
    .filter((p) => p.count >= REPEAT)
    .sort((a, b) => b.count - a.count);
}

/** Showdowns a seat won chips at, chips nobody called handed back not counted (as pot_won is on the server). */
export function wonAtShowdown(rec: HandRecord): Set<number> {
  const back = new Map<number, number>();
  for (const pot of rec.pots ?? []) if (pot.uncalled) for (const w of pot.winners) back.set(w.seatIndex, (back.get(w.seatIndex) ?? 0) + w.amount);
  return new Set(rec.players.filter((p) => p.wentToShowdown && p.won - (back.get(p.seatIndex) ?? 0) > 0).map((p) => p.seatIndex));
}

/** A seat's HUD over the session, each ratio over its chances as the server's HUD counts them (api lib/play-stats.ts). */
export function hudOf(c: Counters, showdownsWon: number): HudStatsDto {
  const r = (n: number, of: number) => ({ n, of });
  return {
    hands: c.hands,
    vpip: r(c.vpip, c.hands),
    pfr: r(c.pfr, c.hands),
    wtsd: r(c.showdowns, c.sawFlop),
    wsd: r(showdownsWon, c.showdowns),
    counted: c.hands,
    threeBet: r(c.threeBet, c.threeBetOpp),
    foldTo3Bet: r(c.foldTo3Bet, c.foldTo3BetOpp),
    cbet: r(c.cbet, c.cbetOpp),
    foldToCbet: r(c.foldToCbet, c.foldToCbetOpp),
    aggression: { bets: c.postBets, calls: c.postCalls },
  };
}
