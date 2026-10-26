/**
 * After the flop. The bot weighs its equity against every opponent's range as narrowed by what they did on each street
 * (a big bet from a player who rarely bluffs means more than one from a player who overbets all the time), the price of
 * a call, its position and the stacks behind. Facing a bet it raises for value or as a semi-bluff, calls when the
 * price is right, and otherwise folds; not facing one it bets for value, continuation-bets, barrels, stabs or bluffs at
 * frequencies tied to the board, the number of opponents and their habits. Heuristic, not solver output.
 */
import type { ActionRequest } from '../hand';
import { aggress, callOr, find, passive, potSized, shove } from './act';
import { comboIndex, OVERBET, PRIORS, type Tendencies } from './profile';
import { equityIfRaised, equityOf, soft, type Spot } from './spot';
import { AIR, bucketOf, DRAW, isStrongDraw, MEDIUM, strengthTable, unbeaten, WEAK, wetness } from './strength';
import { clamp } from './villain';

export function postflopAct(s: Spot): ActionRequest {
  const table = strengthTable(s.board);
  const ci = comboIndex(s.hole[0]!, s.hole[1]!);
  const hs = ci >= 0 ? Math.max(0, table.hs[ci]!) : 0;
  const draws = ci >= 0 ? table.draws[ci]! : 0;
  const bucket = bucketOf(hs, draws);
  const e = equityOf(s, s.opps);
  const heads = s.opps.length <= 1;
  // The one opponent whose habits matter most: the bettor, or the only player left.
  const main = s.aggressor !== null ? s.opps.find((o) => o.seat === s.aggressor) : heads ? s.opps[0] : undefined;
  const nuts = s.board.length === 5 && ci >= 0 && unbeaten(table, ci, s.hole[0]!, s.hole[1]!);
  const h: Hand = { hs, draws, bucket, e, heads, nuts, t: main?.t };
  return s.toCall > 0 ? facingBet(s, h) : notFacing(s, h);
}

interface Hand {
  hs: number;
  draws: number;
  bucket: number;
  e: number;
  heads: boolean;
  /** On the river nothing can beat it (it may still only split the pot). */
  nuts: boolean;
  t?: Tendencies;
}

const canRaise = (s: Spot) => {
  const allin = find(s.v.legal, 'allin');
  return !!find(s.v.legal, 'raise') || (!!allin && allin.amount > s.v.streetBet + s.toCall);
};

/** Chips behind against the pot once the bot has called. */
const sprOf = (s: Spot) => (s.eff - s.v.streetBet - s.toCall) / Math.max(1, s.v.pot + s.toCall);

function facingBet(s: Spot, h: Hand): ActionRequest {
  const { v, lp, persona, rand } = s;
  const river = v.stage === 'river';
  const pinned = s.toCall >= v.stack;
  const req = s.toCall / (v.pot + s.toCall);
  const r = river || pinned || s.ip ? 1 : v.stage === 'flop' ? 0.92 : 0.95;
  const extra = Math.max(0, s.opps.length - 1);
  const spr = sprOf(s);
  const raiseOk = canRaise(s) && !s.facingAllIn;
  // Raise for value, judged against the hands that would call or re-raise (not the bluffs, which fold); jam when the
  // stacks are short against the pot. A bet bigger than the pot is polar: one pair calls it or folds, never raises.
  const thr = (river ? 0.78 : 0.72) + 0.05 * extra;
  if (raiseOk && h.e >= thr - 0.12 && (s.facingSize <= OVERBET || h.hs >= 0.9)) {
    const want = soft(h.e, thr, 0.03) * soft(equityIfRaised(s), 0.58 + 0.04 * extra, 0.04);
    if (rand() < want * Math.min(1, 0.75 * persona.aggression ** 1.5) * lp.value) {
      const all = v.stack + v.streetBet;
      const to = potSized(v, 0.75 * persona.sizing);
      return (spr <= 2 || to >= all * 0.45 ? shove(v) : aggress(v, to)) ?? callOr(v);
    }
  }
  // Raise a strong draw now and then, heads-up, against bets up to the pot.
  if (raiseOk && h.heads && !river && isStrongDraw(h.draws) && h.hs < 0.62 && s.facingSize <= 1 && spr > 1.5 && rand() < 0.25 * persona.aggression * lp.bluff) {
    const to = potSized(v, 0.75 * persona.sizing);
    const b = aggress(v, to);
    if (b) return b;
  }
  // Near the nuts never folds, nor does a hand nothing can beat (a split pot still pays more than folding).
  if ((river && (h.hs >= 0.97 || h.nuts)) || h.e >= 0.92) return callOr(v);
  const margin = Math.max(-0.02, lp.margin - (persona.call - 1) * 0.06) + 0.015 * s.behind + 0.01 * extra;
  return rand() < soft(h.e * r, req + margin, lp.mix) ? callOr(v) : passive(v);
}

