import { applyLedger, createDb, dayStart, LEDGER_GUARD, statsDay } from '@jc/db';
import {
  normalizeReferralCode,
  REFERRAL_CODE_RE,
  type ReferralCodeCheckDto,
  type ReferralFailure,
  type ReferralInviteeDto,
  type ReferralMeDto,
  type ReferralPolicyDto,
  type ReferralSideStatus,
  type ReferralStatus,
} from '@jc/types';
import type { Env } from '../env';
import { sendMessages } from './community';
import { hmacSign } from './crypto';
import { notices } from './notices';

/**
 * Referral rewards: a member shares their code (or the link `/register?ref=CODE`); a new member who signs up with it
 * and the member who shared it each receive virtual chips, separate from the signup grant. The server decides
 * everything; the amounts and conditions are the operators' (referral_policies, routes/admin-referral.ts).
 *
 * - Accepted at signup under the policy then in force: the referral row keeps that version's amounts and hand
 *   condition, so a later change or switch-off never alters a promise already made. Off at signup: recorded, unpaid.
 * - Paid once per side: the ledger key is `referral:<id>:invitee` / `referral:<id>:referrer`, and the ledger insert
 *   re-checks in the same statement that the side is still pending, payouts are not paused and (for the referrer) the
 *   current caps; the side's status and ledger id are written in that batch, only when its ledger row was. A retry, a
 *   second tab, the cron and an operator settling the same referral at once pay nothing twice.
 * - Abuse: one referrer per new member (unique invitee), the same inbox (normalised email) is rewarded once ever,
 *   aliases of the referrer's own address are not rewarded, per-referrer daily and total caps, and many signups for one
 *   referrer from one network within a day wait for an operator. A shared network alone never refuses anything: it is
 *   only a signal shown to operators.
 * - Settled at signup, when either member opens their referral card, by the daily cron, or by an operator.
 */

export const REFERRAL_LIMITS = {
  amount: { min: 0, max: 1_000_000 },
  dailyCap: { min: 1, max: 1_000 },
  totalCap: { min: 1, max: 100_000 },
  minHands: { min: 0, max: 1_000 },
  burstLimit: { min: 2, max: 1_000 },
} as const;
/** A new member has this long to finish the policy's hands; after it the referral closes unpaid. */
export const REFERRAL_HANDS_DAYS = 30;
/** Signup networks are kept this long, for the review signal only (the daily sweep clears them). */
export const REFERRAL_IP_DAYS = 30;
/** Referrals one cron sweep settles (oldest checked first, so none is starved). */
export const REFERRAL_SWEEP = 50;
/** Referrals one member's visit to their card settles. */
const MEMBER_SETTLE = 10;
const DAY = 86_400_000;
/** No 0/O or 1/I: a code read aloud or retyped stays the same. 32 letters, so a random byte & 31 is uniform. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface ReferralPolicyRow extends ReferralPolicyDto {
  burstLimit: number;
  change: 'seed' | 'policy' | 'pause' | 'resume';
  actorId: string | null;
  reason: string | null;
  createdAt: number;
}

export const POLICY_COLUMNS = `version, enabled, paused, referrer_amount AS referrerAmount, invitee_amount AS inviteeAmount, daily_cap AS dailyCap,
  total_cap AS totalCap, min_hands AS minHands, burst_limit AS burstLimit, change, actor_id AS actorId, reason, created_at AS createdAt`;

export function policyRow(r: Record<string, unknown> | null | undefined): ReferralPolicyRow | null {
  if (!r) return null;
  return {
    version: Number(r.version),
    enabled: !!r.enabled,
    paused: !!r.paused,
    referrerAmount: Number(r.referrerAmount),
    inviteeAmount: Number(r.inviteeAmount),
    dailyCap: Number(r.dailyCap),
    totalCap: Number(r.totalCap),
    minHands: Number(r.minHands),
    burstLimit: Number(r.burstLimit),
    change: r.change as ReferralPolicyRow['change'],
    actorId: (r.actorId as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: Number(r.createdAt),
  };
}

export const currentPolicySql = `SELECT ${POLICY_COLUMNS} FROM referral_policies ORDER BY version DESC LIMIT 1`;

export async function currentPolicy(db: D1Database): Promise<ReferralPolicyRow | null> {
  return policyRow(await db.prepare(currentPolicySql).first());
}

export const publicPolicy = (p: ReferralPolicyRow): ReferralPolicyDto => ({
  version: p.version,
  enabled: p.enabled,
  paused: p.paused,
  referrerAmount: p.referrerAmount,
  inviteeAmount: p.inviteeAmount,
  dailyCap: p.dailyCap,
  totalCap: p.totalCap,
  minHands: p.minHands,
});

/** What is wrong with a policy an administrator wants to save (null: nothing). */
export function policyIssue(p: { enabled: boolean; referrerAmount: number; inviteeAmount: number; dailyCap: number; totalCap: number }): string | null {
  if (p.enabled && p.referrerAmount + p.inviteeAmount <= 0) return 'referral_nothing_to_pay';
  if (p.dailyCap > p.totalCap) return 'referral_caps_order';
  return null;
}

