/**
 * A Sit & Go tournament at its table (docs/TOURNAMENT.md): what the room reads of its tournament from D1, the state it
 * keeps in room storage (`TourneyState`) and the progress it writes back (`syncTournament`). Tournament chips are only
 * numbers of this tournament: nothing here reaches a wallet, the chip ledger or a table session.
 *
 * The level clock runs while the table can deal: `stopClock` keeps the time left when a pause or a maintenance keeps the
 * next hand from being dealt, `runClock` starts it again from there when a hand is dealt, and moves past the levels
 * whose time is up. The level is fixed at the deal, so a hand in progress keeps its blinds.
 */
import { advanceLevel, rankBusts, TOURNAMENT_FINISH_LINGER_MS, type BlindLevel, type TournamentStatus, type TournamentTimeBank } from '@jc/types';
import { maintenanceQuery, toMaintenance, type Maintenance } from './settlement';

export interface TournamentEntryRow {
  userId: string;
  seat: number | null;
  stack: number | null;
  status: string;
  place: number | null;
  nickname: string;
  avatarUrl: string | null;
  role: string;
}

/** The tournament a table plays, as D1 has it (read with the table: TOURNAMENT_JSON). */
export interface TournamentRow {
  id: string;
  name: string;
  status: TournamentStatus;
  startStack: number;
  levels: BlindLevel[];
  levelMs: number;
  pauseRequested: boolean;
  tb: TournamentTimeBank;
  level: number;
  levelEndsAt: number | null;
  levelLeftMs: number | null;
  pausedAt: number | null;
  hands: number;
  /** Entries that took part (playing, eliminated, won, stopped), with what the seat shows. */
  entries: TournamentEntryRow[];
}

/** The table's tournament as one JSON value (SQL expression over `tables`; null for a cash table). */
export const TOURNAMENT_JSON = `SELECT json_object('id', tn.id, 'name', tn.name, 'status', tn.status, 'startStack', tn.start_stack,
  'levels', json(tn.levels), 'levelMs', tn.level_ms, 'pauseRequested', tn.pause_requested,
  'tb', json_object('enabled', tn.tb_enabled, 'initialMs', tn.tb_initial_ms, 'maxMs', tn.tb_max_ms, 'unitMs', tn.tb_unit_ms,
    'refillHands', tn.tb_refill_hands, 'refillMs', tn.tb_refill_ms),
  'level', tn.level, 'levelEndsAt', tn.level_ends_at, 'levelLeftMs', tn.level_left_ms, 'pausedAt', tn.paused_at, 'hands', tn.hands,
  'entries', json((SELECT json_group_array(json_object('userId', e.user_id, 'seat', e.seat_index, 'stack', e.stack, 'status', e.status,
      'place', e.place, 'nickname', u.nickname, 'avatarUrl', u.avatar_url, 'role', u.role))
    FROM tournament_entries e JOIN users u ON u.id = e.user_id
    WHERE e.tournament_id = tn.id AND e.status IN ('playing', 'eliminated', 'won', 'stopped'))))
  FROM tournaments tn WHERE tn.table_id = tables.id`;

const STATUSES: readonly TournamentStatus[] = ['registering', 'closed', 'running', 'finished', 'cancelled', 'aborted'];

const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

