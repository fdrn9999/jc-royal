/**
 * Time bank administration (packages/types/src/timebank.ts, game-worker room.ts "time bank"). Mounted inside the admin
 * router: an admin session, the admin origin and the permission table's rule are already applied.
 *
 * - The policy (on at official tables, also in member rooms, the first grant, the most a member holds, what one use adds,
 *   the refill) is a super admin's, with the password, a reason and a preview of the old and new values. A change is a
 *   new version row; two administrators editing from the same version: the second is told it changed (409) and shown the
 *   current one.
 * - The boundary: a table takes a new version from its next hand. The hand being played, and the deadline of the turn
 *   being played, keep the rules they were dealt with; a bank over a lowered maximum is cut to it when the member is
 *   next dealt in. Tables with players are told to reload; one that did not answer takes it with its next hand record.
 * - No one sets a member's time: there is no route that edits a bank. A turn whose timer failed is recovered by the
 *   room's own rules (POST /tables/:id/timer-recover), audited with the table, the hand and what the room did.
 */
import { statsDay, statsIncrements, STATS_DAY, TIME_BANK_METRICS } from '@jc/db';
import { TIME_BANK_LIMITS, TIME_BANK_MIN_USE_MS, timeBankProblem, type TimeBankSettings } from '@jc/types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { roomCall } from '../lib/room';

const ReasonSchema = z.string().trim().min(2).max(200);
const L = TIME_BANK_LIMITS;
const PolicyFields = {
  /** The version the administrator was looking at: a newer one meanwhile is a conflict. */
  baseVersion: z.number().int().min(0),
  enabled: z.boolean(),
  memberRooms: z.boolean(),
  initialMs: z.number().int().min(L.initialMs.min).max(L.initialMs.max),
  maxMs: z.number().int().min(L.maxMs.min).max(L.maxMs.max),
  unitMs: z.number().int().min(L.unitMs.min).max(L.unitMs.max),
  refillHands: z.number().int().min(L.refillHands.min).max(L.refillHands.max),
  refillMs: z.number().int().min(L.refillMs.min).max(L.refillMs.max),
};
const PolicySchema = z.object({ ...PolicyFields, reason: ReasonSchema });
const PolicyPreviewSchema = z.object({ ...PolicyFields, reason: ReasonSchema.optional() });
const RecoverSchema = z.object({ reason: ReasonSchema });

/** Where a new version takes effect (shown to the administrator with every preview and change). */
export const TIME_BANK_APPLIES_FROM = 'next_hand';
/** Most tables one change asks to reload; the rest take it with their next hand record. */
const RELOAD_MAX = 100;

export interface TimeBankPolicyRow extends TimeBankSettings {
  version: number;
  change: string;
  actorId: string | null;
  actorNickname: string | null;
  reason: string | null;
  createdAt: number;
}

const POLICY_COLUMNS = `p.version, p.enabled, p.member_rooms AS memberRooms, p.initial_ms AS initialMs, p.max_ms AS maxMs, p.unit_ms AS unitMs,
  p.refill_hands AS refillHands, p.refill_ms AS refillMs, p.change, p.actor_id AS actorId, p.reason, p.created_at AS createdAt, u.nickname AS actorNickname`;
