/**
 * Balance simulation for the bot levels and styles (docs/BOT_AI.md "난이도·스타일 밸런싱"). Whole hands through the real
 * hand engine, 100 big blinds reset every hand, sessions of the same players so the adapting levels see a record.
 *
 *   pnpm exec tsx sim/balance-sim.ts --exp field --sessions 12 --hands 200 --seed 7 --shard 0/14 --out <file.json>
 *   pnpm exec tsx sim/balance-sim.ts --exp duel --sessions 40 --hands 200 --seed 7 --shard 0/14 --out <file.json>
 *   pnpm exec tsx sim/balance-sim.ts --exp perf --hands 300 --seed 7 --out <file.json>
 *
 * field  Six seats: one bot against five players of one kind (sim/opponents.ts) or five bots of random levels and
 *        styles (the auto styles, as a table on 'auto' deals them). Every level × style plays the same decks, from the same seat, against opponents drawing the same
 *        random numbers, so differences between levels or styles are paired session by session.
 * duel   Two bots heads-up for each pair of levels (balanced style), every deck dealt twice with the seats swapped.
 * perf   Six and nine bots of one level at one table: decision time per decision and for the whole table per hand.
 *
 * The bots decide from their own view only. The simulation reads a bot's own two cards after it decided, to grade the
 * decision (a bet with a hand that loses to most hands, a river call below the pot odds against any hand).
 */
import { writeFileSync } from 'node:fs';
import { classOf } from '../src/ai/classes';
import { comboIndex } from '../src/ai/profile';
import { percentile } from '../src/ai/ranges';
import { cardCode } from '../src/ai/score';
import { isStrongDraw, strengthTable } from '../src/ai/strength';
import type { PubAction } from '../src/ai/walk';
import { addCounters, BOT_AUTO_STYLES, BOT_LEVELS, BOT_STYLES, botView, decideBot, emptyCounters, handCounters, HandEngine, packCounters, type BotLevel, type BotStyle, type BotView, type Counters, type MaxSeats } from '../src';
import type { ActionRequest } from '../src/hand';
import { decideOpponent, OPPONENTS, type Opponent } from './opponents';
import { seeded } from './rng';
import { mix, shuffled } from './table-sim';

export const BB = 10;
const DEPTH = 100;
export const FIELDS = [...OPPONENTS, 'bots'] as const;
export type Field = (typeof FIELDS)[number];
export const PAIRS: [BotLevel, BotLevel][] = [
  ['expert', 'hard'],
  ['expert', 'normal'],
  ['expert', 'easy'],
  ['hard', 'normal'],
  ['hard', 'easy'],
  ['normal', 'easy'],
];

/** Decisions graded with the deciding bot's own cards (afterwards, for the report only). */
export interface Grade {
  /** Bets and raises on the flop and turn; with a hand weaker than half the hands (no strong draw), with a strong draw. */
  earlyBets: number;
  earlyBluffs: number;
  semiBluffs: number;
  /** Bets and raises on the river; with a hand weaker than half the hands. */
  riverBets: number;
  riverBluffs: number;
  /** River calls; below the pot odds even against a random hand. */
  riverCalls: number;
  badRiverCalls: number;
  /** Calls of 20 big blinds or more; with a weak hand (outside the top 45% before the flop, strength under 0.4 after). */
  bigCalls: number;
  weakBigCalls: number;
  /** After the flop, each bet or raise as a share of the pot (summed, over earlyBets + riverBets); those over the pot. */
  sizeSum: number;
  overbets: number;
  /**
   * Bets and raises all in; those out of line, as sim/table-sim.ts grades them: before the flop for 30 big blinds or
   * more outside the top 25% of hands, after it for more than three times the pot with a strength under 0.3.
   */
  jams: number;
  wildJams: number;
  decisions: number;
}
export const emptyGrade = (): Grade => ({ earlyBets: 0, earlyBluffs: 0, semiBluffs: 0, riverBets: 0, riverBluffs: 0, riverCalls: 0, badRiverCalls: 0, bigCalls: 0, weakBigCalls: 0, sizeSum: 0, overbets: 0, jams: 0, wildJams: 0, decisions: 0 });

/** One player's session: chips, hands won, the public counters (packed, `STAT_KEYS` order) and the graded decisions. */
export interface Rec {
  key: string;
  si: number;
  hands: number;
  net: number;
  won: number;
  sdWon: number;
  c: number[];
  g: Grade;
}

