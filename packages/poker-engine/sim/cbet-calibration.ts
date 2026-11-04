/**
 * Why the bots fold to continuation bets as often as they do (docs/BOT_AI.md 11절 "C벳 보정"). The field of the balance
 * simulation (one bot against five scripted players of a kind, 100 big blinds, a record kept of the scripted players),
 * and at every heads-up flop where the bot faces the preflop raiser's first bet, two equities side by side:
 *
 *   est  what the bot reckons: its equity against the bettor's range as its level reads it (the same `equityOf` the
 *        decision uses, from the bot's own view only);
 *   act  what it was: its equity against the bettor's actual two cards, every turn and river dealt out.
 *
 * Over many spots the mean of `act` is the equity against the range the bettor really bets with, so `est - act` is the
 * bias of the bot's read. The bettor's cards are read for this measure only, after the bot decided; the bot never sees
 * them. Also counted: how often the bot folds, and how often it folded a hand whose `act` beat the price of the call.
 *
 *   pnpm exec tsx sim/cbet-calibration.ts --sessions 2 --hands 200 --seed 2026 --shard 0/12 --out <file.json>
 *   pnpm exec tsx sim/cbet-calibration.ts --report <dir>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { equityOf, readSpot } from '../src/ai/spot';
import { cardCode, DECK_CODES, quickScore } from '../src/ai/score';
import { addCounters, BOT_LEVELS, BOT_STYLES, botView, decideBot, emptyCounters, handCounters, HandEngine, type Counters, type MaxSeats } from '../src';
import type { PubAction } from '../src/ai/walk';
import { decideOpponent, OPPONENTS, type Opponent } from './opponents';
import { seeded } from './rng';
import { mix, shuffled } from './table-sim';

const BB = 10;
const DEPTH = 100;

export interface Cell {
  spots: number;
  folds: number;
  calls: number;
  raises: number;
  est: number;
  act: number;
  price: number;
  /** Folds whose `act` was above the price of the call. */
  badFolds: number;
  /** Equity bins of `est` (0–0.1, …, 0.9–1): spots, sum of est, sum of act. */
  bins: [number, number, number][];
}
const emptyCell = (): Cell => ({ spots: 0, folds: 0, calls: 0, raises: 0, est: 0, act: 0, price: 0, badFolds: 0, bins: Array.from({ length: 10 }, () => [0, 0, 0] as [number, number, number]) });

interface Out {
  hands: number;
  /** Keys `level` and `level|opponent`. */
  cells: Record<string, Cell>;
  errors: string[];
}

/** The bot's equity against two known cards, every remaining turn and river dealt. */
function exactEquity(hole: number[], villain: number[], board: number[]): number {
  const used = new Set([...hole, ...villain, ...board]);
  const rest = DECK_CODES.filter((c) => !used.has(c));
  let win = 0;
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      const b = [...board, rest[i]!, rest[j]!];
      const a = quickScore([...hole, ...b]);
      const v = quickScore([...villain, ...b]);
      win += a > v ? 1 : a === v ? 0.5 : 0;
      n++;
    }
  }
  return win / n;
}

function add(cell: Cell, est: number, act: number, price: number, kind: 'fold' | 'call' | 'raise') {
  cell.spots++;
  cell.est += est;
  cell.act += act;
  cell.price += price;
  if (kind === 'fold') {
    cell.folds++;
    if (act > price) cell.badFolds++;
  } else if (kind === 'call') cell.calls++;
  else cell.raises++;
  const bin = cell.bins[Math.min(9, Math.floor(est * 10))]!;
  bin[0]++;
  bin[1] += est;
  bin[2] += act;
}

