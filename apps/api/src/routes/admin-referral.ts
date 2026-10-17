/**
 * Referral administration (lib/referral.ts). Mounted inside the admin router: an admin session, the admin origin and
 * the permission table's rule are already applied.
 *
 * - The policy (on/off, both amounts, the referrer's daily and total caps, the new member's hands, the review threshold)
 *   is changed by a super admin, with the password, a reason and a preview. A change is a new version row: signups from
 *   then on are accepted under it; referrals already accepted keep the amounts and hands they were promised, while the
 *   caps are the ones in force when the referrer is paid. Two administrators editing from the same version: the second
 *   is told the policy changed (409) and shown the current one.
 * - Any administrator with the feature can pause payouts in an emergency (password and reason); only a super admin
 *   resumes them. Paused, referrals keep being recorded and wait; nothing paid is touched.
 * - A referral held for review (many signups for one referrer from one network within a day) is approved (then paid as
 *   any other) or rejected by an administrator, with the password and a reason. Rejecting closes the sides not paid yet;
 *   chips already paid are taken back only with the member's chip adjustment, naming the ledger row.
 * - Settling again runs what the member's card and the cron run: it pays at most once per side.
 * - No e-mail address or network is shown here: only whether the referrer was seen on the new member's network.
 */
import { dayStart, statsDay } from '@jc/db';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { currentPolicy, policyIssue, policyRow, publicPolicy, REFERRAL_LIMITS, settleReferral, type ReferralPolicyRow } from '../lib/referral';

const ReasonSchema = z.string().trim().min(2).max(200);
const L = REFERRAL_LIMITS;
const PolicyFields = {
  /** The version the administrator was looking at: a newer one meanwhile is a conflict. */
  baseVersion: z.number().int().min(0),
  enabled: z.boolean(),
  referrerAmount: z.number().int().min(L.amount.min).max(L.amount.max),
  inviteeAmount: z.number().int().min(L.amount.min).max(L.amount.max),
  dailyCap: z.number().int().min(L.dailyCap.min).max(L.dailyCap.max),
  totalCap: z.number().int().min(L.totalCap.min).max(L.totalCap.max),
  minHands: z.number().int().min(L.minHands.min).max(L.minHands.max),
  burstLimit: z.number().int().min(L.burstLimit.min).max(L.burstLimit.max),
};
const PolicySchema = z.object({ ...PolicyFields, reason: ReasonSchema });
const PolicyPreviewSchema = z.object({ ...PolicyFields, reason: ReasonSchema.optional() });
const ReasonOnly = z.object({ reason: ReasonSchema });

const STATUSES = ['pending', 'review', 'settled', 'unpaid'] as const;
const FAILURES = [
  'off',
  'paused',
  'hands',
  'email',
  'repeat_email',
  'burst',
  'rejected',
  'daily_cap',
  'total_cap',
  'invitee_deleted',
  'invitee_suspended',
  'referrer_deleted',
  'referrer_suspended',
] as const;
const POLICY_KEYS = ['enabled', 'referrerAmount', 'inviteeAmount', 'dailyCap', 'totalCap', 'minHands', 'burstLimit'] as const;

const page = (c: Context<AppEnv>, fallback = 50) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? fallback) || fallback, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

const VERSION_COLUMNS = `p.version, p.enabled, p.paused, p.referrer_amount AS referrerAmount, p.invitee_amount AS inviteeAmount, p.daily_cap AS dailyCap,
  p.total_cap AS totalCap, p.min_hands AS minHands, p.burst_limit AS burstLimit, p.change, p.actor_id AS actorId, p.reason, p.created_at AS createdAt,
  u.nickname AS actorNickname`;
const versionRow = (r: Record<string, unknown>) => ({ ...policyRow(r)!, actorNickname: (r.actorNickname as string | null) ?? null });
/** What administrators see of a policy: the members' view and the review threshold. */
const adminPolicy = (p: ReferralPolicyRow) => ({ ...publicPolicy(p), burstLimit: p.burstLimit });

