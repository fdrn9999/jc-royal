import { applyLedger, LEDGER_GUARD, statsDay, statsIncrements, type RefillMetric } from '@jc/db';
import type { RefillClaimDto, RefillHold, RefillPolicyDto, RefillReason, RefillStatusDto } from '@jc/types';
import type { Env } from '../env';
import { roomCallEnv } from './room';

/**
 * Free chip refill: a member whose chips — the wallet and every open seat's stack, a hand's bets included — are below
 * the policy's line may claim a fixed amount, then waits the policy's cooldown before the next one. Separate from a
 * table top-up (which moves wallet chips to a seat); nothing is asked in return (no ad, streak or bet).
 *
 * Exactly once: a claim's idempotency key is `refill:<user>:<n>` (the member's n-th refill), so two tabs or a retry
 * decided from the same state write one ledger row. The ledger insert also re-checks, in the same statement, what the
 * decision was made from — the wallet, the number of open seats, no refill whose wait is still running, the policy
 * version — so a claim decided on a stale read pays nothing and is asked again. The claim row (refill_claims) goes in
 * the same batch, guarded by the ledger row, and fixes when the next refill may come: a later policy change applies to
 * the next decision only, never to a wait already running.
 *
 * Held, not paid, when the table chips cannot be confirmed: a table that does not answer, a seat whose chips are on
 * their way to or from the wallet, or a seat D1 has open that the table does not.
 */

export const REFILL_LIMITS = {
  below: { min: 100, max: 10_000_000 },
  amount: { min: 100, max: 1_000_000 },
  cooldownMs: { min: 10 * 60_000, max: 30 * 86_400_000 },
} as const;

/**
 * Members listed for a look on the admin page (never acted on by themselves): at least minClaims refills in the period,
 * and at least share of the most the current wait allows in it.
 */
export const REFILL_FREQUENT = { minClaims: 3, share: 0.5 } as const;

/** Claims one member may send per minute (the button asks once; this only stops a script). */
export const REFILL_RATE = { limit: 10, windowMs: 60_000 } as const;

export interface RefillPolicyRow extends RefillPolicyDto {
  change: 'seed' | 'policy' | 'pause' | 'resume';
  actorId: string | null;
  reason: string | null;
  createdAt: number;
}

const POLICY_COLUMNS = `version, enabled, paused, below, amount, cooldown_ms AS cooldownMs, change, actor_id AS actorId, reason, created_at AS createdAt`;