function notFacing(s: Spot, h: Hand): ActionRequest {
  const { v, lp, persona, rand } = s;
  const canBet = !!find(v.legal, 'bet') || !!find(v.legal, 'raise') || !!find(v.legal, 'allin');
  if (!canBet) return { type: 'check' };
  const stage = v.stage;
  const river = stage === 'river';
  const extra = Math.max(0, s.opps.length - 1);
  const t = h.t;
  const station = h.heads && !!t && (t.wtsd >= 0.38 || (t.vpip >= 0.45 && t.af < 1));
  const overfolder = h.heads && !!t && t.foldToCbet >= 0.6;
  const wet = wetness(s.board);
  let thr = (river ? 0.62 : 0.6) - (lp.refined ? 0.04 : 0) + 0.06 * extra - (persona.aggression - 1) * 0.15;
  if (station) thr -= 0.04;
  const bluffF = lp.bluff * persona.bluff * (station ? 0.4 : 1) * (overfolder ? 1.4 : 1);

  if (h.e >= thr - 0.08) {
    // Slow-play a monster on a dry flop now and then, or check to raise an aggressive player.
    const slow = lp.adapt && stage === 'flop' && h.hs >= 0.95 && wet < 0.3 && rand() < 0.15;
    const trap = !s.ip && h.heads && h.e >= 0.75 && !!t && t.af >= 2 && rand() < 0.3;
    if (!slow && !trap && rand() < soft(h.e, thr, 0.03) * Math.min(1, persona.aggression) * lp.value) return bet(s, h, true, wet);
    if (slow || trap) return { type: 'check' };
  }

  const me = s.v.seat;
  const myStreet = (st: 'flop' | 'turn') => me !== undefined && s.streetAggressor[st] === me;
  let p = 0;
  if (stage === 'flop' && s.preflopAggressor && s.raises === 0) {
    // Continuation bet: more on dry boards and heads-up, less into several players or a player who seldom folds.
    const foldF = t ? clamp(t.foldToCbet / PRIORS.foldToCbet, 0.5, 1.6) : 1;
    p = (wet < 0.45 ? 0.65 : 0.45) * persona.cbet * foldF * Math.pow(0.35, extra);
    if (h.bucket === DRAW) p *= 1.2;
    else if (h.bucket === WEAK) p *= 0.5;
    else if (h.bucket === MEDIUM) p *= 0.6;
    else if (h.bucket === AIR) p *= 0.5 + 0.5 * bluffF;
    if (station && h.bucket === AIR) p *= 0.4;
  } else if (stage === 'turn' && myStreet('flop') && s.raises === 0) {
    // Second barrel with draws and some air.
    p = h.bucket === DRAW ? 0.5 : h.bucket === AIR ? 0.2 * bluffF : h.bucket === WEAK ? 0.08 : 0;
    p *= Math.pow(0.4, extra);
  } else if (stage === 'turn' && s.ip && h.heads && s.streetAggressor.flop === undefined) {
    // The flop went check, check: take a stab at the turn.
    p = h.bucket === AIR || h.bucket === DRAW ? 0.25 * Math.max(0.3, bluffF) : h.bucket === WEAK ? 0.15 : 0;
  } else if (river && h.heads && h.hs < 0.3 && (myStreet('turn') || s.ip)) {
    // River bluff with a hand that cannot win at showdown.
    p = 0.18 * bluffF;
  } else if (!river && h.heads && h.bucket === DRAW && s.ip) {
    p = 0.3 * persona.aggression * lp.bluff;
  }
  if (p > 0 && rand() < p) return bet(s, h, false, wet);
  return { type: 'check' };
}

/** A bet sized by street and board; very strong hands may overbet at the levels that do; all in when the stacks are short. */
function bet(s: Spot, h: Hand, value: boolean, wet: number): ActionRequest {
  const { v, lp, persona, rand } = s;
  const spr = sprOf(s);
  if (spr <= 1.2 && (value || h.bucket === DRAW)) return shove(v) ?? { type: 'check' };
  let f = !lp.sizes ? 0.5 : v.stage === 'flop' ? (wet >= 0.45 ? 0.66 : 0.33) : v.stage === 'turn' ? 0.66 : 0.7;
  if (value && lp.overbet > 0 && v.stage !== 'flop' && h.heads && h.e >= 0.85 && rand() < lp.overbet) f = 1.25;
  f *= persona.sizing;
  const to = potSized(v, f);
  const all = v.stack + v.streetBet;
  if (to >= all * 0.6) return (value || h.bucket === DRAW ? shove(v) : aggress(v, to)) ?? { type: 'check' };
  return aggress(v, to) ?? { type: 'check' };
}
