/**
 * Free chip refill administration (lib/refill.ts). Mounted inside the admin router: an admin session, the admin origin
 * and the permission table's rule are already applied.
 *
 * - The policy (on/off, the line, the amount, the wait) is changed by a super admin, with the password, a reason and a
 *   preview of the old and new values. A change is a new version row: the next claim is decided by it, a wait already
 *   running keeps the time it was given, and every refill paid names the version it was paid under. Two administrators
 *   editing from the same version: the second is told the policy changed (409) and shown the current one.
 * - Any administrator with the feature can pause new refills in an emergency (password and reason); only a super admin
 *   resumes them. Pausing stops new claims only; nothing paid is touched.
 * - Refills paid are never edited or deleted here: a refill paid in error is taken back with the member's chip
 *   adjustment, which names the refill's ledger row (`refLedgerId`).
 * - Members who claim often are listed for a look; nothing here suspends anyone.
 */
import { dayStart, statsDay, STATS_DAY, STATS_TZ_OFFSET_MS } from '@jc/db';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { currentPolicy, policyRow, publicPolicy, REFILL_FREQUENT, REFILL_LIMITS, refillSnapshot, type RefillPolicyRow } from '../lib/refill';

const ReasonSchema = z.string().trim().min(2).max(200);
const PolicyFields = {
  /** The version the administrator was looking at: a newer one meanwhile is a conflict. */
  baseVersion: z.number().int().min(0),
  enabled: z.boolean(),
  below: z.number().int().min(REFILL_LIMITS.below.min).max(REFILL_LIMITS.below.max),
  amount: z.number().int().min(REFILL_LIMITS.amount.min).max(REFILL_LIMITS.amount.max),
  cooldownMs: z.number().int().min(REFILL_LIMITS.cooldownMs.min).max(REFILL_LIMITS.cooldownMs.max),
};
const PolicySchema = z.object({ ...PolicyFields, reason: ReasonSchema });
const PolicyPreviewSchema = z.object({ ...PolicyFields, reason: ReasonSchema.optional() });
const SwitchSchema = z.object({ reason: ReasonSchema });

/** The longest wait a policy can give: a wait still running started within it. */
const LONGEST_WAIT = REFILL_LIMITS.cooldownMs.max;

const page = (c: Context<AppEnv>, fallback = 50) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? fallback) || fallback, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

const VERSION_COLUMNS = `p.version, p.enabled, p.paused, p.below, p.amount, p.cooldown_ms AS cooldownMs, p.change, p.actor_id AS actorId, p.reason, p.created_at AS createdAt, u.nickname AS actorNickname`;
const versionRow = (r: Record<string, unknown>) => ({ ...policyRow(r)!, actorNickname: (r.actorNickname as string | null) ?? null });

