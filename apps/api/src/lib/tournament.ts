/**
 * Sit & Go tournaments on the api side (docs/TOURNAMENT.md): what members and operators read, the eligibility check and
 * the start, which the members' registration (an automatic start when the last seat is taken) and an operator's start
 * share. Tournament chips are numbers in `tournament_entries`: nothing here reaches a wallet, the chip ledger or a table
 * session.
 *
 * Every change is one conditional statement (or one batch whose statements are conditional on the first), so two
 * requests at once can never start a tournament twice, take a seat over the capacity, or start from a roster that
 * changed meanwhile: `version` changes with the tournament's status and settings, `roster` with every registration.
 */
import {
  type BlindLevel,
  type EntryStatus,
  type TournamentIneligible,
  type TournamentStatus,
  type TournamentSummaryDto,
  type TournamentTimeBank,
  isKstNight,
  shownVip,
  TOURNAMENT_STATUSES,
} from '@jc/types';
import { outboxForEntries } from '@jc/db';
import type { Env } from '../env';
import { adminTournamentChanged } from './admin-monitor';
import { fail } from './http';
import { notices } from './notices';
import { queuePush } from './notify';
import { sendToAll } from './realtime';
import { roomCallEnv } from './room';
import { currentMaintenance } from './service';

/** A tournament id as made by newTournamentId (route parameters are checked against it before any query). */
export const TOURNAMENT_ID = /^[a-z0-9]{12}$/;
export function newTournamentId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = new Uint8Array(12);
  crypto.getRandomValues(r);
  return Array.from(r, (b) => a[b % a.length]).join('');
}

/** An entry that holds a member: still to be played, or being played. */
export const HOLDING_ENTRY = `('registered', 'playing')`;
export const ACTIVE_TOURNAMENT = `('registering', 'closed', 'running')`;

/** Whether the member `?2` holds a seat in another tournament still to be played or being played (than `?1`). */
export const ELSEWHERE_SQL = (user: string) => `EXISTS (SELECT 1 FROM tournament_entries o JOIN tournaments ot ON ot.id = o.tournament_id
  WHERE o.user_id = ${user} AND o.tournament_id != ?1 AND o.status IN ${HOLDING_ENTRY} AND ot.status IN ${ACTIVE_TOURNAMENT})`;

/** Hands the member has played, counted up to `limit` (an index range on hp_user_idx, never the whole history). */
export const HANDS_SQL = (user: string, limit: string) => `CASE WHEN ${limit} > 0 THEN (SELECT COUNT(*) FROM (SELECT 1 FROM hand_players h WHERE h.user_id = ${user} LIMIT ${limit})) ELSE 0 END`;

export const parseLevels = (raw: unknown): BlindLevel[] => {
  try {
    const v = JSON.parse(String(raw)) as unknown;
    return Array.isArray(v) ? v.filter((l): l is BlindLevel => Number.isSafeInteger(l?.sb) && Number.isSafeInteger(l?.bb)) : [];
  } catch {
    return [];
  }
};

export const isStatus = (v: unknown): v is TournamentStatus => TOURNAMENT_STATUSES.includes(v as TournamentStatus);

/** A tournament's time bank from its `tb_*` columns (read as tbEnabled, tbInitialMs, ...). */
export const timeBankOf = (r: Record<string, unknown>): TournamentTimeBank => ({
  enabled: Number(r.tbEnabled) === 1,
  initialMs: Number(r.tbInitialMs),
  maxMs: Number(r.tbMaxMs),
  unitMs: Number(r.tbUnitMs),
  refillHands: Number(r.tbRefillHands),
  refillMs: Number(r.tbRefillMs),
});
export const TB_COLUMNS = (a: string) =>
  `${a}.tb_enabled AS tbEnabled, ${a}.tb_initial_ms AS tbInitialMs, ${a}.tb_max_ms AS tbMaxMs, ${a}.tb_unit_ms AS tbUnitMs, ${a}.tb_refill_hands AS tbRefillHands, ${a}.tb_refill_ms AS tbRefillMs`;

