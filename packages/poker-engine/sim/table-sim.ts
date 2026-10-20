/**
 * Plays whole hands through the real hand engine with table bots (and one scripted player per table for the user
 * scenarios), and counts what everybody did. The same seed deals the same cards in both modes, so the bots before
 * Bot AI 2.0 (`legacy`) and after it (`new`) play the same decks.
 *
 *   pnpm exec tsx sim/table-sim.ts --mode new --hands 100000 --seed 1 --shard 0/8 --out <file.json>
 *
 * Tables: 2, 6 and 9 seats; stacks of 20, 50, 100 and 200 big blinds (reset every hand); scenarios "bots" (bots only)
 * and A–G (sim/users.ts). Each session keeps the same players for SESSION hands so the adapting levels see a record.
 * The simulation reads the cards only to grade decisions afterwards (a call of an all-in with a weak hand, an all-in
 * with nothing); bots and scripted players decide from their own view.
 */
import { writeFileSync } from 'node:fs';
import type { Card } from '@jc/types';
import { classOf } from '../src/ai/classes';
import { comboIndex } from '../src/ai/profile';
import { percentile } from '../src/ai/ranges';
import { cardCode } from '../src/ai/score';
import { strengthTable } from '../src/ai/strength';
import { seating, walk, type PubAction } from '../src/ai/walk';
import { addCounters, BOT_LEVELS, BOT_STYLES, botView, decideBot, emptyCounters, handCounters, HandEngine, standardDeck, type BotLevel, type BotStyle, type Counters, type MaxSeats } from '../src';
import { decideLegacy } from './legacy-bot';
import { seeded } from './rng';
import { decideUser, USER_KINDS, type UserKind } from './users';

const SIZES = [2, 6, 9] as const;
const DEPTHS = [20, 50, 100, 200] as const;
const SCENARIOS = ['bots', ...USER_KINDS] as const;
type Scenario = (typeof SCENARIOS)[number];
const SESSION = 250;
const BB = 10;

export interface Extra {
  net: number;
  bbDefOpp: number;
  bbDef: number;
  bigOpenOpp: number;
  bigOpenFold: number;
  allinCallsMade: number;
  recklessCall: number;
  jamsMade: number;
  abnormalJam: number;
  decisions: number;
  ms: number;
  msMax: number;
  slow: number;
  illegal: number;
}
export const emptyExtra = (): Extra => ({ net: 0, bbDefOpp: 0, bbDef: 0, bigOpenOpp: 0, bigOpenFold: 0, allinCallsMade: 0, recklessCall: 0, jamsMade: 0, abnormalJam: 0, decisions: 0, ms: 0, msMax: 0, slow: 0, illegal: 0 });
export interface Group {
  c: Counters;
  x: Extra;
}
export interface TableAgg {
  hands: number;
  pot: number;
  actions: number;
  flops: number;
  showdowns: number;
  threeBetPots: number;
  userRaises: number;
  userRaisesAllFold: number;
  userBigOpens: number;
  userBigOpensAllFold: number;
  userOverbets: number;
  userOverbetsAllFold: number;
  userJams: number;
  userJamsAllFold: number;
}
const emptyTable = (): TableAgg => ({ hands: 0, pot: 0, actions: 0, flops: 0, showdowns: 0, threeBetPots: 0, userRaises: 0, userRaisesAllFold: 0, userBigOpens: 0, userBigOpensAllFold: 0, userOverbets: 0, userOverbetsAllFold: 0, userJams: 0, userJamsAllFold: 0 });
export interface SimOutput {
  mode: 'legacy' | 'new';
  seed: number;
  shard: string;
  hands: number;
  groups: Record<string, Group>;
  tables: Record<string, TableAgg>;
  errors: string[];
  wallMs: number;
}

interface Player {
  id: string;
  seat: number;
  bot?: { level: BotLevel; style: BotStyle };
  user?: UserKind;
}

/** A stable 32-bit seed from parts (FNV-1a). */
function mix(...parts: (number | string)[]): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shuffled(rand: () => number): Card[] {
  const d = standardDeck();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

function args(): { mode: 'legacy' | 'new'; hands: number; seed: number; shard: number; of: number; out: string } {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 && a[i + 1] ? a[i + 1]! : d;
  };
  const [shard, of] = get('shard', '0/1').split('/').map(Number) as [number, number];
  return { mode: get('mode', 'new') === 'legacy' ? 'legacy' : 'new', hands: Number(get('hands', '2000')), seed: Number(get('seed', '1')), shard, of, out: get('out', 'sim-out.json') };
}

