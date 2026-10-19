/**
 * Advanced GTO Academy: the arithmetic behind its tools and answers. Pure functions, no engine, no network.
 * Amounts are in one unit (big blinds or chips). `pot` is always the pot BEFORE the bet in question.
 *
 * The formulas are the standard ones of poker theory under simple models, which every caller states:
 *  - pot odds / required equity: the call closes the action and no more money goes in;
 *  - MDF, alpha and the balanced bluff share: one bet on the river, the caller holds only bluff-catchers;
 *  - outs: every out wins and no non-out wins (no reverse implied odds, no redraws).
 */
import type { Card } from '@jc/types';
import type { GtoCalc } from './types';

/** Ranks from the highest, the order of the 13x13 matrix. */
export const MATRIX_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export type MatrixRank = (typeof MATRIX_RANKS)[number];
const SUITS = ['s', 'h', 'd', 'c'] as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x) && x >= 0);

/** Share of the final pot a call must win to break even: bet / (pot + 2·bet). 0 when nothing is bet. */
export function potOdds(pot: number, bet: number): number {
  if (!finite(pot, bet) || bet <= 0) return 0;
  return bet / (pot + 2 * bet);
}

/** Pot odds as "x : 1" (what the call can win : what it costs) = (pot + bet) / bet. */
export function potOddsRatio(pot: number, bet: number): number {
  if (!finite(pot, bet) || bet <= 0) return Infinity;
  return (pot + bet) / bet;
}

/** Minimum defence frequency: pot / (pot + bet). Defending less lets any two cards bluff at a profit. */
export function mdf(pot: number, bet: number): number {
  if (!finite(pot, bet) || bet <= 0) return 1;
  if (pot + bet === 0) return 1;
  return pot / (pot + bet);
}

/** Alpha: how often a pure bluff must work to break even, bet / (pot + bet) = 1 − MDF. */
export function alpha(pot: number, bet: number): number {
  if (!finite(pot, bet) || bet <= 0) return 0;
  return bet / (pot + bet);
}

/** Bluffs in a balanced river betting range: bet / (pot + 2·bet), which leaves the caller indifferent. */
export function bluffShare(pot: number, bet: number): number {
  return potOdds(pot, bet);
}

/** EV of calling (vs folding, which is 0): equity·(pot + 2·bet) − bet. */
export function evCall(pot: number, bet: number, equity: number): number {
  if (!finite(pot, bet)) return 0;
  return clamp01(equity) * (pot + 2 * bet) - bet;
}

/** EV of a pure bluff (a bet that never wins when called): fold·pot − (1 − fold)·bet. */
export function evBluff(pot: number, bet: number, fold: number): number {
  if (!finite(pot, bet)) return 0;
  const f = clamp01(fold);
  return f * pot - (1 - f) * bet;
}

/**
 * Geometric sizing: the pot share f bet on each of `streets` streets, both players calling, so that the last bet puts
 * the stack in exactly. Each street multiplies the pot by (1 + 2f), so (1 + 2f)^streets = 1 + 2·stack / pot.
 */
export function geometric(pot: number, stack: number, streets: number): number {
  if (!finite(pot, stack) || pot <= 0 || stack <= 0 || !Number.isInteger(streets) || streets < 1) return 0;
  return ((1 + (2 * stack) / pot) ** (1 / streets) - 1) / 2;
}

/** Stack-to-pot ratio: the effective stack behind ÷ the pot (usually measured on the flop). */
export function spr(pot: number, stack: number): number {
  if (!finite(pot, stack) || pot <= 0) return 0;
  return stack / pot;
}

/**
 * How many pot-size bets (each called) put the stack in: every one triples the pot, so after n of them each player has
 * put in pot·(3^n − 1)/2. The answer is log₃(1 + 2·SPR), a fraction when the last bet is less than the pot.
 */
export function potBetsToAllIn(pot: number, stack: number): number {
  const r = spr(pot, stack);
  return r <= 0 ? 0 : Math.log(1 + 2 * r) / Math.log(3);
}

/**
 * Bluffs that keep a river bluff-catcher indifferent, given the value combos: value · bet / (pot + bet), so that bluffs
 * are bet / (pot + 2·bet) of the betting range. Value : bluff is then (pot + bet) : bet.
 */
