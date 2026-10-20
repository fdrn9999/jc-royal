/**
 * Before the flop. Unopened pots are played from position-based ranges (wider with fewer players left behind, push or
 * fold when short). Facing a raise, the bot reads the raiser's range from their position, size and history, and
 * compares its equity against the players in the pot, discounted by how much of it it can realise after the flop, with
 * the price of the call: size and range are judged apart, so a big open is neither an automatic fold nor a call.
 * Value 3-bets and 4-bets come from equity against those ranges; bluff 3-bets from a fixed set of blockers and suited
 * hands, at frequencies that depend on position, stacks, callers and the opener's habit of folding to 3-bets.
 * Heuristic, not solver output.
 */
import type { ActionRequest } from '../hand';
import { aggress, callOr, find, passive, shove } from './act';
import { classId, classRanks, isPair, isSuited } from './classes';
import { PRIORS } from './profile';
import { equityOf, soft, type Opp, type Spot } from './spot';
import { clamp, openWidth, pushWidth } from './villain';
import { isStealPos } from './walk';

const AA = classId('AA');
const KK = classId('KK');
/** Hands that 3-bet as bluffs: an ace blocks the strongest hands, and suited hands play well when called. */
const BLUFF_3BET = new Set(['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'Q9s', 'J9s', 'T9s', '98s', '87s', '76s', '65s', '54s'].map(classId));
const BLUFF_4BET = new Set(['A5s', 'A4s'].map(classId));

/** Never folded before the flop, whatever the size. */
export const isPremium = (cls: number) => cls === AA || cls === KK;

const canRaise = (s: Spot) => {
  const allin = find(s.v.legal, 'allin');
  return !!find(s.v.legal, 'raise') || (!!allin && allin.amount > s.v.streetBet + s.toCall);
};

/** Raise (or bet) to `to`, all in when that is most of the stack anyway. */
function raiseTo(s: Spot, to: number): ActionRequest | null {
  const all = s.v.stack + s.v.streetBet;
  return to >= all * 0.85 ? shove(s.v) : aggress(s.v, to);
}

/** A first raise's size: smaller from late position and when short, a big blind more per limper. */
export function openSize(s: Spot): number {
  const bb = s.bb;
  let x = s.dealt <= 2 ? 2.5 : s.pos === 'SB' ? 3 : s.pos === 'BTN' || s.pos === 'CO' ? 2.3 : 2.5;
  if (s.eff / bb <= 25) x = Math.min(x, 2.1);
  x += s.limpers * (s.ipVsRaiser ? 1 : 1.2);
  return x * bb * s.persona.sizing;
}

/** How much of its equity a hand keeps after the flop (position, playability, stacks). */
export function realization(s: Spot, opp: number): number {
  const v = s.v;
  if (s.toCall >= v.stack || s.facingAllIn) return 1;
  let r = s.ipVsRaiser ? 0.95 : s.pos === 'BB' ? 0.82 : 0.78;
  const [hi, lo] = classRanks(s.cls);
  if (isPair(s.cls) || isSuited(s.cls)) r += 0.05;
  else if (lo < 10 || hi < 10) r -= 0.08;
  // Small pairs set-mine when what is behind pays for it.
  if (isPair(s.cls) && s.toCall > 0 && (s.eff - s.toCall) / s.toCall >= 15) r += 0.08;
  if (opp >= 2) r *= 0.95;
  // With little behind, most of the equity is all in anyway.
  const spr = (s.eff - v.streetBet - s.toCall) / Math.max(1, v.pot + s.toCall);
  r += (1 - r) * clamp((4 - spr) / 4, 0, 1) * 0.7;
  return clamp(r, 0.5, 1.05);
}

/** Extra equity asked before calling: the level's margin, the style, and every player still to act behind. */
const callMargin = (s: Spot) => Math.max(-0.02, s.lp.margin - (s.persona.call - 1) * 0.06 + 0.01 * s.behind);

export function preflopAct(s: Spot): ActionRequest {
  const free = !!find(s.v.legal, 'check');
  // The easy level plays a few more hands.
  const pct = s.pct;
  const wide = s.lp.loose;
  if (s.raises === 0) return free ? option(s, pct, wide) : s.limpers > 0 ? overLimpers(s, pct, wide) : firstIn(s, pct, wide);
  if (free) return { type: 'check' };
  return facingRaise(s);
}

/** Nobody has entered the pot yet: open, shove or fold (the small blind may also complete). */
function firstIn(s: Spot, pct: number, wide: number): ActionRequest {
  const { v, persona, rand } = s;
  const effBB = s.eff / s.bb;
  const behind = Math.max(1, s.behindPreflop);
  const premium = isPremium(s.cls);
  if (effBB <= 12) {
    const w = pushWidth(effBB, behind) * Math.sqrt(persona.open) * wide;
    if (pct <= w || premium) return shove(v) ?? callOr(v);
    // The small blind can still see a flop for half a blind.
    if (s.pos === 'SB' && s.dealt > 2 && pct <= 0.5 && rand() < 0.25 + persona.limp) return callOr(v);
    return passive(v);
  }
  const w = clamp(openWidth(s.dealt, behind) * persona.open * wide, 0.05, 0.95);
  const edge = pct <= w || (pct <= w + 0.03 && rand() < (w + 0.03 - pct) / 0.06);
  if (edge && !premium && s.lp.limp > 0 && rand() < s.lp.limp) return callOr(v);
  if (edge || premium) return raiseTo(s, openSize(s)) ?? callOr(v);
  if (s.pos === 'SB' && s.dealt > 2) {
    // Against the big blind alone, completing keeps many hands that are too weak to raise.
    if (pct <= 0.62 && rand() < 0.3 + persona.limp) return callOr(v);
    return passive(v);
  }
  if (persona.limp > 0 && pct <= w * 1.6 && rand() < persona.limp) return callOr(v);
  return passive(v);
}

/** Limpers in front: raise to isolate them, over-limp with hands that play well in big pots, or fold. */
function overLimpers(s: Spot, pct: number, wide: number): ActionRequest {
  const { v, persona, rand } = s;
  const w = clamp(openWidth(s.dealt, Math.max(1, s.behindPreflop)) * persona.open * wide, 0.05, 0.95);
  if (pct <= w * 0.55 || isPremium(s.cls)) return raiseTo(s, openSize(s) + s.bb * 0.5) ?? callOr(v);
  const [hi, lo] = classRanks(s.cls);
  const speculative = isPair(s.cls) || isSuited(s.cls) || hi - lo <= 1;
  if (s.pos === 'SB' && pct <= 0.6) return callOr(v);
  if (pct <= w * 1.3 && speculative) return callOr(v);
  if (persona.limp > 0 && pct <= w * 1.6 && rand() < persona.limp * 2) return callOr(v);
  return passive(v);
}

/** The big blind's option after limps (or the small blind completing): raise the best hands, check the rest. */
function option(s: Spot, pct: number, wide: number): ActionRequest {
  const iso = (0.1 + (s.limpers <= 1 ? 0.04 : 0)) * s.persona.open * wide;
  if (pct <= iso || isPremium(s.cls)) return raiseTo(s, (3.5 + s.limpers) * s.bb * s.persona.sizing) ?? { type: 'check' };
  return { type: 'check' };
}

/** Opponents with chips in the pot by choice (the raisers and callers). Players yet to act are counted as `behind`. */
function inPot(s: Spot): Opp[] {
  const opps = s.opps.filter((o) => o.role);
  return opps.length ? opps : s.opps.slice(0, 1);
}

function facingRaise(s: Spot): ActionRequest {
  const { v, lp, persona, rand } = s;
  const opps = inPot(s);
  const e = equityOf(s, opps);
  const premium = isPremium(s.cls);
  const req = s.toCall / (v.pot + s.toCall);
  const r = realization(s, opps.length);
  const margin = callMargin(s);
  const raiseOk = canRaise(s) && !s.facingAllIn;
  const effBB = s.eff / s.bb;
  const fair = 1 / (opps.length + 1);
  const raiser = s.aggressor !== null ? s.opps.find((o) => o.seat === s.aggressor) : undefined;
  const t = raiser?.t;

  if (raiseOk && s.raises === 1) {
    // 3-bet (a squeeze when players called the open) for value.
    const thr = lp.value3 * Math.pow(2 * fair, 0.75);
    const trap = s.cls === AA && lp.adapt && s.ipVsRaiser && rand() < 0.1;
    if (!trap && rand() < Math.min(1, soft(e, thr, 0.02) * Math.sqrt(persona.threeBet))) return threeBet(s, true) ?? callOr(v);
    // 3-bet as a bluff with blockers and suited hands, from the right spots only.
    if (BLUFF_3BET.has(s.cls) && rand() < bluff3Rate(s, t)) {
      const b = threeBet(s, false);
      if (b) return b;
    }
  } else if (raiseOk && s.raises === 2) {
    const opened = s.opener !== null && s.opener === s.v.seat;
    const thr = (opened ? 0.58 : 0.62) * Math.pow(2 * fair, 0.6);
    if (rand() < soft(e, thr, 0.02)) return fourBet(s) ?? callOr(v);
    if (opened && opps.length === 1 && BLUFF_4BET.has(s.cls) && lp.bluff >= 0.9 && effBB >= 60 && rand() < 0.12 * lp.bluff * persona.bluff) {
      const b = fourBet(s);
      if (b && b.type !== 'allin') return b;
    }
  } else if (raiseOk && s.raises >= 3) {
    if (rand() < soft(e, 0.55 * Math.pow(2 * fair, 0.6), 0.02)) return shove(v) ?? callOr(v);
  }

  if (premium) return callOr(v);
  const cold = s.raises >= 2 && !(s.opener !== null && s.opener === s.v.seat) && !s.mine.some((m) => m.stage === 'preflop' && m.kind !== 'fold');
  const need = req + margin + (cold ? 0.03 : 0);
  return rand() < soft(e * r, need, lp.mix) ? callOr(v) : passive(v);
}

/** How often a bluff-3-bet hand 3-bets: wide against late opens, never when short or against big opens. */
function bluff3Rate(s: Spot, t: Opp['t']): number {
  const { lp, persona } = s;
  const effBB = s.eff / s.bb;
  const late = s.inferred ? s.v.position >= 0.6 : isStealPos(s.openerPos);
  const posF = late ? 1 : s.pos === 'SB' || s.pos === 'BB' ? 0.9 : 0.35;
  const foldF = t ? clamp(t.foldTo3Bet / PRIORS.foldTo3Bet, 0.4, 1.8) : 1;
  const stackF = effBB >= 40 ? 1 : effBB >= 25 ? 0.4 : 0;
  const callersF = s.callers === 0 ? 1 : s.callers === 1 ? 0.35 : 0.1;
  const openBB = (s.openTo || s.bet) / s.bb;
  const sizeF = openBB > 6 ? 0 : openBB > 4 ? 0.3 : 1;
  return 0.45 * persona.threeBet * persona.bluff * lp.bluff * posF * foldF * stackF * callersF * sizeF;
}

function threeBet(s: Spot, value: boolean): ActionRequest | null {
  const v = s.v;
  const open = s.bet;
  let to = open * (s.ipVsRaiser ? 3 : 4) + open * s.callers;
  to *= s.persona.sizing;
  const all = v.stack + v.streetBet;
  const effBB = s.eff / s.bb;
  if (to >= all * 0.4 || (value && effBB <= 25)) return value ? shove(v) : null;
  return aggress(v, to);
}

function fourBet(s: Spot): ActionRequest | null {
  const v = s.v;
  const to = s.bet * (s.ipVsRaiser ? 2.2 : 2.5) * s.persona.sizing;
  const all = v.stack + v.streetBet;
  if (to >= all * 0.4 || s.eff / s.bb <= 40) return shove(v);
  return aggress(v, to);
}