/** Decision times in 0.05 ms bins up to 100 ms (the last bin holds everything slower). */
export const BIN = 0.05;
export const BINS = 2000;
export interface Timing {
  n: number;
  sum: number;
  max: number;
  bins: number[];
}
const emptyTiming = (): Timing => ({ n: 0, sum: 0, max: 0, bins: new Array(BINS).fill(0) });
function time(t: Timing, ms: number) {
  t.n++;
  t.sum += ms;
  t.max = Math.max(t.max, ms);
  t.bins[Math.min(BINS - 1, Math.floor(ms / BIN))]!++;
}

export interface BalanceOutput {
  exp: 'field' | 'duel' | 'perf';
  seed: number;
  shard: string;
  hands: number;
  recs: Rec[];
  /** Per level: every decision a bot of that level made (field: the bot under test only). */
  timing: Record<string, Timing>;
  /** perf: per level and table size, the decision time of all bots together per hand. */
  tables: Record<string, Timing>;
  errors: string[];
  wallMs: number;
}

interface Player {
  id: string;
  seat: number;
  bot?: { level: BotLevel; style: BotStyle };
  opp?: Opponent;
}

interface Played {
  net: Map<number, number>;
  showdown: Set<number>;
  counters: Map<number, Counters>;
}

/** Grades one bot decision with its own cards. */
function grade(g: Grade, v: BotView, req: ActionRequest) {
  g.decisions++;
  const allin = v.legal.find((o) => o.type === 'allin');
  const raises = req.type === 'bet' || req.type === 'raise' || (req.type === 'allin' && !!allin && 'amount' in allin && allin.amount > v.streetBet + v.toCall);
  const calls = v.toCall > 0 && (req.type === 'call' || (req.type === 'allin' && !raises));
  const hole = v.hole.map(cardCode);
  let hs = 0;
  let draw = false;
  if (v.board.length >= 3) {
    const t = strengthTable(v.board.map(cardCode));
    const i = comboIndex(hole[0]!, hole[1]!);
    hs = i >= 0 ? Math.max(0, t.hs[i]!) : 0;
    draw = i >= 0 && isStrongDraw(t.draws[i]!);
  }
  if (calls && Math.min(v.toCall, v.stack) >= 20 * v.bigBlind) {
    g.bigCalls++;
    if (v.stage === 'preflop' ? percentile(classOf(v.hole)) > 0.45 : hs < 0.4) g.weakBigCalls++;
  }
  // The street total it bets or raises to, and what that adds beyond a call against the pot once called.
  const all = v.stack + v.streetBet;
  const to = req.type === 'allin' ? (allin && 'amount' in allin ? allin.amount : all) : (req.amount ?? 0);
  const share = (to - v.streetBet - v.toCall) / Math.max(1, v.pot + v.toCall);
  if (raises && to >= all) {
    g.jams++;
    if (v.stage === 'preflop' ? to >= 30 * v.bigBlind && percentile(classOf(v.hole)) > 0.25 : share > 3 && hs < 0.3) g.wildJams++;
  }
  if (v.stage === 'preflop') return;
  if (raises) {
    g.sizeSum += share;
    if (share > 1) g.overbets++;
    if (v.stage === 'river') {
      g.riverBets++;
      if (hs < 0.5) g.riverBluffs++;
    } else {
      g.earlyBets++;
      if (hs < 0.5 && !draw) g.earlyBluffs++;
      if (hs < 0.5 && draw) g.semiBluffs++;
    }
  } else if (calls && v.stage === 'river') {
    g.riverCalls++;
    if (hs < v.toCall / (v.pot + v.toCall)) g.badRiverCalls++;
  }
}

/**
 * Plays one hand. `decide` answers for every player; bots' decisions are timed and graded into `grades` (by seat).
 * Returns null when the hand broke (an error is logged).
 */
