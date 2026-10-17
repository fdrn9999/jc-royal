/**
 * Tournament administration (docs/TOURNAMENT.md "권한", "운영 중단과 취소", "복구 필요 표시"). Mounted inside the admin
 * router: an admin session, the admin origin and the permission table's rule are already applied (feature
 * `tournaments`; templates are the super admin's `tournament.structure`).
 *
 * - Templates hold a structure (capacity, stack, blinds, turn time, time bank, registration conditions); a tournament is
 *   opened from the template's version the administrator saw in the summary and keeps a copy, so a later template
 *   change never reaches it.
 * - Every change names the version it was decided from: a tournament (or template) that changed meanwhile is a conflict
 *   (409) with what it is now. Each status change is one conditional statement, so a second request — from another
 *   administrator, a member's registration taking the last seat or the room finishing it — finds it already done.
 * - Nothing here sets a stack, a card, a winner or a place: after the start the room alone decides them. An operator
 *   pauses (from the next hand), resumes, stops a running tournament (aborted, not finished: places already decided
 *   stay, nobody wins) or asks the room to read D1 again.
 * - Members are told of a start, a cancel and an abort by a system message in their language, one per tournament,
 *   member and kind (sent again: still one).
 */
import {
  tournamentRecovery,
  tournamentStructureProblem,
  TournamentStructureSchema,
  TOURNAMENT_RECOVERY_MS,
  TOURNAMENT_STATUSES,
  type AdminTournamentRow,
  type TournamentStatus,
  type TournamentStructure,
  type TournamentTemplateDto,
} from '@jc/types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit, searchAudit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { roomCall } from '../lib/room';
import {
  newTournamentId,
  parseLevels,
  reloadRoom,
  startTournament,
  TB_COLUMNS,
  timeBankOf,
  TOURNAMENT_ID,
  tournamentNotice,
} from '../lib/tournament';

const ReasonSchema = z.string().trim().min(2).max(200);
const BaseVersion = z.number().int().min(1);
const TemplateId = z.string().regex(/^[a-z0-9-]{3,40}$/);

/** Open tournaments (registering or closed) at once: more is a mistake, not a schedule. */
export const TOURNAMENT_OPEN_MAX = 20;
/** Ended tournaments are looked at for a table left open this far back. */
const TABLE_OPEN_SCAN_MS = 30 * 86_400_000;

const page = (c: Context<AppEnv>, fallback = 30) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? fallback) || fallback, 1), 100),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

function tournamentId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? '';
  if (!TOURNAMENT_ID.test(id)) fail(404, 'tournament_not_found', 'tournament not found');
  return id;
}

// ---------------------------------------------------------------- tournaments: reading

const ROW_COLUMNS = `tn.id, tn.name, tn.status, tn.template_id AS templateId, tn.capacity, tn.min_players AS minPlayers, tn.start_stack AS startStack,
  tn.auto_start AS autoStart, tn.levels, tn.level, tn.level_ends_at AS levelEndsAt, tn.level_left_ms AS levelLeftMs, tn.pause_requested AS pauseRequested,
  tn.pause_changed_at AS pauseChangedAt, tn.paused_at AS pausedAt, tn.players_left AS playersLeft, tn.hands, tn.room_seen_at AS roomSeenAt,
  tn.table_id AS tableId, tt.status AS tableStatus, tn.created_at AS createdAt, tn.started_at AS startedAt,
  COALESCE(tn.finished_at, tn.aborted_at, tn.cancelled_at) AS endedAt, tn.end_reason AS endReason, w.nickname AS winner, tn.version, tn.roster,
  tn.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = tn.id AND e.status NOT IN ('unregistered', 'dropped')) AS registered`;
const ROW_FROM = `tournaments tn LEFT JOIN users w ON w.id = tn.winner_id LEFT JOIN tables tt ON tt.id = tn.table_id`;