/** Members whose wait is still running (it started within the longest wait, through the time index). */
async function runningWaits(db: D1Database, now: number) {
  const r = await db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM refill_claims WHERE created_at > ?1 AND next_at > ?2`)
    .bind(now - LONGEST_WAIT, now)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

function conflict(current: RefillPolicyRow | null): never {
  fail(409, 'refill_policy_conflict', 'the refill policy changed meanwhile', { policy: current ? publicPolicy(current) : null });
}

/** One new version from the latest one, written only while the latest is still the one decided from. */
async function writeSwitch(c: Context<AppEnv>, to: 'pause' | 'resume', reason: string) {
  const now = Date.now();
  const current = await currentPolicy(c.env.DB);
  if (!current) fail(409, 'refill_no_policy', 'there is no refill policy');
  if (to === 'pause' && current.paused) fail(409, 'refill_already_paused', 'new refills are already paused');
  if (to === 'resume' && !current.paused) fail(409, 'refill_not_paused', 'new refills are not paused');
  const r = await c.env.DB.prepare(
    `INSERT INTO refill_policies (version, enabled, paused, below, amount, cooldown_ms, change, actor_id, reason, created_at)
     SELECT version + 1, enabled, ?1, below, amount, cooldown_ms, ?2, ?3, ?4, ?5 FROM refill_policies
      WHERE version = ?6 AND version = (SELECT MAX(version) FROM refill_policies)
     ON CONFLICT (version) DO NOTHING`,
  )
    .bind(to === 'pause' ? 1 : 0, to, c.var.user!.id, reason, now, current.version)
    .run();
  if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
  await audit(c, `refill.${to}`, undefined, { version: current.version + 1, from: current.version, reason });
  return c.json({ ok: true, policy: publicPolicy({ ...current, version: current.version + 1, paused: to === 'pause' }) });
}

export const adminRefillRoutes = new Hono<AppEnv>()
  /** The current policy, the latest versions (who changed what, and why), the limits a policy must keep to. */
  .get('/refill', async (c) => {
    const now = Date.now();
    const [versions, waits] = await Promise.all([
      c.env.DB.prepare(`SELECT ${VERSION_COLUMNS} FROM refill_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 20`).all<Record<string, unknown>>(),
      runningWaits(c.env.DB, now),
    ]);
    const items = versions.results.map(versionRow);
    return c.json({ policy: items[0] ?? null, versions: items, limits: REFILL_LIMITS, runningWaits: waits, now });
  })
  /**
   * A new policy version. `preview`: the old and new values, from when they apply (the next claim; waits already running
   * keep their time) and how many members are waiting. Pausing is kept as it is (pause and resume are their own routes).
   */
  .put('/refill/policy', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PolicyPreviewSchema : PolicySchema);
    const now = Date.now();
    const current = await currentPolicy(c.env.DB);
    if ((current?.version ?? 0) !== body.baseVersion) conflict(current);
    const next = { enabled: body.enabled, below: body.below, amount: body.amount, cooldownMs: body.cooldownMs };
    if (current && current.enabled === next.enabled && current.below === next.below && current.amount === next.amount && current.cooldownMs === next.cooldownMs) {
      fail(400, 'refill_no_change', 'the policy is the same as now');
    }
    const to = { version: body.baseVersion + 1, paused: current?.paused ?? false, ...next };
    if (preview) {
      return c.json({ preview: true, from: current ? publicPolicy(current) : null, to, appliesFrom: 'next_claim', runningWaits: await runningWaits(c.env.DB, now), now });
    }
    const reason = body.reason!;
    // From the version the administrator saw, and only while it is still the latest (the primary key stops a race).
    const r = current
      ? await c.env.DB.prepare(
          `INSERT INTO refill_policies (version, enabled, paused, below, amount, cooldown_ms, change, actor_id, reason, created_at)
           SELECT version + 1, ?1, paused, ?2, ?3, ?4, 'policy', ?5, ?6, ?7 FROM refill_policies
            WHERE version = ?8 AND version = (SELECT MAX(version) FROM refill_policies)
           ON CONFLICT (version) DO NOTHING`,
        )
          .bind(next.enabled ? 1 : 0, next.below, next.amount, next.cooldownMs, c.var.user!.id, reason, now, current.version)
          .run()
      : await c.env.DB.prepare(
          `INSERT INTO refill_policies (version, enabled, paused, below, amount, cooldown_ms, change, actor_id, reason, created_at)
           SELECT 1, ?1, 0, ?2, ?3, ?4, 'policy', ?5, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM refill_policies)
           ON CONFLICT (version) DO NOTHING`,
        )
          .bind(next.enabled ? 1 : 0, next.below, next.amount, next.cooldownMs, c.var.user!.id, reason, now)
          .run();
    if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
    await audit(c, 'refill.policy', undefined, { from: current ? publicPolicy(current) : null, to, reason });
    return c.json({ ok: true, policy: to });
  })
  /** Emergency stop of new refills (any administrator with the feature). Refills already paid are not touched. */
  .post('/refill/pause', async (c) => writeSwitch(c, 'pause', (await parseBody(c, SwitchSchema)).reason))
  /** New refills again (super admins). */
  .post('/refill/resume', async (c) => writeSwitch(c, 'resume', (await parseBody(c, SwitchSchema)).reason))
  /**
   * The period's refills by day (Korean days, like the operations statistics): how many, how many chips, how many
   * members; claims that paid nothing by reason; policy changes; members who claimed often. `days` 1 to 90.
   */
  .get('/refill/stats', async (c) => {
    const days = Math.trunc(Number(c.req.query('days') ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 90) fail(400, 'invalid_input', 'days must be 1 to 90');
    const now = Date.now();
    const today = statsDay(now);
    const first = today - days + 1;
    const since = dayStart(first);
    const policy = await currentPolicy(c.env.DB);
    const periodMs = now - since;
    const most = policy ? Math.floor(periodMs / policy.cooldownMs) + 1 : 0;
    const frequentAt = Math.max(REFILL_FREQUENT.minClaims, Math.ceil(most * REFILL_FREQUENT.share));
    const db = c.env.DB;
    const [totals, byDay, refused, frequent, changes] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum, COUNT(DISTINCT user_id) AS members FROM refill_claims WHERE created_at >= ?1`).bind(since),
      db
        .prepare(
          `SELECT CAST((created_at + ?2) / ?3 AS INTEGER) AS day, COUNT(*) AS n, SUM(amount) AS sum, COUNT(DISTINCT user_id) AS members
             FROM refill_claims WHERE created_at >= ?1 GROUP BY day`,
        )
        .bind(since, STATS_TZ_OFFSET_MS, STATS_DAY),
      db.prepare(`SELECT day, metric, n FROM daily_stats WHERE day >= ?1 AND metric GLOB 'rf_*'`).bind(first),
      db
        .prepare(
          `SELECT c.user_id AS userId, u.nickname, u.status, COUNT(*) AS n, SUM(c.amount) AS sum, MIN(c.created_at) AS firstAt, MAX(c.created_at) AS lastAt
             FROM refill_claims c LEFT JOIN users u ON u.id = c.user_id
            WHERE c.created_at >= ?1 GROUP BY c.user_id HAVING COUNT(*) >= ?2 ORDER BY n DESC, lastAt DESC LIMIT 50`,
        )
        .bind(since, frequentAt),
      db.prepare(`SELECT ${VERSION_COLUMNS} FROM refill_policies p LEFT JOIN users u ON u.id = p.actor_id WHERE p.created_at >= ?1 ORDER BY p.version DESC LIMIT 50`).bind(since),
    ]);
    const t = (totals!.results[0] ?? {}) as { n?: number; sum?: number; members?: number };
    const perDay = new Map((byDay!.results as { day: number; n: number; sum: number; members: number }[]).map((r) => [r.day, r]));
    const refusedByDay = new Map<number, Record<string, number>>();
    const refusedTotal: Record<string, number> = {};
    for (const r of refused!.results as { day: number; metric: string; n: number }[]) {
      const k = r.metric.slice(3);
      refusedTotal[k] = (refusedTotal[k] ?? 0) + r.n;
      refusedByDay.set(r.day, { ...refusedByDay.get(r.day), [k]: r.n });
    }
    const series = Array.from({ length: days }, (_, i) => {
      const day = first + i;
      const d = perDay.get(day);
      return { date: new Date(day * STATS_DAY).toISOString().slice(0, 10), n: d?.n ?? 0, sum: d?.sum ?? 0, members: d?.members ?? 0, refused: refusedByDay.get(day) ?? {} };
    });
    return c.json({
      days,
      since,
      now,
      policy: policy ? publicPolicy(policy) : null,
      totals: { n: t.n ?? 0, sum: t.sum ?? 0, members: t.members ?? 0 },
      refused: refusedTotal,
      series,
      frequent: { atLeast: frequentAt, items: frequent!.results },
      changes: (changes!.results as Record<string, unknown>[]).map(versionRow),
    });
  })
  /** Refills paid, newest first; `user` narrows to one member. Server pages (`limit`, `offset`); `hasMore` says if more follow. */
  .get('/refill/claims', async (c) => {
    const { limit, offset } = page(c);
    const user = c.req.query('user')?.trim().slice(0, 64) || null;
    const { results } = await c.env.DB.prepare(
      `SELECT c.id, c.user_id AS userId, u.nickname, c.seq, c.policy_version AS policyVersion, c.amount, c.wallet, c.table_chips AS tableChips,
              c.next_at AS nextAt, c.created_at AS createdAt
         FROM refill_claims c LEFT JOIN users u ON u.id = c.user_id
        ${user ? 'WHERE c.user_id = ?3 ORDER BY c.seq DESC' : 'ORDER BY c.created_at DESC, c.id DESC'} LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit + 1, offset, ...(user ? [user] : []))
      .all();
    return c.json({ items: results.slice(0, limit), hasMore: results.length > limit, limit, offset });
  })
  /**
   * One member's refills: whether one would pay now and why not (the tables they sit at are asked, as for the member),
   * when the next may come, and the refills paid with the adjustments that took any back.
   */
  .get('/users/:id/refill', async (c) => {
    const id = c.req.param('id');
    const { limit, offset } = page(c, 20);
    const member = await c.env.DB.prepare(`SELECT nickname, status, role FROM users WHERE id = ?1`).bind(id).first<{ nickname: string; status: string; role: string }>();
    if (!member) fail(404, 'not_found', 'user not found');
    const [snap, history] = await Promise.all([
      refillSnapshot(c.env, id),
      // An adjustment naming a refill comes after it: read from the refill's time on, through the member's ledger index.
      c.env.DB.prepare(
        `SELECT c.id, c.seq, c.policy_version AS policyVersion, c.amount, c.wallet, c.table_chips AS tableChips, c.next_at AS nextAt, c.created_at AS createdAt,
                (SELECT json_group_array(json_object('id', a.id, 'amount', a.amount, 'at', a.created_at))
                   FROM chip_ledger a WHERE a.user_id = c.user_id AND a.created_at >= c.created_at AND a.type = 'admin_adjust' AND a.ref_id = c.id) AS corrections
           FROM refill_claims c WHERE c.user_id = ?1 ORDER BY c.seq DESC LIMIT ?2 OFFSET ?3`,
      )
        .bind(id, limit + 1, offset)
        .all<Record<string, unknown> & { corrections: string | null }>(),
    ]);
    const items = history.results.slice(0, limit).map((r) => ({ ...r, corrections: r.corrections ? (JSON.parse(r.corrections) as { id: string; amount: number; at: number }[]) : [] }));
    return c.json({ member, status: snap.status, items, hasMore: history.results.length > limit, limit, offset });
  });
