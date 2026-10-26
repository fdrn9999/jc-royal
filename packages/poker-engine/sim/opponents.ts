/**
 * Opponent types for the balance simulation (sim/balance-sim.ts): a table of one kind of player around one bot, so the
 * bot's levels and styles can be compared against each habit on its own. Three come from sim/users.ts (F tight value,
 * D river over-bluffer, G regular); the rest are written here. Like the scripted users they decide from the view a bot
 * gets: their own cards and the public table.
 *
 *   tight       F: few hands, big bets only with strong ones
 *   loose       plays about half its hands, bets made hands, calls a bit light
 *   aggressive  raises and re-raises often before the flop, bets most flops and raises draws and bluffs
 *   passive     limps and calls, bets only very strong hands
 *   station     calls down with any pair or draw, almost never raises
 *   bluffer     D: overbets the river with nothing and with strong hands
 *   random      picks any legal action at random, with random sizes up to twice the pot
 *   regular     G: position-based ranges, c-bets, value bets, folds weak hands to big bets
 */
import { aggress, callOr, find, legalize, passive, potSized } from '../src/ai/act';
import { comboIndex } from '../src/ai/profile';
import { readSpot, type Spot } from '../src/ai/spot';
import { isStrongDraw, strengthTable } from '../src/ai/strength';
import type { BotView } from '../src/bot';
import type { ActionRequest } from '../src/hand';
import { decideUser } from './users';

export const OPPONENTS = ['tight', 'loose', 'aggressive', 'passive', 'station', 'bluffer', 'random', 'regular'] as const;
export type Opponent = (typeof OPPONENTS)[number];

export const OPPONENT_LABELS: Record<Opponent | 'bots', string> = {
  tight: '타이트(F)',
  loose: '루즈',
  aggressive: '공격적(매니악)',
  passive: '수동적',
  station: '콜링 스테이션',
  bluffer: '과도한 블러퍼(D)',
  random: '무작위',
  regular: '레귤러(G)',
  bots: '봇 혼합',
};

interface Read {
  s: Spot;
  hs: number;
  draw: boolean;
  pre: number;
  price: number;
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
  return { s, hs, draw, pre, price: s.toCall / Math.max(1, v.pot + s.toCall) };
}

const free = (v: BotView) => !!find(v.legal, 'check');
const bbTo = (v: BotView, x: number) => x * v.bigBlind;
const reraise = (v: BotView, x: number) => (v.streetBet + v.toCall) * x;

function loose(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0) return s.pct <= 0.3 ? (aggress(v, bbTo(v, 3)) ?? callOr(v)) : s.pct <= 0.5 ? callOr(v) : passive(v);
    if (r.pre === 1) return s.pct <= 0.05 ? (aggress(v, reraise(v, 3)) ?? callOr(v)) : s.pct <= 0.4 ? callOr(v) : passive(v);
    return s.pct <= 0.08 ? callOr(v) : passive(v);
  }
  if (free(v)) {
    if (r.hs >= 0.6) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    if (v.stage === 'flop' && s.preflopAggressor && rand() < 0.5) return aggress(v, potSized(v, 0.5)) ?? { type: 'check' };
    return { type: 'check' };
  }
  if (r.hs >= 0.88) return aggress(v, potSized(v, 0.9)) ?? callOr(v);
  if (r.hs >= r.price + 0.15 || (r.draw && v.stage !== 'river')) return callOr(v);
  return passive(v);
}

function aggressive(v: BotView, r: Read, rand: () => number): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0) return s.pct <= 0.45 ? (aggress(v, bbTo(v, 3 + Math.floor(rand() * 2))) ?? callOr(v)) : s.pct <= 0.55 ? callOr(v) : passive(v);
    if (r.pre === 1) return s.pct <= 0.15 || (s.pct <= 0.45 && rand() < 0.15) ? (aggress(v, reraise(v, 3)) ?? callOr(v)) : s.pct <= 0.4 ? callOr(v) : passive(v);
    return s.pct <= 0.06 ? (aggress(v, reraise(v, 2.5)) ?? callOr(v)) : s.pct <= 0.18 ? callOr(v) : passive(v);
  }
  if (free(v)) return r.hs >= 0.5 || r.draw || rand() < 0.6 ? (aggress(v, potSized(v, 0.6 + rand() * 0.6)) ?? { type: 'check' }) : { type: 'check' };
  if (r.hs >= 0.8 || (r.draw && v.stage !== 'river' && rand() < 0.5) || rand() < 0.12) return aggress(v, potSized(v, 0.9)) ?? callOr(v);
  if (r.hs >= 0.35 || (r.draw && v.stage !== 'river')) return callOr(v);
  return passive(v);
}

function passiveKind(v: BotView, r: Read): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0) return s.pct <= 0.02 ? (aggress(v, bbTo(v, 3)) ?? callOr(v)) : s.pct <= 0.4 ? callOr(v) : passive(v);
    if (r.pre === 1) return s.pct <= 0.3 ? callOr(v) : passive(v);
    return s.pct <= 0.06 ? callOr(v) : passive(v);
  }
  if (free(v)) return r.hs >= 0.9 ? (aggress(v, potSized(v, 0.4)) ?? { type: 'check' }) : { type: 'check' };
  if (r.hs >= 0.45 || (r.draw && v.stage !== 'river' && r.price <= 0.35)) return callOr(v);
  return passive(v);
}

function station(v: BotView, r: Read): ActionRequest {
  const { s } = r;
  if (v.stage === 'preflop') {
    if (r.pre === 0) return s.pct <= 0.6 ? callOr(v) : passive(v);
    if (r.pre === 1) return s.pct <= 0.5 ? callOr(v) : passive(v);
    return s.pct <= 0.15 ? callOr(v) : passive(v);
  }
  if (free(v)) return r.hs >= 0.92 ? (aggress(v, potSized(v, 0.5)) ?? { type: 'check' }) : { type: 'check' };
  return r.hs >= 0.25 || r.draw ? callOr(v) : passive(v);
}

/** Any legal move with a random size; all in only when it is the only way to call or raise. */
function random(v: BotView, rand: () => number): ActionRequest {
  const all = v.legal.map((o) => o.type);
  const raises = all.includes('bet') || all.includes('raise');
  const types = raises ? all.filter((t) => t !== 'allin') : all;
  const t = types[Math.floor(rand() * types.length)]!;
  const o = v.legal.find((x) => x.type === t)!;
  if (o.type === 'bet' || o.type === 'raise') {
    const cap = Math.min(o.max, Math.max(o.min, Math.round(potSized(v, 2))));
    return { type: o.type, amount: o.min + Math.floor(rand() * (cap - o.min + 1)) };
  }
  return { type: o.type };
}

export function decideOpponent(kind: Opponent, v: BotView, rand: () => number): ActionRequest {
  if (kind === 'tight') return decideUser('F', v, rand);
  if (kind === 'bluffer') return decideUser('D', v, rand);
  if (kind === 'regular') return decideUser('G', v, rand);
  if (kind === 'random') return legalize(v, random(v, rand));
  const r = read(v, rand);
  const want = kind === 'loose' ? loose(v, r, rand) : kind === 'aggressive' ? aggressive(v, r, rand) : kind === 'passive' ? passiveKind(v, r) : station(v, r);
  const req = legalize(v, want);
  return req.type === 'fold' && find(v.legal, 'check') ? { type: 'check' } : req;
}