/** One referral as listed: both members (nickname and account state), both sides, why it waits, who reviewed it. */
const ITEM_COLUMNS = `r.id, r.code, r.status, r.referrer_id AS referrerId, ru.nickname AS referrerNickname, ru.status AS referrerAccount,
  r.invitee_id AS inviteeId, iu.nickname AS inviteeNickname, iu.status AS inviteeAccount,
  r.referrer_status AS referrerStatus, r.invitee_status AS inviteeStatus, r.referrer_amount AS referrerAmount, r.invitee_amount AS inviteeAmount,
  r.policy_version AS policyVersion, r.min_hands AS minHands, r.failure_code AS failure, r.same_ip AS sameIp, r.email_verified AS emailVerified,
  r.referrer_ledger_id AS referrerLedgerId, r.invitee_ledger_id AS inviteeLedgerId, r.referrer_paid_at AS referrerPaidAt, r.invitee_paid_at AS inviteePaidAt,
  r.reviewed_by AS reviewedBy, au.nickname AS reviewerNickname, r.review_reason AS reviewReason, r.reviewed_at AS reviewedAt,
  r.created_at AS createdAt, r.updated_at AS updatedAt`;
const ITEM_FROM = `referrals r LEFT JOIN users ru ON ru.id = r.referrer_id LEFT JOIN users iu ON iu.id = r.invitee_id LEFT JOIN users au ON au.id = r.reviewed_by`;
interface ReferralItem {
  id: string;
  status: string;
  referrerStatus: string;
  inviteeStatus: string;
  failure: string | null;
  sameIp: boolean;
  emailVerified: boolean;
  [column: string]: unknown;
}
const item = (r: Record<string, unknown>) => ({ ...r, sameIp: !!r.sameIp, emailVerified: !!r.emailVerified }) as ReferralItem;

async function loadItem(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE r.id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? item(r) : null;
}

function conflict(current: ReferralPolicyRow | null): never {
  fail(409, 'referral_policy_conflict', 'the referral policy changed meanwhile', { policy: current ? adminPolicy(current) : null });
}

