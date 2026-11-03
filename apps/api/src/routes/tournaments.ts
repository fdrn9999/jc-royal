/**
 * Members' Sit & Go tournaments (docs/TOURNAMENT.md "등록"): the list, one tournament with its players and whether the
 * viewer may register, registering and unregistering. Free entry and no prize: nothing here touches chips.
 *
 * Registering is one statement with every condition in its WHERE (registration open, a seat left, the member eligible
 * and in no other tournament), so many members taking the last seat at once never go over the capacity, and pressing
 * again is the same one row. The registration that takes the last seat of a tournament that starts by itself starts it
 * (lib/tournament.ts startTournament, which an operator's start shares).
 *
 * A private tournament (docs/TOURNAMENT.md "비공개 대회") is a Sit & Go a member opens from an active template, as its
 * host: hidden from everyone but its host, those with an entry in it and those its host invited (visibleSql, the same
 * test for the list, the page and registering), joined with its code (shown to the host once, only its hash kept) or
 * the host's invite, started or cancelled by the host as an operator would.
 */
import { IF_CHANGED, inboxStatement, realtimeOutboxStatement } from '@jc/db';
import {
  JOIN_CODE_ALPHABET,
  normalizeJoinCode,
  PRIVATE_TOURNAMENT,
  PrivateTournamentCreateSchema,
  shownVip,
  TournamentInviteSchema,
  TournamentJoinCodeSchema,
  type EntryStatus,
  type PrivateTemplateDto,
  type TournamentDetailDto,
  type TournamentEntryView,
} from '@jc/types';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { outboxToUsers, realtimeOutboxSend, realtimeToUsers } from '../lib/realtime';
import { refuseNewGamesInMaintenance } from '../lib/service';
import {
  ACTIVE_TOURNAMENT,
  cancelTournament,
  ELSEWHERE_SQL,
  eligibility,
  HANDS_SQL,
  newTournamentId,
  parseLevels,
  privateInviteKey,
  startTournament,
  SUMMARY_COLUMNS,
  SUMMARY_FROM,
  summaryOf,
  TB_COLUMNS,
  timeBankOf,
  TOURNAMENT_ID,
  tournamentChanged,
  tournamentTold,
  visibleSql,
  type StartResult,
} from '../lib/tournament';
import { notBlocked, pairOf } from './social';

/** Private tournaments open (registering or closed) at once, across all hosts. */
export const PRIVATE_OPEN_MAX = 100;

/** A new join code (crypto): PRIVATE_TOURNAMENT.codeLength characters of JOIN_CODE_ALPHABET. */
function newJoinCode(): string {
  const r = new Uint32Array(PRIVATE_TOURNAMENT.codeLength);
  crypto.getRandomValues(r);
  return Array.from(r, (n) => JOIN_CODE_ALPHABET[n % JOIN_CODE_ALPHABET.length]).join('');
}
/** What D1 keeps of a code (normalized): its hash, never the code. */
const joinCodeHash = (code: string) => sha256(`tournament:${normalizeJoinCode(code)}`);

const ENDED = `('finished', 'cancelled', 'aborted')`;
/** Who a tournament shows: the registered before it starts (and when cancelled), those who played after. */
const PLAYED = `('playing', 'eliminated', 'won', 'stopped')`;

const page = (c: Context<AppEnv>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 50),
  offset: Math.min(Math.max(Number(c.req.query('offset') ?? 0) || 0, 0), 1_000),
});

/** The tournament's status now (null: none). */
async function statusOf(c: Context<AppEnv>, id: string) {
  return (await c.env.DB.prepare(`SELECT status FROM tournaments WHERE id = ?1`).bind(id).first<{ status: string }>())?.status ?? null;
}

function tournamentId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? '';
  if (!TOURNAMENT_ID.test(id)) fail(404, 'tournament_not_found', 'tournament not found');
  return id;
}

interface RegisterRow {
  status: string;
  capacity: number;
  minHands: number;
  requireVerified: number;
  autoStart: number;
  visible: number;
}

/**
 * A private tournament's host acting on it: 404 for whoever may not see it, 403 for anyone else who is not its host.
 * Its name for the notices.
 */
