/**
 * Bot AI 2.0 (docs/STATUS.md "봇 AI 2.0"): positions and ranges, the answers to big opens, overbets and all-ins, the
 * public statistics the bots adapt to, and what every level keeps — legal actions only, nothing hidden read, the same
 * decisions for the same seed. Spots are dealt by the real engine; `decideLegacy` (sim/legacy-bot) is the bot as it
 * played before 2.0, kept for the diagnosis cases only.
 */
import type { Card } from '@jc/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideLegacy } from '../sim/legacy-bot';
import { seeded } from '../sim/rng';
import {
  BOT_LEVELS,
  BOT_STYLES,
  bigBetRead,
  botView,
  dealOrder,
  decideBot,
  emptyCounters,
  HandEngine,
  handCounters,
  stackedDeck,
  standardDeck,
  STAT_KEYS,
  STRATEGY_VERSION,
  styleFor,
  tendencies,
  unpackCounters,
  type ActionRequest,
  type BotLevel,
  type BotStyle,
  type BotView,
  type Counters,
  type MaxSeats,
} from '../src';
import { allCombos, classCombos, classId, className, NUM_CLASSES, TOTAL_COMBOS } from '../src/ai/classes';
import { PLAY_ORDER, rangeShare, topRange } from '../src/ai/ranges';
import { equityIfRaised, equityOf, readSpot } from '../src/ai/spot';
import { seating } from '../src/ai/walk';

const c = (s: string) => s.split(' ') as Card[];
const BB = 10;
let seq = 0;

/** A hand on seats 0…n-1 (button on seat 0 unless said), the seats in `holes` holding those cards. */
function deal(n: number, holes: Record<number, string>, opts: { button?: number; stacks?: number[]; board?: string } = {}) {
  const button = opts.button ?? 0;
  const fixed = new Set([...Object.values(holes).flatMap(c), ...(opts.board ? c(opts.board) : [])]);
  const spare = standardDeck().filter((x) => !fixed.has(x));
  const holeOf = (seat: number) => (holes[seat] ? c(holes[seat]!) : [spare.pop()!, spare.pop()!]);
  const dealt = dealOrder(n, button).map(holeOf);
  const stacks = opts.stacks ?? Array.from({ length: n }, () => 1000);
  return HandEngine.start({
    handId: `ai${++seq}`,
    rules: { maxSeats: (n === 2 ? 2 : n <= 6 ? 6 : 9) as MaxSeats, smallBlind: 5, bigBlind: BB, turnMs: 20_000 },
    seats: stacks.map((stack, i) => ({ playerId: `p${i}`, seatIndex: i, stack, displayName: `P${i}` })),
    buttonSeat: button,
    now: 1_000,
    deck: stackedDeck(dealt, opts.board ? c(opts.board) : spare.splice(-5)),
  });
}

type Step = [seat: number, type: ActionRequest['type'], amount?: number];

async function play(h: HandEngine, steps: readonly Step[]) {
  for (const [seat, type, amount] of steps) {
    const r = await h.act(`p${seat}`, { type, amount }, `i${++seq}`, 2_000 + seq);
    if (!r.ok) throw new Error(`p${seat} ${type} ${amount ?? ''}: ${r.reason}`);
  }
}

async function viewAt(seat: number, n: number, holes: Record<number, string>, steps: readonly Step[], opts: Parameters<typeof deal>[2] = {}) {
  const h = deal(n, holes, opts);
  await play(h, steps);
  const v = botView(h, `p${seat}`, BB);
  if (!v) throw new Error(`not p${seat}'s turn`);
  return v;
}

/** Two cards of a hand class ('AA', 'AKs', 'AKo'), hearts and diamonds unless one of them is on the board. */
function holeOf(id: number, dead: ReadonlySet<string> = new Set()): string {
  const n = className(id);
  const suited = n[2] === 's';
  const first = suited ? `${n[0]}h ${n[1]}h` : `${n[0]}h ${n[1]}d`;
  if (!c(first).some((x) => dead.has(x))) return first;
  for (const a of 'hdcs')
    for (const b of 'hdcs') {
      const hole = `${n[0]}${a} ${n[1]}${b}`;
      if (suited === (a === b) && !c(hole).some((x) => dead.has(x))) return hole;
    }
  throw new Error(`no ${n} left beside ${[...dead].join(' ')}`);
}

type Kind = 'fold' | 'call' | 'raise';
const kindOf = (v: BotView, r: ActionRequest): Kind =>
  r.type === 'fold' ? 'fold' : r.type === 'call' || r.type === 'check' || (r.type === 'allin' && v.stack <= v.toCall) ? 'call' : 'raise';

interface Mix {
  fold: number;
  call: number;
  raise: number;
  defend: number;
}

type Decide = (v: BotView, rand: () => number) => ActionRequest;
const bot =
  (level: BotLevel, opts: Parameters<typeof decideBot>[3] = {}): Decide =>
  (v, rand) =>
    decideBot(level, v, rand, opts);
const legacy =
  (level: BotLevel): Decide =>
  (v, rand) =>
    decideLegacy(level, v, rand);

/**
 * How a spot is played across all 1,326 starting hands: a few decisions per hand class, weighted by its combinations
 * (after the flop, one combination of each class that the board leaves).
 */
async function rangeMix(spot: (hole: string) => Promise<BotView>, decide: Decide, seeds = 3, board = ''): Promise<Mix> {
  const m: Mix = { fold: 0, call: 0, raise: 0, defend: 0 };
  const dead = new Set(board ? c(board) : []);
  for (let id = 0; id < NUM_CLASSES; id++) {
    const v = await spot(holeOf(id, dead));
    for (let k = 0; k < seeds; k++) m[kindOf(v, decide(v, seeded(id * 31 + k)))] += classCombos(id) / TOTAL_COMBOS / seeds;
  }
  m.defend = m.call + m.raise;
  return m;
}