/** Referrals still waiting to be paid: they keep the amounts and hands they were promised whatever the new policy says. */
async function waitingCount(db: D1Database) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE status IN ('pending', 'review')`).first<{ n: number }>();
  return r?.n ?? 0;
}

/** One new version from the latest one, written only while the latest is still the one decided from. */
async function writeSwitch(c: Context<AppEnv>, to: 'pause' | 'resume', reason: string) {
  const now = Date.now();
  const current = await currentPolicy(c.env.DB);
  if (!current) fail(409, 'referral_no_policy', 'there is no referral policy');
  if (to === 'pause' && current.paused) fail(409, 'referral_already_paused', 'referral payouts are already paused');
  if (to === 'resume' && !current.paused) fail(409, 'referral_not_paused', 'referral payouts are not paused');
  const r = await c.env.DB.prepare(
    `INSERT INTO referral_policies (version, enabled, paused, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, change, actor_id, reason, created_at)
     SELECT version + 1, enabled, ?1, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, ?2, ?3, ?4, ?5 FROM referral_policies
      WHERE version = ?6 AND version = (SELECT MAX(version) FROM referral_policies)
     ON CONFLICT (version) DO NOTHING`,
  )
    .bind(to === 'pause' ? 1 : 0, to, c.var.user!.id, reason, now, current.version)
    .run();
  if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
  await audit(c, `referral.${to}`, undefined, { version: current.version + 1, from: current.version, reason, waiting: await waitingCount(c.env.DB) });
  return c.json({ ok: true, policy: adminPolicy({ ...current, version: current.version + 1, paused: to === 'pause' }) });
}

export const adminReferralRoutes = new Hono<AppEnv>()
  /**
   * The current policy and its latest versions (who changed what, and why), the limits a policy must keep to, the
   * referrals by state, the chips paid (and whether the ledger agrees), and the period's signups, reasons and referrers
   * with the most signups. `days` 1 to 90 (Korean days, like the operations statistics).
   */
  .get('/referrals', async (c) => {
    const days = Math.trunc(Number(c.req.query('days') ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 90) fail(400, 'invalid_input', 'days must be 1 to 90');
    const now = Date.now();
    const since = dayStart(statsDay(now) - days + 1);
    const db = c.env.DB;
    const [versions, byStatus, paid, ledger, orphans, period, failures, top] = await db.batch([
      db.prepare(`SELECT ${VERSION_COLUMNS} FROM referral_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 20`),
      db.prepare(`SELECT status, COUNT(*) AS n FROM referrals GROUP BY status`),
      db.prepare(
        `SELECT COALESCE(SUM(invitee_status = 'paid'), 0) AS invitees, COALESCE(SUM(CASE WHEN invitee_status = 'paid' THEN invitee_amount END), 0) AS inviteeChips,
                COALESCE(SUM(referrer_status = 'paid'), 0) AS referrers, COALESCE(SUM(CASE WHEN referrer_status = 'paid' THEN referrer_amount END), 0) AS referrerChips
           FROM referrals`,
      ),
      // Every referral payout, through the ledger's key index (the keys all start with `referral:`).
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM chip_ledger WHERE idempotency_key >= 'referral:' AND idempotency_key < 'referral;'`),
      // A payout whose referral does not name it: should never happen (both are written in one batch).
      db.prepare(
        `SELECT COUNT(*) AS n FROM chip_ledger l WHERE l.idempotency_key >= 'referral:' AND l.idempotency_key < 'referral;'
            AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.id = l.ref_id AND l.id IN (r.invitee_ledger_id, r.referrer_ledger_id))`,
      ),
      db
        .prepare(
          `SELECT COALESCE(SUM(created_at >= ?1), 0) AS created, COALESCE(SUM(created_at >= ?1 AND status = 'review'), 0) AS review,
                  COALESCE(SUM(created_at >= ?1 AND same_ip = 1), 0) AS sameIp,
                  COALESCE(SUM(invitee_paid_at >= ?1), 0) AS inviteesPaid, COALESCE(SUM(referrer_paid_at >= ?1), 0) AS referrersPaid
             FROM referrals WHERE created_at >= ?1 OR invitee_paid_at >= ?1 OR referrer_paid_at >= ?1`,
        )
        .bind(since),
      db.prepare(`SELECT failure_code AS failure, COUNT(*) AS n FROM referrals WHERE created_at >= ?1 AND failure_code IS NOT NULL GROUP BY failure_code`).bind(since),
      db
        .prepare(
          `SELECT r.referrer_id AS userId, u.nickname, u.status, COUNT(*) AS n, COALESCE(SUM(r.referrer_status = 'paid'), 0) AS paid,
                  COALESCE(SUM(r.status = 'review'), 0) AS review, COALESCE(SUM(r.same_ip), 0) AS sameIp, MAX(r.created_at) AS lastAt
             FROM referrals r LEFT JOIN users u ON u.id = r.referrer_id
            WHERE r.created_at >= ?1 GROUP BY r.referrer_id ORDER BY n DESC, lastAt DESC LIMIT 20`,
        )
        .bind(since),
    ]);
    const items = (versions!.results as Record<string, unknown>[]).map(versionRow);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
    for (const r of byStatus!.results as { status: (typeof STATUSES)[number]; n: number }[]) counts[r.status] = r.n;
    const p = paid!.results[0] as { invitees: number; inviteeChips: number; referrers: number; referrerChips: number };
    const l = ledger!.results[0] as { n: number; sum: number };
    const chips = p.inviteeChips + p.referrerChips;
    return c.json({
      policy: items[0] ?? null,
      versions: items,
      limits: REFERRAL_LIMITS,
      counts,
      paid: { ...p, chips },
      integrity: { ledgerRows: l.n, ledgerSum: l.sum, paidRows: p.invitees + p.referrers, paidSum: chips, unlinked: (orphans!.results[0] as { n: number }).n, ok: l.n === p.invitees + p.referrers && l.sum === chips },
      period: { days, since, ...(period!.results[0] as Record<string, number>), failures: Object.fromEntries((failures!.results as { failure: string; n: number }[]).map((f) => [f.failure, f.n])) },
      top: top!.results,
      now,
    });
  })
  /**
   * A new policy version. `preview`: the old and new values, when they apply (the amounts and hands to signups from now
   * on, the caps to the next payout) and how many referrals wait with the terms they were given. Pausing is kept as it
   * is (pause and resume are their own routes).
   */
  .put('/referrals/policy', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PolicyPreviewSchema : PolicySchema);
    const now = Date.now();
    const current = await currentPolicy(c.env.DB);
    if ((current?.version ?? 0) !== body.baseVersion) conflict(current);
    const next = {
      enabled: body.enabled,
      referrerAmount: body.referrerAmount,
      inviteeAmount: body.inviteeAmount,
      dailyCap: body.dailyCap,
      totalCap: body.totalCap,
      minHands: body.minHands,
      burstLimit: body.burstLimit,
    };
    if (current && POLICY_KEYS.every((k) => current[k] === next[k])) fail(400, 'referral_no_change', 'the policy is the same as now');
    const issue = policyIssue(next);
    if (issue) fail(400, issue, issue === 'referral_nothing_to_pay' ? 'an enabled policy must pay at least one side' : 'the daily cap cannot exceed the total cap');
    const to = { version: body.baseVersion + 1, paused: current?.paused ?? false, ...next };
    if (preview) {
      return c.json({ preview: true, from: current ? adminPolicy(current) : null, to, appliesFrom: { terms: 'next_signup', caps: 'next_payout' }, waiting: await waitingCount(c.env.DB), now });
    }
    const reason = body.reason!;
    const v = [next.enabled ? 1 : 0, next.referrerAmount, next.inviteeAmount, next.dailyCap, next.totalCap, next.minHands, next.burstLimit, c.var.user!.id, reason, now];
    // From the version the administrator saw, and only while it is still the latest (the primary key stops a race).
    const r = current
      ? await c.env.DB.prepare(
          `INSERT INTO referral_policies (version, enabled, paused, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, change, actor_id, reason, created_at)
           SELECT version + 1, ?1, paused, ?2, ?3, ?4, ?5, ?6, ?7, 'policy', ?8, ?9, ?10 FROM referral_policies
            WHERE version = ?11 AND version = (SELECT MAX(version) FROM referral_policies)
           ON CONFLICT (version) DO NOTHING`,
        )
          .bind(...v, current.version)
          .run()
      : await c.env.DB.prepare(
          `INSERT INTO referral_policies (version, enabled, paused, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, change, actor_id, reason, created_at)
           SELECT 1, ?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, 'policy', ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM referral_policies)
           ON CONFLICT (version) DO NOTHING`,
        )
          .bind(...v)
          .run();
    if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
    await audit(c, 'referral.policy', undefined, { from: current ? adminPolicy(current) : null, to, reason });
    return c.json({ ok: true, policy: to });
  })
  /** Emergency stop of referral payouts (any administrator with the feature). Signups are still recorded and wait. */
  .post('/referrals/pause', async (c) => writeSwitch(c, 'pause', (await parseBody(c, ReasonOnly)).reason))
  /** Payouts again (super admins); waiting referrals are paid as members open their card, by the cron, or by settling. */
  .post('/referrals/resume', async (c) => writeSwitch(c, 'resume', (await parseBody(c, ReasonOnly)).reason))
  /**
   * Referrals, newest first. Filters: `status`, `failure`, `user` (as either member), `sameIp=1`. Server pages
   * (`limit`, `offset`); `hasMore` says if more follow.
   */
  .get('/referrals/list', async (c) => {
    const { limit, offset } = page(c);
    const status = c.req.query('status');
    const failure = c.req.query('failure');
    const user = c.req.query('user')?.trim().slice(0, 64) || null;
    if (status && !(STATUSES as readonly string[]).includes(status)) fail(400, 'invalid_input', 'unknown status');
    if (failure && !(FAILURES as readonly string[]).includes(failure)) fail(400, 'invalid_input', 'unknown failure');
    const where: string[] = [];
    const params: (string | number)[] = [];
    /** The placeholder for a value bound in order. */
    const bind = (v: string | number) => `?${params.push(v)}`;
    if (status) where.push(`r.status = ${bind(status)}`);
    if (failure) where.push(`r.failure_code = ${bind(failure)}`);
    if (user) {
      const p = bind(user);
      where.push(`(r.referrer_id = ${p} OR r.invitee_id = ${p})`);
    }
    if (c.req.query('sameIp') === '1') where.push(`r.same_ip = 1`);
    const { results } = await c.env.DB.prepare(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`,
    )
      .bind(...params)
      .all<Record<string, unknown>>();
    return c.json({ items: results.slice(0, limit).map(item), hasMore: results.length > limit, limit, offset });
  })
  /** A referral held for review goes on: it is paid as any other (now, if it may be). Password and reason. */
  .post('/referrals/:id/approve', async (c) => {
    const id = c.req.param('id');
    const { reason } = await parseBody(c, ReasonOnly);
    const before = await loadItem(c.env.DB, id);
    if (!before) fail(404, 'not_found', 'referral not found');
    const now = Date.now();
    const r = await c.env.DB.prepare(
      `UPDATE referrals SET status = 'pending', failure_code = NULL, reviewed_by = ?2, review_reason = ?3, reviewed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'review'`,
    )
      .bind(id, c.var.user!.id, reason, now)
      .run();
    if (!r.meta.changes) fail(409, 'referral_not_in_review', 'the referral is not held for review', { status: before.status });
    const settled = await settleReferral(c.env, id);
    await audit(c, 'referral.approve', { type: 'referral', id }, { reason, before: sides(before), after: sides(settled), paid: settled.paid });
    return c.json({ ok: true, referral: await loadItem(c.env.DB, id), paid: settled.paid });
  })
  /**
   * Closes a referral that is waiting or held: sides not paid yet are not paid. A side already paid stays paid (its
   * chips are taken back, if they must be, with the member's chip adjustment naming the ledger row). Password and reason.
   */
  .post('/referrals/:id/reject', async (c) => {
    const id = c.req.param('id');
    const { reason } = await parseBody(c, ReasonOnly);
    const before = await loadItem(c.env.DB, id);
    if (!before) fail(404, 'not_found', 'referral not found');
    const now = Date.now();
    const r = await c.env.DB.prepare(
      `UPDATE referrals SET
         invitee_status = CASE invitee_status WHEN 'pending' THEN 'unpaid' ELSE invitee_status END,
         referrer_status = CASE referrer_status WHEN 'pending' THEN 'unpaid' ELSE referrer_status END,
         status = CASE WHEN invitee_status = 'paid' OR referrer_status = 'paid' THEN 'settled' ELSE 'unpaid' END,
         failure_code = 'rejected', reviewed_by = ?2, review_reason = ?3, reviewed_at = ?4, updated_at = ?4
       WHERE id = ?1 AND status IN ('pending', 'review')`,
    )
      .bind(id, c.var.user!.id, reason, now)
      .run();
    if (!r.meta.changes) fail(409, 'referral_final', 'the referral is already closed', { status: before.status });
    const after = await loadItem(c.env.DB, id);
    await audit(c, 'referral.reject', { type: 'referral', id }, { reason, before: sides(before), after: after ? sides(after) : null });
    return c.json({ ok: true, referral: after });
  })
  /** Settles a waiting referral now (what the member's card and the cron do): pays at most once per side. */
  .post('/referrals/:id/settle', async (c) => {
    const id = c.req.param('id');
    const before = await loadItem(c.env.DB, id);
    if (!before) fail(404, 'not_found', 'referral not found');
    const settled = await settleReferral(c.env, id);
    await audit(c, 'referral.settle', { type: 'referral', id }, { before: sides(before), after: sides(settled), paid: settled.paid });
    return c.json({ ok: true, referral: await loadItem(c.env.DB, id), paid: settled.paid });
  })
  /**
   * One member's referrals: their code (if they have made one), who invited them, and the members they invited (server
   * pages). Read only: opening it neither makes a code nor pays anything.
   */
  .get('/users/:id/referral', async (c) => {
    const id = c.req.param('id');
    const { limit, offset } = page(c, 20);
    const db = c.env.DB;
    const member = await db.prepare(`SELECT nickname, status, role FROM users WHERE id = ?1`).bind(id).first<{ nickname: string; status: string; role: string }>();
    if (!member) fail(404, 'not_found', 'user not found');
    const [code, invitedBy, totals, invited] = await db.batch([
      db.prepare(`SELECT code, created_at AS createdAt FROM referral_codes WHERE user_id = ?1`).bind(id),
      db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE r.invitee_id = ?1`).bind(id),
      db
        .prepare(
          `SELECT COUNT(*) AS invited, COALESCE(SUM(referrer_status = 'paid'), 0) AS paid, COALESCE(SUM(referrer_status = 'pending'), 0) AS pending,
                  COALESCE(SUM(status = 'review'), 0) AS review, COALESCE(SUM(CASE WHEN referrer_status = 'paid' THEN referrer_amount END), 0) AS earned
             FROM referrals WHERE referrer_id = ?1`,
        )
        .bind(id),
      db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE r.referrer_id = ?1 ORDER BY r.created_at DESC LIMIT ?2 OFFSET ?3`).bind(id, limit + 1, offset),
    ]);
    const list = invited!.results as Record<string, unknown>[];
    const by = invitedBy!.results[0] as Record<string, unknown> | undefined;
    return c.json({
      member,
      code: (code!.results[0] as { code: string; createdAt: number } | undefined) ?? null,
      invitedBy: by ? item(by) : null,
      totals: totals!.results[0],
      items: list.slice(0, limit).map(item),
      hasMore: list.length > limit,
      limit,
      offset,
    });
  });

/** A referral's state for the audit row: statuses and the reason, nothing about the members. */
function sides(r: { status?: unknown; referrerStatus?: unknown; inviteeStatus?: unknown; failure?: unknown }) {
  return { status: r.status ?? null, referrerStatus: r.referrerStatus ?? null, inviteeStatus: r.inviteeStatus ?? null, failure: r.failure ?? null };
}