export function newReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `JC${Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('')}`;
}

/** The member's code, made the first time it is asked for. */
export async function referralCodeOf(db: D1Database, userId: string): Promise<string> {
  const select = db.prepare(`SELECT code FROM referral_codes WHERE user_id = ?1`).bind(userId);
  const have = await select.first<{ code: string }>();
  if (have) return have.code;
  // A code another member already holds writes nothing; a second tab making one at the same time is read back.
  for (let i = 0; i < 5; i++) {
    const [, row] = await db.batch([db.prepare(`INSERT INTO referral_codes (user_id, code) VALUES (?1, ?2) ON CONFLICT DO NOTHING`).bind(userId, newReferralCode()), select]);
    const code = (row!.results[0] as { code: string } | undefined)?.code;
    if (code) return code;
  }
  throw new Error('referral code: no free code after 5 tries');
}

/**
 * One inbox, however it is written: lower case, no `+tag`, and for Gmail no dots (googlemail.com is gmail.com). Used
 * only to recognise the same inbox signing up again; never stored as such.
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  let local = e.slice(0, at).split('+')[0]!;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** The network an address belongs to: the address itself for IPv4, its /64 for IPv6 (one home's devices). */
export function networkOf(ip: string): string {
  if (!ip.includes(':')) return ip;
  const lower = ip.toLowerCase();
  const [head = '', tail] = lower.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Keyed, so a stored value cannot be matched against a list of addresses without the server's secret. */
const keyed = (env: Env, purpose: 'email' | 'ip', value: string) => hmacSign(env.INTERNAL_SECRET, `referral-${purpose}:${value}`);

export interface Referrer {
  id: string;
  nickname: string;
  email: string;
  code: string;
}

/** The active member (never a table bot) whose code this is; null for a malformed or unknown code. */
export async function findReferrer(db: D1Database, raw: string): Promise<Referrer | null> {
  const code = normalizeReferralCode(raw);
  if (!REFERRAL_CODE_RE.test(code)) return null;
  return (
    (await db
      .prepare(
        `SELECT u.id, u.nickname, u.email, rc.code FROM referral_codes rc JOIN users u ON u.id = rc.user_id
          WHERE rc.code = ?1 AND u.status = 'active' AND u.is_bot = 0`,
      )
      .bind(code)
      .first<Referrer>()) ?? null
  );
}

/**
 * Records a signup made with `referrer`'s code, right after the new member's row is written, and returns its id.
 * Decides only what is known at signup (policy on, same inbox, a burst from one network); paying is settleReferral's.
 */
export async function recordReferral(
  env: Env,
  p: { referrer: Referrer; inviteeId: string; email: string; emailVerified: boolean; verificationRequired: boolean; ip: string; now?: number },
): Promise<string> {
  const db = env.DB;
  const now = p.now ?? Date.now();
  const email = normalizeEmail(p.email);
  const [emailHash, ipHash] = await Promise.all([keyed(env, 'email', email), keyed(env, 'ip', networkOf(p.ip))]);
  const [pol, repeat, burst, same] = await db.batch([
    db.prepare(currentPolicySql),
    db.prepare(`SELECT 1 AS x FROM referrals WHERE email_hash = ?1 LIMIT 1`).bind(emailHash),
    db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?1 AND created_at > ?2 AND ip_hash = ?3`).bind(p.referrer.id, now - DAY, ipHash),
    db.prepare(`SELECT 1 AS x FROM sessions WHERE user_id = ?1 AND kind = 'user' AND ip = ?2 LIMIT 1`).bind(p.referrer.id, p.ip),
  ]);
  const policy = policyRow(pol!.results[0] as Record<string, unknown> | undefined);
  let status: ReferralStatus = 'pending';
  let failure: ReferralFailure | null = null;
  if (!policy?.enabled) [status, failure] = ['unpaid', 'off'];
  else if (p.verificationRequired && !p.emailVerified) [status, failure] = ['unpaid', 'email'];
  else if (repeat!.results.length || email === normalizeEmail(p.referrer.email)) [status, failure] = ['unpaid', 'repeat_email'];
  else if (Number((burst!.results[0] as { n: number }).n) + 1 >= policy.burstLimit) [status, failure] = ['review', 'burst'];
  const referrerAmount = policy?.enabled ? policy.referrerAmount : 0;
  const inviteeAmount = policy?.enabled ? policy.inviteeAmount : 0;
  const side = (amount: number): ReferralSideStatus => (status === 'unpaid' ? 'unpaid' : amount > 0 ? 'pending' : 'skipped');
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO referrals (id, code, referrer_id, invitee_id, status, referrer_status, invitee_status, policy_version, referrer_amount, invitee_amount,
                              min_hands, email_hash, ip_hash, same_ip, email_verified, failure_code, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
       ON CONFLICT (invitee_id) DO NOTHING`,
    )
    .bind(
      id,
      p.referrer.code,
      p.referrer.id,
      p.inviteeId,
      status,
      side(referrerAmount),
      side(inviteeAmount),
      policy?.version ?? 0,
      referrerAmount,
      inviteeAmount,
      policy?.minHands ?? 0,
      emailHash,
      ipHash,
      same!.results.length ? 1 : 0,
      p.emailVerified ? 1 : 0,
      failure,
      now,
    )
    .run();
  return id;
}

type MemberState = 'active' | 'suspended' | 'deleted' | null;

/** What settling a referral is decided from (read in one batch). */
export interface SettleFacts {
  status: ReferralStatus;
  referrerStatus: ReferralSideStatus;
  inviteeStatus: ReferralSideStatus;
  minHands: number;
  createdAt: number;
  policy: { paused: boolean; dailyCap: number; totalCap: number } | null;
  invitee: MemberState;
  referrer: MemberState;
  /** Hands the new member has finished, and the referrer's rewards paid today (KST) and ever. */
  hands: number;
  paidToday: number;
  paidTotal: number;
  now: number;
}

export interface SettlePlan {
  /** Pending sides close unpaid (the new member left, or ran out of time for the hands). */
  close: boolean;
  invitee: 'pay' | null;
  referrer: 'pay' | 'capped' | 'skipped' | null;
  /** Why it waits, or why a side closed without pay; null when nothing is wrong. */
  failure: ReferralFailure | null;
}

/** What to do with a referral now. Only `pending` referrals move; one under review waits for an operator. */
export function planSettlement(f: SettleFacts): SettlePlan | null {
  if (f.status !== 'pending') return null;
  const none: SettlePlan = { close: false, invitee: null, referrer: null, failure: null };
  if (f.invitee === 'deleted' || f.invitee === null) return { ...none, close: true, failure: 'invitee_deleted' };
  const handsDue = f.hands < f.minHands;
  if (handsDue && f.now - f.createdAt > REFERRAL_HANDS_DAYS * DAY) return { ...none, close: true, failure: 'hands' };
  if (!f.policy) return { ...none, failure: 'off' };
  if (f.policy.paused) return { ...none, failure: 'paused' };
  if (f.invitee === 'suspended') return { ...none, failure: 'invitee_suspended' };
  if (handsDue) return { ...none, failure: 'hands' };
  const plan: SettlePlan = { ...none, invitee: f.inviteeStatus === 'pending' ? 'pay' : null };
  // A side withdrawal already skipped (auth.ts /me/delete) keeps saying why.
  if (f.referrerStatus !== 'pending') return f.referrerStatus === 'skipped' && f.referrer === 'deleted' ? { ...plan, failure: 'referrer_deleted' } : plan;
  if (f.referrer === 'deleted' || f.referrer === null) return { ...plan, referrer: 'skipped', failure: 'referrer_deleted' };
  if (f.paidTotal >= f.policy.totalCap) return { ...plan, referrer: 'capped', failure: 'total_cap' };
  if (f.paidToday >= f.policy.dailyCap) return { ...plan, referrer: 'capped', failure: 'daily_cap' };
  if (f.referrer === 'suspended') return { ...plan, failure: 'referrer_suspended' };
  return { ...plan, referrer: 'pay' };
}

interface Row {
  id: string;
  referrerId: string;
  inviteeId: string;
  status: ReferralStatus;
  referrerStatus: ReferralSideStatus;
  inviteeStatus: ReferralSideStatus;
  referrerAmount: number;
  inviteeAmount: number;
  minHands: number;
  failureCode: ReferralFailure | null;
  createdAt: number;
}
interface Person {
  id: string;
  nickname: string;
  status: 'active' | 'suspended' | 'deleted';
  locale: string | null;
}

const ROW_COLUMNS = `id, referrer_id AS referrerId, invitee_id AS inviteeId, status, referrer_status AS referrerStatus, invitee_status AS inviteeStatus,
  referrer_amount AS referrerAmount, invitee_amount AS inviteeAmount, min_hands AS minHands, failure_code AS failureCode, created_at AS createdAt`;

/** Payouts are not paused right now (read inside the ledger statement, so a pause stops even a payout decided before it). */
const NOT_PAUSED = `NOT EXISTS (SELECT 1 FROM referral_policies WHERE version = (SELECT MAX(version) FROM referral_policies) AND paused = 1)`;

export interface SettleResult {
  /** The referral after settling (null: no such referral). */
  status: ReferralStatus | null;
  referrerStatus?: ReferralSideStatus;
  inviteeStatus?: ReferralSideStatus;
  failure?: ReferralFailure | null;
  /** Chips this call paid (a side already paid by another call is not counted). */
  paid: { invitee: number; referrer: number };
}

/**
 * Pays what a referral may pay now, at most once per side whoever calls it and however often. `touch`: mark it checked
 * even when nothing changed (the cron, so the oldest-checked come first next time).
 */
export async function settleReferral(env: Env, id: string, opts: { now?: number; touch?: boolean } = {}): Promise<SettleResult> {
  const db = env.DB;
  const paid = { invitee: 0, referrer: 0 };
  for (let attempt = 0; ; attempt++) {
    const now = opts.now ?? Date.now();
    const since = dayStart(statsDay(now));
    const [rowR, polR, peopleR, handsR, capR] = await db.batch([
      db.prepare(`SELECT ${ROW_COLUMNS} FROM referrals WHERE id = ?1`).bind(id),
      db.prepare(currentPolicySql),
      db.prepare(`SELECT u.id, u.nickname, u.status, u.locale FROM referrals r JOIN users u ON u.id IN (r.referrer_id, r.invitee_id) WHERE r.id = ?1`).bind(id),
      // Counted only while hands are still asked for, and no further than the most a policy can ask.
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM hand_players
            WHERE user_id = (SELECT invitee_id FROM referrals WHERE id = ?1 AND status = 'pending' AND min_hands > 0) LIMIT ?2)`,
        )
        .bind(id, REFERRAL_LIMITS.minHands.max),
      db
        .prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(referrer_paid_at >= ?2), 0) AS today FROM referrals
            WHERE referrer_id = (SELECT referrer_id FROM referrals WHERE id = ?1) AND referrer_status = 'paid'`,
        )
        .bind(id, since),
    ]);
    const row = rowR!.results[0] as Row | undefined;
    if (!row) return { status: null, paid };
    const policy = policyRow(polR!.results[0] as Record<string, unknown> | undefined);
    const people = peopleR!.results as Person[];
    const referrer = people.find((u) => u.id === row.referrerId) ?? null;
    const invitee = people.find((u) => u.id === row.inviteeId) ?? null;
    const caps = capR!.results[0] as { total: number; today: number };
    const plan = planSettlement({
      status: row.status,
      referrerStatus: row.referrerStatus,
      inviteeStatus: row.inviteeStatus,
      minHands: row.minHands,
      createdAt: row.createdAt,
      policy,
      invitee: invitee?.status ?? null,
      referrer: referrer?.status ?? null,
      hands: Number((handsR!.results[0] as { n: number } | undefined)?.n ?? 0),
      paidToday: Number(caps.today),
      paidTotal: Number(caps.total),
      now,
    });
    const done = (): SettleResult => ({ status: row.status, referrerStatus: row.referrerStatus, inviteeStatus: row.inviteeStatus, failure: row.failureCode, paid });
    if (!plan) return done();

    if (plan.close) {
      // Pending sides close unpaid; a side already paid stays paid (and the referral counts as settled).
      await db
        .prepare(
          `UPDATE referrals SET
             invitee_status = CASE invitee_status WHEN 'pending' THEN 'unpaid' ELSE invitee_status END,
             referrer_status = CASE referrer_status WHEN 'pending' THEN 'unpaid' ELSE referrer_status END,
             status = CASE WHEN invitee_status = 'paid' OR referrer_status = 'paid' THEN 'settled' ELSE 'unpaid' END,
             failure_code = ?2, updated_at = ?3
           WHERE id = ?1 AND status = 'pending'`,
        )
        .bind(id, plan.failure, now)
        .run();
      return finish(db, id, paid);
    }

    let raced = false;
    if (plan.invitee === 'pay' && invitee) {
      const r = await applyLedger(
        db,
        {
          userId: row.inviteeId,
          type: 'referral',
          amount: row.inviteeAmount,
          idempotencyKey: `referral:${id}:invitee`,
          refId: id,
          memo: 'referral reward (invited)',
          activeOnly: true,
          guard: { sql: `EXISTS (SELECT 1 FROM referrals WHERE id = ?10 AND status = 'pending' AND invitee_status = 'pending') AND ${NOT_PAUSED}`, params: [id] },
        },
        (ledgerId) => [
          db
            .prepare(`UPDATE referrals SET invitee_status = 'paid', invitee_ledger_id = ?1, invitee_paid_at = ?2, updated_at = ?2 WHERE id = ?3 AND invitee_status = 'pending' AND ${LEDGER_GUARD}`)
            .bind(ledgerId, now, id, ledgerId),
        ],
      );
      if (r.status === 'applied') {
        paid.invitee = row.inviteeAmount;
        await notify(env, invitee, 'invitee', row.inviteeAmount, referrer?.status === 'deleted' ? null : (referrer?.nickname ?? null));
      } else if (r.status === 'insufficient') raced = true;
    }
    if (plan.referrer === 'pay' && referrer) {
      const r = await applyLedger(
        db,
        {
          userId: row.referrerId,
          type: 'referral',
          amount: row.referrerAmount,
          idempotencyKey: `referral:${id}:referrer`,
          refId: id,
          memo: 'referral reward (referrer)',
          activeOnly: true,
          // The caps of the policy in force now, counted in the same statement: two referrals paid at once cannot both
          // take the last place under a cap.
          guard: {
            sql: `EXISTS (SELECT 1 FROM referrals WHERE id = ?10 AND status = 'pending' AND referrer_status = 'pending') AND ${NOT_PAUSED}
              AND (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?9 AND referrer_status = 'paid')
                  < (SELECT total_cap FROM referral_policies ORDER BY version DESC LIMIT 1)
              AND (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?9 AND referrer_status = 'paid' AND referrer_paid_at >= ?11)
                  < (SELECT daily_cap FROM referral_policies ORDER BY version DESC LIMIT 1)`,
            params: [id, since],
          },
        },
        (ledgerId) => [
          db
            .prepare(`UPDATE referrals SET referrer_status = 'paid', referrer_ledger_id = ?1, referrer_paid_at = ?2, updated_at = ?2 WHERE id = ?3 AND referrer_status = 'pending' AND ${LEDGER_GUARD}`)
            .bind(ledgerId, now, id, ledgerId),
        ],
      );
      if (r.status === 'applied') {
        paid.referrer = row.referrerAmount;
        await notify(env, referrer, 'referrer', row.referrerAmount, invitee?.nickname ?? null);
      } else if (r.status === 'insufficient') raced = true;
    } else if (plan.referrer === 'capped' || plan.referrer === 'skipped') {
      await db.prepare(`UPDATE referrals SET referrer_status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'pending' AND referrer_status = 'pending'`).bind(id, plan.referrer, now).run();
    }
    // Something changed between the read and the write (a pause, a cap reached, a suspension): decide again from now.
    if (raced && attempt < 2) continue;

    // Both sides final: settled if either was paid, unpaid if neither. The reason is kept (a cap, a wait).
    const changed = plan.failure !== row.failureCode || plan.invitee || plan.referrer;
    if (changed || opts.touch) {
      await db
        .prepare(
          `UPDATE referrals SET
             status = CASE WHEN invitee_status = 'pending' OR referrer_status = 'pending' THEN status
                           WHEN invitee_status = 'paid' OR referrer_status = 'paid' THEN 'settled' ELSE 'unpaid' END,
             failure_code = ?2, updated_at = ?3
           WHERE id = ?1 AND status = 'pending'`,
        )
        .bind(id, plan.failure, now)
        .run();
    }
    return finish(db, id, paid);
  }
}