/** A tournament read with TOURNAMENT_JSON; null for none, or for one this build cannot read. */
export function toTournamentRow(raw: unknown): TournamentRow | null {
  if (typeof raw !== 'string') return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const levels = Array.isArray(r.levels) ? (r.levels as unknown[]) : [];
    const lv = levels.flatMap((l) => {
      const o = l as Record<string, unknown>;
      const sb = int(o?.sb);
      const bb = int(o?.bb);
      return sb !== null && bb !== null && sb > 0 && bb > sb ? [{ sb, bb }] : [];
    });
    const tb = (r.tb ?? {}) as Record<string, unknown>;
    const startStack = int(r.startStack);
    const levelMs = int(r.levelMs);
    if (typeof r.id !== 'string' || !STATUSES.includes(r.status as TournamentStatus) || !startStack || !levelMs || lv.length === 0 || lv.length !== levels.length) return null;
    const tbn = (k: string) => Math.max(0, int(tb[k]) ?? 0);
    const entries = (Array.isArray(r.entries) ? (r.entries as Record<string, unknown>[]) : []).flatMap((e) =>
      typeof e?.userId === 'string'
        ? [
            {
              userId: e.userId,
              seat: int(e.seat),
              stack: int(e.stack),
              status: String(e.status),
              place: int(e.place),
              nickname: String(e.nickname ?? ''),
              avatarUrl: typeof e.avatarUrl === 'string' ? e.avatarUrl : null,
              role: String(e.role ?? 'user'),
            },
          ]
        : [],
    );
    return {
      id: r.id,
      name: String(r.name ?? ''),
      status: r.status as TournamentStatus,
      startStack,
      levels: lv,
      levelMs,
      pauseRequested: r.pauseRequested === 1,
      tb: {
        enabled: tb.enabled === 1,
        initialMs: tbn('initialMs'),
        maxMs: tbn('maxMs'),
        unitMs: tbn('unitMs'),
        refillHands: Math.max(1, tbn('refillHands')),
        refillMs: tbn('refillMs'),
      },
      level: Math.max(0, Math.min(int(r.level) ?? 0, lv.length - 1)),
      levelEndsAt: int(r.levelEndsAt),
      levelLeftMs: int(r.levelLeftMs),
      pausedAt: int(r.pausedAt),
      hands: Math.max(0, int(r.hands) ?? 0),
      entries,
    };
  } catch {
    return null;
  }
}

/** A place decided at the table: who, which place, in which tournament hand, when. */
export interface TourneyPlace {
  userId: string;
  nickname: string;
  place: number;
  hand: number;
  at: number;
}

/** The tournament as the room plays it (RoomState.tourney). */
export interface TourneyState {
  id: string;
  name: string;
  /** 'finished' once the room found the last player standing; 'aborted' once D1 said so. */
  status: 'running' | 'finished' | 'aborted';
  startStack: number;
  levels: BlindLevel[];
  levelMs: number;
  /** The level of the hand being played (or the last one dealt). */
  level: number;
  /** Running clock: when the next level starts (null at the last level, or while stopped). */
  levelEndsAt: number | null;
  /** Stopped clock: the time this level had left when it stopped (null at the last level, or while running). */
  levelLeftMs: number | null;
  /** When the clock stopped (null: running). */
  stoppedAt: number | null;
  /** An operator paused the tournament: no new hand from the next one on. */
  pauseRequested: boolean;
  /** Everyone who took part, by user id (nickname at the start). */
  players: Record<string, string>;
  places: TourneyPlace[];
  /** Places D1 has confirmed (kept when an abort turns out to have come first). */
  confirmed: number;
  /** Tournament hands dealt. */
  hands: number;
  winnerId: string | null;
  finishedAt: number | null;
  /** When the finished table closes (the result stays on screen until then). */
  closeAt: number | null;
  tb: TournamentTimeBank;
  /** Progress D1 does not have yet (retried until it does). */
  dirty: boolean;
}

