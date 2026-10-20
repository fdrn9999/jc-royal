/**
 * What a table's bots remember about the members they played (room.ts, docs/STATUS.md "봇 AI 2.0"): per member, the
 * counters `handCounters` takes from each finished hand — its public actions and the cards the table saw shown, never
 * a folded or mucked hand. Kept in the room's storage under its own key, written in the same put as the hand's result
 * (so a restart neither loses nor counts a hand twice), only at tables where a bot played, and deleted when the table
 * closes. Nothing here reaches D1 or another table, and table bots are not counted.
 */
import { addCounters, emptyCounters, handCounters, handFactsOf, packCounters, STAT_KEYS, unpackCounters, type Counters, type HandRecord } from '@jc/poker-engine';

export const OPP_STATS_KEY = 'oppStats';
/** Members kept per table (the most recently seen). */
export const OPP_STATS_MAX = 64;
/** A member not seen at the table for this long is forgotten. */
export const OPP_STATS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OppStats {
  /** The counters' layout (`STAT_KEYS`); stored counters of another layout are dropped, not misread. */
  keys: number;
  /** The last hand added, so the same hand is never added twice. */
  handId: string | null;
  /** Packed counters (`packCounters`) and when the member last played here. */
  players: Record<string, { c: number[]; at: number }>;
}

/** Stored statistics as they can be used: anything malformed or of another layout reads as none. */
export function readOppStats(stored: unknown): OppStats | null {
  const s = stored as Partial<OppStats> | null | undefined;
  if (!s || typeof s !== 'object' || s.keys !== STAT_KEYS.length || !s.players || typeof s.players !== 'object') return null;
  return { keys: s.keys, handId: typeof s.handId === 'string' ? s.handId : null, players: s.players };
}

/**
 * The statistics with a finished hand added for the players `isMember` accepts, then trimmed to members seen in the
 * last `OPP_STATS_TTL_MS`, at most `OPP_STATS_MAX` of them. The hand last added is not added again (null then).
 */
export function addHand(prev: OppStats | null, rec: HandRecord, bigBlind: number, isMember: (playerId: string) => boolean, now: number): OppStats | null {
  if (prev?.handId === rec.handId) return null;
  // Forgotten first: a member back after a week away starts over rather than reviving what was forgotten.
  const players = Object.fromEntries(Object.entries(prev?.players ?? {}).filter(([, e]) => now - e.at < OPP_STATS_TTL_MS));
  const counted = handCounters(handFactsOf(rec, bigBlind));
  for (const p of rec.players) {
    const add = counted.get(p.seatIndex);
    if (!add || !isMember(p.playerId)) continue;
    const before = players[p.playerId];
    players[p.playerId] = { c: packCounters(addCounters(before ? unpackCounters(before.c) : emptyCounters(), add)), at: now };
  }
  const kept = Object.entries(players)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, OPP_STATS_MAX);
  return { keys: STAT_KEYS.length, handId: rec.handId, players: Object.fromEntries(kept) };
}

/** The counters of the members in `seats` (by seat index), for the bots' decisions. Bots and unknown members get none. */
export function statsBySeat(stats: OppStats | null, seats: readonly ({ userId: string; bot?: unknown } | null)[], now: number): Map<number, Counters> {
  const out = new Map<number, Counters>();
  if (!stats) return out;
  seats.forEach((s, i) => {
    const e = s && !s.bot ? stats.players[s.userId] : undefined;
    if (e && now - e.at < OPP_STATS_TTL_MS) out.set(i, unpackCounters(e.c));
  });
  return out;
}