/** The members' list row (`?1`: the viewer). */
export const SUMMARY_COLUMNS = `tn.id, tn.name, tn.status, tn.capacity, tn.min_players AS minPlayers, tn.start_stack AS startStack, tn.levels,
  tn.level_ms AS levelMs, tn.turn_seconds AS turnSeconds, tn.level, tn.players_left AS playersLeft, tn.auto_start AS autoStart,
  tn.min_hands AS minHands, tn.require_verified AS requireVerified, tn.table_id AS tableId, tn.created_at AS createdAt,
  tn.started_at AS startedAt, COALESCE(tn.finished_at, tn.aborted_at, tn.cancelled_at) AS endedAt,
  (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = tn.id AND e.status NOT IN ('unregistered', 'dropped')) AS registered,
  w.nickname AS winner, w.role AS winnerRole, w.status AS winnerStatus, w.is_bot AS winnerBot, w.vip_color AS winnerVipColor,
  me.status AS meStatus, me.place AS mePlace`;
export const SUMMARY_FROM = `tournaments tn LEFT JOIN users w ON w.id = tn.winner_id
  LEFT JOIN tournament_entries me ON me.tournament_id = tn.id AND me.user_id = ?1`;

export function summaryOf(r: Record<string, unknown>): TournamentSummaryDto {
  const levels = parseLevels(r.levels);
  const winnerVip = r.winner ? shownVip({ role: r.winnerRole as string, status: r.winnerStatus as string, isBot: Number(r.winnerBot), vipColor: r.winnerVipColor as string | null }) : undefined;
  return {
    id: String(r.id),
    name: String(r.name),
    status: r.status as TournamentStatus,
    capacity: Number(r.capacity),
    minPlayers: Number(r.minPlayers),
    // A cancelled tournament keeps its registrations (they were never played); an ended one counts who took part.
    registered: Number(r.registered),
    startStack: Number(r.startStack),
    levelMinutes: Math.round(Number(r.levelMs) / 60_000),
    turnSeconds: Number(r.turnSeconds),
    firstLevel: levels[0] ?? { sb: 0, bb: 0 },
    levelCount: levels.length,
    level: Number(r.level ?? 0),
    playersLeft: r.playersLeft === null || r.playersLeft === undefined ? null : Number(r.playersLeft),
    autoStart: Number(r.autoStart) === 1,
    minHands: Number(r.minHands),
    requireVerified: Number(r.requireVerified) === 1,
    tableId: (r.tableId as string | null) ?? null,
    createdAt: Number(r.createdAt),
    startedAt: (r.startedAt as number | null) ?? null,
    endedAt: (r.endedAt as number | null) ?? null,
    winner: (r.winner as string | null) ?? null,
    ...(winnerVip ? { winnerVip } : {}),
    me: r.meStatus ? { status: r.meStatus as EntryStatus, place: (r.mePlace as number | null) ?? null } : null,
  };
}

export type Eligibility = { ok: true } | { ok: false; reason: TournamentIneligible | 'active_elsewhere' | 'full'; handsLeft?: number };

interface MemberFacts {
  status: string;
  isBot: number;
  verified: number;
  hands: number;
  elsewhere: number;
}

/** Why a member may not play (registration and the start's second look), or null. */
function ineligible(m: MemberFacts, t: { minHands: number; requireVerified: boolean }): { reason: TournamentIneligible | 'active_elsewhere'; handsLeft?: number } | null {
  if (m.status !== 'active') return { reason: 'suspended' };
  if (m.isBot) return { reason: 'bot' };
  if (t.requireVerified && !m.verified) return { reason: 'unverified' };
  if (t.minHands > 0 && m.hands < t.minHands) return { reason: 'min_hands', handsLeft: t.minHands - m.hands };
  if (m.elsewhere) return { reason: 'active_elsewhere' };
  return null;
}

/** Whether `userId` could register for the tournament now (registration open is checked by the caller). */
export async function eligibility(db: D1Database, t: { id: string; capacity: number; minHands: number; requireVerified: boolean }, userId: string): Promise<Eligibility> {
  const m = await db
    .prepare(
      `SELECT u.status, u.is_bot AS isBot, u.email_verified_at IS NOT NULL AS verified, ${HANDS_SQL('?2', '?3')} AS hands, ${ELSEWHERE_SQL('?2')} AS elsewhere,
              (SELECT COUNT(*) FROM tournament_entries x WHERE x.tournament_id = ?1 AND x.status = 'registered') AS registered
         FROM users u WHERE u.id = ?2`,
    )
    .bind(t.id, userId, t.minHands)
    .first<MemberFacts & { registered: number }>();
  if (!m) return { ok: false, reason: 'suspended' };
  const no = ineligible(m, t);
  if (no) return { ok: false, ...no };
  if (m.registered >= t.capacity) return { ok: false, reason: 'full' };
  return { ok: true };
}