async function finish(db: D1Database, id: string, paid: SettleResult['paid']): Promise<SettleResult> {
  const r = await db.prepare(`SELECT ${ROW_COLUMNS} FROM referrals WHERE id = ?1`).bind(id).first<Row>();
  return { status: r?.status ?? null, referrerStatus: r?.referrerStatus, inviteeStatus: r?.inviteeStatus, failure: r?.failureCode ?? null, paid };
}

/** A system message to the member just paid, in their language. A message that fails never undoes the payment. */
async function notify(env: Env, to: Person, side: 'referrer' | 'invitee', amount: number, other: string | null) {
  const n = notices(to.locale === 'en' ? 'en' : 'ko');
  await sendMessages(createDb(env.DB), { userIds: [to.id], category: 'system', ...n.referralPaid(side, amount, other) }).catch((e) => console.error('referral notice', e));
}

/**
 * Settles the member's own pending referrals (as the new member and as the referrer), least recently checked first.
 * Returns the chips paid to this member now.
 */
export async function settleMine(env: Env, userId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, invitee_id = ?1 AS invitee FROM referrals WHERE status = 'pending' AND (invitee_id = ?1 OR referrer_id = ?1) ORDER BY updated_at LIMIT ?2`,
  )
    .bind(userId, MEMBER_SETTLE)
    .all<{ id: string; invitee: number }>();
  let mine = 0;
  for (const r of results) {
    const { paid } = await settleReferral(env, r.id);
    mine += r.invitee ? paid.invitee : paid.referrer;
  }
  return mine;
}

/** For the signup form: whose code it is and what the new member would receive now (nothing about the inviter but the nickname). */
export async function checkReferralCode(db: D1Database, raw: string): Promise<ReferralCodeCheckDto> {
  const referrer = await findReferrer(db, raw);
  if (!referrer) return { valid: false, inviter: null, reward: null };
  const p = await currentPolicy(db);
  return { valid: true, inviter: referrer.nickname, reward: p?.enabled ? { amount: p.inviteeAmount, minHands: p.minHands, paused: p.paused } : null };
}

/**
 * The member's referral card: their code (made now if they had none), the share link, the policy, what the members
 * they invited brought them, and their own reward if they signed up with a code. What can be paid is paid first.
 */
export async function referralMe(env: Env, userId: string, origin: string): Promise<ReferralMeDto> {
  const db = env.DB;
  const paidNow = await settleMine(env, userId);
  const code = await referralCodeOf(db, userId);
  /** A member's nickname, or null once they withdrew (their row keeps only a placeholder). */
  const nickname = (alias: string) => `CASE WHEN ${alias}.status = 'deleted' THEN NULL ELSE ${alias}.nickname END`;
  const [pol, totals, mine, recent] = await db.batch([
    db.prepare(currentPolicySql),
    db
      .prepare(
        `SELECT COUNT(*) AS invited, COALESCE(SUM(referrer_status = 'paid'), 0) AS paid, COALESCE(SUM(referrer_status = 'pending'), 0) AS pending,
                COALESCE(SUM(referrer_status IN ('unpaid', 'capped')), 0) AS unpaid,
                COALESCE(SUM(CASE WHEN referrer_status = 'paid' THEN referrer_amount END), 0) AS earned,
                COALESCE(SUM(CASE WHEN referrer_status = 'pending' THEN referrer_amount END), 0) AS waiting
           FROM referrals WHERE referrer_id = ?1`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT r.status, r.invitee_status AS side, r.invitee_amount AS amount, r.invitee_paid_at AS paidAt, r.failure_code AS failure, r.min_hands AS minHands,
                r.created_at AS createdAt, ${nickname('i')} AS nickname,
                (SELECT COUNT(*) FROM (SELECT 1 FROM hand_players WHERE user_id = ?1 LIMIT ?2)) AS hands
           FROM referrals r LEFT JOIN users i ON i.id = r.referrer_id WHERE r.invitee_id = ?1`,
      )
      .bind(userId, REFERRAL_LIMITS.minHands.max),
    db
      .prepare(
        `SELECT r.status, r.referrer_status AS side, r.referrer_amount AS amount, r.referrer_paid_at AS paidAt, r.failure_code AS failure,
                r.created_at AS createdAt, ${nickname('i')} AS nickname
           FROM referrals r LEFT JOIN users i ON i.id = r.invitee_id WHERE r.referrer_id = ?1 ORDER BY r.created_at DESC LIMIT 20`,
      )
      .bind(userId),
  ]);
  const policy = policyRow(pol!.results[0] as Record<string, unknown> | undefined);
  const t = totals!.results[0] as Record<string, number>;
  const own = mine!.results[0] as (Omit<ReferralInviteeDto, 'handsLeft'> & { minHands: number; hands: number }) | undefined;
  const base = env.APP_ORIGIN ?? origin;
  return {
    code,
    link: `${base}/register?ref=${code}`,
    policy: policy ? publicPolicy(policy) : null,
    counts: { invited: Number(t.invited), paid: Number(t.paid), pending: Number(t.pending), unpaid: Number(t.unpaid) },
    earned: Number(t.earned),
    waiting: Number(t.waiting),
    invitedBy: own
      ? {
          status: own.status,
          side: own.side,
          amount: own.amount,
          paidAt: own.paidAt,
          failure: own.failure,
          handsLeft: Math.max(0, own.minHands - Number(own.hands)),
          createdAt: own.createdAt,
          nickname: own.nickname,
        }
      : null,
    recent: (recent!.results as Omit<ReferralInviteeDto, 'handsLeft'>[]).map((r) => ({ ...r, handsLeft: null })),
    paidNow,
    now: Date.now(),
  };
}

/**
 * The daily cron: clears signup networks older than REFERRAL_IP_DAYS, and settles the pending referrals checked
 * longest ago (nothing pays while payouts are paused, so then only the networks are cleared).
 */
export async function sweepReferrals(env: Env, now = Date.now()) {
  const db = env.DB;
  const cleared = await db.prepare(`UPDATE referrals SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?1`).bind(now - REFERRAL_IP_DAYS * DAY).run();
  const policy = await currentPolicy(db);
  const out = { ipCleared: cleared.meta.changes ?? 0, checked: 0, paid: 0 };
  if (policy?.paused) return out;
  const { results } = await db.prepare(`SELECT id FROM referrals WHERE status = 'pending' ORDER BY updated_at LIMIT ?1`).bind(REFERRAL_SWEEP).all<{ id: string }>();
  for (const r of results) {
    const s = await settleReferral(env, r.id, { now, touch: true });
    out.checked++;
    out.paid += s.paid.invitee + s.paid.referrer;
  }
  return out;
}
