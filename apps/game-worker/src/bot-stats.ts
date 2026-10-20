/**
 * The table bots' play, counted for the admin console per level (packages/db stats.ts `BOT_STAT_KEYS`, docs/BOT_AI.md):
 * from each hand a bot was dealt into, the public counters `handCounters` takes (the same the bots keep of their
 * opponents), and from each of their moves whether it fell back, whether the engine refused it and how late it came.
 *
 * Summed in the room's state (saved with each hand's result, so a restart neither loses nor counts a hand twice) and
 * moved into a hand's record every BOT_STATS_FLUSH_HANDS hands, at a new day, when a hand has no bot and when the table
 * is closing: a few rows reach D1 per batch of hands rather than per hand. A table closed between hands drops what it
 * summed since its last record (statistics only). Per level only, never per bot or member.
 */
import { BOT_SLOW_MS, botStatMetric, statsDay, type BotStatKey } from '@jc/db';
import { handCounters, handFactsOf, type HandRecord } from '@jc/poker-engine';
import type { BotLevel } from '@jc/types';

export const BOT_STATS_FLUSH_HANDS = 20;

/**
 * What the room has summed and not yet written: the day it counts for, the hands in it, and the counters by metric;
 * `before`, what earlier days summed when a move came after midnight, waiting for the next hand's record.
 */
export interface BotStatsAcc {
  day: number;
  hands: number;
  n: Record<string, number>;
  before?: BotStatsFlush[];
}

/** A day's counters for a hand's record (recordHand's `botStats`). */
export interface BotStatsFlush {
  day: number;
  n: Record<string, number>;
}

/** The hand counters reported, out of the 33 `handCounters` keeps. */
const FROM_HAND = ['hands', 'vpipOpp', 'vpip', 'pfr', 'threeBetOpp', 'threeBet', 'bbStealOpp', 'bbFoldToSteal', 'foldToOverbetOpp', 'foldToOverbet'] as const satisfies readonly BotStatKey[];

function add(acc: BotStatsAcc, level: string, key: BotStatKey, by: number) {
  if (!(by > 0)) return;
  const m = botStatMetric(level, key);
  acc.n[m] = (acc.n[m] ?? 0) + Math.round(by);
}

/** A bot's move: `lagMs` after the moment planned for it, whether it fell back to a check or fold, whether the engine refused it. */
export function countMove(acc: BotStatsAcc | null | undefined, now: number, level: BotLevel, m: { lagMs: number; fallback: boolean; failed: boolean }): BotStatsAcc {
  const day = statsDay(now);
  // Past midnight: the day before's sum waits for the next hand's record, and this day starts its own.
  const a: BotStatsAcc = !acc
    ? { day, hands: 0, n: {} }
    : acc.day === day
      ? acc
      : { day, hands: 0, n: {}, before: [...(acc.before ?? []), ...(Object.keys(acc.n).length ? [{ day: acc.day, n: acc.n }] : [])] };
  add(a, level, 'decisions', 1);
  if (m.fallback) add(a, level, 'fallbacks', 1);
  if (m.failed) add(a, level, 'failures', 1);
  const lag = Math.max(0, m.lagMs);
  add(a, level, 'lagMs', lag);
  if (lag > BOT_SLOW_MS) add(a, level, 'slow', 1);
  return a;
}

/**
 * Adds a settled hand: the bots' seats (`levelOf` gives a bot's level, undefined for a member) by level. Returns what
 * to keep and what to write with this hand's record (oldest day first, possibly nothing).
 */
export function countHand(
  acc: BotStatsAcc | null | undefined,
  rec: HandRecord,
  bigBlind: number,
  levelOf: (playerId: string) => BotLevel | undefined,
  now: number,
  closing: boolean,
): { acc: BotStatsAcc | null; flush: BotStatsFlush[] } {
  const flush: BotStatsFlush[] = [...(acc?.before ?? [])];
  const day = statsDay(now);
  // A copy: should counting fail half way, what was kept stays as it was.
  let a: BotStatsAcc | null = acc ? { day: acc.day, hands: acc.hands, n: { ...acc.n } } : null;
  if (a && a.day !== day) {
    flush.push({ day: a.day, n: a.n });
    a = null;
  }
  const bots = rec.players.flatMap((p) => {
    const level = levelOf(p.playerId);
    return level ? [{ seat: p.seatIndex, level }] : [];
  });
  if (bots.length) {
    const counted = handCounters(handFactsOf(rec, bigBlind));
    a ??= { day, hands: 0, n: {} };
    for (const b of bots) {
      const c = counted.get(b.seat);
      if (c) for (const k of FROM_HAND) add(a, b.level, k, c[k]);
    }
    a.hands += 1;
  }
  if (a && (!bots.length || closing || a.hands >= BOT_STATS_FLUSH_HANDS)) {
    if (Object.keys(a.n).length) flush.push({ day: a.day, n: a.n });
    a = null;
  }
  return { acc: a, flush };
}