async function playHand(
  out: BalanceOutput,
  handId: string,
  players: Player[],
  button: number,
  deckSeed: number,
  decide: (p: Player, v: BotView) => ActionRequest,
  grades: Map<number, Grade> | null,
  timed: (p: Player, ms: number) => void,
): Promise<Played | null> {
  const size = players.length;
  const deck = shuffled(seeded(deckSeed));
  const h = HandEngine.start({ handId, rules: { maxSeats: (size <= 2 ? 2 : size <= 6 ? 6 : 9) as MaxSeats, smallBlind: BB / 2, bigBlind: BB, turnMs: 20_000 }, seats: players.map((p) => ({ playerId: p.id, seatIndex: p.seat, stack: DEPTH * BB, displayName: p.id })), buttonSeat: button, now: 1, deck });
  let now = 2;
  for (let step = 0; !h.isSettled; step++) {
    if (step > 500) {
      out.errors.push(`${handId}: hand did not finish`);
      return null;
    }
    if (h.isStalled()) {
      await h.resolveStall(now++);
      continue;
    }
    const actor = h.actorId()!;
    const p = players.find((x) => x.id === actor)!;
    const v = botView(h, actor, BB);
    if (!v) {
      out.errors.push(`${handId}: no view for ${actor}`);
      return null;
    }
    const t = performance.now();
    const req = decide(p, v);
    const ms = performance.now() - t;
    if (p.bot) {
      timed(p, ms);
      const g = grades?.get(p.seat);
      if (g) grade(g, v, req);
    }
    const r = await h.act(actor, req, `i${step}`, now++);
    if (!r.ok) {
      out.errors.push(`${handId}: ${actor} ${JSON.stringify(req)} rejected: ${r.reason}`);
      const fb = await h.act(actor, v.legal.some((o) => o.type === 'check') ? { type: 'check' } : { type: 'fold' }, `f${step}`, now++);
      if (!fb.ok) return null;
    }
  }
  const rec = h.record(now, new Set(players.map((x) => x.id)));
  const total = rec.players.reduce((a, x) => a + x.stackEnd, 0);
  if (total !== size * DEPTH * BB) out.errors.push(`${handId}: chips ${total} != ${size * DEPTH * BB}`);
  const actions: PubAction[] = rec.actions.map((a) => ({ seat: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount }));
  const counters = handCounters({
    bigBlind: BB,
    buttonSeat: button,
    seats: rec.players.map((x) => ({ seat: x.seatIndex, stack: x.stackStart })),
    actions,
    board: rec.board,
    shown: rec.players.filter((x) => x.shown).map((x) => ({ seat: x.seatIndex, hole: x.holeCards })),
    showdown: rec.players.filter((x) => x.wentToShowdown).map((x) => x.seatIndex),
  });
  out.hands++;
  return { net: new Map(rec.players.map((x) => [x.seatIndex, x.net])), showdown: new Set(rec.players.filter((x) => x.wentToShowdown).map((x) => x.seatIndex)), counters };
}

const newRec = (key: string, si: number): Rec => ({ key, si, hands: 0, net: 0, won: 0, sdWon: 0, c: packCounters(emptyCounters()), g: emptyGrade() });
function addHand(r: Rec, played: Played, seat: number) {
  const net = played.net.get(seat) ?? 0;
  r.hands++;
  r.net += net;
  if (net > 0) r.won++;
  if (played.showdown.has(seat) && net > 0) r.sdWon++;
  const packed = packCounters(addCounters(emptyCounters(), played.counters.get(seat) ?? {}));
  r.c = r.c.map((x, i) => x + packed[i]!);
}

function timingOf(out: BalanceOutput, key: string): Timing {
  return (out.timing[key] ??= emptyTiming());
}

/** One bot of every level × style against one field, session `si`. */
async function fieldSession(out: BalanceOutput, seed: number, field: Field, si: number, hands: number) {
  const size = 6;
  const heroSeat = si % size;
  const setup = seeded(mix(seed, field, si, 'setup'));
  const others: Player[] = [];
  for (let seat = 0; seat < size; seat++) {
    if (seat === heroSeat) continue;
    if (field === 'bots') others.push({ id: `b${seat}`, seat, bot: { level: BOT_LEVELS[Math.floor(setup() * BOT_LEVELS.length)]!, style: BOT_AUTO_STYLES[Math.floor(setup() * BOT_AUTO_STYLES.length)]! } });
    else others.push({ id: `o${seat}`, seat, opp: field });
  }
  for (const level of BOT_LEVELS) {
    for (const style of BOT_STYLES) {
      const hero: Player = { id: 'hero', seat: heroSeat, bot: { level, style } };
      const players = [...others, hero].sort((a, b) => a.seat - b.seat);
      const rec = newRec(`field:${field}|${level}|${style}`, si);
      // What the table has seen of the scripted players (a room keeps it for people, not for bots).
      const record = new Map<number, Counters>();
      for (let hn = 0; hn < hands; hn++) {
        const heroRand = seeded(mix(seed, field, si, hn, 'hero'));
        const oppRand = seeded(mix(seed, field, si, hn, 'opp'));
        const grades = new Map([[heroSeat, rec.g]]);
        const played = await playHand(
          out,
          `f:${field}:${si}:${level}:${style}:${hn}`,
          players,
          players[hn % size]!.seat,
          mix(seed, field, si, hn, 'deck'),
          (p, v) => (p.opp ? decideOpponent(p.opp, v, oppRand) : decideBot(p.bot!.level, v, p === hero ? heroRand : oppRand, { style: p.bot!.style, stats: record })),
          grades,
          (p, ms) => {
            if (p === hero) time(timingOf(out, level), ms);
          },
        );
        if (!played) continue;
        addHand(rec, played, heroSeat);
        if (field !== 'bots') for (const o of others) record.set(o.seat, addCounters(record.get(o.seat) ?? emptyCounters(), played.counters.get(o.seat) ?? {}));
      }
      out.recs.push(rec);
    }
  }
}