export function policyRow(r: Record<string, unknown> | null | undefined): RefillPolicyRow | null {
  if (!r) return null;
  return {
    version: Number(r.version),
    enabled: !!r.enabled,
    paused: !!r.paused,
    below: Number(r.below),
    amount: Number(r.amount),
    cooldownMs: Number(r.cooldownMs),
    change: r.change as RefillPolicyRow['change'],
    actorId: (r.actorId as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: Number(r.createdAt),
  };
}

export const currentPolicySql = `SELECT ${POLICY_COLUMNS} FROM refill_policies ORDER BY version DESC LIMIT 1`;

export async function currentPolicy(db: D1Database): Promise<RefillPolicyRow | null> {
  return policyRow(await db.prepare(currentPolicySql).first());
}

export const publicPolicy = (p: RefillPolicyRow): RefillPolicyDto => ({ version: p.version, enabled: p.enabled, paused: p.paused, below: p.below, amount: p.amount, cooldownMs: p.cooldownMs });

interface Snapshot {
  status: RefillStatusDto;
  policy: RefillPolicyRow | null;
  /** Open seats in D1 when read, and the member's last refill number. */
  seats: number;
  seq: number;
}

/** What the member has, and whether a refill would pay now. Asks the tables only when the answer depends on them. */
export async function refillSnapshot(env: Env, userId: string, now = Date.now()): Promise<Snapshot> {
  const db = env.DB;
  const [pol, usr, sess, last] = await db.batch([
    db.prepare(currentPolicySql),
    db.prepare(`SELECT balance, status FROM users WHERE id = ?1`).bind(userId),
    db.prepare(`SELECT id, table_id AS tableId FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`).bind(userId),
    db.prepare(`SELECT seq, amount, next_at AS nextAt, created_at AS at FROM refill_claims WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1`).bind(userId),
  ]);
  const policy = policyRow(pol!.results[0] as Record<string, unknown> | undefined);
  const user = usr!.results[0] as { balance: number; status: string } | undefined;
  const seats = sess!.results as { id: string; tableId: string }[];
  const l = last!.results[0] as { seq: number; amount: number; nextAt: number; at: number } | undefined;
  const wallet = user?.balance ?? 0;
  const status: RefillStatusDto = {
    policy: policy ? publicPolicy(policy) : null,
    wallet,
    tables: seats.length ? null : 0,
    eligible: false,
    reason: null,
    hold: null,
    nextAt: l ? l.nextAt : null,
    last: l ? { at: l.at, amount: l.amount } : null,
    received: l?.seq ?? 0,
    now,
  };
  const snap: Snapshot = { status, policy, seats: seats.length, seq: l?.seq ?? 0 };
  const refuse = (reason: RefillReason, hold: RefillHold | null = null) => {
    status.reason = reason;
    status.hold = hold;
    return snap;
  };
  if (!policy || !policy.enabled) return refuse('off');
  if (policy.paused) return refuse('paused');
  if (user?.status !== 'active') return refuse('suspended');
  if (l && l.nextAt > now) return refuse('cooldown');
  // Table chips only add to the wallet: a wallet at the line already is enough.
  if (wallet >= policy.below) return refuse('above');
  let tables = 0;
  const answers = await Promise.all(seats.map((s) => roomCallEnv(env, s.tableId, 'holdings', { user: userId })));
  for (const [i, a] of answers.entries()) {
    if (!a) return refuse('held', 'unreachable');
    if (!a.seated || a.tableSessionId !== seats[i]!.id) return refuse('held', 'mismatch');
    if (!a.stable) return refuse('held', 'busy');
    tables += Number(a.stack) || 0;
  }
  status.tables = tables;
  if (wallet + tables >= policy.below) return refuse('above');
  status.eligible = true;
  return snap;
}

const METRIC: Record<RefillReason, RefillMetric> = {
  off: 'rf_off',
  paused: 'rf_paused',
  cooldown: 'rf_cooldown',
  above: 'rf_above',
  suspended: 'rf_suspended',
  held: 'rf_held',
};

async function count(db: D1Database, metric: RefillMetric, now: number) {
  // A counter that fails to write never fails the answer.
  await db.batch(statsIncrements(db, statsDay(now), { [metric]: 1 })).catch(() => undefined);
}

export type ClaimOutcome =
  | { ok: true; claim: RefillClaimDto }
  | { ok: false; code: 'refill_refused'; status: RefillStatusDto }
  | { ok: false; code: 'refill_changed'; status: RefillStatusDto };

/** Pays the member's refill if they may have one now: once, whatever the number of tabs, retries or concurrent claims. */
export async function claimRefill(env: Env, userId: string, now = Date.now()): Promise<ClaimOutcome> {
  const db = env.DB;
  const snap = await refillSnapshot(env, userId, now);
  const { status, policy } = snap;
  if (!status.eligible || !policy) {
    await count(db, METRIC[status.reason ?? 'off'], now);
    return { ok: false, code: 'refill_refused', status };
  }
  const seq = snap.seq + 1;
  const nextAt = now + policy.cooldownMs;
  const r = await applyLedger(
    db,
    {
      userId,
      type: 'free_refill',
      amount: policy.amount,
      idempotencyKey: `refill:${userId}:${seq}`,
      memo: 'free refill',
      activeOnly: true,
      guard: {
        sql: `balance = ?10
          AND (SELECT COUNT(*) FROM table_sessions WHERE user_id = ?9 AND status = 'seated') = ?11
          AND NOT EXISTS (SELECT 1 FROM refill_claims WHERE user_id = ?9 AND (seq >= ?12 OR next_at > ?13))
          AND (SELECT MAX(version) FROM refill_policies) = ?14`,
        params: [status.wallet, snap.seats, seq, now, policy.version],
      },
    },
    (ledgerId) => [
      db
        .prepare(
          `INSERT INTO refill_claims (id, user_id, seq, policy_version, amount, wallet, table_chips, next_at, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${LEDGER_GUARD}`,
        )
        .bind(ledgerId, userId, seq, policy.version, policy.amount, status.wallet, status.tables ?? 0, nextAt, now, ledgerId),
    ],
  );
  if (r.status === 'insufficient') {
    await count(db, 'rf_changed', now);
    return { ok: false, code: 'refill_changed', status: (await refillSnapshot(env, userId, Date.now())).status };
  }
  const after = (await refillSnapshot(env, userId, Date.now())).status;
  if (r.status === 'duplicate') {
    const c = await db.prepare(`SELECT amount, next_at AS nextAt FROM refill_claims WHERE id = ?1`).bind(r.ledgerId).first<{ amount: number; nextAt: number }>();
    return { ok: true, claim: { amount: c?.amount ?? policy.amount, balance: after.wallet, nextAt: c?.nextAt ?? nextAt, duplicate: true, status: after } };
  }
  return { ok: true, claim: { amount: policy.amount, balance: r.balanceAfter, nextAt, duplicate: false, status: after } };
}