export function balancedBluffs(pot: number, bet: number, value: number): number {
  if (!finite(pot, bet, value) || bet <= 0) return 0;
  return (value * bet) / (pot + bet);
}

/** Value combos per bluff combo in a balanced river range: (pot + bet) / bet. */
export function valuePerBluff(pot: number, bet: number): number {
  if (!finite(pot, bet) || bet <= 0) return Infinity;
  return (pot + bet) / bet;
}

// ------------------------------------------------------------------ outs

const choose2 = (n: number) => (n < 2 ? 0 : (n * (n - 1)) / 2);

/** Unseen cards by default: 47 on the flop (two cards to come), 46 on the turn (one). */
export const defaultUnseen = (cards: 1 | 2) => (cards === 2 ? 47 : 46);

/** Exact chance that at least one of the next `cards` cards is an out. */
export function outsExact(outs: number, cards: 1 | 2, unseen = defaultUnseen(cards)): number {
  const o = Math.max(0, Math.min(Math.floor(outs), unseen));
  if (unseen <= 0) return 0;
  if (cards === 1) return o / unseen;
  return 1 - choose2(unseen - o) / choose2(unseen);
}

/** The table shortcut: outs × 4 with two cards to come, × 2 with one (as a share, capped at 1). */
export function outsRule(outs: number, cards: 1 | 2): number {
  return clamp01((Math.max(0, outs) * (cards === 2 ? 4 : 2)) / 100);
}

// ------------------------------------------------------------------ hand classes and combos

/** A starting-hand class: a pair "AA", suited "AKs" or offsuit "AKo" (higher rank first). */
export type HandClass = string;

const rankIndex = (r: string) => MATRIX_RANKS.indexOf(r as MatrixRank);

/** The class in a matrix cell: the diagonal holds pairs, above it suited hands, below it offsuit. */
export function cellClass(row: number, col: number): HandClass {
  const a = MATRIX_RANKS[row]!;
  const b = MATRIX_RANKS[col]!;
  if (row === col) return `${a}${a}`;
  return row < col ? `${a}${b}s` : `${b}${a}o`;
}

/** Every class in matrix order (row by row): 13 pairs, 78 suited, 78 offsuit. */
export const ALL_CLASSES: HandClass[] = MATRIX_RANKS.flatMap((_, r) => MATRIX_RANKS.map((__, c) => cellClass(r, c)));

/** "AKs" → { hi: 'A', lo: 'K', kind: 'suited' }; null when it is not a class. */
export function parseClass(cls: string): { hi: MatrixRank; lo: MatrixRank; kind: 'pair' | 'suited' | 'offsuit' | 'any' } | null {
  const m = /^([AKQJT2-9])([AKQJT2-9])([so]?)$/.exec(cls);
  if (!m) return null;
  const [, x, y, s] = m as unknown as [string, MatrixRank, MatrixRank, string];
  const ix = rankIndex(x);
  const iy = rankIndex(y);
  if (x === y) return s ? null : { hi: x, lo: y, kind: 'pair' };
  if (ix > iy) return null; // written lower rank first
  return { hi: x, lo: y, kind: s === 's' ? 'suited' : s === 'o' ? 'offsuit' : 'any' };
}

/** The concrete two-card hands of a class, without any that use a dead (known) card. */
export function combosOf(cls: HandClass, dead: readonly Card[] = []): [Card, Card][] {
  const p = parseClass(cls);
  if (!p) return [];
  const gone = new Set<string>(dead);
  const out: [Card, Card][] = [];
  for (let i = 0; i < SUITS.length; i++) {
    for (let j = 0; j < SUITS.length; j++) {
      if (p.kind === 'pair' && j <= i) continue;
      if (p.kind === 'suited' && i !== j) continue;
      if (p.kind === 'offsuit' && i === j) continue;
      const a = `${p.hi}${SUITS[i]}` as Card;
      const b = `${p.lo}${SUITS[j]}` as Card;
      if (gone.has(a) || gone.has(b)) continue;
      out.push([a, b]);
    }
  }
  return out;
}

/** Number of combos: 6 for a pair, 4 suited, 12 offsuit, 16 any, fewer when cards are known. */
export function comboCount(cls: HandClass, dead: readonly Card[] = []): number {
  return combosOf(cls, dead).length;
}

