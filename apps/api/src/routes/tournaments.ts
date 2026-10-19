/**
 * Members' Sit & Go tournaments (docs/TOURNAMENT.md "등록"): the list, one tournament with its players and whether the
 * viewer may register, registering and unregistering. Free entry and no prize: nothing here touches chips.
 *
 * Registering is one statement with every condition in its WHERE (registration open, a seat left, the member eligible
 * and in no other tournament), so many members taking the last seat at once never go over the capacity, and pressing
 * again is the same one row. The registration that takes the last seat of a tournament that starts by itself starts it
 * (lib/tournament.ts startTournament, which an operator's start shares).
 */
import type { EntryStatus, TournamentDetailDto, TournamentEntryView } from '@jc/types';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { refuseNewGamesInMaintenance } from '../lib/service';
import {
  ACTIVE_TOURNAMENT,
  ELSEWHERE_SQL,
  eligibility,
  HANDS_SQL,
  parseLevels,
  startTournament,
  SUMMARY_COLUMNS,
  SUMMARY_FROM,
  summaryOf,
  TB_COLUMNS,
  timeBankOf,
  TOURNAMENT_ID,
  type StartResult,
} from '../lib/tournament';

const ENDED = `('finished', 'cancelled', 'aborted')`;
/** Who a tournament shows: the registered before it starts (and when cancelled), those who played after. */
const PLAYED = `('playing', 'eliminated', 'won', 'stopped')`;

const page = (c: Context<AppEnv>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 50),
  offset: Math.min(Math.max(Number(c.req.query('offset') ?? 0) || 0, 0), 1_000),
});

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
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE tn.status IN ${ended ? ENDED : ACTIVE_TOURNAMENT} ORDER BY tn.created_at DESC, tn.id DESC LIMIT ?2 OFFSET ?3`)
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
  /** One tournament: its structure, clock, players (nickname, status, place, tournament chips) and the viewer's eligibility. */
  .get('/:id', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    const db = c.env.DB;
    const r = await db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, tn.level_ends_at AS levelEndsAt, tn.level_left_ms AS levelLeftMs, tn.pause_requested AS pauseRequested, ${TB_COLUMNS('tn')}
           FROM ${SUMMARY_FROM} WHERE tn.id = ?2`,
      )
      .bind(me, id)
      .first<Record<string, unknown>>();
    if (!r) fail(404, 'tournament_not_found', 'tournament not found');
    const s = summaryOf(r);
    const played = s.status === 'running' || s.status === 'finished' || s.status === 'aborted';
    const { results } = await db
      .prepare(
        `SELECT e.user_id AS userId, u.nickname, e.status, e.place, e.stack FROM tournament_entries e JOIN users u ON u.id = e.user_id
          WHERE e.tournament_id = ?1 AND e.status IN ${played ? PLAYED : `('registered')`}
          ORDER BY CASE e.status WHEN 'won' THEN 0 WHEN 'playing' THEN 1 WHEN 'stopped' THEN 2 ELSE 3 END, e.place, e.stack DESC, e.registered_at
          LIMIT 12`,
      )
      .bind(id)
      .all<{ userId: string; nickname: string; status: EntryStatus; place: number | null; stack: number | null }>();
    const entries: TournamentEntryView[] = results.map((e) => ({
      nickname: e.nickname,
      status: e.status,
      place: e.place,
      stack: played ? e.stack : null,
      ...(e.userId === me ? { me: true } : {}),
    }));
    const holding = s.me?.status === 'registered' || s.me?.status === 'playing';
    const dto: TournamentDetailDto = {
      ...s,
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
  .post('/:id/register', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    await rateLimit(c, `tournament-register:${me}`, 20, 60_000);
    await refuseNewGamesInMaintenance(c);
    const db = c.env.DB;
    const t = await db
      .prepare(`SELECT status, capacity, min_hands AS minHands, require_verified AS requireVerified, auto_start AS autoStart FROM tournaments WHERE id = ?1`)
      .bind(id)
      .first<RegisterRow>();
    if (!t) fail(404, 'tournament_not_found', 'tournament not found');
    const now = Date.now();
    const [ins] = await db.batch([
      // min_hands is fixed when the tournament is opened, so it is bound (as the LIMIT of the hands count).
      db
        .prepare(
          `INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at, updated_at)
           SELECT ?1, ?2, 'registered', ?3, ?3
            WHERE EXISTS (SELECT 1 FROM tournaments t WHERE t.id = ?1 AND t.status = 'registering'
                    AND (SELECT COUNT(*) FROM tournament_entries x WHERE x.tournament_id = ?1 AND x.status = 'registered') < t.capacity
                    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.status = 'active' AND u.is_bot = 0
                          AND (t.require_verified = 0 OR u.email_verified_at IS NOT NULL)
                          AND (?4 = 0 OR ${HANDS_SQL('?2', '?4')} >= ?4)))
              AND NOT ${ELSEWHERE_SQL('?2')}
           ON CONFLICT (tournament_id, user_id) DO UPDATE SET status = 'registered', registered_at = excluded.registered_at, updated_at = excluded.updated_at
            WHERE tournament_entries.status IN ('unregistered', 'dropped')`,
        )
        .bind(id, me, now, t.minHands),
      db
        .prepare(
          `UPDATE tournaments SET roster = roster + 1, updated_at = ?3
            WHERE id = ?1 AND EXISTS (SELECT 1 FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'registered' AND registered_at = ?3)`,
        )
        .bind(id, me, now),
    ]);
    if (!ins?.meta.changes) {
      const [mine, cur] = await db.batch<{ status: string }>([
        db.prepare(`SELECT status FROM tournament_entries WHERE tournament_id = ?1 AND user_id = ?2`).bind(id, me),
        db.prepare(`SELECT status FROM tournaments WHERE id = ?1`).bind(id),
      ]);
      const entry = mine?.results[0]?.status;
      if (entry === 'registered' || entry === 'playing') return c.json({ ok: true, already: true, started: false, tableId: null });
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
    return c.json({ ok: true, already: false, started: !!start?.started, tableId: start?.started ? start.tableId : null });
  })
  /** Gives up the viewer's seat before the start. Not registered: ok. After the start nobody leaves a tournament. */
  .post('/:id/unregister', async (c) => {
    const id = tournamentId(c);
    const me = c.var.user!.id;
    await rateLimit(c, `tournament-register:${me}`, 20, 60_000);
    const db = c.env.DB;
    const now = Date.now();
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
    }
    return c.json({ ok: true });
  });