/** How one spot is played over `n` decisions (call counts checks, raise counts bets). */
function spotMix(v: BotView, decide: Decide, n = 100): Mix {
  const k = { fold: 0, call: 0, raise: 0 };
  const rand = seeded(11);
  for (let i = 0; i < n; i++) k[kindOf(v, decide(v, rand))]++;
  return { fold: k.fold / n, call: k.call / n, raise: k.raise / n, defend: (k.call + k.raise) / n };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const show = (m: Mix) => `fold ${pct(m.fold)} call ${pct(m.call)} raise ${pct(m.raise)}`;

// Six seats, button on seat 0: SB 1, BB 2, UTG 3, HJ 4, CO 5.
const FOLD_TO_BTN: Step[] = [
  [3, 'fold'],
  [4, 'fold'],
  [5, 'fold'],
];
const bbVsBtn = (to: number) => (hole: string) => viewAt(2, 6, { 2: hole }, [...FOLD_TO_BTN, [0, 'raise', to], [1, 'fold']]);
const bbVsUtg = (to: number) => (hole: string) =>
  viewAt(2, 6, { 2: hole }, [
    [3, 'raise', to],
    [4, 'fold'],
    [5, 'fold'],
    [0, 'fold'],
    [1, 'fold'],
  ]);
const sbVsBtn = (to: number) => (hole: string) => viewAt(1, 6, { 1: hole }, [...FOLD_TO_BTN, [0, 'raise', to]]);
const bbVsBtnShove = (hole: string) => viewAt(2, 6, { 2: hole }, [...FOLD_TO_BTN, [0, 'allin'], [1, 'fold']]);

const counters = (o: Partial<Counters>): Counters => ({ ...emptyCounters(), ...o });

describe('Bot AI 2.0: positions and ranges', () => {
  it('names the positions of 2 to 9 players from the button, skipping empty seats', () => {
    for (let n = 2; n <= 9; n++) {
      const s = seating(
        Array.from({ length: n }, (_, i) => i),
        0,
      );
      const names = s.preflop.map((x) => s.pos.get(x));
      expect(new Set(names).size).toBe(n);
      expect(s.pos.get(0)).toBe('BTN');
      expect(names.at(-1)).toBe('BB');
      expect(s.pos.get(1)).toBe(n === 2 ? 'BB' : 'SB');
      // The button acts last after the flop, heads-up too.
      expect(s.postflop.at(-1)).toBe(0);
    }
    const six = seating([0, 1, 2, 3, 4, 5], 0);
    expect(six.preflop.map((x) => six.pos.get(x))).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    const nine = seating([0, 1, 2, 3, 4, 5, 6, 7, 8], 8);
    expect(nine.preflop.map((x) => nine.pos.get(x))).toEqual(['UTG', 'EP', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    const gaps = seating([1, 4, 7], 4);
    expect([gaps.pos.get(4), gaps.pos.get(7), gaps.pos.get(1)]).toEqual(['BTN', 'SB', 'BB']);
  });

  it('knows all 169 hand classes and 1,326 combinations, and cuts ranges from the top', () => {
    expect(NUM_CLASSES).toBe(169);
    let combos = 0;
    for (let id = 0; id < NUM_CLASSES; id++) {
      combos += classCombos(id);
      expect(classId(className(id))).toBe(id);
    }
    expect(combos).toBe(TOTAL_COMBOS);
    expect(allCombos().a.length).toBe(TOTAL_COMBOS);
    expect(className(PLAY_ORDER[0]!)).toBe('AA');
    for (const w of [0.05, 0.15, 0.4, 1]) expect(rangeShare(topRange(w))).toBeCloseTo(w, 2);
  });

  it('opens far more hands on the button than under the gun, and fewer at a full table', async () => {
    for (const level of ['normal', 'expert'] as const) {
      const utg = await rangeMix((hole) => viewAt(3, 6, { 3: hole }, []), bot(level));
      const btn = await rangeMix((hole) => viewAt(0, 6, { 0: hole }, FOLD_TO_BTN), bot(level));
      const utg9 = await rangeMix((hole) => viewAt(3, 9, { 3: hole }, []), bot(level));
      console.log(`${level} open: UTG6 ${show(utg)} | BTN ${show(btn)} | UTG9 ${show(utg9)}`);
      expect(utg.raise).toBeGreaterThan(0.08);
      expect(utg.raise).toBeLessThan(0.25);
      expect(btn.raise).toBeGreaterThan(2 * utg.raise);
      expect(utg9.raise).toBeLessThan(utg.raise);
    }
  }, 120_000);

  it('defends the big blind by the price and the opener’s range, the small blind tighter, with 3-bets in the mix', async () => {
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const vsBtn = await rangeMix(bbVsBtn(25), bot(level));
      const vsUtg = await rangeMix(bbVsUtg(25), bot(level));
      const sb = await rangeMix(sbVsBtn(25), bot(level));
      const old = await rangeMix(bbVsBtn(25), legacy(level));
      console.log(`${level} BB vs BTN 2.5BB ${show(vsBtn)} | vs UTG ${show(vsUtg)} | SB vs BTN ${show(sb)} | before 2.0 ${show(old)}`);
      expect(vsBtn.defend).toBeGreaterThan(0.35);
      expect(vsBtn.defend).toBeLessThan(0.85);
      expect(vsBtn.raise).toBeGreaterThan(0.05);
      expect(vsUtg.defend).toBeLessThan(vsBtn.defend - 0.05);
      expect(sb.defend).toBeLessThan(vsBtn.defend);
      expect(sb.raise).toBeGreaterThan(0.03);
    }
  }, 180_000);

  it('3-bets about three times the open in position, four out of position, more over a caller, and all in when short', async () => {
    const sized = async (seat: number, steps: Step[], stacks?: number[]) => {
      const out: ActionRequest[] = [];
      for (let k = 0; k < 20; k++) {
        const v = await viewAt(seat, 6, { [seat]: 'Kh Kd' }, steps, { stacks });
        out.push(decideBot('expert', v, seeded(k), { style: 'balanced' }));
      }
      return out;
    };
    const ip = await sized(0, [
      [3, 'fold'],
      [4, 'fold'],
      [5, 'raise', 25],
    ]);
    const oop = await sized(2, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']]);
    const squeeze = await sized(2, [
      [3, 'fold'],
      [4, 'fold'],
      [5, 'raise', 25],
      [0, 'call'],
      [1, 'fold'],
    ]);
    const short = await sized(2, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']], [200, 200, 200, 200, 200, 200]);
    const tos = (rs: ActionRequest[]) => rs.filter((r) => r.type === 'raise').map((r) => r.amount!);
    expect(tos(ip).length).toBeGreaterThanOrEqual(16);
    for (const to of tos(ip)) expect(to / 25).toBeCloseTo(3, 1);
    expect(tos(oop).length).toBeGreaterThanOrEqual(16);
    for (const to of tos(oop)) expect(to / 25).toBeCloseTo(4, 1);
    for (const to of tos(squeeze)) expect(to / 25).toBeCloseTo(5, 1);
    expect(tos(squeeze).length).toBeGreaterThanOrEqual(16);
    expect(short.every((r) => r.type === 'allin')).toBe(true);
  }, 60_000);
});

describe('Bot AI 2.0: big opens, all-ins and overbets', () => {
  it('judges a big open by its size and by the range behind it: no automatic fold, no automatic call', async () => {
    const opener = (o: Partial<Counters>) => ({ stats: { 0: counters(o) } });
    // Opens 10 big blinds with every hand it plays, and plays a lot of them.
    const bigOpener = opener({ hands: 200, vpipOpp: 200, vpip: 70, pfr: 66, opens: 66, bigOpens: 66, stealOpp: 80, steal: 50 });
    // Also opens 10 big blinds, but seldom.
    const tightBig = opener({ hands: 300, vpipOpp: 300, vpip: 27, pfr: 25, opens: 25, bigOpens: 25, stealOpp: 100, steal: 9 });
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const small = await rangeMix(bbVsBtn(25), bot(level));
      const five = await rangeMix(bbVsBtn(50), bot(level));
      const big = await rangeMix(bbVsBtn(100), bot(level));
      const huge = await rangeMix(bbVsBtn(200), bot(level));
      const vsBigOpener = await rangeMix(bbVsBtn(100), bot(level, bigOpener));
      const vsTight = await rangeMix(bbVsBtn(100), bot(level, tightBig));
      const old = await rangeMix(bbVsBtn(100), legacy(level));
      console.log(
        `${level} BB vs BTN 5BB ${show(five)} | 10BB ${show(big)} | 20BB ${show(huge)} | 10BB from a big opener ${show(vsBigOpener)} | from a tight one ${show(vsTight)} | before 2.0 ${show(old)}`,
      );
      expect(five.defend).toBeLessThan(small.defend);
      expect(five.defend).toBeGreaterThan(big.defend);
      expect(big.defend).toBeGreaterThan(0.06);
      expect(big.defend).toBeLessThan(small.defend);
      expect(huge.defend).toBeGreaterThan(0.03);
      expect(vsBigOpener.defend).toBeGreaterThan(big.defend);
      expect(vsTight.defend).toBeLessThanOrEqual(big.defend + 0.005);
      for (const hole of ['Ah Ad', 'Kh Kd', 'Qh Qd', 'Ah Kh']) {
        const v = await bbVsBtn(100)(hole);
        for (let k = 0; k < 10; k++) expect(kindOf(v, decideBot(level, v, seeded(k))), `${level} ${hole}`).not.toBe('fold');
      }
    }
  }, 240_000);

  it('never folds aces or kings before the flop, at any level, style or size', async () => {
    const spots: [string, (hole: string) => Promise<BotView>][] = [
      ['open shove', bbVsBtnShove],
      ['20BB open', bbVsBtn(200)],
      [
        '3-bet shove over its open',
        (hole) =>
          viewAt(3, 6, { 3: hole }, [
            [3, 'raise', 25],
            [4, 'allin'],
            [5, 'fold'],
            [0, 'fold'],
            [1, 'fold'],
            [2, 'fold'],
          ]),
      ],
    ];
    for (const [name, spot] of spots)
      for (const hole of ['Ah Ad', 'Kh Kd']) {
        const v = await spot(hole);
        for (const level of BOT_LEVELS)
          for (const style of BOT_STYLES)
            for (let k = 0; k < 6; k++) expect(decideBot(level, v, seeded(k), { style }).type, `${name} ${hole} ${level} ${style}`).not.toBe('fold');
      }
  }, 120_000);

  it('calls all-ins with a range: wider against a player who shoves all the time, not wider against one who seldom does', async () => {
    const jammer = { stats: { 0: counters({ hands: 120, vpipOpp: 120, vpip: 60, pfr: 56, opens: 54, jams: 54, stealOpp: 50, steal: 40 }) } };
    const tight = { stats: { 0: counters({ hands: 400, vpipOpp: 400, vpip: 60, pfr: 40, opens: 36, jams: 2, stealOpp: 150, steal: 30 }) } };
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const none = await rangeMix(bbVsBtnShove, bot(level));
      const vsJammer = await rangeMix(bbVsBtnShove, bot(level, jammer));
      const vsTight = await rangeMix(bbVsBtnShove, bot(level, tight));
      const old = await rangeMix(bbVsBtnShove, legacy(level));
      console.log(`${level} BB vs BTN 100BB shove: ${show(none)} | from a jammer ${show(vsJammer)} | from a tight player ${show(vsTight)} | before 2.0 ${show(old)}`);
      // Against an unknown, a 100BB shove is read as a strong range: more than aces and kings call, far from everything.
      expect(none.call).toBeGreaterThan(0.012);
      expect(none.call).toBeLessThan(0.25);
      expect(vsJammer.call).toBeGreaterThan(none.call + 0.04);
      expect(vsTight.call).toBeLessThanOrEqual(none.call + 0.005);
      const trash = await bbVsBtnShove('7h 2d');
      for (const o of [{}, jammer, tight]) for (let k = 0; k < 10; k++) expect(decideBot(level, trash, seeded(k), o).type).toBe('fold');
    }
  }, 240_000);

  // Heads-up, the bot (seat 1, big blind) called a raise and checks the river to a 2× pot overbet. On the "checked" line
  // the bettor checked the flop and turn behind; on the "barrel" line they bet half and two thirds of the pot, called.
  const BOARD = 'Kh 8d 4c 2s 9h';
  async function riverOverbet(hero: string, line: 'checked' | 'barrel', villain = '5d 6d') {
    const h = deal(2, { 1: hero, 0: villain }, { board: BOARD });
    await play(h, [
      [0, 'raise', 25],
      [1, 'call'],
    ]);
    for (const f of [0.5, 0.66]) {
      await play(h, [[1, 'check']]);
      if (line === 'checked') await play(h, [[0, 'check']]);
      else
        await play(h, [
          [0, 'bet', Math.round(h.handView().potTotal * f)],
          [1, 'call'],
        ]);
    }
    await play(h, [[1, 'check']]);
    await play(h, [[0, 'bet', Math.round(h.handView().potTotal * 2)]]);
    return botView(h, 'p1', BB)!;
  }
  const regular = { hands: 300, vpipOpp: 300, vpip: 80, pfr: 60, opens: 50, sawFlop: 150, showdowns: 45, postBets: 90, postCalls: 50, postBetOpp: 400 };
  const PROFILES: Record<string, Counters | undefined> = {
    none: undefined,
    // Three overbets in five chances and one bluff shown: too little to call a player a bluffer.
    small: counters({ hands: 6, vpipOpp: 6, vpip: 4, pfr: 3, sawFlop: 4, postBets: 3, postBetOpp: 5, overbets: 3, bigBetsShown: 1, bigBetBluffsShown: 1 }),
    bluffer: counters({ ...regular, overbets: 60, bigBetsShown: 20, bigBetBluffsShown: 14 }),
    tight: counters({ ...regular, overbets: 6, bigBetsShown: 10, bigBetBluffsShown: 1 }),
  };
  const N = 100;
  const rates = (level: BotLevel, v: BotView, profile: Counters | undefined) => {
    const rand = seeded(7);
    let call = 0;
    let raise = 0;
    for (let k = 0; k < N; k++) {
      const r = kindOf(v, decideBot(level, v, rand, { stats: profile ? { 0: profile } : undefined }));
      if (r === 'call') call++;
      else if (r === 'raise') raise++;
    }
    return { call: call / N, raise: raise / N };
  };

  it('answers a river overbet by the hand and the bettor’s public record: no automatic fold, no automatic call', async () => {
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const row: string[] = [];
      const at = async (hero: string, line: 'checked' | 'barrel') => {
        const v = await riverOverbet(hero, line);
        const out = Object.fromEntries(Object.entries(PROFILES).map(([name, p]) => [name, rates(level, v, p)]));
        row.push(`${hero} ${line}: ${Object.entries(out).map(([n, r]) => `${n} ${pct(r.call)}/${pct(r.raise)}`).join(', ')}`);
        return out;
      };
      // Top pair after the bettor checked twice: a bluff-catcher that calls the overbet whoever makes it.
      const checked = await at('Kd 7c', 'checked');
      // Top pair after two barrels: folds against an unknown or a value bettor, calls a proven bluffer.
      const barrel = await at('Kd 7c', 'barrel');
      const good = await at('Ks Qs', 'barrel');
      const air = await at('Qc Jc', 'barrel');
      const set = await at('4h 4s', 'barrel');
      console.log(`${level}\n  ${row.join('\n  ')}`);
      for (const r of [...Object.values(checked), ...Object.values(barrel), ...Object.values(good)]) expect(r.raise).toBe(0);
      for (const r of Object.values(checked)) expect(r.call).toBeGreaterThan(0.9);
      expect(barrel.bluffer!.call).toBeGreaterThan(level === 'normal' ? 0.6 : 0.9);
      expect(barrel.none!.call).toBeLessThan(0.15);
      expect(Math.abs(barrel.small!.call - barrel.none!.call)).toBeLessThan(0.15);
      expect(barrel.tight!.call).toBeLessThanOrEqual(barrel.none!.call + 0.05);
      expect(good.bluffer!.call).toBeGreaterThan(good.none!.call);
      for (const r of Object.values(air)) expect(r.call + r.raise).toBeLessThan(0.05);
      for (const r of Object.values(set)) expect(r.raise).toBeGreaterThan(0.4);
    }
    // The easy level misreads: it calls the overbet with any top pair (one of its intended mistakes).
    const v = await riverOverbet('Kd 7c', 'barrel');
    expect(rates('easy', v, undefined).call).toBeGreaterThan(0.8);
  }, 240_000);

  it('values a raise against the hands that would go on, not the bluffs that would fold', async () => {
    const stats = { stats: { 0: PROFILES.bluffer! } };
    const pair = readSpot('expert', await riverOverbet('Kd 7c', 'barrel'), seeded(1), stats);
    const set = readSpot('expert', await riverOverbet('4h 4s', 'barrel'), seeded(1), stats);
    const [pe, pr, se, sr] = [equityOf(pair, pair.opps), equityIfRaised(pair), equityOf(set, set.opps), equityIfRaised(set)];
    console.log(`top pair ${pct(pe)} → if raised ${pct(pr)}; set ${pct(se)} → if raised ${pct(sr)}`);
    expect(pr).toBeLessThan(pe - 0.2);
    expect(sr).toBeGreaterThan(0.58);
  }, 60_000);

  it('calls an overbet more often from a player who overbets at many chances, none shown down, and still folds air', async () => {
    // Overbets at one chance in five: that many cannot all be strong hands.
    const frequent = counters({ ...regular, overbets: 80 });
    const pair = await riverOverbet('Kd 7c', 'barrel');
    const air = await riverOverbet('Qc Jc', 'barrel');
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const none = rates(level, pair, undefined);
      const often = rates(level, pair, frequent);
      const airOften = rates(level, air, frequent);
      console.log(`${level} top pair vs a river overbet after two barrels: unknown ${pct(none.call)} | overbets often ${pct(often.call)} | air ${pct(airOften.call + airOften.raise)}`);
      expect(often.call).toBeGreaterThan(none.call + 0.1);
      expect(airOften.call + airOften.raise).toBeLessThan(0.05);
    }
    // The easy level reads no statistics: the same answer whoever bets.
    expect(rates('easy', pair, frequent)).toEqual(rates('easy', pair, undefined));
  }, 120_000);
});