/** A system message to entries of the tournament: one per tournament, member and kind (sending again sends nothing). */
export function tournamentNotice(
  db: D1Database,
  t: { id: string; name: string },
  kind: 'started' | 'cancelled' | 'aborted',
  entries: readonly EntryStatus[],
  /** The change this notice is for, as a condition on `tournaments tn` (so the notice goes only with it). */
  guard: string,
  now: number,
) {
  const key = kind === 'started' ? 'tournamentStarted' : kind === 'cancelled' ? 'tournamentCancelled' : 'tournamentAborted';
  const ko = notices('ko')[key](t.name);
  const en = notices('en')[key](t.name);
  return db
    .prepare(
      `INSERT OR IGNORE INTO messages (id, user_id, category, title, body, sender_id, created_at)
       SELECT 'tn:' || ?1 || ':' || ?2 || ':' || u.id, u.id, 'system', CASE WHEN u.locale = 'en' THEN ?3 ELSE ?4 END,
              CASE WHEN u.locale = 'en' THEN ?5 ELSE ?6 END, NULL, ?7
         FROM tournament_entries e JOIN users u ON u.id = e.user_id
        WHERE e.tournament_id = ?1 AND e.status IN (${entries.map((s) => `'${s}'`).join(', ')}) AND u.status != 'deleted' AND u.is_bot = 0
          AND EXISTS (SELECT 1 FROM tournaments tn WHERE tn.id = ?1 AND ${guard})`,
    )
    .bind(t.id, kind, en.title, ko.title, en.body, ko.body, now);
}

/** Asks the tournament's room to read D1 again (twice when it does not answer). Null: it did not answer. */
export async function reloadRoom(env: Env, tableId: string | null) {
  if (!tableId) return null;
  return (await roomCallEnv(env, tableId, 'reload')) ?? (await roomCallEnv(env, tableId, 'reload'));
}

export interface StartOptions {
  /** The operator who started it (null: the automatic start when the last seat was taken). */
  actorId: string | null;
  /** The automatic start: never refuses (it reports why it did not start) and starts only with every seat taken. */
  auto: boolean;
  /** The version the operator was looking at: a change meanwhile is a conflict. */
  baseVersion?: number;
  /** The request's, to send the start's pushes in the background (without it the minute cron sends them). */
  ctx?: Pick<ExecutionContext, 'waitUntil'>;
}

export interface StartResult {
  started: boolean;
  /** Why an automatic start did not happen. */
  reason?: 'not_found' | 'state' | 'maintenance' | 'ineligible' | 'not_full' | 'busy';
  tableId: string | null;
  players: number;
  /** Registrations dropped because their member no longer qualified. */
  dropped: { userId: string; reason: string }[];
  /** The room answered the reload (when not, it seats the players the first time anyone opens it). */
  roomConfirmed: boolean;
}

/**
 * A tournament changed in D1 (opened, registration, a start, a cancel, a pause): the tournament pages read it again.
 * Public and carries only the id; in the background, never failing the change (without `ctx` the pages' poll finds it).
 * The console's tournament pages hear of it too, with its version (admin.monitor.changed).
 */
export function tournamentChanged(env: Env, id: string, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined) {
  ctx?.waitUntil(sendToAll(env, { scope: 'lobby', type: 'tournament.changed', resourceId: id }).catch((err) => console.warn('realtime tournament change not sent', String(err))));
  ctx?.waitUntil(adminTournamentChanged(env, id).catch((err) => console.warn('admin monitor tournament publish failed', String(err))));
}

/** Tries before giving up on a roster that keeps changing (each registration changes it). */
const START_ATTEMPTS = 4;

interface StartRow {
  id: string;
  name: string;
  status: TournamentStatus;
  capacity: number;
  minPlayers: number;
  startStack: number;
  levels: string;
  turnSeconds: number;
  minHands: number;
  requireVerified: number;
  version: number;
  roster: number;
}