/** All 1326 two-card starting hands. */
export const TOTAL_COMBOS = 1326;

/** Combos in a range (a set of classes), with card removal. */
export function rangeCombos(range: Iterable<HandClass>, dead: readonly Card[] = []): number {
  let n = 0;
  for (const c of range) n += comboCount(c, dead);
  return n;
}

/** Share of all starting hands a range holds, from 0 to 1 (no card removal: a preflop share). */
export function rangeShare(range: Iterable<HandClass>): number {
  return rangeCombos(range) / TOTAL_COMBOS;
}

/**
 * Range notation → classes. Supports single classes ("AKs", "QJo", "77"), "+" ("77+" = 77…AA, "A2s+" = A2s…AKs,
 * "KTo+" = KTo…KQo) and dashes between two of a kind ("99-55", "A5s-A2s"). Unknown tokens throw: the presets are ours.
 */
export function parseRange(text: string): Set<HandClass> {
  const out = new Set<HandClass>();
  for (const raw of text.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const dash = /^(\w{2,3})-(\w{2,3})$/.exec(tok);
    if (dash) {
      const a = parseClass(dash[1]!);
      const b = parseClass(dash[2]!);
      if (!a || !b || a.kind !== b.kind) throw new Error(`bad range ${tok}`);
      if (a.kind === 'pair') {
        const [lo, hi] = [rankIndex(a.hi), rankIndex(b.hi)].sort((x, y) => x - y) as [number, number];
        for (let i = lo; i <= hi; i++) out.add(`${MATRIX_RANKS[i]}${MATRIX_RANKS[i]}`);
      } else {
        if (a.hi !== b.hi) throw new Error(`bad range ${tok}`);
        const [lo, hi] = [rankIndex(a.lo), rankIndex(b.lo)].sort((x, y) => x - y) as [number, number];
        for (let i = lo; i <= hi; i++) out.add(`${a.hi}${MATRIX_RANKS[i]}${a.kind === 'suited' ? 's' : 'o'}`);
      }
      continue;
    }
    const plus = tok.endsWith('+');
    const p = parseClass(plus ? tok.slice(0, -1) : tok);
    if (!p || p.kind === 'any') throw new Error(`bad range ${tok}`);
    if (!plus) {
      out.add(tok);
      continue;
    }
    if (p.kind === 'pair') {
      for (let i = rankIndex(p.hi); i >= 0; i--) out.add(`${MATRIX_RANKS[i]}${MATRIX_RANKS[i]}`);
    } else {
      const s = p.kind === 'suited' ? 's' : 'o';
      for (let i = rankIndex(p.lo); i > rankIndex(p.hi); i--) out.add(`${p.hi}${MATRIX_RANKS[i]}${s}`);
    }
  }
  return out;
}

/**
 * Illustrative opening ranges for a 6-max cash game, 100 big blinds deep, no ante, raise first in. They are a simple
 * teaching picture of "later position opens wider", made for this academy: not a solver's output and not a chart
 * to copy. Real ranges move with stacks, rake, antes and the players behind.
 */
export const OPEN_RANGES = {
  UTG: '66+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, ATo+, KJo+, QJo',
  HJ: '55+, A2s+, K8s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, 65s, ATo+, KTo+, QTo+, JTo',
  CO: '33+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, A8o+, KTo+, QTo+, JTo',
  BTN: '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K8o+, Q9o+, J9o+, T8o+, 98o',
  SB: '22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+, K9o+, QTo+, JTo',
} as const;
export type OpenSeat = keyof typeof OPEN_RANGES;
export const OPEN_SEATS = Object.keys(OPEN_RANGES) as OpenSeat[];

// ------------------------------------------------------------------ board texture

export interface Texture {
  pairing: 'unpaired' | 'paired' | 'trips';
  suits: 'rainbow' | 'twoTone' | 'monotone';
  /** Three distinct ranks within five (a straight is possible with two cards), two of them, or none. */
  connect: 'connected' | 'semi' | 'disconnected';
  /** By the top card: A–Q high, J–8 middle, 7 and under low. */
  height: 'high' | 'middle' | 'low';
  /** 0–4: suits and connection make it wetter, a pair drier. */
  wetness: number;
  label: 'dry' | 'medium' | 'wet';
}