describe('Bot AI 2.0: 4-bets and reads before the flop', () => {
  // Six seats: under the gun (seat 3) opens 2.5BB, the button (seat 0) 3-bets to 8BB, the blinds fold.
  const utgVs3Bet = (hole: string, stacks?: number[]) =>
    viewAt(
      3,
      6,
      { 3: hole },
      [
        [3, 'raise', 25],
        [4, 'fold'],
        [5, 'fold'],
        [0, 'raise', 80],
        [1, 'fold'],
        [2, 'fold'],
      ],
      { stacks },
    );

  it('4-bets a 3-bet with its best hands, about 2.5 times out of position, folds the bottom, and shoves when short', async () => {
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const mix = await rangeMix(utgVs3Bet, bot(level));
      console.log(`${level} UTG open facing a BTN 3-bet: ${show(mix)}`);
      expect(mix.raise).toBeGreaterThan(0.005);
      expect(mix.raise).toBeLessThan(0.08);
      for (const hole of ['Ah Ad', 'Kh Kd']) {
        const v = await utgVs3Bet(hole);
        const rs = Array.from({ length: 20 }, (_, k) => decideBot(level, v, seeded(k), { style: 'balanced' }));
        const raises = rs.filter((r) => r.type === 'raise');
        expect(rs.some((r) => r.type === 'fold'), `${level} ${hole}`).toBe(false);
        expect(raises.length, `${level} ${hole}`).toBeGreaterThanOrEqual(14);
        for (const r of raises) expect(r.amount! / 80).toBeCloseTo(2.5, 1);
        // 30 big blinds deep a 4-bet would commit most of the stack: all in instead.
        const short = await utgVs3Bet(hole, [300, 300, 300, 300, 300, 300]);
        for (let k = 0; k < 10; k++) expect(decideBot(level, short, seeded(k), { style: 'balanced' }).type, `${level} ${hole} short`).toBe('allin');
      }
      const trash = await utgVs3Bet('7h 2d');
      for (let k = 0; k < 10; k++) expect(decideBot(level, trash, seeded(k)).type).toBe('fold');
    }
  }, 180_000);

  it('defends the big blind wider against a button that steals all the time, tighter against one that seldom does', async () => {
    const stealer = { stats: { 0: counters({ hands: 300, vpipOpp: 300, vpip: 150, pfr: 140, opens: 140, stealOpp: 120, steal: 100 }) } };
    const nit = { stats: { 0: counters({ hands: 300, vpipOpp: 300, vpip: 45, pfr: 36, opens: 36, stealOpp: 120, steal: 12 }) } };
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const none = await rangeMix(bbVsBtn(25), bot(level));
      const vsStealer = await rangeMix(bbVsBtn(25), bot(level, stealer));
      const vsNit = await rangeMix(bbVsBtn(25), bot(level, nit));
      console.log(`${level} BB vs a 2.5BB BTN open: unknown ${show(none)} | a stealer ${show(vsStealer)} | a nit ${show(vsNit)}`);
      expect(vsStealer.defend).toBeGreaterThan(none.defend + 0.03);
      expect(vsStealer.raise).toBeGreaterThan(none.raise);
      expect(vsNit.defend).toBeLessThan(none.defend - 0.03);
    }
    // The easy level reads no statistics: the same decisions whoever opens.
    expect(await rangeMix(bbVsBtn(25), bot('easy', stealer))).toEqual(await rangeMix(bbVsBtn(25), bot('easy')));
  }, 240_000);

  it('3-bets as a bluff more often against an opener who folds to 3-bets than against one who does not', async () => {
    const opener = { hands: 300, vpipOpp: 300, vpip: 90, pfr: 80, opens: 80, stealOpp: 120, steal: 46, foldTo3BetOpp: 80 };
    const folds = { stats: { 0: counters({ ...opener, foldTo3Bet: 72 }) } };
    const sticks = { stats: { 0: counters({ ...opener, foldTo3Bet: 16 }) } };
    const bluffs = ['Ah 5h', 'Ah 4h', 'Kh 9h', 'Th 9h', '8h 7h', '6h 5h'];
    for (const level of ['normal', 'hard', 'expert'] as const) {
      const rate = async (o: Parameters<typeof decideBot>[3]) => {
        let raise = 0;
        for (const hole of bluffs) raise += spotMix(await bbVsBtn(25)(hole), bot(level, o)).raise / bluffs.length;
        return raise;
      };
      const vsFolder = await rate(folds);
      const vsSticky = await rate(sticks);
      console.log(`${level} BB bluff-3-bet hands vs a BTN open: opener folds to 3-bets ${pct(vsFolder)} | does not ${pct(vsSticky)}`);
      expect(vsFolder).toBeGreaterThan(vsSticky + 0.08);
      expect(vsFolder).toBeLessThan(0.9);
    }
  }, 120_000);
});