/** A pair of levels heads-up, each deck from both seats. */
async function duelSession(out: BalanceOutput, seed: number, pair: [BotLevel, BotLevel], si: number, hands: number) {
  const [a, b] = pair;
  const recA = newRec(`duel:${a}-${b}|${a}`, si);
  const recB = newRec(`duel:${a}-${b}|${b}`, si);
  for (const swap of [0, 1]) {
    const pa: Player = { id: 'a', seat: swap, bot: { level: a, style: 'balanced' } };
    const pb: Player = { id: 'b', seat: 1 - swap, bot: { level: b, style: 'balanced' } };
    const players = [pa, pb].sort((x, y) => x.seat - y.seat);
    for (let hn = 0; hn < hands; hn++) {
      const rand = seeded(mix(seed, 'duel', si, hn, swap, 'act'));
      const grades = new Map([
        [pa.seat, recA.g],
        [pb.seat, recB.g],
      ]);
      const played = await playHand(out, `d:${a}-${b}:${si}:${swap}:${hn}`, players, hn % 2, mix(seed, 'duel', si, hn, 'deck'), (p, v) => decideBot(p.bot!.level, v, rand, { style: 'balanced' }), grades, (p, ms) => time(timingOf(out, p.bot!.level), ms));
      if (!played) continue;
      addHand(recA, played, pa.seat);
      addHand(recB, played, pb.seat);
    }
  }
  out.recs.push(recA, recB);
}

/** A whole table of one level: how long the bots take per decision and per hand together. */
async function perfTable(out: BalanceOutput, seed: number, level: BotLevel, size: number, hands: number) {
  const players: Player[] = Array.from({ length: size }, (_, seat) => ({ id: `b${seat}`, seat, bot: { level, style: BOT_AUTO_STYLES[seat % BOT_AUTO_STYLES.length]! } }));
  const table = (out.tables[`${level}|${size}`] ??= emptyTiming());
  for (let hn = 0; hn < hands; hn++) {
    const rand = seeded(mix(seed, 'perf', level, size, hn, 'act'));
    let handMs = 0;
    const played = await playHand(out, `p:${level}:${size}:${hn}`, players, hn % size, mix(seed, 'perf', size, hn, 'deck'), (p, v) => decideBot(p.bot!.level, v, rand, { style: p.bot!.style }), null, (_p, ms) => {
      handMs += ms;
      time(timingOf(out, level), ms);
    });
    if (played) time(table, handMs);
  }
}

function args() {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 && a[i + 1] ? a[i + 1]! : d;
  };
  const [shard, of] = get('shard', '0/1').split('/').map(Number) as [number, number];
  const exp = get('exp', 'field');
  return { exp: (exp === 'duel' || exp === 'perf' ? exp : 'field') as BalanceOutput['exp'], sessions: Number(get('sessions', '4')), hands: Number(get('hands', '200')), seed: Number(get('seed', '7')), shard, of, out: get('out', 'balance-out.json') };
}

export async function runBalance(exp: BalanceOutput['exp'], sessions: number, hands: number, seed: number, shard: number, of: number): Promise<BalanceOutput> {
  const t0 = performance.now();
  const out: BalanceOutput = { exp, seed, shard: `${shard}/${of}`, hands: 0, recs: [], timing: {}, tables: {}, errors: [], wallMs: 0 };
  let job = 0;
  if (exp === 'field') {
    for (let si = 0; si < sessions; si++) for (const field of FIELDS) if (job++ % of === shard) await fieldSession(out, seed, field, si, hands);
  } else if (exp === 'duel') {
    for (let si = 0; si < sessions; si++) for (const pair of PAIRS) if (job++ % of === shard) await duelSession(out, seed, pair, si, hands);
  } else {
    for (const level of BOT_LEVELS) for (const size of [6, 9]) if (job++ % of === shard) await perfTable(out, seed, level, size, hands);
  }
  out.wallMs = performance.now() - t0;
  return out;
}

if (process.argv[1]?.endsWith('balance-sim.ts')) {
  const a = args();
  const out = await runBalance(a.exp, a.sessions, a.hands, a.seed, a.shard, a.of);
  writeFileSync(a.out, JSON.stringify(out));
  console.log(`${a.exp} shard ${a.shard}/${a.of}: ${out.hands} hands, ${out.recs.length} records, ${out.errors.length} errors, ${(out.wallMs / 1000).toFixed(1)} s`);
}