/** Seat numbers 0–5 in a random order (crypto). */
function shuffledSeats(): number[] {
  const seats = [0, 1, 2, 3, 4, 5];
  const r = new Uint32Array(seats.length);
  crypto.getRandomValues(r);
  for (let i = seats.length - 1; i > 0; i--) {
    const j = r[i]! % (i + 1);
    [seats[i], seats[j]] = [seats[j]!, seats[i]!];
  }
  return seats;
}

/**
 * Starts a tournament (docs/TOURNAMENT.md "시작"): reads every registration's eligibility from D1 again (dropping those
 * who lost it), checks the number of players, and in one batch moves the tournament to `running` — only from the version
 * and roster it read — opens its table, seats the players at random seats with the starting stack and sends each the
 * start notice. A second start, from any path, finds the tournament running and is refused (or, automatic, does
 * nothing). Then tells the room to read it; a room that does not answer seats them the first time it is opened.
 */
export async function startTournament(env: Env, id: string, opts: StartOptions): Promise<StartResult> {
  const db = env.DB;
  const dropped: StartResult['dropped'] = [];
  const no = (reason: NonNullable<StartResult['reason']>): StartResult => ({ started: false, reason, tableId: null, players: 0, dropped, roomConfirmed: false });
  // Ids are made here (newTournamentId); the table id below is written into the batch's conditions.
  if (!TOURNAMENT_ID.test(id)) {
    if (opts.auto) return no('not_found');
    fail(404, 'tournament_not_found', 'tournament not found');
  }
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const now = Date.now();
    const t = await db
      .prepare(
        `SELECT id, name, status, capacity, min_players AS minPlayers, start_stack AS startStack, levels, turn_seconds AS turnSeconds,
                min_hands AS minHands, require_verified AS requireVerified, version, roster
           FROM tournaments WHERE id = ?1`,
      )
      .bind(id)
      .first<StartRow>();
    if (!t) {
      if (opts.auto) return no('not_found');
      fail(404, 'tournament_not_found', 'tournament not found');
    }
    if (t.status !== 'registering' && t.status !== 'closed') {
      if (opts.auto) return no('state');
      if (t.status === 'cancelled') fail(409, 'tournament_state', 'the tournament was cancelled', { status: t.status });
      fail(409, 'tournament_started', 'the tournament has already started', { status: t.status });
    }
    if (opts.baseVersion !== undefined && t.version !== opts.baseVersion) fail(409, 'tournament_conflict', 'the tournament changed meanwhile', { version: t.version, status: t.status });
    const m = await currentMaintenance(db, now);
    if (m?.active) {
      if (opts.auto) return no('maintenance');
      fail(503, 'maintenance', 'service maintenance: no new games until it ends', { endsAt: m.endsAt });
    }
    const { results } = await db
      .prepare(
        `SELECT e.user_id AS userId, u.status, u.is_bot AS isBot, u.email_verified_at IS NOT NULL AS verified,
                ${HANDS_SQL('e.user_id', '?2')} AS hands, ${ELSEWHERE_SQL('e.user_id')} AS elsewhere
           FROM tournament_entries e JOIN users u ON u.id = e.user_id
          WHERE e.tournament_id = ?1 AND e.status = 'registered'
          ORDER BY e.registered_at, e.user_id`,
      )
      .bind(id, t.minHands)
      .all<MemberFacts & { userId: string }>();
    const rules = { minHands: t.minHands, requireVerified: t.requireVerified === 1 };
    const lost = results.flatMap((e) => {
      const why = ineligible(e, rules);
      return why ? [{ userId: e.userId, reason: why.reason }] : [];
    });
    if (lost.length > 0) {
      const open = `EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status IN ('registering', 'closed'))`;
      await db.batch([
        ...lost.map((l) =>
          db.prepare(`UPDATE tournament_entries SET status = 'dropped', updated_at = ?3 WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'registered' AND ${open}`).bind(id, l.userId, now),
        ),
        db.prepare(`UPDATE tournaments SET roster = roster + 1, updated_at = ?2 WHERE id = ?1 AND status IN ('registering', 'closed')`).bind(id, now),
      ]);
      dropped.push(...lost);
      tournamentChanged(env, id, opts.ctx);
      // The automatic start keeps registration open for the seats this freed.
      if (opts.auto) return no('ineligible');
      continue;
    }
    const players = results.slice(0, Math.min(t.capacity, 6));
    if (opts.auto ? players.length < t.capacity : players.length < t.minPlayers) {
      if (opts.auto) return no('not_full');
      fail(409, 'tournament_not_ready', 'not enough eligible players', { eligible: players.length, minPlayers: t.minPlayers, dropped });
    }
    const levels = parseLevels(t.levels);
    const first = levels[0];
    if (!first) fail(500, 'tournament_structure_invalid', 'the tournament has no blind levels');
    const tableId = `sng-${id}`;
    const seats = shuffledSeats();
    const started = `tn.status = 'running' AND tn.table_id = '${tableId}' AND tn.started_at = ${now}`;
    const mine = `EXISTS (SELECT 1 FROM tournaments tn WHERE tn.id = ?1 AND ${started})`;
    // The players qualify when the batch commits, not only when they were read above: a suspension (or a seat taken in
    // another tournament, a verification taken back) in between changes neither the version nor the roster, so the
    // start is conditional on it too and looks again (dropping that player) when it no longer holds. Hands played only
    // grow, so they are not read again.
    const res = await db.batch([
      db
        .prepare(
          `UPDATE tournaments SET status = 'running', version = version + 1, table_id = ?2, started_at = ?3, level = 0, level_ends_at = NULL,
                  level_left_ms = CASE WHEN json_array_length(levels) > 1 THEN level_ms ELSE NULL END, paused_at = ?3, pause_requested = 0,
                  pause_changed_at = NULL, players_left = ?4, hands = 0, room_seen_at = NULL, updated_at = ?3
            WHERE id = ?1 AND status IN ('registering', 'closed') AND roster = ?5 AND version = ?6
              AND NOT EXISTS (SELECT 1 FROM json_each(?7) p LEFT JOIN users u ON u.id = p.value
                               WHERE u.id IS NULL OR u.status != 'active' OR u.is_bot != 0 OR (?8 = 1 AND u.email_verified_at IS NULL)
                                  OR ${ELSEWHERE_SQL('u.id')})`,
        )
        .bind(id, tableId, now, players.length, t.roster, t.version, JSON.stringify(players.map((p) => p.userId)), t.requireVerified),
      db
        .prepare(
          `INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, allow_spectators,
                  entry_blocked, room_type, bots_enabled, created_by, created_at, updated_at)
           SELECT ?2, ?3, 6, ?4, ?5, ?6, ?6, ?7, 0, 1, 1, 'tournament', 0, ?8, ?9, ?9 WHERE ${mine}`,
        )
        .bind(id, tableId, t.name, first.sb, first.bb, t.startStack, t.turnSeconds, opts.actorId, now),
      ...players.map((p, i) =>
        db
          .prepare(`UPDATE tournament_entries SET status = 'playing', seat_index = ?3, stack = ?4, updated_at = ?5 WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'registered' AND ${mine}`)
          .bind(id, p.userId, seats[i]!, t.startStack, now),
      ),
      // Nobody else can be registered (the roster did not change); never leave a registration behind a started tournament.
      db.prepare(`UPDATE tournament_entries SET status = 'dropped', updated_at = ?2 WHERE tournament_id = ?1 AND status = 'registered' AND ${mine}`).bind(id, now),
      tournamentNotice(db, t, 'started', ['playing'], started, now),
    ]);
    // The tournament changed (another start, a cancel, a registration closed or opened) or a registration came or went:
    // look again (a start that already happened is refused at the top).
    if (!res[0]?.meta.changes) continue;
    tournamentChanged(env, id, opts.ctx);
    const live = await reloadRoom(env, tableId);
    // After the start is saved, never with it: a push that can't be queued leaves the start as it is.
    await queuePush(
      env,
      [outboxForEntries(db, { tournamentId: id, type: 'tournament_start', statuses: ['playing'], prefix: 'tournament_start', url: `/table/${tableId}`, guard: started, now, night: isKstNight(now) })],
      opts.ctx,
    );
    return { started: true, tableId, players: players.length, dropped, roomConfirmed: !!live };
  }
  if (opts.auto) return no('busy');
  fail(409, 'tournament_conflict', 'registrations kept changing; try again');
}