describe('Bot AI 2.0: after the flop', () => {
  const N = 200;
  const LEVELS = ['normal', 'hard', 'expert'] as const;
  // Heads-up: the button (seat 0) raised to 2.5BB and the big blind (seat 1) called; on the flop the big blind checks
  // and the button bets `bet` into the 50-chip pot.
  const bbFacingFlop = (board: string, bet: number) => (hole: string) =>
    viewAt(
      1,
      2,
      { 1: hole },
      [
        [0, 'raise', 25],
        [1, 'call'],
        [1, 'check'],
        [0, 'bet', bet],
      ],
      { board },
    );

  it('calls a flush draw at a good price and folds most of it to a 2× pot overbet; a draw with 15 outs stays in', async () => {
    for (const level of LEVELS) {
      const small = spotMix(await bbFacingFlop('Kh 8h 3c 2d 5s', 17)('Th 6h'), bot(level), N);
      const over = spotMix(await bbFacingFlop('Kh 8h 3c 2d 5s', 100)('Th 6h'), bot(level), N);
      const combo = spotMix(await bbFacingFlop('Jh 8h 3c 2d 5s', 100)('Th 9h'), bot(level), N);
      console.log(`${level} flush draw vs 1/3 pot ${show(small)} | vs 2× pot ${show(over)} | flush and straight draw vs 2× pot ${show(combo)}`);
      expect(small.defend).toBeGreaterThan(0.85);
      expect(over.defend).toBeLessThan(small.defend - 0.3);
      expect(combo.defend).toBeGreaterThan(over.defend + 0.3);
    }
  }, 120_000);

  it('keeps top pair against a half-pot bet and folds air; a set check-raises and never folds', async () => {
    const board = 'Kh 8d 3c 2s 5h';
    const spot = bbFacingFlop(board, 25);
    for (const level of LEVELS) {
      const top = spotMix(await spot('Kd Jc'), bot(level), N);
      const air = spotMix(await spot('7s 4d'), bot(level), N);
      const set = spotMix(await spot('8s 8c'), bot(level), N);
      console.log(`${level} vs a half-pot flop bet: top pair ${show(top)} | air ${show(air)} | set ${show(set)}`);
      expect(top.defend).toBeGreaterThan(0.9);
      expect(air.fold).toBeGreaterThan(0.75);
      expect(set.fold).toBe(0);
      expect(set.raise).toBeGreaterThan(0.35);
    }
    const set = await spot('8s 8c');
    for (const level of BOT_LEVELS) expect(spotMix(set, bot(level), 50).fold, level).toBe(0);
  }, 120_000);

  it('answers a flop overbet by the hand: top pair mostly stays, middle pair folds more than to a small bet, air folds', async () => {
    const board = 'Kh 8d 3c 2s 5h';
    for (const level of LEVELS) {
      const top = spotMix(await bbFacingFlop(board, 100)('Kd Tc'), bot(level), N);
      const midSmall = spotMix(await bbFacingFlop(board, 17)('8s 7s'), bot(level), N);
      const midOver = spotMix(await bbFacingFlop(board, 100)('8s 7s'), bot(level), N);
      const air = spotMix(await bbFacingFlop(board, 100)('7s 4d'), bot(level), N);
      const half = await rangeMix(bbFacingFlop(board, 25), bot(level), 2, board);
      const over = await rangeMix(bbFacingFlop(board, 100), bot(level), 2, board);
      console.log(
        `${level} vs a 2× pot flop overbet: top pair ${show(top)} | middle pair ${show(midOver)} (vs 1/3 pot ${show(midSmall)}) | air ${show(air)} | all hands ${show(over)} (vs half pot ${show(half)})`,
      );
      expect(top.defend).toBeGreaterThan(0.5);
      expect(midOver.defend).toBeLessThan(midSmall.defend - 0.2);
      expect(air.defend).toBeLessThan(0.05);
      expect(over.defend).toBeLessThan(half.defend);
      expect(over.defend).toBeGreaterThan(0.1);
      expect(over.fold).toBeGreaterThan(0.3);
    }
  }, 240_000);

  it('continuation-bets a dry flop far more heads-up than into two players, and never folds when it can check', async () => {
    const board = '9s 5d 2c Kh 7h';
    const hu = (hole: string) => viewAt(0, 6, { 0: hole }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold'], [2, 'call'], [2, 'check']], { board });
    const multi = (hole: string) => viewAt(0, 6, { 0: hole }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'call'], [2, 'call'], [1, 'check'], [2, 'check']], { board });
    for (const level of LEVELS) {
      const a = spotMix(await hu('Ah Qd'), bot(level), N);
      const b = spotMix(await multi('Ah Qd'), bot(level), N);
      const ra = await rangeMix(hu, bot(level), 2, board);
      const rb = await rangeMix(multi, bot(level), 2, board);
      console.log(`${level} c-bet on 9s 5d 2c: AQ heads-up ${show(a)} | into two ${show(b)} | all hands heads-up ${show(ra)} | into two ${show(rb)}`);
      expect(a.raise).toBeGreaterThan(0.3);
      expect(a.raise).toBeLessThan(0.95);
      expect(b.raise).toBeLessThan(a.raise - 0.2);
      expect(ra.raise).toBeGreaterThan(rb.raise + 0.1);
      expect(a.fold + b.fold + ra.fold + rb.fold).toBe(0);
    }
  }, 240_000);

  it('calls a flop bet with second pair less often when another player has called it too', async () => {
    const board = 'Kh 8d 3c 2s 5h';
    const hu = (hole: string) => viewAt(2, 6, { 2: hole }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold'], [2, 'call'], [2, 'check'], [0, 'bet', 27]], { board });
    const multi = (hole: string) =>
      viewAt(2, 6, { 2: hole }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'call'], [2, 'call'], [1, 'check'], [2, 'check'], [0, 'bet', 38], [1, 'call']], { board });
    for (const level of LEVELS) {
      const a = spotMix(await hu('8s 7s'), bot(level), N);
      const b = spotMix(await multi('8s 7s'), bot(level), N);
      const ra = await rangeMix(hu, bot(level), 2, board);
      const rb = await rangeMix(multi, bot(level), 2, board);
      console.log(`${level} second pair vs a half-pot flop bet: heads-up ${show(a)} | with a caller ${show(b)} | all hands heads-up ${show(ra)} | with a caller ${show(rb)}`);
      expect(b.defend).toBeLessThan(a.defend - 0.1);
      expect(rb.defend).toBeLessThan(ra.defend);
    }
  }, 240_000);

  it('bets the nuts on the river for value and bluffs some of its air, never all of it', async () => {
    // Heads-up, the bot is the button (seat 0) and every street before checked through; the big blind checks the river.
    const river = (hole: string) =>
      viewAt(
        0,
        2,
        { 0: hole },
        [
          [0, 'raise', 25],
          [1, 'call'],
          [1, 'check'],
          [0, 'check'],
          [1, 'check'],
          [0, 'check'],
          [1, 'check'],
        ],
        { board: 'Kh 8d 4c 2s 9h' },
      );
    for (const level of BOT_LEVELS) {
      const nuts = spotMix(await river('Kd Kc'), bot(level), N);
      // A missed straight draw: no pair, seven high.
      const air = spotMix(await river('7c 6c'), bot(level), N);
      console.log(`${level} river in position after three checks: top set ${show(nuts)} | air ${show(air)}`);
      if (level !== 'easy') {
        expect(nuts.raise).toBeGreaterThan(0.8);
        expect(air.raise).toBeGreaterThan(0.03);
      }
      expect(air.raise).toBeLessThan(0.4);
      expect(nuts.fold + air.fold).toBe(0);
    }
  }, 120_000);

  it('never folds a hand nothing can beat on the river, even one that can only split the pot', async () => {
    // Heads-up, checked to the river on a royal flush board; the big blind moves all in, twenty times the pot.
    const v = await viewAt(
      0,
      2,
      { 0: '2c 3d' },
      [
        [0, 'call'],
        [1, 'check'],
        [1, 'check'],
        [0, 'check'],
        [1, 'check'],
        [0, 'check'],
        [1, 'allin'],
      ],
      { board: 'Ts Js Qs Ks As', stacks: [410, 410] },
    );
    expect([v.pot, v.toCall]).toEqual([420, 400]);
    for (const level of BOT_LEVELS) expect(spotMix(v, bot(level), N).fold, level).toBe(0);
  });
});

