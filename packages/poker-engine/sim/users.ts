/**
 * Scripted players for the bot simulations (docs/TEST_REPORT.md "봇 AI 2.0 시뮬레이션"): each plays one habit the
 * table bots have to cope with. They decide from the same view a bot gets (their own cards and the public table).
 *
 *   A  steals from the cutoff, button and small blind with most hands
 *   B  opens 5 to 20 big blinds
 *   C  overbets the flop (150–300% of the pot) with any hand
 *   D  overbets the river (200%) as a bluff with nothing and for value with strong hands
 *   E  moves all in before the flop again and again
 *   F  plays few hands and bets big only with strong ones
 *   G  a regular: position-based ranges, c-bets, value bets, folds weak hands to big bets
 */
import { aggress, callOr, find, legalize, passive, potSized, shove } from '../src/ai/act';
import { comboIndex } from '../src/ai/profile';
import { readSpot, type Spot } from '../src/ai/spot';
import { isStrongDraw, strengthTable } from '../src/ai/strength';
import { openWidth } from '../src/ai/villain';
import type { BotView } from '../src/bot';
import type { ActionRequest } from '../src/hand';

export const USER_KINDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const USER_LABELS: Record<UserKind, string> = {
  A: 'BTN 스틸러',
  B: '5~20BB 오픈',
  C: '플랍 오버벳(150~300%)',
  D: '리버 오버벳 블러퍼',
  E: '반복 올인',
  F: '타이트 밸류',
  G: '일반 레귤러',
};

interface Read {
  s: Spot;
  hs: number;
  draw: boolean;
  /** Raises before the flop, this hand. */
  pre: number;
}

function read(v: BotView, rand: () => number): Read {
  const s = readSpot('normal', v, rand, {});
  let hs = 0;
  let draw = false;
  if (s.board.length >= 3) {
    const t = strengthTable(s.board);
    const i = comboIndex(s.hole[0]!, s.hole[1]!);
    hs = i >= 0 ? Math.max(0, t.hs[i]!) : 0;
    draw = i >= 0 && isStrongDraw(t.draws[i]!);
  }
  const pre = s.log.filter((l) => l.e.stage === 'preflop' && l.e.kind === 'raise').length;
  return { s, hs, draw, pre };
}

const free = (v: BotView) => !!find(v.legal, 'check');
const bbTo = (v: BotView, x: number) => x * v.bigBlind;
const late = (s: Spot) => s.pos === 'CO' || s.pos === 'BTN' || s.pos === 'SB' || s.dealt <= 2;
const iWasAggressor = (s: Spot) => s.preflopAggressor;

/** Facing a bet after the flop: call when the hand is at least `need` strong (draws call small bets). */
function defend(v: BotView, r: Read, need: number): ActionRequest {
  if (free(v)) return { type: 'check' };
  const price = r.s.toCall / (v.pot + r.s.toCall);
  if (r.hs >= need || (r.draw && price <= 0.3 && v.stage !== 'river')) return callOr(v);
  return passive(v);
}

function stealer(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0 && s.limpers === 0 && !free(v)) {
      const w = late(s) ? 0.7 : 0.15;
      return s.pct <= w ? (aggress(v, bbTo(v, 2.5)) ?? callOr(v)) : passive(v);
    }
    if (free(v)) return { type: 'check' };
    if (r.pre === 1) return s.pct <= 0.03 ? (aggress(v, (v.streetBet + v.toCall) * 3) ?? callOr(v)) : s.pct <= 0.12 ? callOr(v) : passive(v);
    return s.pct <= 0.03 ? (shove(v) ?? callOr(v)) : s.pct <= 0.06 ? callOr(v) : passive(v);
  }
  if (free(v)) {
    if (v.stage === 'flop' && iWasAggressor(s) && rand() < 0.75) return aggress(v, potSized(v, 0.5)) ?? { type: 'check' };
    if (r.hs >= 0.6) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    return { type: 'check' };
  }
  return defend(v, r, 0.55);
}

function bigOpener(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0 && !free(v)) return s.pct <= 0.3 ? (aggress(v, bbTo(v, 5 + Math.floor(rand() * 16))) ?? callOr(v)) : passive(v);
    if (free(v)) return { type: 'check' };
    return s.pct <= 0.03 ? (shove(v) ?? callOr(v)) : s.pct <= 0.1 ? callOr(v) : passive(v);
  }
  if (free(v)) return r.hs >= 0.6 ? (aggress(v, potSized(v, 1)) ?? { type: 'check' }) : { type: 'check' };
  return defend(v, r, 0.5);
}

/** Preflop for the players whose habit shows after the flop. */
function looseCaller(v: BotView, r: Read, width: number): ActionRequest {
  const { s } = r;
  if (r.pre === 0 && !free(v)) return s.pct <= width ? (aggress(v, bbTo(v, 2.5)) ?? callOr(v)) : passive(v);
  if (free(v)) return { type: 'check' };
  if (r.pre === 1) return s.pct <= 0.25 ? callOr(v) : passive(v);
  return s.pct <= 0.08 ? callOr(v) : passive(v);
}