/** The room's tournament state from D1, the first time the room meets its tournament (or after losing its storage). */
export function seedTourney(row: TournamentRow, now: number): TourneyState {
  const took = row.entries;
  const winner = took.find((e) => e.status === 'won');
  const status: TourneyState['status'] = row.status === 'running' ? 'running' : row.status === 'finished' ? 'finished' : 'aborted';
  const places = took
    .filter((e) => (e.status === 'eliminated' || e.status === 'won') && e.place !== null)
    .map((e) => ({ userId: e.userId, nickname: e.nickname, place: e.place!, hand: 0, at: now }))
    .filter((p) => p.userId !== winner?.userId);
  // A clock D1 shows running keeps running; one never started (or stopped) waits for the first deal.
  const stopped = row.levelEndsAt === null;
  return {
    id: row.id,
    name: row.name,
    status,
    startStack: row.startStack,
    levels: row.levels,
    levelMs: row.levelMs,
    level: row.level,
    levelEndsAt: stopped ? null : row.levelEndsAt,
    levelLeftMs: stopped ? (row.level >= row.levels.length - 1 ? null : (row.levelLeftMs ?? row.levelMs)) : null,
    stoppedAt: stopped ? (row.pausedAt ?? now) : null,
    pauseRequested: row.pauseRequested,
    players: Object.fromEntries(took.map((e) => [e.userId, e.nickname])),
    places,
    confirmed: places.length,
    hands: row.hands,
    winnerId: winner?.userId ?? null,
    finishedAt: status === 'finished' ? now : null,
    closeAt: status === 'running' ? null : now,
    tb: row.tb,
    dirty: false,
  };
}

/** Stops the level clock (keeping the time left). Returns whether it was running. */
export function stopClock(t: TourneyState, now: number): boolean {
  if (t.stoppedAt !== null) return false;
  t.levelLeftMs = t.levelEndsAt === null ? null : Math.max(0, t.levelEndsAt - now);
  t.levelEndsAt = null;
  t.stoppedAt = now;
  return true;
}

/**
 * At a deal: starts a stopped clock from the time it had left and leaves behind the levels whose time is up. Returns
 * whether anything changed (for D1).
 */
export function runClock(t: TourneyState, now: number): boolean {
  let changed = false;
  if (t.stoppedAt !== null) {
    t.levelEndsAt = t.levelLeftMs === null ? null : now + t.levelLeftMs;
    t.levelLeftMs = null;
    t.stoppedAt = null;
    changed = true;
  }
  const c = advanceLevel({ level: t.level, levelEndsAt: t.levelEndsAt }, t.levels.length, t.levelMs, now);
  if (c.level !== t.level || c.levelEndsAt !== t.levelEndsAt) changed = true;
  t.level = c.level;
  t.levelEndsAt = c.levelEndsAt;
  return changed;
}

/** Players still in: everyone who took part, less those out (the winner, once there is one, is the one left). */
export function playersLeft(t: TourneyState): number {
  return Math.max(0, Object.keys(t.players).length - t.places.filter((p) => p.userId !== t.winnerId).length);
}

/**
 * A settled hand of a running tournament: those who lost their last chip get their places (docs: bigger stack at the
 * start of the hand places higher, equal stacks share the higher place), and with one player left that player wins.
 * Returns the busted user ids.
 */
export function bustOut(t: TourneyState, dealt: readonly { playerId: string; displayName: string; stack: number }[], final: ReadonlyMap<string, number>, now: number): string[] {
  if (t.status !== 'running') return [];
  const placed = new Set(t.places.map((p) => p.userId));
  const busts = dealt
    .filter((p) => !placed.has(p.playerId) && (final.get(p.playerId) ?? 0) === 0)
    .map((p) => ({ userId: p.playerId, nickname: t.players[p.playerId] ?? p.displayName, startStack: p.stack }));
  if (busts.length === 0) return [];
  const before = playersLeft(t);
  for (const b of rankBusts(before, busts)) t.places.push({ userId: b.userId, nickname: b.nickname, place: b.place, hand: t.hands, at: now });
  t.dirty = true;
  if (playersLeft(t) <= 1) {
    const out = new Set(t.places.map((p) => p.userId));
    const winner = Object.keys(t.players).find((u) => !out.has(u) && (final.get(u) ?? 0) > 0) ?? null;
    t.status = 'finished';
    t.winnerId = winner;
    t.finishedAt = now;
    t.closeAt = now + TOURNAMENT_FINISH_LINGER_MS;
    if (winner) t.places.push({ userId: winner, nickname: t.players[winner] ?? '', place: 1, hand: t.hands, at: now });
  }
  return busts.map((b) => b.userId);
}