describe('Bot AI 2.0: public statistics', () => {
  const facts = (h: HandEngine, stacks: number[], button = 0) => ({
    bigBlind: BB,
    buttonSeat: button,
    seats: stacks.map((stack, seat) => ({ seat, stack })),
    actions: h.publicActions().map((a) => ({ seat: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
    board: h.handView().board,
    shown: [],
    showdown: [],
  });

  it('counts each statistic over its own opportunities, from the public action list', async () => {
    // Three players: the button opens, the small blind folds, the big blind 3-bets and the button folds.
    const pre = deal(3, {});
    await play(pre, [
      [0, 'raise', 25],
      [1, 'fold'],
      [2, 'raise', 90],
      [0, 'fold'],
    ]);
    const a = handCounters(facts(pre, [1000, 1000, 1000]));
    expect(a.get(0)).toMatchObject({ hands: 1, vpipOpp: 1, vpip: 1, pfr: 1, stealOpp: 1, steal: 1, opens: 1, bigOpens: 0, foldTo3BetOpp: 1, foldTo3Bet: 1, fourBetOpp: 1, fourBet: 0 });
    expect(a.get(1)).toMatchObject({ vpipOpp: 1, vpip: 0, threeBetOpp: 1, threeBet: 0, bbStealOpp: 0 });
    expect(a.get(2)).toMatchObject({ vpipOpp: 1, vpip: 1, pfr: 1, threeBetOpp: 1, threeBet: 1, bbStealOpp: 1, bbFoldToSteal: 0 });
    // Heads-up: a limp, a check, then a 1.5× pot bet on the flop that the big blind folds to.
    const post = deal(2, {});
    await play(post, [
      [0, 'call'],
      [1, 'check'],
      [1, 'check'],
      [0, 'bet', 30],
      [1, 'fold'],
    ]);
    const b = handCounters(facts(post, [1000, 1000]));
    expect(b.get(0)).toMatchObject({ opens: 0, postBetOpp: 1, postBets: 1, overbets: 1, sawFlop: 1 });
    expect(b.get(1)).toMatchObject({ postBetOpp: 2, foldToOverbetOpp: 1, foldToOverbet: 1, sawFlop: 1 });
  });

  it('counts a chance to 3-bet only when the player could have raised', async () => {
    // Heads-up, equal stacks: the button moves all in and the big blind can only call or fold.
    const even = deal(2, {});
    await play(even, [
      [0, 'allin'],
      [1, 'fold'],
    ]);
    expect(handCounters(facts(even, [1000, 1000])).get(1)).toMatchObject({ threeBetOpp: 0, allinCallOpp: 1 });
    // Covering the shove is not enough when nobody is left with chips to answer a raise.
    const covered = deal(2, {}, { stacks: [500, 1000] });
    await play(covered, [
      [0, 'allin'],
      [1, 'fold'],
    ]);
    expect(handCounters(facts(covered, [500, 1000])).get(1)).toMatchObject({ threeBetOpp: 0, allinCallOpp: 1 });
    // Three players: the small blind could raise to isolate (the big blind still has chips); the big blind, last to act
    // once the small blind folds, could not.
    const three = deal(3, {}, { stacks: [500, 1000, 1000] });
    await play(three, [
      [0, 'allin'],
      [1, 'fold'],
      [2, 'fold'],
    ]);
    const t = handCounters(facts(three, [500, 1000, 1000]));
    expect(t.get(1)).toMatchObject({ threeBetOpp: 1, threeBet: 0 });
    expect(t.get(2)).toMatchObject({ threeBetOpp: 0, allinCallOpp: 1 });
  });

  it('counts no chance to 4-bet for a player an all-in too short to reopen the raising comes back to', async () => {
    // The small blind's shove to 145 raises by 45, less than the open's 90: the opener may only call or fold, while
    // the big blind, yet to act, may raise.
    const short = deal(3, {}, { stacks: [1000, 145, 1000] });
    await play(short, [
      [0, 'raise', 100],
      [1, 'allin'],
      [2, 'call'],
    ]);
    expect(short.legalOptions('p0').map((o) => o.type)).not.toContain('raise');
    await play(short, [[0, 'call']]);
    const s = handCounters(facts(short, [1000, 145, 1000]));
    expect(s.get(0)).toMatchObject({ fourBetOpp: 0, foldTo3BetOpp: 1 });
    expect(s.get(2)).toMatchObject({ fourBetOpp: 1, fourBet: 0 });
    // A player who called the open is not reopened either.
    const caller = deal(4, {}, { stacks: [1000, 145, 1000, 1000] });
    await play(caller, [
      [3, 'raise', 100],
      [0, 'call'],
      [1, 'allin'],
      [2, 'fold'],
    ]);
    expect(caller.legalOptions('p3').map((o) => o.type)).not.toContain('raise');
    await play(caller, [[3, 'call']]);
    expect(caller.legalOptions('p0').map((o) => o.type)).not.toContain('raise');
    await play(caller, [[0, 'call']]);
    const k = handCounters(facts(caller, [1000, 145, 1000, 1000]));
    expect(k.get(3)).toMatchObject({ fourBetOpp: 0 });
    expect(k.get(0)).toMatchObject({ fourBetOpp: 0 });
    expect(k.get(1)).toMatchObject({ threeBetOpp: 1, threeBet: 1 });
  });

  it('stays near the population average on a small sample, and needs showdowns before reading big bets', () => {
    const regular = { hands: 300, vpipOpp: 300, vpip: 80, pfr: 60, postBets: 90, postCalls: 50, postBetOpp: 400 };
    for (const k of [14, 30, 60]) {
      const small = tendencies(counters({ hands: 6, vpipOpp: 6, vpip: 4, pfr: 3, postBets: 3, postBetOpp: 5, overbets: 3, bigBetsShown: 1, bigBetBluffsShown: 1 }), k);
      expect(small.overbet).toBeLessThan(0.05);
      expect(small.overbetChances).toBe(5);
      expect(bigBetRead(small)).toBe('unknown');
      expect(small.type).toBe('unknown');
      // Five big bets shown, all bluffs: still too few to call.
      expect(bigBetRead(tendencies(counters({ ...regular, bigBetsShown: 5, bigBetBluffsShown: 5 }), k))).toBe('unknown');
      expect(bigBetRead(tendencies(counters({ ...regular, bigBetsShown: 20, bigBetBluffsShown: 14 }), k))).toBe('bluff-heavy');
      expect(bigBetRead(tendencies(counters({ ...regular, bigBetsShown: 20, bigBetBluffsShown: 1 }), k))).toBe('value-heavy');
      expect(bigBetRead(tendencies(counters({ ...regular, bigBetsShown: 10, bigBetBluffsShown: 3 }), k))).toBe('balanced');
      // 60 overbets in 400 chances moves the estimate well off the population average.
      expect(tendencies(counters({ ...regular, overbets: 60 }), k).overbet).toBeGreaterThan(tendencies(counters(regular), k).overbet + 0.05);
    }
    expect(tendencies(counters({ hands: 300, vpipOpp: 300, vpip: 150, pfr: 20, postBets: 20, postCalls: 80 }), 14).type).toBe('LP');
    expect(tendencies(counters({ hands: 300, vpipOpp: 300, vpip: 60, pfr: 50, postBets: 90, postCalls: 30 }), 14).type).toBe('TAG');
  });
});

describe('Bot AI 2.0: levels and styles move separately', () => {
  // The cutoff (seat 5) first in, and the button's continuation bet heads-up on a dry flop after the big blind called.
  const coFirstIn = (hole: string) => viewAt(5, 6, { 5: hole }, [[3, 'fold'], [4, 'fold']]);
  const board = '9s 5d 2c Kh 7h';
  const cbet = (hole: string) => viewAt(0, 6, { 0: hole }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold'], [2, 'call'], [2, 'check']], { board });
  const bbFacingFlop = (bet: number) => (hole: string) =>
    viewAt(1, 2, { 1: hole }, [[0, 'raise', 25], [1, 'call'], [1, 'check'], [0, 'bet', bet]], { board: 'Kh 8d 3c 2s 5h' });

  it('keeps each style’s width and aggression at every level', async () => {
    for (const level of BOT_LEVELS) {
      const m = {} as Record<BotStyle, Mix>;
      for (const style of BOT_STYLES) m[style] = await rangeMix(coFirstIn, bot(level, { style }), 2);
      console.log(`${level} CO first in: ${BOT_STYLES.map((s) => `${s} ${show(m[s])}`).join(' | ')}`);
      // Wider: loose-aggressive over tight-aggressive, loose-passive over balanced; tighter: both tight styles.
      expect(m.lag.defend, level).toBeGreaterThan(m.tag.defend + 0.05);
      expect(m['loose-passive'].defend, level).toBeGreaterThan(m.balanced.defend);
      expect(m.tag.defend, level).toBeLessThan(m.balanced.defend);
      expect(m['tight-passive'].defend, level).toBeLessThan(m.balanced.defend);
      // Passive: the hands it plays are limped more and raised less.
      for (const s of ['tight-passive', 'loose-passive'] as const) {
        expect(m[s].call / m[s].defend, `${level} ${s}`).toBeGreaterThan(m.balanced.call / m.balanced.defend);
        expect(m[s].raise, `${level} ${s}`).toBeLessThan(m.tag.raise);
      }
    }
  }, 240_000);

  it('lets an expert be passive and an easy bot aggressive, and keeps the expert’s passive calls by the price', async () => {
    const expertTp = await rangeMix(cbet, bot('expert', { style: 'tight-passive' }), 2, board);
    const easyLag = await rangeMix(cbet, bot('easy', { style: 'lag' }), 2, board);
    console.log(`c-bet heads-up on 9s 5d 2c: expert tight-passive ${show(expertTp)} | easy loose-aggressive ${show(easyLag)}`);
    expect(easyLag.raise).toBeGreaterThan(expertTp.raise + 0.1);
    // A loose-passive expert calls wide but is no calling station: air folds to a half-pot bet and to an overbet,
    // top pair stays, and an overbet is defended less than a half-pot bet.
    const lp = bot('expert', { style: 'loose-passive' });
    const air = spotMix(await bbFacingFlop(25)('7s 4d'), lp, 200);
    const airOver = spotMix(await bbFacingFlop(100)('7s 4d'), lp, 200);
    const top = spotMix(await bbFacingFlop(25)('Kd Jc'), lp, 200);
    const half = await rangeMix(bbFacingFlop(25), lp, 2, 'Kh 8d 3c 2s 5h');
    const over = await rangeMix(bbFacingFlop(100), lp, 2, 'Kh 8d 3c 2s 5h');
    console.log(`expert loose-passive vs a flop bet: air ${show(air)} | air vs 2× pot ${show(airOver)} | top pair ${show(top)} | all hands vs half pot ${show(half)} | vs 2× pot ${show(over)}`);
    expect(air.fold).toBeGreaterThan(0.75);
    expect(airOver.defend).toBeLessThan(0.05);
    expect(top.defend).toBeGreaterThan(0.9);
    expect(over.defend).toBeLessThan(half.defend - 0.1);
  }, 240_000);
});

describe('Bot AI 2.0: fairness and safety', () => {
  it('sees only its own seat: the same view and the same decisions whatever the others hold', async () => {
    const stats = { stats: { 0: PROFILES_FOR_FAIRNESS } };
    const pairs: [BotView, BotView][] = [
      [await viewAt(2, 6, { 2: 'Jh Td', 0: '2c 7d' }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']]), await viewAt(2, 6, { 2: 'Jh Td', 0: 'Ac As' }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']])],
    ];
    const river = async (villain: string) => {
      const h = deal(2, { 1: 'Kd 7c', 0: villain }, { board: 'Kh 8d 4c 2s 9h' });
      await play(h, [
        [0, 'raise', 25],
        [1, 'call'],
        [1, 'check'],
        [0, 'bet', 25],
        [1, 'call'],
        [1, 'check'],
        [0, 'check'],
        [1, 'check'],
        [0, 'bet', 200],
      ]);
      return botView(h, 'p1', BB)!;
    };
    pairs.push([await river('5d 6d'), await river('Ad Ac')]);
    for (const [a, b] of pairs) {
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      for (const level of BOT_LEVELS) {
        const ra = seeded(3);
        const rb = seeded(3);
        for (let k = 0; k < 50; k++) expect(decideBot(level, a, ra, stats)).toEqual(decideBot(level, b, rb, stats));
      }
    }
  }, 60_000);

  const tableArb = fc.constantFrom<MaxSeats>(2, 6, 9).chain((maxSeats) =>
    fc.record({
      maxSeats: fc.constant(maxSeats),
      players: fc.uniqueArray(fc.integer({ min: 0, max: maxSeats - 1 }), { minLength: 2, maxLength: maxSeats }),
      stacks: fc.array(fc.integer({ min: 1, max: 4000 }), { minLength: maxSeats, maxLength: maxSeats }),
      levels: fc.array(fc.constantFrom<BotLevel>(...BOT_LEVELS), { minLength: maxSeats, maxLength: maxSeats }),
      styles: fc.array(fc.constantFrom<BotStyle>(...BOT_STYLES), { minLength: maxSeats, maxLength: maxSeats }),
      // Any counters at all, inconsistent ones included (more calls than chances, and so on).
      stats: fc.array(fc.array(fc.nat(400), { minLength: STAT_KEYS.length, maxLength: STAT_KEYS.length }), { minLength: maxSeats, maxLength: maxSeats }),
      button: fc.integer({ min: 0, max: maxSeats - 1 }),
      seed: fc.integer(),
    }),
  );

  it('only acts legally with any style and any statistics, and plays a hand the same way twice from the same seed', async () => {
    let actions = 0;
    await fc.assert(
      fc.asyncProperty(tableArb, async (t) => {
        const deck = [...standardDeck()];
        const shuffle = seeded(t.seed ^ 0x5bd1e995);
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(shuffle() * (i + 1));
          [deck[i], deck[j]] = [deck[j]!, deck[i]!];
        }
        const stats = new Map(t.stats.map((a, seat) => [seat, unpackCounters(a)]));
        const playOnce = async () => {
          const rand = seeded(t.seed);
          const seats = t.players.map((seatIndex, i) => ({ playerId: `b${seatIndex}`, seatIndex, stack: t.stacks[i]!, displayName: `B${seatIndex}` }));
          const total = seats.reduce((a, s) => a + s.stack, 0);
          const h = HandEngine.start({ handId: 'fuzz', rules: { maxSeats: t.maxSeats, smallBlind: 5, bigBlind: 10, turnMs: 20_000 }, seats, buttonSeat: t.button, now: 1, deck });
          const log: string[] = [];
          for (let step = 0; !h.isSettled; step++) {
            expect(step).toBeLessThan(400);
            if (h.isStalled()) {
              await h.resolveStall(10 + step);
              continue;
            }
            const actor = h.actorId()!;
            const v = botView(h, actor, 10)!;
            const seat = h.seatOf(actor)!;
            const req = decideBot(t.levels[seat]!, v, rand, { style: t.styles[seat], stats });
            if (req.type === 'fold') expect(v.legal.some((o) => o.type === 'check')).toBe(false);
            const r = await h.act(actor, req, `f${step}`, 10 + step);
            expect(r.ok, JSON.stringify({ req, legal: v.legal })).toBe(true);
            expect(h.totalChips()).toBe(total);
            log.push(`${seat}:${req.type}:${req.amount ?? ''}`);
            actions++;
          }
          return log;
        };
        expect(await playOnce()).toEqual(await playOnce());
      }),
      { numRuns: 60 },
    );
    expect(actions).toBeGreaterThan(200);
  }, 300_000);

  it('keeps working on broken statistics, and names its strategy and styles stably', async () => {
    const v = await viewAt(2, 6, { 2: 'Jh Td' }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']]);
    const broken = { ...emptyCounters(), hands: Number.NaN, vpipOpp: -5, vpip: Number.POSITIVE_INFINITY, postBetOpp: -1, overbets: 9e9 } as Counters;
    for (const level of BOT_LEVELS) {
      const r = decideBot(level, v, seeded(1), { stats: { 0: broken } });
      expect(['fold', 'call', 'raise', 'allin']).toContain(r.type);
    }
    expect(STRATEGY_VERSION).toBe('bot-ai-2.0');
    const styles = new Set(Array.from({ length: 100 }, (_, i) => styleFor(`bot-${i}`)));
    expect(styles.size).toBe(BOT_STYLES.length);
    expect(styleFor('bot-7')).toBe(styleFor('bot-7'));
  });

  it('checks or folds when its strategy fails, and tells only the caller who asked (for statistics)', async () => {
    const v = await viewAt(2, 6, { 2: 'Jh Td' }, [...FOLD_TO_BTN, [0, 'raise', 25], [1, 'fold']]);
    const broken = () => {
      throw new Error('no randomness');
    };
    for (const level of BOT_LEVELS) {
      let told = 0;
      expect(decideBot(level, v, broken, { onFallback: () => told++ })).toEqual({ type: 'fold' });
      expect(told).toBe(1);
      // Without the option nothing changes, and a decision that worked tells nothing.
      expect(decideBot(level, v, broken)).toEqual({ type: 'fold' });
      decideBot(level, v, seeded(3), { onFallback: () => told++ });
      expect(told).toBe(1);
    }
  });

  it('decides quickly enough at Expert, multiway after the flop', async () => {
    const h = deal(6, { 3: 'Jh Td' }, { board: '9c 8s 2d Kh 4c' });
    await play(h, [
      [3, 'raise', 25],
      [4, 'call'],
      [5, 'call'],
      [0, 'call'],
      [1, 'fold'],
      [2, 'fold'],
    ]);
    const v = botView(h, 'p3', BB)!;
    const stats = Object.fromEntries([4, 5, 0].map((s) => [s, counters({ hands: 100, vpipOpp: 100, vpip: 30, pfr: 20, postBets: 30, postCalls: 20, postBetOpp: 120, sawFlop: 40 })]));
    const rand = seeded(5);
    const t0 = performance.now();
    for (let k = 0; k < 30; k++) decideBot('expert', v, rand, { stats });
    const ms = (performance.now() - t0) / 30;
    console.log(`expert multiway flop decision ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });
});

/** A player whose big bets have been shown to be bluffs (for the fairness case: statistics do not change what is seen). */
const PROFILES_FOR_FAIRNESS = counters({ hands: 300, vpipOpp: 300, vpip: 80, pfr: 60, postBets: 90, postCalls: 50, postBetOpp: 400, overbets: 60, bigBetsShown: 20, bigBetBluffsShown: 14 });