/** The SQL form of tournamentRecovery (packages/types), for the "needs recovery" filter: 8 bound times, see recoveryBinds. */
const RECOVERY_SQL = `(
  (tn.status = 'running' AND tn.pause_requested = 0
    AND ((tn.room_seen_at IS NULL AND tn.started_at < ?) OR (tn.room_seen_at IS NOT NULL AND tn.paused_at IS NULL AND tn.room_seen_at < ?)))
  OR (tn.status = 'running' AND tn.pause_requested = 1 AND tn.pause_changed_at < ? AND tn.paused_at IS NULL)
  OR (tn.status = 'running' AND tn.pause_requested = 0 AND tn.pause_changed_at < ? AND tn.paused_at IS NOT NULL)
  OR (tn.status = 'running' AND tn.pause_requested = 0 AND tn.room_seen_at IS NOT NULL AND tn.paused_at < ?)
  OR (tn.status IN ('finished', 'aborted') AND tn.created_at > ? AND COALESCE(tn.finished_at, tn.aborted_at) < ? AND tt.status IS NOT NULL AND tt.status != 'closed')
  OR (tn.status = 'registering' AND tn.auto_start = 1 AND tn.updated_at < ?
    AND (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = tn.id AND e.status = 'registered') >= tn.capacity)
)`;
const recoveryBinds = (now: number) => {
  const R = TOURNAMENT_RECOVERY_MS;
  return [now - R.firstWrite, now - R.silent, now - R.pauseStuck, now - R.resumeStuck, now - R.stalled, now - TABLE_OPEN_SCAN_MS, now - R.tableOpen, now - R.startStuck];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function rowOf(r: Record<string, unknown>, now: number): AdminTournamentRow {
  const levels = parseLevels(r.levels);
  const level = Math.max(0, Math.min(Number(r.level ?? 0), levels.length - 1));
  const status = r.status as TournamentStatus;
  const row = {
    id: String(r.id),
    name: String(r.name),
    status,
    templateId: (r.templateId as string | null) ?? null,
    capacity: Number(r.capacity),
    minPlayers: Number(r.minPlayers),
    registered: Number(r.registered),
    startStack: Number(r.startStack),
    autoStart: Number(r.autoStart) === 1,
    levelCount: levels.length,
    level,
    smallBlind: levels[level]?.sb ?? 0,
    bigBlind: levels[level]?.bb ?? 0,
    levelEndsAt: num(r.levelEndsAt),
    levelLeftMs: num(r.levelLeftMs),
    pauseRequested: Number(r.pauseRequested) === 1,
    clockStoppedAt: num(r.pausedAt),
    playersLeft: num(r.playersLeft),
    hands: Number(r.hands ?? 0),
    roomSeenAt: num(r.roomSeenAt),
    tableId: (r.tableId as string | null) ?? null,
    tableStatus: (r.tableStatus as string | null) ?? null,
    createdAt: Number(r.createdAt),
    startedAt: num(r.startedAt),
    endedAt: num(r.endedAt),
    endReason: (r.endReason as AdminTournamentRow['endReason']) ?? null,
    winner: (r.winner as string | null) ?? null,
    version: Number(r.version),
    roster: Number(r.roster),
  };
  const recovery = tournamentRecovery(
    {
      status,
      pauseRequested: row.pauseRequested,
      pauseChangedAt: num(r.pauseChangedAt),
      pausedAt: row.clockStoppedAt,
      roomSeenAt: row.roomSeenAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      tableStatus: row.tableStatus,
      autoStart: row.autoStart,
      registered: row.registered,
      capacity: row.capacity,
      updatedAt: Number(r.updatedAt),
    },
    now,
  );
  return { ...row, recovery };
}

async function loadRow(db: D1Database, id: string, now = Date.now()) {
  const r = await db.prepare(`SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} WHERE tn.id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? rowOf(r, now) : null;
}

/** What a refused change says: the tournament as it is now. */
const brief = (t: AdminTournamentRow | null) => (t ? { id: t.id, status: t.status, version: t.version, pauseRequested: t.pauseRequested } : null);

/**
 * A conditional change that changed nothing: why. Missing: 404. A different version: 409 tournament_conflict (the
 * console reloads it). The same version in another status: 409 tournament_state.
 */
async function refused(db: D1Database, id: string, baseVersion: number): Promise<never> {
  const t = await loadRow(db, id);
  if (!t) fail(404, 'tournament_not_found', 'tournament not found');
  if (t.version !== baseVersion) fail(409, 'tournament_conflict', 'the tournament changed meanwhile', { tournament: brief(t) });
  fail(409, 'tournament_state', 'the tournament is not in a state that allows this', { tournament: brief(t) });
}

// ---------------------------------------------------------------- templates

const TEMPLATE_COLUMNS = `t.id, t.name, t.capacity, t.min_players AS minPlayers, t.start_stack AS startStack, t.levels, t.level_ms AS levelMs,
  t.turn_seconds AS turnSeconds, ${TB_COLUMNS('t')}, t.min_hands AS minHands, t.require_verified AS requireVerified, t.auto_start AS autoStart,
  t.status, t.version, t.created_at AS createdAt, t.updated_at AS updatedAt, u.nickname AS updatedBy`;

function templateOf(r: Record<string, unknown>): TournamentTemplateDto {
  return {
    id: String(r.id),
    name: String(r.name),
    capacity: Number(r.capacity),
    minPlayers: Number(r.minPlayers),
    startStack: Number(r.startStack),
    levels: parseLevels(r.levels),
    levelMinutes: Math.round(Number(r.levelMs) / 60_000),
    turnSeconds: Number(r.turnSeconds),
    timeBank: timeBankOf(r),
    minHands: Number(r.minHands),
    requireVerified: Number(r.requireVerified) === 1,
    autoStart: Number(r.autoStart) === 1,
    status: r.status === 'archived' ? 'archived' : 'active',
    version: Number(r.version),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    updatedBy: (r.updatedBy as string | null) ?? null,
  };
}

const STRUCTURE_KEYS = ['name', 'capacity', 'minPlayers', 'startStack', 'levels', 'levelMinutes', 'turnSeconds', 'timeBank', 'minHands', 'requireVerified', 'autoStart'] as const;
const structureOf = (s: TournamentStructure): TournamentStructure => Object.fromEntries(STRUCTURE_KEYS.map((k) => [k, s[k]])) as unknown as TournamentStructure;
const sameStructure = (a: TournamentStructure, b: TournamentStructure) => JSON.stringify(structureOf(a)) === JSON.stringify(structureOf(b));

async function loadTemplate(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM tournament_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? templateOf(r) : null;
}

function checkStructure(s: TournamentStructure) {
  const problem = tournamentStructureProblem(s);
  if (problem) fail(400, 'tournament_structure_invalid', 'the structure does not hold together', { problem });
}

/** The values a structure writes, in the order of the template columns from `name` to `auto_start`. */
const structureBinds = (s: TournamentStructure) => [
  s.name.trim(),
  s.capacity,
  s.minPlayers,
  s.startStack,
  JSON.stringify(s.levels.map((l) => ({ sb: l.sb, bb: l.bb }))),
  s.levelMinutes * 60_000,
  s.turnSeconds,
  s.timeBank.enabled ? 1 : 0,
  s.timeBank.initialMs,
  s.timeBank.maxMs,
  s.timeBank.unitMs,
  s.timeBank.refillHands,
  s.timeBank.refillMs,
  s.minHands,
  s.requireVerified ? 1 : 0,
  s.autoStart ? 1 : 0,
];

const TemplateWrite = TournamentStructureSchema.extend({ reason: ReasonSchema });
const TemplatePreview = TournamentStructureSchema.extend({ reason: ReasonSchema.optional() });
const TemplateUpdate = TemplateWrite.extend({ baseVersion: BaseVersion });
const TemplateUpdatePreview = TemplatePreview.extend({ baseVersion: BaseVersion });
const TemplateStatus = z.object({ status: z.enum(['active', 'archived']), baseVersion: BaseVersion, reason: ReasonSchema });

// ---------------------------------------------------------------- bodies

const CreateSchema = z.object({
  templateId: TemplateId,
  /** The template version the summary showed: a template changed meanwhile is a conflict. */
  templateVersion: BaseVersion,
  name: z.string().trim().min(2).max(40).optional(),
  preview: z.boolean().optional(),
});
const VersionSchema = z.object({ baseVersion: BaseVersion, reason: ReasonSchema.optional() });
const RegistrationSchema = z.object({ action: z.enum(['close', 'open']), baseVersion: BaseVersion });
const CancelSchema = z.object({ baseVersion: BaseVersion, reason: ReasonSchema });
const AbortSchema = z.object({ baseVersion: BaseVersion, reason: ReasonSchema, confirmName: z.string().trim().min(1).max(60) });
const RecoverSchema = z.object({ reason: ReasonSchema.optional() });

const ACTIVE = `('registering', 'closed', 'running')`;
const ENDED = `('finished', 'cancelled', 'aborted')`;

export const adminTournamentRoutes = new Hono<AppEnv>()
  /**
   * Tournaments, newest first: `status` (one status, `active` or `ended`), `q` (name or id), `recovery=1` (needs an
   * operator), paged. With the count of each active status and of those needing recovery (index ranges, not the whole
   * history).
   */
  .get('/tournaments', async (c) => {
    const now = Date.now();
    const status = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().slice(0, 60);
    const { limit, offset } = page(c);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (status === 'active') where.push(`tn.status IN ${ACTIVE}`);
    else if (status === 'ended') where.push(`tn.status IN ${ENDED}`);
    else if (status) {
      if (!TOURNAMENT_STATUSES.includes(status as TournamentStatus)) fail(400, 'bad_request', 'unknown status');
      where.push('tn.status = ?');
      binds.push(status);
    }
    if (q) {
      where.push(`(tn.name LIKE ? ESCAPE '\\' OR tn.id = ?)`);
      binds.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, q);
    }
    if (c.req.query('recovery') === '1') {
      where.push(RECOVERY_SQL);
      binds.push(...recoveryBinds(now));
    }
    const db = c.env.DB;
    const filtered = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [list, counts, recovery] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} ${filtered} ORDER BY tn.created_at DESC, tn.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset),
      db.prepare(`SELECT status, COUNT(*) AS n FROM tournaments WHERE status IN ${ACTIVE} GROUP BY status`),
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${ROW_FROM} WHERE (tn.status IN ('registering', 'running') OR (tn.status IN ('finished', 'aborted') AND tn.created_at > ?)) AND ${RECOVERY_SQL}`,
        )
        .bind(now - TABLE_OPEN_SCAN_MS, ...recoveryBinds(now)),
    ]);
    const rows = list?.results ?? [];
    const byStatus = Object.fromEntries(((counts?.results ?? []) as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)]));
    return c.json({
      now,
      tournaments: rows.slice(0, limit).map((r) => rowOf(r, now)),
      hasMore: rows.length > limit,
      counts: { registering: byStatus.registering ?? 0, closed: byStatus.closed ?? 0, running: byStatus.running ?? 0, recovery: Number(recovery?.results[0]?.n ?? 0) },
    });
  })
  /**
   * Opens a tournament from a template: a copy of the template's structure, registering. `preview`: the summary to
   * confirm (the template's version, which the change must name).
   */
  .post('/tournaments', async (c) => {
    const body = await parseBody(c, CreateSchema);
    const db = c.env.DB;
    const tpl = await loadTemplate(db, body.templateId);
    if (!tpl) fail(404, 'tournament_template_not_found', 'template not found');
    if (tpl.status !== 'active') fail(409, 'tournament_template_archived', 'the template is archived');
    if (tpl.version !== body.templateVersion) fail(409, 'tournament_template_conflict', 'the template changed meanwhile', { template: tpl });
    const name = body.name ?? tpl.name;
    const open = await db.prepare(`SELECT COUNT(*) AS n FROM tournaments WHERE status IN ('registering', 'closed')`).first<{ n: number }>();
    if (body.preview) {
      return c.json({ preview: true, template: tpl, summary: { ...structureOf(tpl), name }, open: Number(open?.n ?? 0), openMax: TOURNAMENT_OPEN_MAX });
    }
    const id = newTournamentId();
    const now = Date.now();
    const r = await db
      .prepare(
        `INSERT INTO tournaments (id, template_id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds,
                tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start,
                version, roster, level, hands, pause_requested, created_by, created_at, updated_at)
         SELECT ?1, t.id, ?2, 'registering', t.capacity, t.min_players, t.start_stack, t.levels, t.level_ms, t.turn_seconds,
                t.tb_enabled, t.tb_initial_ms, t.tb_max_ms, t.tb_unit_ms, t.tb_refill_hands, t.tb_refill_ms, t.min_hands, t.require_verified, t.auto_start,
                1, 0, 0, 0, 0, ?3, ?4, ?4
           FROM tournament_templates t
          WHERE t.id = ?5 AND t.status = 'active' AND t.version = ?6
            AND (SELECT COUNT(*) FROM tournaments WHERE status IN ('registering', 'closed')) < ?7`,
      )
      .bind(id, name, c.var.user!.id, now, tpl.id, tpl.version, TOURNAMENT_OPEN_MAX)
      .run();
    if (!r.meta.changes) {
      const again = await loadTemplate(db, body.templateId);
      if (!again || again.status !== 'active' || again.version !== body.templateVersion) fail(409, 'tournament_template_conflict', 'the template changed meanwhile', { template: again });
      fail(409, 'tournament_limit', 'too many tournaments are open', { openMax: TOURNAMENT_OPEN_MAX });
    }
    await audit(c, 'tournament.create', { type: 'tournament', id }, { templateId: tpl.id, templateVersion: tpl.version, name, structure: structureOf(tpl) });
    return c.json({ ok: true, tournament: await loadRow(db, id) });
  })
  /**
   * One tournament: its row, structure, every entry (also unregistered and dropped ones), how it ended, the room as it
   * answers now (connections, seats, issues: read only) and the operator actions on it (the audit log).
   */
  .get('/tournaments/:id', async (c) => {
    const id = tournamentId(c);
    const db = c.env.DB;
    const now = Date.now();
    const [main, entries] = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT ${ROW_COLUMNS}, tn.level_ms AS levelMs, tn.turn_seconds AS turnSeconds, ${TB_COLUMNS('tn')}, tn.min_hands AS minHands,
                  tn.require_verified AS requireVerified, tn.end_note AS endNote, eb.nickname AS endedBy, cb.nickname AS createdBy
             FROM ${ROW_FROM} LEFT JOIN users eb ON eb.id = tn.ended_by LEFT JOIN users cb ON cb.id = tn.created_by
            WHERE tn.id = ?1`,
        )
        .bind(id),
      db
        .prepare(
          `SELECT e.user_id AS userId, u.nickname, e.status, e.seat_index AS seat, e.stack, e.place, e.registered_at AS registeredAt,
                  e.eliminated_at AS eliminatedAt, e.eliminated_hand AS eliminatedHand, e.updated_at AS updatedAt
             FROM tournament_entries e LEFT JOIN users u ON u.id = e.user_id
            WHERE e.tournament_id = ?1
            ORDER BY CASE e.status WHEN 'won' THEN 0 WHEN 'playing' THEN 1 WHEN 'stopped' THEN 2 WHEN 'eliminated' THEN 3 WHEN 'registered' THEN 4 ELSE 5 END,
                     e.place, e.stack DESC, e.registered_at
            LIMIT 100`,
        )
        .bind(id),
    ]);
    const r = main?.results[0];
    if (!r) fail(404, 'tournament_not_found', 'tournament not found');
    const row = rowOf(r, now);
    const live = row.tableId && row.tableStatus && row.tableStatus !== 'closed' ? await roomCall(c, row.tableId, 'status') : null;
    const seats = ((live?.seats as (Record<string, unknown> | null)[] | undefined) ?? []).filter((s): s is Record<string, unknown> => !!s);
    const history = await searchAudit(db, { targetType: 'tournament', targetId: id, limit: 50, count: false });
    return c.json({
      now,
      tournament: {
        ...row,
        levels: parseLevels(r.levels),
        levelMinutes: Math.round(Number(r.levelMs) / 60_000),
        turnSeconds: Number(r.turnSeconds),
        timeBank: timeBankOf(r),
        minHands: Number(r.minHands),
        requireVerified: Number(r.requireVerified) === 1,
        endNote: (r.endNote as string | null) ?? null,
        endedBy: (r.endedBy as string | null) ?? null,
        createdBy: (r.createdBy as string | null) ?? null,
      },
      entries: (entries?.results ?? []).map((e) => ({ ...e, connected: seats.find((s) => s.userId === e.userId)?.connected ?? null })),
      // The room's own view (no cards): whether it answered, its connections and seats, what it reports wrong.
      live: row.tableId
        ? {
            answered: !!live,
            handInProgress: live ? !!live.handInProgress : null,
            handNumber: (live?.handNumber as number | undefined) ?? null,
            connections: (live?.connections as number | undefined) ?? null,
            issues: (live?.issues as string[] | undefined) ?? [],
            tournament: live?.tournament ?? null,
            seats: seats.map((s) => ({
              seatIndex: s.seatIndex,
              userId: s.userId,
              nickname: s.nickname,
              stack: s.stack,
              connected: s.connected,
              sittingOut: s.sittingOut,
              inHand: s.inHand,
              timeouts: s.timeouts,
              timeBank: s.timeBank ?? null,
            })),
            alarmAt: (live?.alarmAt as number | undefined) ?? null,
          }
        : null,
      history: history.items,
    });
  })
  /** Closes registration (nobody new; unregistering still works) or opens it again. */
  .post('/tournaments/:id/registration', async (c) => {
    const id = tournamentId(c);
    const { action, baseVersion } = await parseBody(c, RegistrationSchema);
    const [from, to] = action === 'close' ? (['registering', 'closed'] as const) : (['closed', 'registering'] as const);
    const now = Date.now();
    const r = await c.env.DB.prepare(`UPDATE tournaments SET status = ?2, version = version + 1, updated_at = ?3 WHERE id = ?1 AND status = ?4 AND version = ?5`)
      .bind(id, to, now, from, baseVersion)
      .run();
    if (!r.meta.changes) await refused(c.env.DB, id, baseVersion);
    // Reopened with every seat taken: a tournament that starts by itself starts now (as the last registration would have).
    let start = null;
    const t = await loadRow(c.env.DB, id);
    if (to === 'registering' && t?.autoStart && t.registered >= t.capacity) start = await startTournament(c.env, id, { actorId: c.var.user!.id, auto: true }).catch(() => null);
    await audit(c, 'tournament.registration', { type: 'tournament', id }, { action, from, to, ...(start ? { autoStart: { started: start.started, reason: start.reason ?? null } } : {}) });
    return c.json({ ok: true, tournament: await loadRow(c.env.DB, id) });
  })
  /**
   * Starts it now: every registration's eligibility is read again (those who lost it are dropped), at least the minimum
   * number of players; a second start is refused (lib/tournament.ts startTournament).
   */
  .post('/tournaments/:id/start', async (c) => {
    const id = tournamentId(c);
    const { baseVersion, reason } = await parseBody(c, VersionSchema);
    const res = await startTournament(c.env, id, { actorId: c.var.user!.id, auto: false, baseVersion });
    await audit(c, 'tournament.start', { type: 'tournament', id }, { reason: reason ?? null, players: res.players, tableId: res.tableId, dropped: res.dropped, roomConfirmed: res.roomConfirmed });
    return c.json({ ok: true, ...res, tournament: await loadRow(c.env.DB, id) });
  })
  /** Cancels a tournament before it starts: no result; the registered members are told. */
  .post('/tournaments/:id/cancel', async (c) => {
    const id = tournamentId(c);
    const { baseVersion, reason } = await parseBody(c, CancelSchema);
    const db = c.env.DB;
    const before = await loadRow(db, id);
    if (!before) fail(404, 'tournament_not_found', 'tournament not found');
    const now = Date.now();
    const [r, sent] = await db.batch([
      db
        .prepare(
          `UPDATE tournaments SET status = 'cancelled', cancelled_at = ?2, end_reason = 'cancelled', end_note = ?3, ended_by = ?4, version = version + 1, updated_at = ?2
            WHERE id = ?1 AND status IN ('registering', 'closed') AND version = ?5`,
        )
        .bind(id, now, reason, c.var.user!.id, baseVersion),
      tournamentNotice(db, before, 'cancelled', ['registered'], `tn.status = 'cancelled' AND tn.cancelled_at = ${now}`, now),
    ]);
    if (!r?.meta.changes) await refused(db, id, baseVersion);
    await audit(c, 'tournament.cancel', { type: 'tournament', id }, { reason, from: before.status, registered: before.registered, notified: sent?.meta.changes ?? 0 });
    return c.json({ ok: true, notified: sent?.meta.changes ?? 0, tournament: await loadRow(db, id) });
  })
  /**
   * Pauses a running tournament from the next hand (the hand being played ends as dealt), or resumes it. The level
   * clock stops when the table stops dealing and runs again from where it stopped at the next deal; the time bank is
   * neither used nor refilled while no hand is dealt.
   */
  .post('/tournaments/:id/pause', (c) => pauseOrResume(c, true))
  .post('/tournaments/:id/resume', (c) => pauseOrResume(c, false))
  /**
   * Stops a running tournament (not a finish): the password, a reason and the tournament's name typed again. The hand
   * being played ends, the table closes without moving chips, places already decided stay, those still playing are
   * `stopped`, nobody wins; every player is told.
   */
  .post('/tournaments/:id/abort', async (c) => {
    const id = tournamentId(c);
    const { baseVersion, reason, confirmName } = await parseBody(c, AbortSchema);
    const db = c.env.DB;
    const before = await loadRow(db, id);
    if (!before) fail(404, 'tournament_not_found', 'tournament not found');
    if (confirmName !== before.name.trim()) fail(400, 'tournament_name_mismatch', 'the name typed is not the tournament name');
    const now = Date.now();
    const mine = `EXISTS (SELECT 1 FROM tournaments tn WHERE tn.id = ?1 AND tn.status = 'aborted' AND tn.aborted_at = ?2)`;
    const [r, stopped, , sent] = await db.batch([
      db
        .prepare(
          `UPDATE tournaments SET status = 'aborted', aborted_at = ?2, end_reason = 'aborted', end_note = ?3, ended_by = ?4, version = version + 1, updated_at = ?2
            WHERE id = ?1 AND status = 'running' AND version = ?5`,
        )
        .bind(id, now, reason, c.var.user!.id, baseVersion),
      db.prepare(`UPDATE tournament_entries SET status = 'stopped', updated_at = ?2 WHERE tournament_id = ?1 AND status = 'playing' AND ${mine}`).bind(id, now),
      db
        .prepare(`UPDATE tables SET status = 'closing', entry_blocked = 1, updated_at = ?2 WHERE id = (SELECT table_id FROM tournaments WHERE id = ?1) AND status = 'open' AND ${mine}`)
        .bind(id, now),
      tournamentNotice(db, before, 'aborted', ['stopped', 'eliminated'], `tn.status = 'aborted' AND tn.aborted_at = ${now}`, now),
    ]);
    if (!r?.meta.changes) await refused(db, id, baseVersion);
    const live = await reloadRoom(c.env, before.tableId);
    await audit(c, 'tournament.abort', { type: 'tournament', id }, {
      reason,
      playersLeft: before.playersLeft,
      stopped: stopped?.meta.changes ?? 0,
      notified: sent?.meta.changes ?? 0,
      hands: before.hands,
      level: before.level + 1,
      roomConfirmed: !!live,
    });
    return c.json({ ok: true, roomConfirmed: !!live, notified: sent?.meta.changes ?? 0, tournament: await loadRow(db, id) });
  })
  /**
   * Asks the tournament's room to read D1 again (seats it never made, a pause or an abort it missed, a finished table
   * left open). Nothing about the result is decided here.
   */
  .post('/tournaments/:id/recover', async (c) => {
    const id = tournamentId(c);
    const { reason } = await parseBody(c, RecoverSchema);
    const before = await loadRow(c.env.DB, id);
    if (!before) fail(404, 'tournament_not_found', 'tournament not found');
    if (!before.tableId) fail(409, 'tournament_state', 'the tournament has no table', { tournament: brief(before) });
    const live = await reloadRoom(c.env, before.tableId);
    const after = await loadRow(c.env.DB, id);
    await audit(c, 'tournament.recover', { type: 'tournament', id }, { reason: reason ?? null, codes: before.recovery, roomConfirmed: !!live, after: after?.recovery ?? [] });
    if (!live) fail(503, 'room_unavailable', 'the table did not answer; try again');
    return c.json({ ok: true, tournament: after });
  })
  // ---------------------------------------------------------------- templates (super admin)
  /** Templates (`status` active or archived), most recently changed first. */
  .get('/tournament-templates', async (c) => {
    const status = c.req.query('status');
    const { limit, offset } = page(c, 50);
    const where = status === 'archived' || status === 'active' ? `WHERE t.status = '${status}'` : '';
    const { results } = await c.env.DB.prepare(
      `SELECT ${TEMPLATE_COLUMNS} FROM tournament_templates t LEFT JOIN users u ON u.id = t.updated_by ${where} ORDER BY t.status, t.updated_at DESC, t.id LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit + 1, offset)
      .all<Record<string, unknown>>();
    return c.json({ templates: results.slice(0, limit).map(templateOf), hasMore: results.length > limit });
  })
  /** A new template. `preview`: the structure as it would be saved (checked), nothing written. */
  .post('/tournament-templates', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? TemplatePreview : TemplateWrite);
    const s = structureOf(body);
    checkStructure(s);
    if (preview) return c.json({ preview: true, to: s });
    const id = newTournamentId();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO tournament_templates (id, name, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
              tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, status, version, created_by, updated_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 'active', 1, ?18, ?18, ?19, ?19)`,
    )
      .bind(id, ...structureBinds(s), c.var.user!.id, now)
      .run();
    await audit(c, 'tournament_template.create', { type: 'tournament_template', id }, { reason: body.reason, to: s });
    return c.json({ ok: true, template: await loadTemplate(c.env.DB, id) });
  })
  /**
   * Changes a template from the version the administrator saw. Tournaments already opened keep the structure they
   * copied. `preview`: the old and new structure and how many open tournaments came from it (unchanged by this).
   */
  .put('/tournament-templates/:id', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? TemplateUpdatePreview : TemplateUpdate);
    const s = structureOf(body);
    checkStructure(s);
    const db = c.env.DB;
    const current = await loadTemplate(db, id);
    if (!current) fail(404, 'tournament_template_not_found', 'template not found');
    if (current.version !== body.baseVersion) fail(409, 'tournament_template_conflict', 'the template changed meanwhile', { template: current });
    if (sameStructure(current, s)) fail(400, 'tournament_template_no_change', 'the template is the same as now');
    if (preview) {
      const open = await db.prepare(`SELECT COUNT(*) AS n FROM tournaments WHERE template_id = ?1 AND status IN ${ACTIVE}`).bind(id).first<{ n: number }>();
      return c.json({ preview: true, from: structureOf(current), to: s, version: current.version + 1, openTournaments: Number(open?.n ?? 0) });
    }
    const now = Date.now();
    const r = await db
      .prepare(
        `UPDATE tournament_templates SET name = ?2, capacity = ?3, min_players = ?4, start_stack = ?5, levels = ?6, level_ms = ?7, turn_seconds = ?8,
                tb_enabled = ?9, tb_initial_ms = ?10, tb_max_ms = ?11, tb_unit_ms = ?12, tb_refill_hands = ?13, tb_refill_ms = ?14, min_hands = ?15,
                require_verified = ?16, auto_start = ?17, version = version + 1, updated_by = ?18, updated_at = ?19
          WHERE id = ?1 AND version = ?20`,
      )
      .bind(id, ...structureBinds(s), c.var.user!.id, now, body.baseVersion)
      .run();
    if (!r.meta.changes) fail(409, 'tournament_template_conflict', 'the template changed meanwhile', { template: await loadTemplate(db, id) });
    await audit(c, 'tournament_template.update', { type: 'tournament_template', id }, { reason: body.reason, from: structureOf(current), to: s, version: current.version + 1 });
    return c.json({ ok: true, template: await loadTemplate(db, id) });
  })
  /** Archives a template (no new tournament from it; those opened keep going) or makes it active again. */
  .post('/tournament-templates/:id/status', async (c) => {
    const id = c.req.param('id');
    const { status, baseVersion, reason } = await parseBody(c, TemplateStatus);
    const db = c.env.DB;
    const r = await db
      .prepare(`UPDATE tournament_templates SET status = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE id = ?1 AND version = ?5 AND status != ?2`)
      .bind(id, status, c.var.user!.id, Date.now(), baseVersion)
      .run();
    if (!r.meta.changes) {
      const current = await loadTemplate(db, id);
      if (!current) fail(404, 'tournament_template_not_found', 'template not found');
      if (current.version !== baseVersion) fail(409, 'tournament_template_conflict', 'the template changed meanwhile', { template: current });
      fail(409, 'tournament_template_state', `the template is already ${status}`, { template: current });
    }
    await audit(c, 'tournament_template.status', { type: 'tournament_template', id }, { reason, to: status });
    return c.json({ ok: true, template: await loadTemplate(db, id) });
  });

/** Pause (from the next hand) or resume: the conditional switch, then the room is told; it applies the next deal. */
async function pauseOrResume(c: Context<AppEnv>, pause: boolean) {
  const id = tournamentId(c);
  const { baseVersion, reason } = await parseBody(c, VersionSchema);
  const db = c.env.DB;
  const now = Date.now();
  const r = await db
    .prepare(
      `UPDATE tournaments SET pause_requested = ?2, pause_changed_at = ?3, version = version + 1, updated_at = ?3
        WHERE id = ?1 AND status = 'running' AND pause_requested = ?4 AND version = ?5`,
    )
    .bind(id, pause ? 1 : 0, now, pause ? 0 : 1, baseVersion)
    .run();
  if (!r.meta.changes) await refused(db, id, baseVersion);
  const t = await loadRow(db, id);
  const live = await reloadRoom(c.env, t?.tableId ?? null);
  // The room says whether a hand is being played (a pause then waits for its end); unanswered: it applies at its next look.
  const appliesFrom = pause ? (live ? (live.handInProgress ? 'next_hand' : 'now') : 'next_hand') : 'now';
  await audit(c, pause ? 'tournament.pause' : 'tournament.resume', { type: 'tournament', id }, { reason: reason ?? null, appliesFrom, roomConfirmed: !!live, level: (t?.level ?? 0) + 1 });
  return c.json({ ok: true, appliesFrom, roomConfirmed: !!live, tournament: t });
}