const VALUE: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };

/** Whether these rank values (distinct) fit inside one five-rank straight window (the ace also plays low). */
function inWindow(values: number[]): boolean {
  const sets = [values, values.map((v) => (v === 14 ? 1 : v))];
  return sets.some((vs) => Math.max(...vs) - Math.min(...vs) <= 4);
}

/** Classifies a flop (three cards). Turn and river cards are ignored: the tool teaches flop textures. */
export function texture(flop: readonly Card[]): Texture {
  const cards = flop.slice(0, 3);
  const values = cards.map((c) => VALUE[c[0]!]!);
  const distinct = [...new Set(values)];
  const pairing = distinct.length === 1 ? 'trips' : distinct.length === 2 ? 'paired' : 'unpaired';
  const suitCount = Math.max(...SUITS.map((s) => cards.filter((c) => c[1] === s).length));
  const suits = suitCount === 3 ? 'monotone' : suitCount === 2 ? 'twoTone' : 'rainbow';
  let connect: Texture['connect'] = 'disconnected';
  if (distinct.length === 3 && inWindow(distinct)) connect = 'connected';
  else {
    for (let i = 0; i < distinct.length && connect === 'disconnected'; i++)
      for (let j = i + 1; j < distinct.length; j++) if (inWindow([distinct[i]!, distinct[j]!])) connect = 'semi';
  }
  const top = Math.max(...values);
  const height = top >= 12 ? 'high' : top >= 8 ? 'middle' : 'low';
  const raw = (suits === 'monotone' ? 2 : suits === 'twoTone' ? 1 : 0) + (connect === 'connected' ? 2 : connect === 'semi' ? 1 : 0) - (pairing === 'unpaired' ? 0 : 1);
  const wetness = Math.max(0, Math.min(4, raw));
  return { pairing, suits, connect, height, wetness, label: wetness <= 1 ? 'dry' : wetness === 2 ? 'medium' : 'wet' };
}

// ------------------------------------------------------------------ answers

/** Recomputes a numeric answer (a share 0–1, an EV, or a combo count). */
export function evaluateCalc(c: GtoCalc): number {
  switch (c.kind) {
    case 'potOdds':
      return potOdds(c.pot, c.bet);
    case 'mdf':
      return mdf(c.pot, c.bet);
    case 'alpha':
      return alpha(c.pot, c.bet);
    case 'bluffShare':
      return bluffShare(c.pot, c.bet);
    case 'evCall':
      return evCall(c.pot, c.bet, c.equity);
    case 'evBluff':
      return evBluff(c.pot, c.bet, c.fold);
    case 'combos':
      return comboCount(c.hand, c.dead ?? []);
    case 'outs':
      return outsExact(c.outs, c.cards, c.unseen);
    case 'geometric':
      return geometric(c.pot, c.stack, c.streets);
    case 'spr':
      return spr(c.pot, c.stack);
    case 'bluffCombos':
      return balancedBluffs(c.pot, c.bet, c.value);
  }
}

/** A plain number as the lessons write it: one decimal at most, without a trailing ".0" (4.5, 3). */
export function num(x: number): string {
  const v = Math.round(x * 10) / 10;
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
}

/** A share as a whole percent ("33%"), or with one decimal when asked (33.3%). */
export function pct(x: number, digits = 0): string {
  const v = Math.round(x * 100 * 10 ** digits) / 10 ** digits;
  return `${v.toFixed(digits)}%`;
}

/** A share as the lessons write it: one decimal, without a trailing ".0" (25%, 33.3%). */
export function share(x: number): string {
  const v = Math.round(x * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** An amount with its sign, one decimal at most: +8, −25 (a real minus sign), 0. */
export function signed(x: number): string {
  const v = Math.round(x * 10) / 10;
  const abs = Math.abs(v);
  const s = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : '0';
}

/** A numeric answer as its option text shows it: a share, a signed EV, or a count. */
export function formatCalc(c: GtoCalc): string {
  const v = evaluateCalc(c);
  if (c.kind === 'evCall' || c.kind === 'evBluff') return signed(v);
  if (c.kind === 'combos' || c.kind === 'spr' || c.kind === 'bluffCombos') return num(v);
  return share(v);
}