function flopOverbettor(v: BotView, r: Read, rand: () => number): ActionRequest {
  if (v.stage === 'preflop') return looseCaller(v, r, 0.35);
  if (free(v)) {
    if (v.stage === 'flop' && rand() < 0.7) return aggress(v, potSized(v, 1.5 + rand() * 1.5)) ?? { type: 'check' };
    return { type: 'check' };
  }
  return defend(v, r, v.stage === 'flop' ? 0.6 : 0.5);
}

function riverBluffer(v: BotView, r: Read, rand: () => number): ActionRequest {
  if (v.stage === 'preflop') return looseCaller(v, r, 0.35);
  if (free(v)) {
    if (v.stage === 'river' && (r.hs >= 0.8 || (r.hs < 0.3 && rand() < 0.65))) return aggress(v, potSized(v, 2)) ?? { type: 'check' };
    return { type: 'check' };
  }
  if (v.stage === 'river') return defend(v, r, 0.55);
  return r.hs >= 0.45 || (r.draw && r.s.toCall <= v.pot * 0.75) ? callOr(v) : passive(v);
}

function jammer(v: BotView, r: Read): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (free(v)) return s.pct <= 0.45 ? (shove(v) ?? { type: 'check' }) : { type: 'check' };
    if (r.pre <= 1) return s.pct <= 0.45 ? (shove(v) ?? callOr(v)) : passive(v);
    return s.pct <= 0.1 ? (shove(v) ?? callOr(v)) : passive(v);
  }
  if (free(v)) return r.hs >= 0.7 ? (shove(v) ?? { type: 'check' }) : { type: 'check' };
  return defend(v, r, 0.7);
}

function tightValue(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0 && !free(v)) return s.pct <= 0.12 ? (aggress(v, bbTo(v, 3)) ?? callOr(v)) : passive(v);
    if (free(v)) return s.pct <= 0.04 ? (aggress(v, bbTo(v, 4)) ?? { type: 'check' }) : { type: 'check' };
    if (r.pre === 1) return s.pct <= 0.03 ? (aggress(v, (v.streetBet + v.toCall) * 3) ?? callOr(v)) : s.pct <= 0.08 ? callOr(v) : passive(v);
    return s.pct <= 0.02 ? (shove(v) ?? callOr(v)) : s.pct <= 0.04 ? callOr(v) : passive(v);
  }
  if (free(v)) {
    if (r.hs >= 0.85) return aggress(v, potSized(v, v.stage === 'river' && rand() < 0.5 ? 1.5 : 1)) ?? { type: 'check' };
    if (r.hs >= 0.6) return aggress(v, potSized(v, 0.4)) ?? { type: 'check' };
    return { type: 'check' };
  }
  if (r.hs >= 0.9) return aggress(v, potSized(v, 1)) ?? callOr(v);
  return defend(v, r, 0.55);
}

function regular(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0 && !free(v)) {
      const w = s.dealt <= 2 ? 0.75 : openWidth(s.dealt, Math.max(1, s.behindPreflop));
      return s.pct <= w ? (aggress(v, bbTo(v, s.pos === 'SB' ? 3 : 2.5)) ?? callOr(v)) : passive(v);
    }
    if (free(v)) return s.pct <= 0.08 ? (aggress(v, bbTo(v, 4)) ?? { type: 'check' }) : { type: 'check' };
    if (r.pre === 1) {
      if (s.pct <= 0.04 || (s.pct <= 0.25 && rand() < 0.04)) return aggress(v, (v.streetBet + v.toCall) * 3) ?? callOr(v);
      return s.pct <= (s.pos === 'BB' ? 0.35 : 0.15) ? callOr(v) : passive(v);
    }
    return s.pct <= 0.02 ? (shove(v) ?? callOr(v)) : s.pct <= 0.05 ? callOr(v) : passive(v);
  }
  if (free(v)) {
    if (r.hs >= 0.7) return aggress(v, potSized(v, 0.66)) ?? { type: 'check' };
    if (v.stage === 'flop' && iWasAggressor(s) && rand() < 0.6) return aggress(v, potSized(v, 0.5)) ?? { type: 'check' };
    return { type: 'check' };
  }
  const price = r.s.toCall / (v.pot + r.s.toCall);
  if (r.hs >= 0.9) return aggress(v, potSized(v, 0.8)) ?? callOr(v);
  if (r.hs >= price + 0.3 || (r.draw && price <= 0.3 && v.stage !== 'river')) return callOr(v);
  return passive(v);
}

export function decideUser(kind: UserKind, v: BotView, rand: () => number): ActionRequest {
  const r = read(v, rand);
  const want =
    kind === 'A' ? stealer(v, r, rand) : kind === 'B' ? bigOpener(v, r, rand) : kind === 'C' ? flopOverbettor(v, r, rand) : kind === 'D' ? riverBluffer(v, r, rand) : kind === 'E' ? jammer(v, r) : kind === 'F' ? tightValue(v, r, rand) : regular(v, r, rand);
  const req = legalize(v, want);
  return req.type === 'fold' && find(v.legal, 'check') ? { type: 'check' } : req;
}