async function hostOf(c: Context<AppEnv>, id: string): Promise<{ name: string; status: string }> {
  const me = c.var.user!.id;
  const t = await c.env.DB.prepare(`SELECT t.name, t.status, t.is_private AS isPrivate, t.host_id AS hostId, ${visibleSql('t', '?2')} AS visible FROM tournaments t WHERE t.id = ?1`)
    .bind(id, me)
    .first<{ name: string; status: string; isPrivate: number; hostId: string | null; visible: number }>();
  if (!t || !t.visible) fail(404, 'tournament_not_found', 'tournament not found');
  if (t.isPrivate !== 1 || t.hostId !== me) fail(403, 'tournament_host_only', 'only the host of a private tournament does this');
  return t;
}

/**
 * Registers the viewer (again, after unregistering): see POST /:id/register. `codeHash`: they came with this code (a
 * private tournament takes it instead of an invite), checked in the same statement.
 */
async function register(c: Context<AppEnv>, id: string, codeHash: string | null) {
  const me = c.var.user!.id;
  await rateLimit(c, `tournament-register:${me}`, 20, 60_000);
  await refuseNewGamesInMaintenance(c);
  const db = c.env.DB;
  const t = await db
    .prepare(
      `SELECT t.status, t.capacity, t.min_hands AS minHands, t.require_verified AS requireVerified, t.auto_start AS autoStart, ${visibleSql('t', '?2')} AS visible
         FROM tournaments t WHERE t.id = ?1`,
    )
    .bind(id, me)
    .first<RegisterRow>();
  if (!t || (!t.visible && !codeHash)) fail(404, 'tournament_not_found', 'tournament not found');
  const now = Date.now();
  const changed = tournamentTold(db, id, now);
  const [ins] = await db.batch([
    // min_hands is fixed when the tournament is opened, so it is bound (as the LIMIT of the hands count).
    db
      .prepare(
        `INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at, updated_at)
         SELECT ?1, ?2, 'registered', ?3, ?3
          WHERE EXISTS (SELECT 1 FROM tournaments t WHERE t.id = ?1 AND t.status = 'registering'
                  AND (t.join_code_hash = ?5 OR ${visibleSql('t', '?2')})
                  AND (SELECT COUNT(*) FROM tournament_entries x WHERE x.tournament_id = ?1 AND x.status = 'registered') < t.capacity
                  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.status = 'active' AND u.is_bot = 0
                        AND (t.require_verified = 0 OR u.email_verified_at IS NOT NULL)
                        AND (?4 = 0 OR ${HANDS_SQL('?2', '?4')} >= ?4)))
            AND NOT ${ELSEWHERE_SQL('?2')}
         ON CONFLICT (tournament_id, user_id) DO UPDATE SET status = 'registered', registered_at = excluded.registered_at, updated_at = excluded.updated_at
          WHERE tournament_entries.status IN ('unregistered', 'dropped')`,
      )
      .bind(id, me, now, t.minHands, codeHash),
    db
      .prepare(
        `UPDATE tournaments SET roster = roster + 1, updated_at = ?3
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'registered' AND registered_at = ?3)`,
      )
      .bind(id, me, now),
    changed.statement,
  ]);
  if (!ins?.meta.changes) {
    const [mine, cur] = await db.batch<{ status: string }>([
      db.prepare(`SELECT status FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2`).bind(id, me),
      db.prepare(`SELECT status FROM tournaments WHERE id = ?1`).bind(id),
    ]);
    const entry = mine?.results[0]?.status;
    if (entry === 'registered' || entry === 'playing') return { ok: true, already: true, started: false, tableId: null };
    const status = cur?.results[0]?.status;
    if (status !== 'registering') fail(409, 'tournament_not_open', 'registration is not open', { status });
    const e = await eligibility(db, { id, capacity: t.capacity, minHands: t.minHands, requireVerified: t.requireVerified === 1 }, me);
    if (!e.ok) {
      if (e.reason === 'full') fail(409, 'tournament_full', 'every seat is taken');
      if (e.reason === 'active_elsewhere') fail(409, 'tournament_already_active', 'you are already in another tournament');
      fail(403, 'tournament_ineligible', 'you do not meet the registration conditions', { reason: e.reason, handsLeft: e.handsLeft });
    }
    fail(409, 'tournament_conflict', 'registration changed meanwhile; try again');
  }
  tournamentChanged(c.env, id, changed.row, c.executionCtx);
  let start: StartResult | null = null;
  if (t.autoStart === 1) {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?1 AND status = 'registered'`).bind(id).first<{ n: number }>();
    if ((n?.n ?? 0) >= t.capacity) {
      try {
        start = await startTournament(c.env, id, { actorId: null, auto: true, ctx: c.executionCtx });
      } catch (err) {
        // The registration stands; the tournament shows as needing a start (start_stuck) until an operator starts it.
        console.error('automatic tournament start failed', id, err);
      }
    }
  }
  return { ok: true, already: false, started: !!start?.started, tableId: start?.started ? start.tableId : null };
}

export const tournamentRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  /**
   * Tournaments to play (`status=active`: registering, registration closed, running) or played (`ended`), newest first,
   * with the viewer's own entry; `current` is the one the viewer is registered for or playing, wherever it is listed.
   */
  .get('/', async (c) => {
    const me = c.var.user!.id;
    const ended = c.req.query('status') === 'ended';
    const { limit, offset } = page(c);
    const db = c.env.DB;
    const [list, current] = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE tn.status IN ${ended ? ENDED : ACTIVE_TOURNAMENT} AND ${visibleSql('tn', '?1')}
            ORDER BY tn.created_at DESC, tn.id DESC LIMIT ?2 OFFSET ?3`,
        )
        .bind(me, limit + 1, offset),
      db.prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE tn.id = (SELECT e.tournament_id FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
            WHERE e.user_id = ?1 AND e.status IN ('registered', 'playing') AND t.status IN ${ACTIVE_TOURNAMENT} LIMIT 1)`,
      ).bind(me),
    ]);
    const rows = list?.results ?? [];
    const mine = current?.results[0];
    return c.json({ tournaments: rows.slice(0, limit).map(summaryOf), hasMore: rows.length > limit, current: mine ? summaryOf(mine) : null, now: Date.now() });
  })
  /** The Sit & Go templates a member may open a private tournament from (active ones, one table). */
  .get('/private/templates', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, capacity, min_players AS minPlayers, start_stack AS startStack, level_ms AS levelMs, turn_seconds AS turnSeconds, levels
         FROM tournament_templates WHERE status = 'active' AND format = 'sng' ORDER BY name, id LIMIT 50`,
    ).all<{ id: string; name: string; capacity: number; minPlayers: number; startStack: number; levelMs: number; turnSeconds: number; levels: string }>();
    const templates = results.flatMap((t): PrivateTemplateDto[] => {
      const levels = parseLevels(t.levels);
      const first = levels[0];
      if (!first) return [];
      return [
        {
          id: t.id,
          name: t.name,
          capacity: t.capacity,
          minPlayers: t.minPlayers,
          startStack: t.startStack,
          levelMinutes: Math.round(t.levelMs / 60_000),
          turnSeconds: t.turnSeconds,
          firstLevel: first,
          levelCount: levels.length,
        },
      ];
    });
    return c.json({ templates, openPerHost: PRIVATE_TOURNAMENT.openPerHost });
  })
  /**
   * Opens a private tournament (docs/TOURNAMENT.md "비공개 대회") from an active Sit & Go template, with its host
   * registered: one statement holds every condition (the template, the host able to play and in no other tournament,
   * their open private tournaments, all open private tournaments). Its join code is answered here only; D1 keeps its
   * hash, and a new one replaces it (POST /:id/code).
   */
  .post('/private', async (c) => {
    const me = c.var.user!.id;
    const body = await parseBody(c, PrivateTournamentCreateSchema);
    await rateLimit(c, `tournament-private:${me}`, 5, 10 * 60_000);
    await refuseNewGamesInMaintenance(c);
    const db = c.env.DB;
    const tpl = await db
      .prepare(
        `SELECT name, status, format, capacity, min_hands AS minHands, require_verified AS requireVerified FROM tournament_templates WHERE id = ?1`,
      )
      .bind(body.templateId)
      .first<{ name: string; status: string; format: string; capacity: number; minHands: number; requireVerified: number }>();
    if (!tpl || tpl.status !== 'active' || tpl.format !== 'sng') fail(404, 'tournament_template_not_found', 'template not found');
    const name = body.name ?? tpl.name;
    for (let attempt = 0; ; attempt++) {
      const id = newTournamentId();
      const code = newJoinCode();
      const now = Date.now();
      const changed = tournamentTold(db, id, now);
      let made: boolean;
      try {
        const [r] = await db.batch([
          // min_hands is bound (the LIMIT of the hands count) and checked unchanged.
          db
            .prepare(
              `INSERT INTO tournaments (id, template_id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds,
                      tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start,
                      format, table_seats, is_private, host_id, join_code_hash, version, roster, level, hands, pause_requested, created_by, created_at, updated_at)
               SELECT ?1, t.id, ?2, 'registering', t.capacity, t.min_players, t.start_stack, t.levels, t.level_ms, t.turn_seconds,
                      t.tb_enabled, t.tb_initial_ms, t.tb_max_ms, t.tb_unit_ms, t.tb_refill_hands, t.tb_refill_ms, t.min_hands, t.require_verified, t.auto_start,
                      'sng', 0, 1, ?3, ?4, 1, 1, 0, 0, 0, ?3, ?5, ?5
                 FROM tournament_templates t
                WHERE t.id = ?6 AND t.status = 'active' AND t.format = 'sng' AND t.min_hands = ?7
                  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?3 AND u.status = 'active' AND u.is_bot = 0
                        AND (t.require_verified = 0 OR u.email_verified_at IS NOT NULL)
                        AND (?7 = 0 OR ${HANDS_SQL('?3', '?7')} >= ?7))
                  AND NOT ${ELSEWHERE_SQL('?3')}
                  AND (SELECT COUNT(*) FROM tournaments h WHERE h.host_id = ?3 AND h.status IN ${ACTIVE_TOURNAMENT}) < ?8
                  AND (SELECT COUNT(*) FROM tournaments p WHERE p.is_private = 1 AND p.status IN ('registering', 'closed')) < ?9`,
            )
            .bind(id, name, me, await joinCodeHash(code), now, body.templateId, tpl.minHands, PRIVATE_TOURNAMENT.openPerHost, PRIVATE_OPEN_MAX),
          db
            .prepare(
              `INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at, updated_at)
               SELECT ?1, ?2, 'registered', ?3, ?3 WHERE EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND host_id = ?2 AND created_at = ?3)`,
            )
            .bind(id, me, now),
          changed.statement,
        ]);
        made = !!r?.meta.changes;
      } catch (err) {
        // Two codes alike (about 2^-50 a pair): another code.
        if (attempt < 2 && String(err).includes('join_code_hash')) continue;
        throw err;
      }
      if (!made) {
        const why = await db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM tournaments h WHERE h.host_id = ?1 AND h.status IN ${ACTIVE_TOURNAMENT}) AS mine,
                    (SELECT COUNT(*) FROM tournaments p WHERE p.is_private = 1 AND p.status IN ('registering', 'closed')) AS open`,
          )
          .bind(me)
          .first<{ mine: number; open: number }>();
        if (Number(why?.mine) >= PRIVATE_TOURNAMENT.openPerHost) fail(409, 'tournament_private_limit', 'you already host a private tournament', { openPerHost: PRIVATE_TOURNAMENT.openPerHost });
        const e = await eligibility(db, { id, capacity: tpl.capacity, minHands: tpl.minHands, requireVerified: tpl.requireVerified === 1 }, me);
        if (!e.ok && e.reason === 'active_elsewhere') fail(409, 'tournament_already_active', 'you are already in another tournament');
        if (!e.ok) fail(403, 'tournament_ineligible', 'you do not meet the registration conditions', { reason: e.reason, handsLeft: e.handsLeft });
        if (Number(why?.open) >= PRIVATE_OPEN_MAX) fail(409, 'tournament_limit', 'too many tournaments are open');
        fail(409, 'tournament_template_conflict', 'the template changed meanwhile');
      }
      tournamentChanged(c.env, id, changed.row, c.executionCtx);
      return c.json({ ok: true, id, code }, 201);
    }
  })
  /**
   * Registers with a private tournament's code (registration open): the same registration as POST /:id/register, the
   * code standing in for an invite. A wrong code and a code no longer open answer alike.
   */
  .post('/join', async (c) => {
    const me = c.var.user!.id;
    const { code } = await parseBody(c, TournamentJoinCodeSchema);
    await rateLimit(c, `tournament-code:${me}`, 10, 10 * 60_000);
    await rateLimit(c, `tournament-code-ip:${clientIp(c)}`, 30, 10 * 60_000, { perIp: true });
    const hash = await joinCodeHash(code);
    const t = await c.env.DB.prepare(`SELECT id FROM tournaments WHERE join_code_hash = ?1 AND is_private = 1 AND status = 'registering'`).bind(hash).first<{ id: string }>();
    if (!t) fail(404, 'tournament_code_invalid', 'no open tournament has this code');
    return c.json({ ...(await register(c, t.id, hash)), id: t.id });
  })
  /** One tournament: its structure, clock, players (nickname, status, place, tournament chips) and the viewer's eligibility. */
  .get('/:id', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    const db = c.env.DB;
    const r = await db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, tn.level_ends_at AS levelEndsAt, tn.level_left_ms AS levelLeftMs, tn.pause_requested AS pauseRequested, ${TB_COLUMNS('tn')}
           FROM ${SUMMARY_FROM} WHERE tn.id = ?2 AND ${visibleSql('tn', '?1')}`,
      )
      .bind(me, id)
      .first<Record<string, unknown>>();
    // A private tournament the viewer may not see is not there for them.
    if (!r) fail(404, 'tournament_not_found', 'tournament not found');
    const s = summaryOf(r);
    const played = s.status === 'running' || s.status === 'finished' || s.status === 'aborted';
    const { results } = await db
      .prepare(
        `SELECT e.user_id AS userId, u.nickname, u.role, u.status AS userStatus, u.is_bot AS isBot, u.vip_color AS vipColor, e.status, e.place, e.stack
           FROM tournament_entries e JOIN users u ON u.id = e.user_id
          WHERE e.tournament_id = ?1 AND e.status IN ${played ? PLAYED : `('registered')`}
          ORDER BY CASE e.status WHEN 'won' THEN 0 WHEN 'playing' THEN 1 WHEN 'stopped' THEN 2 ELSE 3 END, e.place, e.stack DESC, e.registered_at
          LIMIT 12`,
      )
      .bind(id)
      .all<{
        userId: string;
        nickname: string;
        role: string;
        userStatus: string;
        isBot: number;
        vipColor: string | null;
        status: EntryStatus;
        place: number | null;
        stack: number | null;
      }>();
    const entries: TournamentEntryView[] = results.map((e) => {
      const vip = shownVip({ role: e.role, status: e.userStatus, isBot: e.isBot, vipColor: e.vipColor });
      return {
        nickname: e.nickname,
        ...(vip ? { vip } : {}),
        status: e.status,
        place: e.place,
        stack: played ? e.stack : null,
        ...(e.userId === me ? { me: true } : {}),
      };
    });
    const holding = s.me?.status === 'registered' || s.me?.status === 'playing';
    // A multi-table tournament's open tables, to watch (each table's players as D1 last had them; no card).
    const tables =
      s.mtt && played
        ? (
            await db
              .prepare(
                `SELECT t.id, (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = ?1 AND e.table_id = t.id AND e.status = 'playing') AS players
                   FROM tables t WHERE t.tournament_id = ?1 AND t.status = 'open'`,
              )
              .bind(id)
              .all<{ id: string; players: number }>()
          ).results.sort((a, b) => Number(a.id.split('-').at(-1)) - Number(b.id.split('-').at(-1)))
        : undefined;
    const dto: TournamentDetailDto = {
      ...s,
      ...(tables ? { tables } : {}),
      levels: parseLevels(r.levels),
      timeBank: timeBankOf(r),
      levelEndsAt: (r.levelEndsAt as number | null) ?? null,
      levelLeftMs: (r.levelLeftMs as number | null) ?? null,
      paused: s.status === 'running' && Number(r.pauseRequested) === 1,
      entries,
      eligibility: s.status === 'registering' && !holding ? await eligibility(db, { id, capacity: s.capacity, minHands: s.minHands, requireVerified: s.requireVerified }, me) : null,
      now: Date.now(),
    };
    return c.json(dto);
  })
  /**
   * Registers the viewer (again, after unregistering). Already registered: ok, nothing changes. The registration that
   * takes the last seat of a tournament that starts by itself starts it; when the start cannot happen (a registered
   * member no longer qualifies, maintenance) the tournament stays open and operators see it as needing a start.
   */
  .post('/:id/register', async (c) => c.json(await register(c, tournamentId(c), null)))
  /** Gives up the viewer's seat before the start. Not registered: ok. After the start nobody leaves a tournament. */
  .post('/:id/unregister', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    await rateLimit(c, `tournament-register:${me}`, 20, 60_000);
    const db = c.env.DB;
    const now = Date.now();
    const changed = tournamentTold(db, id, now);
    const [up] = await db.batch([
      db
        .prepare(
          `UPDATE tournament_entries SET status = 'unregistered', updated_at = ?3
            WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'registered'
              AND EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status IN ('registering', 'closed'))`,
        )
        .bind(id, me, now),
      db
        .prepare(
          `UPDATE tournaments SET roster = roster + 1, updated_at = ?3
            WHERE id = ?1 AND EXISTS (SELECT 1 FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'unregistered' AND updated_at = ?3)`,
        )
        .bind(id, me, now),
      changed.statement,
    ]);
    if (!up?.meta.changes) {
      const [mine, cur] = await db.batch<{ status: string }>([
        db.prepare(`SELECT status FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2`).bind(id, me),
        db.prepare(`SELECT status FROM tournaments WHERE id = ?1`).bind(id),
      ]);
      const status = cur?.results[0]?.status;
      if (!status) fail(404, 'tournament_not_found', 'tournament not found');
      const entry = mine?.results[0]?.status;
      if (entry === 'registered' || entry === 'playing') {
        if (status === 'cancelled') fail(409, 'tournament_state', 'the tournament was cancelled', { status });
        fail(409, 'tournament_started', 'a started tournament cannot be left', { status });
      }
    } else tournamentChanged(c.env, id, changed.row, c.executionCtx);
    return c.json({ ok: true });
  })
  /**
   * The host starts their private tournament (registration open or closed, at least its minimum of players): the start
   * an operator makes (startTournament), with every check it holds.
   */
  .post('/:id/start', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    await hostOf(c, id);
    await rateLimit(c, `tournament-host:${me}`, 10, 60_000);
    await refuseNewGamesInMaintenance(c);
    const r = await startTournament(c.env, id, { actorId: me, auto: false, ctx: c.executionCtx });
    return c.json({ ok: true, started: r.started, tableId: r.started ? r.tableId : null });
  })
  /** The host cancels their private tournament before its start: as an operator's cancel (cancelTournament), without a reason. */
  .post('/:id/cancel', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    const t = await hostOf(c, id);
    await rateLimit(c, `tournament-host:${me}`, 10, 60_000);
    const r = await cancelTournament(c.env, { id, name: t.name }, { actorId: me, reason: null, hostId: me, ctx: c.executionCtx });
    if (!r) fail(409, 'tournament_state', 'only a tournament not started yet is cancelled', { status: (await statusOf(c, id)) ?? t.status });
    return c.json({ ok: true });
  })
  /** A new join code for the host's private tournament (registration open): the old one stops working. Answered here only. */
  .post('/:id/code', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    await hostOf(c, id);
    await rateLimit(c, `tournament-host:${me}`, 10, 60_000);
    for (let attempt = 0; ; attempt++) {
      const code = newJoinCode();
      let r: D1Result;
      try {
        r = await c.env.DB.prepare(`UPDATE tournaments SET join_code_hash = ?3, updated_at = ?4 WHERE id = ?1 AND host_id = ?2 AND is_private = 1 AND status = 'registering'`)
          .bind(id, me, await joinCodeHash(code), Date.now())
          .run();
      } catch (err) {
        if (attempt < 2 && String(err).includes('join_code_hash')) continue;
        throw err;
      }
      if (!r.meta.changes) fail(409, 'tournament_not_open', 'registration is not open', { status: await statusOf(c, id) });
      return c.json({ ok: true, code });
    }
  })
  /** The viewer declines a private tournament's invite: the item goes, and with it the tournament (unless they have an entry in it). */
  .post('/:id/decline', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    const r = await c.env.DB.prepare(`DELETE FROM notifications WHERE user_id = ?1 AND key = ?2`).bind(me, privateInviteKey(id)).run();
    if (r.meta.changes) realtimeToUsers(c, [me], { scope: 'user', type: 'notification.changed' });
    return c.json({ ok: true });
  })
  /**
   * Asks a friend to register (docs/TOURNAMENT.md "친구 초대"): an item in their notification inbox, one per friend who
   * invites (their newest tournament), as a table invite is. It grants nothing: registering checks everything as for
   * anyone. One statement holds every condition (registration open with a seat left, friends with neither blocking the
   * other, the friend an active member not in it yet), and the event that tells their pages is in the same batch.
   * A private tournament's invite is its host's only, one item a tournament (privateInviteKey), and it is what lets the
   * friend see and register for it.
   */
  .post('/:id/invite', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    const { userId: other } = await parseBody(c, TournamentInviteSchema);
    if (other === me) fail(400, 'invite_self', 'you cannot invite yourself');
    await rateLimit(c, `tournament-invite:${me}`, 20, 10 * 60_000);
    const db = c.env.DB;
    const t = await db
      .prepare(`SELECT t.name, t.is_private AS isPrivate, t.host_id AS hostId, ${visibleSql('t', '?2')} AS visible FROM tournaments t WHERE t.id = ?1`)
      .bind(id, me)
      .first<{ name: string; isPrivate: number; hostId: string | null; visible: number }>();
    if (!t || !t.visible) fail(404, 'tournament_not_found', 'tournament not found');
    const priv = t.isPrivate === 1;
    if (priv && t.hostId !== me) fail(403, 'tournament_invite_host_only', 'only the host invites to a private tournament');
    const now = Date.now();
    const [a, b] = pairOf(me, other);
    const told = outboxToUsers([other], { scope: 'user', type: 'notification.changed' }, now);
    const [r] = await db.batch([
      // ?8 is the friend (the item's member); the guard's values follow.
      inboxStatement(db, other, { kind: 'tournament_invite', key: priv ? privateInviteKey(id) : `tournament_invite:${me}`, actorId: me, ref: id, params: { name: t.name }, now }, {
        sql: `EXISTS (SELECT 1 FROM tournaments t WHERE t.id = ?9 AND t.status = 'registering'
                AND (SELECT COUNT(*) FROM tournament_entries x WHERE x.tournament_id = ?9 AND x.status = 'registered') < t.capacity)
              AND EXISTS (SELECT 1 FROM friendships WHERE user_a = ?10 AND user_b = ?11 AND status = 'accepted') AND ${notBlocked('?12', '?8')}
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?8 AND u.status = 'active' AND u.is_bot = 0)
              AND NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = ?9 AND e.user_id = ?8 AND e.status IN ('registered', 'playing'))`,
        params: [id, a, b, me],
      }),
      realtimeOutboxStatement(db, told, IF_CHANGED),
    ]);
    if (!r?.meta.changes) {
      const why = await db
        .prepare(
          `SELECT t.status, (SELECT COUNT(*) FROM tournament_entries x WHERE x.tournament_id = t.id AND x.status = 'registered') >= t.capacity AS full,
                  EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.user_id = ?2 AND e.status IN ('registered', 'playing')) AS joined
             FROM tournaments t WHERE t.id = ?1`,
        )
        .bind(id, other)
        .first<{ status: string; full: number; joined: number }>();
      if (why?.status !== 'registering') fail(409, 'tournament_not_open', 'registration is not open', { status: why?.status });
      if (why.joined) fail(409, 'tournament_invite_joined', 'this friend is already registered');
      if (why.full) fail(409, 'tournament_full', 'every seat is taken');
      // Not friends, a block either way, or a member who cannot play: the same answer, as for a 1:1 message.
      fail(403, 'not_friends', 'you can only invite friends');
    }
    realtimeOutboxSend(c, [told]);
    return c.json({ ok: true }, 201);
  });