function group(out: SimOutput, key: string): Group {
  return (out.groups[key] ??= { c: emptyCounters(), x: emptyExtra() });
}
function table(out: SimOutput, key: string): TableAgg {
  return (out.tables[key] ??= emptyTable());
}

export async function runSessions(mode: 'legacy' | 'new', totalHands: number, seed: number, shard: number, of: number): Promise<SimOutput> {
  const t0 = performance.now();
  const out: SimOutput = { mode, seed, shard: `${shard}/${of}`, hands: 0, groups: {}, tables: {}, errors: [], wallMs: 0 };
  const sessions = Math.ceil(totalHands / SESSION);
  const combos = SIZES.length * DEPTHS.length * SCENARIOS.length;
  for (let si = 0; si < sessions; si++) {
    if (si % of !== shard) continue;
    const combo = si % combos;
    const size = SIZES[combo % SIZES.length]!;
    const depth = DEPTHS[Math.floor(combo / SIZES.length) % DEPTHS.length]!;
    const scenario = SCENARIOS[Math.floor(combo / (SIZES.length * DEPTHS.length))]!;
    await session(out, mode, seed, si, size, depth, scenario);
  }
  out.wallMs = performance.now() - t0;
  return out;
}

async function session(out: SimOutput, mode: 'legacy' | 'new', seed: number, si: number, size: number, depth: number, scenario: Scenario) {
  const setup = seeded(mix(seed, si, 'setup'));
  const userSeat = scenario === 'bots' ? -1 : Math.floor(setup() * size);
  const players: Player[] = [];
  for (let seat = 0; seat < size; seat++) {
    if (seat === userSeat) players.push({ id: `u${seat}`, seat, user: scenario as UserKind });
    else players.push({ id: `b${seat}`, seat, bot: { level: BOT_LEVELS[Math.floor(setup() * BOT_LEVELS.length)]!, style: BOT_STYLES[Math.floor(setup() * BOT_STYLES.length)]! } });
  }
  // What the table has seen of each scripted player so far (the record a room keeps for people, not for bots).
  const record = new Map<number, Counters>();
  for (let hn = 0; hn < SESSION; hn++) {
    const button = players[hn % size]!.seat;
    const deck = shuffled(seeded(mix(seed, si, hn, 'deck')));
    const rand = seeded(mix(seed, si, hn, 'act'));
    const seats = players.map((p) => ({ playerId: p.id, seatIndex: p.seat, stack: depth * BB, displayName: p.id }));
    const h = HandEngine.start({ handId: `s${si}h${hn}`, rules: { maxSeats: size as MaxSeats, smallBlind: BB / 2, bigBlind: BB, turnMs: 20_000 }, seats, buttonSeat: button, now: 1, deck });
    const timing = new Map<number, { n: number; ms: number; max: number; slow: number }>();
    let illegal = 0;
    let now = 2;
    for (let step = 0; !h.isSettled; step++) {
      if (step > 500) {
        out.errors.push(`s${si}h${hn}: hand did not finish`);
        break;
      }
      if (h.isStalled()) {
        await h.resolveStall(now++);
        continue;
      }
      const actor = h.actorId()!;
      const p = players.find((x) => x.id === actor)!;
      const v = botView(h, actor, BB);
      if (!v) {
        out.errors.push(`s${si}h${hn}: no view for ${actor}`);
        break;
      }
      let req;
      const t = performance.now();
      if (p.user) req = decideUser(p.user, v, rand);
      else if (mode === 'legacy') req = decideLegacy(p.bot!.level, v, rand);
      else req = decideBot(p.bot!.level, v, rand, { style: p.bot!.style, stats: record });
      const ms = performance.now() - t;
      if (p.bot) {
        const tm = timing.get(p.seat) ?? { n: 0, ms: 0, max: 0, slow: 0 };
        tm.n++;
        tm.ms += ms;
        tm.max = Math.max(tm.max, ms);
        if (ms > 50) tm.slow++;
        timing.set(p.seat, tm);
      }
      const r = await h.act(actor, req, `i${step}`, now++);
      if (!r.ok) {
        illegal++;
        out.errors.push(`s${si}h${hn}: ${actor} ${JSON.stringify(req)} rejected: ${r.reason}`);
        const fb = await h.act(actor, v.legal.some((o) => o.type === 'check') ? { type: 'check' } : { type: 'fold' }, `f${step}`, now++);
        if (!fb.ok) break;
      }
    }
    if (!h.isSettled) continue;
    const rec = h.record(now, new Set(players.map((x) => x.id)));
    const total = rec.players.reduce((a, x) => a + x.stackEnd, 0);
    if (total !== size * depth * BB) out.errors.push(`s${si}h${hn}: chips ${total} != ${size * depth * BB}`);
    const actions: PubAction[] = rec.actions.map((a) => ({ seat: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount }));
    const facts = {
      bigBlind: BB,
      buttonSeat: button,
      seats: rec.players.map((x) => ({ seat: x.seatIndex, stack: x.stackStart })),
      actions,
      board: rec.board,
      shown: rec.players.filter((x) => x.shown).map((x) => ({ seat: x.seatIndex, hole: x.holeCards })),
      showdown: rec.players.filter((x) => x.wentToShowdown).map((x) => x.seatIndex),
    };
    const counters = handCounters(facts);
    for (const p of players) if (p.user) record.set(p.seat, addCounters(record.get(p.seat) ?? emptyCounters(), counters.get(p.seat) ?? {}));
    const extra = gradeHand(rec.players.map((x) => ({ seat: x.seatIndex, hole: x.holeCards, start: x.stackStart })), actions, rec.board, button);
    const pos = seating(
      players.map((x) => x.seat),
      button,
    ).pos;
    // First or second half of the session: the bots' adaptation shows as a change from one to the other.
    const half = hn < SESSION / 2 ? 1 : 2;
    for (const p of players) {
      const c = counters.get(p.seat) ?? emptyCounters();
      const x = extra.get(p.seat) ?? emptyExtra();
      x.net = rec.players.find((y) => y.seatIndex === p.seat)!.net;
      const tm = timing.get(p.seat);
      if (tm) {
        x.decisions = tm.n;
        x.ms = tm.ms;
        x.msMax = tm.max;
        x.slow = tm.slow;
      }
      if (p.seat === userSeat) x.illegal = 0;
      const keys: string[] = [];
      if (p.bot) {
        const lv = p.bot.level;
        keys.push('bot:all', `bot:${lv}`, `bot:${lv}|pos:${pos.get(p.seat)}`, `bot:${lv}|depth:${depth}`, `bot:${lv}|size:${size}`, `bot:all|pos:${pos.get(p.seat)}`, `bot:all|depth:${depth}`, `bot:all|size:${size}`, `bot:all|vs:${scenario}`, `bot:${lv}|vs:${scenario}`);
        keys.push(`bot:all|vs:${scenario}|half:${half}`, `bot:${lv}|vs:${scenario}|half:${half}`);
        if (mode === 'new') keys.push(`style:${p.bot.style}`);
      } else keys.push(`user:${p.user}`, `user:${p.user}|half:${half}`);
      for (const k of keys) {
        const g = group(out, k);
        addCounters(g.c, c);
        addExtra(g.x, x);
      }
    }
    for (const k of ['all', `size:${size}`, `depth:${depth}`, `vs:${scenario}`, `vs:${scenario}|half:${half}`]) addTable(table(out, k), rec, actions, userSeat);
    if (illegal) group(out, 'bot:all').x.illegal += illegal;
    out.hands++;
  }
}