/** D1 says the tournament was aborted: places D1 did not take are dropped, nobody wins, nothing is left to write. */
export function markAborted(t: TourneyState, now: number) {
  if (t.status === 'aborted') return;
  t.status = 'aborted';
  t.places = t.places.slice(0, t.confirmed).filter((p) => p.userId !== t.winnerId || p.place !== 1);
  t.winnerId = null;
  t.finishedAt = null;
  t.closeAt ??= now;
  t.dirty = false;
}

export interface TourneySyncResult {
  /** The tournament's status in D1 after the write (null: no such tournament). */
  status: TournamentStatus | null;
  pauseRequested: boolean;
  maintenance: Maintenance | null;
}

/**
 * Writes the room's tournament progress to D1 in one batch: places, stack mirrors, the winner and the finish, the level
 * clock, players left and when the room last reported. Every write is the whole state and is conditional on the
 * tournament still running (and, for the clock, on no later hand having been written), so writing it again changes
 * nothing and nothing is written after an abort. Reads back the status, the pause request and the maintenance window.
 */
export async function syncTournament(d1: D1Database, t: TourneyState, stacks: readonly { userId: string; stack: number }[], now: number): Promise<TourneySyncResult> {
  const running = `EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status = 'running')`;
  const stmts: D1PreparedStatement[] = [];
  for (const p of t.places) {
    if (p.userId === t.winnerId) continue;
    stmts.push(
      d1
        .prepare(
          `UPDATE tournament_entries SET status = 'eliminated', place = ?3, stack = 0, eliminated_at = ?4, eliminated_hand = ?5, updated_at = ?6
           WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'playing' AND ${running}`,
        )
        .bind(t.id, p.userId, p.place, p.at, p.hand, now),
    );
  }
  for (const s of stacks) {
    if (s.userId === t.winnerId) continue;
    stmts.push(
      d1
        .prepare(`UPDATE tournament_entries SET stack = ?3, updated_at = ?4 WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'playing' AND stack IS NOT ?3 AND ${running}`)
        .bind(t.id, s.userId, s.stack, now),
    );
  }
  const finish = t.status === 'finished' && t.winnerId !== null;
  if (finish) {
    const total = Object.keys(t.players).length * t.startStack;
    stmts.push(
      d1
        .prepare(`UPDATE tournament_entries SET status = 'won', place = 1, stack = ?3, updated_at = ?4 WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'playing' AND ${running}`)
        .bind(t.id, t.winnerId, total, now),
    );
  }
  stmts.push(
    d1
      .prepare(
        `UPDATE tournaments SET hands = ?2, level = ?3, level_ends_at = ?4, level_left_ms = ?5, paused_at = ?6, players_left = ?7,
           room_seen_at = ?8, updated_at = ?8
           ${finish ? `, status = 'finished', winner_id = ?9, finished_at = ?10, end_reason = 'completed', version = version + 1` : ''}
         WHERE id = ?1 AND status = 'running' AND hands <= ?2`,
      )
      .bind(
        ...[t.id, t.hands, t.level, t.levelEndsAt, t.levelLeftMs, t.stoppedAt, playersLeft(t), now, ...(finish ? [t.winnerId, t.finishedAt ?? now] : [])],
      ),
  );
  stmts.push(d1.prepare(`SELECT status, pause_requested AS pauseRequested FROM tournaments WHERE id = ?1`).bind(t.id));
  stmts.push(maintenanceQuery(d1, now));
  const res = await d1.batch(stmts);
  const back = res[res.length - 2]?.results[0] as { status?: string; pauseRequested?: number } | undefined;
  const status = back && STATUSES.includes(back.status as TournamentStatus) ? (back.status as TournamentStatus) : null;
  return { status, pauseRequested: back?.pauseRequested === 1, maintenance: toMaintenance(res[res.length - 1]?.results[0] as Maintenance | undefined) };
}