const policyOf = (r: Record<string, unknown>): TimeBankPolicyRow => ({
  version: Number(r.version),
  enabled: Number(r.enabled) === 1,
  memberRooms: Number(r.memberRooms) === 1,
  initialMs: Number(r.initialMs),
  maxMs: Number(r.maxMs),
  unitMs: Number(r.unitMs),
  refillHands: Number(r.refillHands),
  refillMs: Number(r.refillMs),
  change: String(r.change),
  actorId: (r.actorId as string | null) ?? null,
  actorNickname: (r.actorNickname as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  createdAt: Number(r.createdAt),
});
const SETTINGS = ['enabled', 'memberRooms', 'initialMs', 'maxMs', 'unitMs', 'refillHands', 'refillMs'] as const;
const settingsOf = (p: TimeBankSettings): TimeBankSettings => Object.fromEntries(SETTINGS.map((k) => [k, p[k]])) as unknown as TimeBankSettings;
const brief = (p: TimeBankPolicyRow | null) => (p ? { version: p.version, ...settingsOf(p) } : null);

async function currentPolicy(db: D1Database): Promise<TimeBankPolicyRow | null> {
  const r = await db.prepare(`SELECT ${POLICY_COLUMNS} FROM time_bank_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 1`).first<Record<string, unknown>>();
  return r ? policyOf(r) : null;
}

function conflict(current: TimeBankPolicyRow | null): never {
  fail(409, 'time_bank_policy_conflict', 'the time bank policy changed meanwhile', { policy: brief(current) });
}

/** Whether member rooms are touched by either version (else only official tables are). */
const touchesMemberRooms = (...ps: (TimeBankSettings | null)[]) => ps.some((p) => !!p?.enabled && p.memberRooms);

/** Open tables a version change is for, through tables_status_idx: official ones, and member rooms when either version has them. */
const tablesWhere = (members: boolean) => `status = 'open'${members ? '' : ` AND room_type = 'official'`}`;

/**
 * Tells the open tables with players (those that deal) to read the policy again, most players first, at most RELOAD_MAX.
 * A table not asked or not answering takes the new version with its next hand record, before the hand after it.
 */
async function reloadTables(c: Context<AppEnv>, members: boolean) {
  const { results } = await c.env.DB.prepare(`SELECT id FROM tables WHERE ${tablesWhere(members)} AND live_seated > 0 ORDER BY live_seated DESC LIMIT ?1`)
    .bind(RELOAD_MAX + 1)
    .all<{ id: string }>();
  const asked = results.slice(0, RELOAD_MAX);
  const answers = await Promise.all(asked.map(async ({ id }) => (await roomCall(c, id, 'reload')) ?? (await roomCall(c, id, 'reload'))));
  const unreached = asked.filter((_, i) => !answers[i]).map((t) => t.id);
  return { tables: asked.length, reached: asked.length - unreached.length, unreached, more: results.length > RELOAD_MAX };
}

/** Writes the next version from `from` (still the latest), or reports the conflict. */
async function writeVersion(c: Context<AppEnv>, from: TimeBankPolicyRow | null, next: TimeBankSettings, reason: string) {
  const r = await c.env.DB.prepare(
    `INSERT INTO time_bank_policies (version, enabled, member_rooms, initial_ms, max_ms, unit_ms, refill_hands, refill_ms, change, actor_id, reason, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'policy', ?9, ?10, ?11
      WHERE COALESCE((SELECT MAX(version) FROM time_bank_policies), 0) = ?12
     ON CONFLICT (version) DO NOTHING`,
  )
    .bind(
      (from?.version ?? 0) + 1,
      next.enabled ? 1 : 0,
      next.memberRooms ? 1 : 0,
      next.initialMs,
      next.maxMs,
      next.unitMs,
      next.refillHands,
      next.refillMs,
      c.var.user!.id,
      reason,
      Date.now(),
      from?.version ?? 0,
    )
    .run();
  if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
  return { version: (from?.version ?? 0) + 1, ...next };
}

export const adminTimeBankRoutes = new Hono<AppEnv>()
  /**
   * The policy and its latest versions, the limits, the open tables it applies to (and those playing a hand, which keep
   * their rules until it ends), and the period's use (`days` 1 to 30) from the daily counters.
   */
  .get('/time-bank', async (c) => {
    const days = Math.trunc(Number(c.req.query('days') ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 30) fail(400, 'invalid_input', 'days must be 1 to 30');
    const now = Date.now();
    const first = statsDay(now) - days + 1;
    const db = c.env.DB;
    const [versions, tables, usage] = await db.batch([
      db.prepare(`SELECT ${POLICY_COLUMNS} FROM time_bank_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 20`),
      db.prepare(`SELECT room_type AS roomType, COUNT(*) AS n, COALESCE(SUM(live_playing), 0) AS playing FROM tables WHERE status = 'open' GROUP BY room_type`),
      db.prepare(`SELECT day, metric, n FROM daily_stats WHERE day >= ?1 AND metric GLOB 'tb_*'`).bind(first),
    ]);
    const list = ((versions?.results ?? []) as Record<string, unknown>[]).map(policyOf);
    const byType = new Map(((tables?.results ?? []) as { roomType: string; n: number; playing: number }[]).map((r) => [r.roomType, r]));
    const totals = Object.fromEntries(TIME_BANK_METRICS.map((m) => [m, 0])) as Record<(typeof TIME_BANK_METRICS)[number], number>;
    const series = new Map<number, Record<string, number>>();
    for (const r of (usage?.results ?? []) as { day: number; metric: string; n: number }[]) {
      if (!(r.metric in totals)) continue;
      totals[r.metric as keyof typeof totals] += Number(r.n);
      series.set(r.day, { ...(series.get(r.day) ?? {}), [r.metric]: Number(r.n) });
    }
    return c.json({
      now,
      days,
      policy: list[0] ?? null,
      versions: list,
      limits: TIME_BANK_LIMITS,
      minUseMs: TIME_BANK_MIN_USE_MS,
      appliesFrom: TIME_BANK_APPLIES_FROM,
      tables: {
        official: Number(byType.get('official')?.n ?? 0),
        member: Number(byType.get('member')?.n ?? 0),
        playing: Number(byType.get('official')?.playing ?? 0) + Number(byType.get('member')?.playing ?? 0),
      },
      usage: totals,
      series: Array.from({ length: days }, (_, i) => ({ date: new Date((first + i) * STATS_DAY).toISOString().slice(0, 10), ...(series.get(first + i) ?? {}) })),
    });
  })
  /**
   * A new policy version. `preview`: the old and new values, where they apply (each table's next hand) and how many open
   * tables are playing a hand now (it keeps its rules, its running turn its deadline).
   */
  .put('/time-bank/policy', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PolicyPreviewSchema : PolicySchema);
    const next = settingsOf(body);
    const problem = timeBankProblem(next);
    if (problem) fail(400, 'time_bank_invalid', 'the times do not hold together', { problem });
    const current = await currentPolicy(c.env.DB);
    if ((current?.version ?? 0) !== body.baseVersion) conflict(current);
    if (current && SETTINGS.every((k) => current[k] === next[k])) fail(400, 'time_bank_no_change', 'the policy is the same as now');
    const members = touchesMemberRooms(current, next);
    if (preview) {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(live_playing), 0) AS playing FROM tables WHERE ${tablesWhere(members)}`).first<{ n: number; playing: number }>();
      return c.json({
        preview: true,
        from: brief(current),
        to: { version: body.baseVersion + 1, ...next },
        appliesFrom: TIME_BANK_APPLIES_FROM,
        tables: Number(r?.n ?? 0),
        playing: Number(r?.playing ?? 0),
        // Banks over the new maximum are cut to it when their member is next dealt in; nothing else is changed in a bank.
        cutToMax: !!current && next.maxMs < current.maxMs,
      });
    }
    const to = await writeVersion(c, current, next, body.reason!);
    const rooms = await reloadTables(c, members);
    await audit(c, 'timebank.policy', undefined, {
      from: brief(current),
      to,
      reason: body.reason,
      appliesFrom: TIME_BANK_APPLIES_FROM,
      rooms: { tables: rooms.tables, reached: rooms.reached, more: rooms.more },
    });
    return c.json({ ok: true, policy: to, appliesFrom: TIME_BANK_APPLIES_FROM, rooms });
  })
  /**
   * Timer recovery for one table, by the room's rules (the table diagnosis shows `timer_unarmed` or `turn_overdue`): a
   * turn past its deadline is decided now as its alarm would have (a bot moves, a member's turn times out), anything else
   * has its alarm set again. Nobody's time, stack or cards are set here. Audited with the hand, the deadline, how late it
   * was and what the room did; a room that does not answer is audited too and reported (503), and asking again is safe.
   */
  .post('/tables/:id/timer-recover', async (c) => {
    const id = c.req.param('id');
    const { reason } = await parseBody(c, RecoverSchema);
    const t = await c.env.DB.prepare(`SELECT status FROM tables WHERE id = ?1`).bind(id).first<{ status: string }>();
    if (!t || t.status === 'closed') fail(404, 'not_found', 'table not found');
    const live = (await roomCall(c, id, 'timer-recover')) ?? (await roomCall(c, id, 'timer-recover'));
    const result = live
      ? {
          result: live.result,
          handId: live.handId ?? null,
          deadline: live.deadline ?? null,
          lateMs: live.lateMs ?? 0,
          alarmBefore: live.alarmBefore ?? null,
          alarmAfter: live.alarmAfter ?? null,
        }
      : null;
    if (live) await c.env.DB.batch(statsIncrements(c.env.DB, statsDay(Date.now()), { tb_recover: 1 }));
    await audit(c, 'table.timer_recover', { type: 'table', id }, { reason, roomConfirmed: !!live, ...(result ?? {}) });
    if (!live) fail(503, 'room_unavailable', 'the table did not answer; try again');
    return c.json({ ok: true, ...result });
  });