function addExtra(into: Extra, x: Extra) {
  for (const k of Object.keys(into) as (keyof Extra)[]) into[k] = k === 'msMax' ? Math.max(into[k], x[k]) : into[k] + x[k];
}

function addTable(t: TableAgg, rec: ReturnType<HandEngine['record']>, actions: PubAction[], userSeat: number) {
  t.hands++;
  t.pot += rec.potTotal / BB;
  const voluntary = actions.filter((a) => a.type !== 'post-sb' && a.type !== 'post-bb');
  t.actions += voluntary.length;
  const preFolds = new Set(actions.filter((a) => a.stage === 'preflop' && (a.type === 'fold' || a.type === 'timeout-fold')).map((a) => a.seat));
  if (rec.board.length >= 3 && rec.players.length - preFolds.size >= 2) t.flops++;
  if (rec.players.filter((x) => x.wentToShowdown).length >= 2) t.showdowns++;
  let preRaises = 0;
  const start = new Map(rec.players.map((x) => [x.seatIndex, x.stackStart]));
  const events: { seat: number; stage: string; kind: string; to: number; size: number; allIn: boolean; level: number }[] = [];
  walk(start, actions, (e) => {
    if (e.stage === 'preflop' && e.kind === 'raise') preRaises++;
    events.push({ seat: e.seat, stage: e.stage, kind: e.kind, to: e.to, size: e.size, allIn: e.allIn, level: e.level });
  });
  if (preRaises >= 2) t.threeBetPots++;
  if (userSeat < 0) return;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seat !== userSeat || e.kind !== 'raise') continue;
    // Never called or raised: every player behind folded and the hand ended there.
    let allFold = true;
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j]!;
      if (f.seat === userSeat || f.stage !== e.stage || f.kind !== 'fold') {
        allFold = false;
        break;
      }
    }
    t.userRaises++;
    if (allFold) t.userRaisesAllFold++;
    if (e.stage === 'preflop' && e.level === 0 && e.to >= 5 * BB && !e.allIn) {
      t.userBigOpens++;
      if (allFold) t.userBigOpensAllFold++;
    }
    if (e.stage !== 'preflop' && e.size > 1) {
      t.userOverbets++;
      if (allFold) t.userOverbetsAllFold++;
    }
    if (e.allIn) {
      t.userJams++;
      if (allFold) t.userJamsAllFold++;
    }
  }
}