async function session(out: Out, seed: number, opp: Opponent, si: number, hands: number) {
  const size = 6;
  const heroSeat = si % size;
  for (const level of BOT_LEVELS) {
    for (const style of BOT_STYLES) {
      const record = new Map<number, Counters>();
      for (let hn = 0; hn < hands; hn++) {
        const heroRand = seeded(mix(seed, opp, si, hn, 'hero'));
        const oppRand = seeded(mix(seed, opp, si, hn, 'opp'));
        const measureRand = seeded(mix(seed, opp, si, hn, level, style, 'measure'));
        const ids = Array.from({ length: size }, (_, s) => (s === heroSeat ? 'hero' : `o${s}`));
        const button = hn % size;
        const deck = shuffled(seeded(mix(seed, opp, si, hn, 'deck')));
        const h = HandEngine.start({ handId: `c:${opp}:${si}:${level}:${style}:${hn}`, rules: { maxSeats: size as MaxSeats, smallBlind: BB / 2, bigBlind: BB, turnMs: 20_000 }, seats: ids.map((id, s) => ({ playerId: id, seatIndex: s, stack: DEPTH * BB, displayName: id })), buttonSeat: button, now: 1, deck });
        let now = 2;
        for (let step = 0; !h.isSettled; step++) {
          if (step > 500) {
            out.errors.push(`${opp}:${si}:${hn}: hand did not finish`);
            break;
          }
          if (h.isStalled()) {
            await h.resolveStall(now++);
            continue;
          }
          const actor = h.actorId()!;
          const v = botView(h, actor, BB)!;
          let req;
          if (actor === 'hero') {
            req = decideBot(level, v, heroRand, { style, stats: record });
            if (v.stage === 'flop' && v.toCall > 0) {
              const s = readSpot(level, v, measureRand, { style, stats: record });
              const preRaiser = [...s.log].reverse().find((l) => l.e.stage === 'preflop' && l.e.kind === 'raise')?.e.seat;
              const flopRaises = s.log.filter((l) => l.e.stage === 'flop' && l.e.kind === 'raise').length;
              if (s.opps.length === 1 && !s.facingAllIn && s.aggressor !== null && s.aggressor === preRaiser && flopRaises === 1) {
                const est = equityOf(s, s.opps);
                const villain = h.holeCardsOf(`o${s.aggressor}`)!.map(cardCode);
                const act = exactEquity(s.hole, villain, s.board);
                const price = v.toCall / (v.pot + v.toCall);
                const kind = req.type === 'fold' ? 'fold' : req.type === 'call' || (req.type === 'allin' && v.stack <= v.toCall) ? 'call' : 'raise';
                for (const key of [level, `${level}|${opp}`]) add((out.cells[key] ??= emptyCell()), est, act, price, kind);
              }
            }
          } else req = decideOpponent(opp, v, oppRand);
          const r = await h.act(actor, req, `i${step}`, now++);
          if (!r.ok) {
            out.errors.push(`${opp}:${si}:${hn}: ${actor} ${JSON.stringify(req)} rejected: ${r.reason}`);
            await h.act(actor, v.legal.some((o) => o.type === 'check') ? { type: 'check' } : { type: 'fold' }, `f${step}`, now++);
          }
        }
        const rec = h.record(now, new Set(ids));
        out.hands++;
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
        for (let seat = 0; seat < size; seat++) if (seat !== heroSeat) record.set(seat, addCounters(record.get(seat) ?? emptyCounters(), counters.get(seat) ?? {}));
      }
    }
  }
}

function args() {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 && a[i + 1] ? a[i + 1]! : d;
  };
  const [shard, of] = get('shard', '0/1').split('/').map(Number) as [number, number];
  return { sessions: Number(get('sessions', '2')), hands: Number(get('hands', '200')), seed: Number(get('seed', '2026')), shard, of, out: get('out', 'cbet-out.json'), report: get('report', '') };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function report(dir: string) {
  const cells: Record<string, Cell> = {};
  let hands = 0;
  let errors = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const o = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Out;
    hands += o.hands;
    errors += o.errors.length;
    for (const [k, c] of Object.entries(o.cells)) {
      const t = (cells[k] ??= emptyCell());
      for (const f2 of ['spots', 'folds', 'calls', 'raises', 'est', 'act', 'price', 'badFolds'] as const) t[f2] += c[f2];
      c.bins.forEach((b, i) => b.forEach((x, j) => (t.bins[i]![j]! += x)));
    }
  }
  const lines = [`hands ${hands}, errors ${errors}`, '', '| key | spots | fold | call | raise | est | act | est - act | price | folds above price |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const keys = [...BOT_LEVELS, ...BOT_LEVELS.flatMap((l) => OPPONENTS.map((o) => `${l}|${o}`))];
  for (const k of keys) {
    const c = cells[k];
    if (!c || !c.spots) continue;
    lines.push(`| ${k} | ${c.spots} | ${pct(c.folds / c.spots)} | ${pct(c.calls / c.spots)} | ${pct(c.raises / c.spots)} | ${pct(c.est / c.spots)} | ${pct(c.act / c.spots)} | ${((c.est - c.act) / c.spots * 100).toFixed(1)} | ${pct(c.price / c.spots)} | ${c.folds ? pct(c.badFolds / c.folds) : '—'} |`);
  }
  lines.push('', '| level | est bin | spots | mean est | mean act |', '|---|---|---:|---:|---:|');
  for (const l of BOT_LEVELS) {
    const c = cells[l];
    if (!c) continue;
    c.bins.forEach(([n, e, a], i) => n && lines.push(`| ${l} | ${i / 10}–${(i + 1) / 10} | ${n} | ${pct(e / n)} | ${pct(a / n)} |`));
  }
  console.log(lines.join('\n'));
}

async function main() {
  const a = args();
  if (a.report) return report(a.report);
  const out: Out = { hands: 0, cells: {}, errors: [] };
  let job = 0;
  for (let si = 0; si < a.sessions; si++) for (const opp of OPPONENTS) if (job++ % a.of === a.shard) await session(out, a.seed, opp, si, a.hands);
  writeFileSync(a.out, JSON.stringify(out));
}

void main();