/**
 * Per seat: big blind defence (facing a single open with nobody in between), answers to opens of 5 big blinds or more,
 * and the two kinds of blunder the spec forbids — calling an all-in for 20 big blinds or more with a weak hand, and
 * moving all in deep with a weak hand.
 */
function gradeHand(players: { seat: number; hole: Card[]; start: number }[], actions: PubAction[], board: Card[], button: number): Map<number, Extra> {
  const out = new Map<number, Extra>();
  const x = (s: number) => {
    let e = out.get(s);
    if (!e) out.set(s, (e = emptyExtra()));
    return e;
  };
  const seats = seating(
    players.map((p) => p.seat),
    button,
  );
  const bb = seats.preflop.at(-1);
  const hole = new Map(players.map((p) => [p.seat, p.hole.map(cardCode)]));
  const pctOf = (s: number) => percentile(classOf(players.find((p) => p.seat === s)!.hole));
  const codes = board.map(cardCode);
  const hsOf = (s: number, stage: string) => {
    const n = stage === 'flop' ? 3 : stage === 'turn' ? 4 : 5;
    const h = hole.get(s)!;
    const i = comboIndex(h[0]!, h[1]!);
    return i < 0 ? 0 : Math.max(0, strengthTable(codes.slice(0, n)).hs[i]!);
  };
  let openTo = 0;
  const answered = new Set<number>();
  walk(new Map(players.map((p) => [p.seat, p.start])), actions, (e, st) => {
    if (e.stage === 'preflop') {
      if (e.kind === 'raise' && e.level === 0) openTo = e.to;
      if (e.level === 1 && !answered.has(e.seat) && e.toCall > 0) {
        answered.add(e.seat);
        if (e.seat === bb && !st.callers.length && !st.limpers.length) {
          x(e.seat).bbDefOpp++;
          if (e.kind !== 'fold') x(e.seat).bbDef++;
        }
        if (openTo >= 5 * BB && !e.facingAllIn) {
          x(e.seat).bigOpenOpp++;
          if (e.kind === 'fold') x(e.seat).bigOpenFold++;
        }
      }
    }
    const cost = Math.min(e.toCall, st.stack.get(e.seat) ?? 0);
    if (e.facingAllIn && e.kind === 'call' && cost >= 20 * BB) {
      x(e.seat).allinCallsMade++;
      const weak = e.stage === 'preflop' ? pctOf(e.seat) > 0.45 : hsOf(e.seat, e.stage) < 0.4;
      if (weak) x(e.seat).recklessCall++;
    }
    if (e.kind === 'raise' && e.allIn) {
      x(e.seat).jamsMade++;
      const deep = e.to >= 30 * BB;
      const potAfter = e.potBefore + e.toCall;
      const weak = e.stage === 'preflop' ? deep && pctOf(e.seat) > 0.25 : e.to - e.toCall > 3 * potAfter && hsOf(e.seat, e.stage) < 0.3;
      if (weak) x(e.seat).abnormalJam++;
    }
  });
  return out;
}

if (process.argv[1]?.endsWith('table-sim.ts')) {
  const a = args();
  const out = await runSessions(a.mode, a.hands, a.seed, a.shard, a.of);
  writeFileSync(a.out, JSON.stringify(out));
  console.log(`${a.mode} shard ${a.shard}/${a.of}: ${out.hands} hands, ${out.errors.length} errors, ${(out.wallMs / 1000).toFixed(1)} s`);
}
