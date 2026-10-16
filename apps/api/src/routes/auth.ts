import { applyLedger, schema } from '@jc/db';
import {
  ageOn,
  ChangePasswordSchema,
  DeleteAccountSchema,
  EmailVerificationConfirmSchema,
  EmailVerificationRequestSchema,
  isoDate,
  LoginSchema,
  MIN_SIGNUP_AGE,
  PRIVACY_NOTICE_VERSION,
  RegisterSchema,
  ResetConfirmSchema,
  ResetRequestSchema,
  UpdateProfileSchema,
  type EmailVerificationSentDto,
  type MeDto,
  type SignupOptionsDto,
} from '@jc/types';
import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv, AuthUser, Env } from '../env';
import { requireUser } from '../lib/auth';
import { sendMessages } from '../lib/community';
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { mailEnabled, passwordResetMail, sendMail, verificationCodeMail } from '../lib/mail';
import { notices } from '../lib/notices';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { checkReferralCode, findReferrer, recordReferral, settleReferral } from '../lib/referral';
import { refuseSignInInMaintenance } from '../lib/service';
import { createSession, destroySession, renewUserCookie } from '../lib/session';

export function toMe(u: AuthUser): MeDto {
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    role: u.role,
    balance: u.balance,
    locale: u.locale,
    createdAt: u.createdAt,
  };
}

async function loadMe(c: { var: AppEnv['Variables'] }, id: string): Promise<MeDto> {
  const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!u) fail(404, 'not_found', 'user not found');
  return toMe(u);
}

/** D1 reports e.g. "UNIQUE constraint failed: users.email" (possibly wrapped by drizzle in `cause`). */
export function isUniqueViolation(e: unknown, column: string) {
  if (!(e instanceof Error)) return false;
  // Only inspect the constraint target: drizzle's message also embeds the full INSERT statement.
  const text = `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`;
  const target = /UNIQUE constraint failed: ([^:\n]+)/.exec(text)?.[1] ?? '';
  return target.includes(column);
}

const HOUR = 60 * 60 * 1000;
const CODE_MINUTES = 10;
const PROOF_MINUTES = 30;
const RESEND_AFTER_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;

/**
 * Sign-up email verification is on whenever codes can be mailed, and always outside
 * production (the code is returned as `devCode` there). In production without a mail
 * provider it is off, because codes could not reach anyone.
 */
export const emailVerificationOn = (env: Env) => mailEnabled(env) || env.ENVIRONMENT !== 'production';

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= 4_294_000_000);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export const authRoutes = new Hono<AppEnv>()
  .get('/signup-options', (c) => c.json<SignupOptionsDto>({ emailVerification: emailVerificationOn(c.env), privacyNoticeVersion: PRIVACY_NOTICE_VERSION }))
  .post('/email-verification/request', async (c) => {
    const body = await parseBody(c, EmailVerificationRequestSchema);
    if (!emailVerificationOn(c.env)) fail(400, 'verification_off', 'email verification is not enabled');
    await rateLimit(c, `verify-ip:${clientIp(c)}`, 20, HOUR, { perIp: true });
    // Per-address cap so nobody can flood an inbox.
    await rateLimit(c, `verify-email:${body.email}`, 5, HOUR);
    const db = c.var.db;
    const ev = schema.emailVerifications;
    // Sign-up reports a taken address anyway; saying so here saves a pointless mail.
    const taken = await db.query.users.findFirst({ where: eq(schema.users.email, body.email), columns: { id: true } });
    if (taken) fail(409, 'email_taken', 'email already registered');
    const now = Date.now();
    const prev = await db.query.emailVerifications.findFirst({ where: eq(ev.email, body.email), columns: { createdAt: true } });
    const wait = prev ? Math.ceil((prev.createdAt + RESEND_AFTER_SECONDS * 1000 - now) / 1000) : 0;
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      fail(429, 'resend_too_soon', 'wait before requesting another code', { retryAfterSeconds: wait });
    }
    const code = sixDigitCode();
    const row = { codeHash: await codeHash(body.email, code), attempts: 0, expiresAt: now + CODE_MINUTES * 60 * 1000, proofHash: null, verifiedAt: null, createdAt: now };
    await db.batch([
      // Sweep abandoned requests so unregistered addresses do not linger.
      db.delete(ev).where(lt(ev.expiresAt, now - 24 * HOUR)),
      db.insert(ev).values({ email: body.email, ...row }).onConflictDoUpdate({ target: ev.email, set: row }),
    ]);
    if (mailEnabled(c.env)) {
      try {
        await sendMail(c.env, { to: body.email, ...verificationCodeMail({ locale: body.locale, code, origin: c.env.APP_ORIGIN!, minutes: CODE_MINUTES }) });
      } catch (e) {
        console.error('verification mail failed', e);
        await db.delete(ev).where(eq(ev.email, body.email));
        fail(502, 'mail_failed', 'could not send the verification email');
      }
    }
    return c.json<EmailVerificationSentDto>({
      ok: true,
      expiresInMinutes: CODE_MINUTES,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
      ...(c.env.ENVIRONMENT !== 'production' ? { devCode: code } : {}),
    });
  })
  .post('/email-verification/confirm', async (c) => {
    const body = await parseBody(c, EmailVerificationConfirmSchema);
    await rateLimit(c, `verify-confirm:${clientIp(c)}`, 60, HOUR, { perIp: true });
    const db = c.var.db;
    const ev = schema.emailVerifications;
    const now = Date.now();
    // Count the attempt before comparing, atomically, so parallel guesses cannot exceed the cap.
    const [hit] = await db
      .update(ev)
      .set({ attempts: sql`${ev.attempts} + 1` })
      .where(and(eq(ev.email, body.email), isNull(ev.verifiedAt), gt(ev.expiresAt, now), lt(ev.attempts, MAX_CODE_ATTEMPTS)))
      .returning({ attempts: ev.attempts, codeHash: ev.codeHash });
    if (!hit) {
      const row = await db.query.emailVerifications.findFirst({ where: eq(ev.email, body.email), columns: { expiresAt: true, verifiedAt: true } });
      if (row && !row.verifiedAt && row.expiresAt > now) fail(400, 'too_many_attempts', 'too many wrong codes; request a new one');
      fail(400, 'code_expired', 'code expired; request a new one');
    }
    if ((await codeHash(body.email, body.code)) !== hit.codeHash) {
      const left = MAX_CODE_ATTEMPTS - hit.attempts;
      if (left <= 0) fail(400, 'too_many_attempts', 'too many wrong codes; request a new one');
      fail(400, 'invalid_code', 'code does not match', { attemptsLeft: left });
    }
    const token = randomToken();
    await db.update(ev).set({ proofHash: await sha256(token), verifiedAt: now, expiresAt: now + PROOF_MINUTES * 60 * 1000 }).where(eq(ev.email, body.email));
    return c.json({ verificationToken: token, expiresInMinutes: PROOF_MINUTES });
  })
  .post('/register', async (c) => {
    await rateLimit(c, `register:${clientIp(c)}`, 10, HOUR, { perIp: true });
    const body = await parseBody(c, RegisterSchema);
    await refuseSignInInMaintenance(c);
    if (ageOn(body.birthDate, isoDate()) < MIN_SIGNUP_AGE) fail(400, 'underage', `members must be ${MIN_SIGNUP_AGE} or older`);
    const db = c.var.db;
    const ev = schema.emailVerifications;
    let emailVerifiedAt: number | null = null;
    if (body.emailVerificationToken) {
      const proof = await db.query.emailVerifications.findFirst({
        where: and(eq(ev.email, body.email), eq(ev.proofHash, await sha256(body.emailVerificationToken)), gt(ev.expiresAt, Date.now())),
        columns: { verifiedAt: true },
      });
      emailVerifiedAt = proof?.verifiedAt ?? null;
    }
    if (!emailVerifiedAt && emailVerificationOn(c.env)) fail(400, 'email_not_verified', 'verify the email address first');
    const nickTaken = await db.query.users.findFirst({ where: sql`lower(${schema.users.nickname}) = lower(${body.nickname})`, columns: { id: true } });
    if (nickTaken) fail(409, 'nickname_taken', 'nickname already in use');
    // A code that is given must be a member's (active, not a table bot): the form says so before anything is written.
    const referralCode = body.referralCode?.trim() ?? '';
    const referrer = referralCode ? await findReferrer(c.env.DB, referralCode) : null;
    if (referralCode && !referrer) fail(400, 'referral_invalid', 'the referral code is not valid');
    const id = crypto.randomUUID();
    try {
      await db.insert(schema.users).values({
        id,
        email: body.email,
        nickname: body.nickname,
        passwordHash: await hashPassword(body.password, Number(c.env.PBKDF2_ITERATIONS)),
        locale: body.locale,
        birthDate: body.birthDate,
        emailVerifiedAt,
        privacyConsentVersion: PRIVACY_NOTICE_VERSION,
        privacyConsentAt: Date.now(),
      });
    } catch (e) {
      if (isUniqueViolation(e, 'nickname')) fail(409, 'nickname_taken', 'nickname already in use');
      // Same response as a fresh signup would leak nothing, but the user needs to know; keep it generic.
      if (isUniqueViolation(e, 'email')) fail(409, 'email_taken', 'email already registered');
      throw e;
    }
    // The proof is single-use. It survives a failed insert (e.g. a nickname race) so the member can retry.
    if (body.emailVerificationToken) await db.delete(ev).where(eq(ev.email, body.email));
    const grant = Number(c.env.SIGNUP_GRANT);
    if (grant > 0) {
      await applyLedger(c.env.DB, { userId: id, type: 'signup_grant', amount: grant, idempotencyKey: `signup:${id}`, memo: 'welcome chips' });
    }
    await sendMessages(db, { userIds: [id], category: 'system', ...notices(body.locale).welcome(grant) });
    // The referral is recorded under the policy in force now and paid if it may be; a failure here never fails the
    // signup (the referral, if recorded, is paid later by the member's card, the daily cron or an operator).
    if (referrer) {
      try {
        const rid = await recordReferral(c.env, {
          referrer,
          inviteeId: id,
          email: body.email,
          emailVerified: !!emailVerifiedAt,
          verificationRequired: emailVerificationOn(c.env),
          ip: clientIp(c),
        });
        await settleReferral(c.env, rid);
      } catch (e) {
        console.error('referral at signup', e);
      }
    }
    await createSession(c, id, 'user');
    return c.json(await loadMe(c, id), 201);
  })
  /** The signup form's check of a referral code (lib/referral.ts): whose it is and what it gives now. */
  .get('/referral/:code', async (c) => {
    await rateLimit(c, `referral-code:${clientIp(c)}`, 30, 60_000, { perIp: true });
    return c.json(await checkReferralCode(c.env.DB, c.req.param('code').slice(0, 40)));
  })
  .post('/login', async (c) => {
    const body = await parseBody(c, LoginSchema);
    await rateLimit(c, `login-ip:${clientIp(c)}`, 30, 15 * 60 * 1000, { perIp: true });
    await rateLimit(c, `login-acct:${body.email}`, 10, 15 * 60 * 1000);
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.email, body.email) });
    // A table bot's account has no password: it is refused like an unknown address.
    const ok = await verifyPassword(body.password, u && !u.isBot ? u.passwordHash : DUMMY_HASH);
    if (!u || u.isBot || !ok || u.status === 'deleted') fail(401, 'invalid_credentials', 'email or password is incorrect');
    if (u.status === 'suspended') fail(403, 'suspended', u.suspendedReason ?? 'account suspended');
    // After the password check, so the refusal tells nothing to someone who does not know it.
    await refuseSignInInMaintenance(c, u.role);
    await createSession(c, u.id, 'user', body.remember);
    return c.json(toMe(u));
  })
  .post('/logout', async (c) => {
    await destroySession(c, 'user');
    return c.json({ ok: true });
  })
  .post('/password-reset/request', async (c) => {
    const body = await parseBody(c, ResetRequestSchema);
    await rateLimit(c, `reset:${clientIp(c)}`, 5, 60 * 60 * 1000, { perIp: true });
    // Per-address cap, applied whether or not the account exists, so nobody can flood an inbox.
    await rateLimit(c, `reset-email:${body.email}`, 3, 60 * 60 * 1000);
    const u = await c.var.db.query.users.findFirst({ where: and(eq(schema.users.email, body.email), eq(schema.users.status, 'active'), eq(schema.users.isBot, false)) });
    let devToken: string | undefined;
    if (u) {
      const token = randomToken();
      await c.var.db.insert(schema.passwordResets).values({ tokenHash: await sha256(token), userId: u.id, expiresAt: Date.now() + 30 * 60 * 1000 });
      if (mailEnabled(c.env)) {
        const origin = c.env.APP_ORIGIN!;
        const mail = passwordResetMail({ locale: u.locale, nickname: u.nickname, link: `${origin}/reset?token=${encodeURIComponent(token)}`, origin, minutes: 30 });
        // Sent after the response so its latency does not reveal whether the account exists.
        c.executionCtx.waitUntil(sendMail(c.env, { to: u.email, ...mail }).catch((e) => console.error('password reset mail failed', e)));
      }
      // Without a mail provider an admin issues the link from the admin console
      // (docs/ADMIN_SECURITY.md). Outside production the token is also returned
      // so the flow can be exercised.
      if (c.env.ENVIRONMENT !== 'production') devToken = token;
    }
    return c.json({ ok: true, ...(devToken ? { devToken } : {}) });
  })
  .post('/password-reset/confirm', async (c) => {
    const body = await parseBody(c, ResetConfirmSchema);
    await rateLimit(c, `reset-confirm:${clientIp(c)}`, 10, 60 * 60 * 1000, { perIp: true });
    const hash = await sha256(body.token);
    const db = c.var.db;
    const row = await db.query.passwordResets.findFirst({
      where: and(eq(schema.passwordResets.tokenHash, hash), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, Date.now())),
    });
    if (!row) fail(400, 'invalid_token', 'reset link is invalid or expired');
    const newHash = await hashPassword(body.newPassword, Number(c.env.PBKDF2_ITERATIONS));
    await db.batch([
      db.update(schema.passwordResets).set({ usedAt: Date.now() }).where(eq(schema.passwordResets.tokenHash, hash)),
      db.update(schema.users).set({ passwordHash: newHash, updatedAt: Date.now() }).where(eq(schema.users.id, row.userId)),
      db.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId)),
    ]);
    return c.json({ ok: true });
  })
  // ----- authenticated -----
  .get('/me', requireUser, async (c) => {
    renewUserCookie(c);
    return c.json(toMe(c.var.user!));
  })
  .patch('/me', requireUser, async (c) => {
    const body = await parseBody(c, UpdateProfileSchema);
    const me = c.var.user!;
    const db = c.var.db;
    if (body.nickname && body.nickname.toLowerCase() !== me.nickname.toLowerCase()) {
      const taken = await db.query.users.findFirst({
        where: and(sql`lower(${schema.users.nickname}) = lower(${body.nickname})`, ne(schema.users.id, me.id)),
        columns: { id: true },
      });
      if (taken) fail(409, 'nickname_taken', 'nickname already in use');
    }
    try {
      await db
        .update(schema.users)
        .set({
          ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
          ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(schema.users.id, me.id));
    } catch (e) {
      if (isUniqueViolation(e, 'nickname')) fail(409, 'nickname_taken', 'nickname already in use');
      throw e;
    }
    return c.json(await loadMe(c, me.id));
  })
  .get('/nickname-available', async (c) => {
    const nick = c.req.query('nickname') ?? '';
    await rateLimit(c, `nick:${clientIp(c)}`, 60, 60 * 1000, { perIp: true });
    const u = await c.var.db.query.users.findFirst({ where: sql`lower(${schema.users.nickname}) = lower(${nick})`, columns: { id: true } });
    return c.json({ available: !u });
  })
  .post('/me/password', requireUser, async (c) => {
    const body = await parseBody(c, ChangePasswordSchema);
    const me = c.var.user!;
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, me.id) });
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) fail(400, 'invalid_credentials', 'current password is incorrect');
    const hash = await hashPassword(body.newPassword, Number(c.env.PBKDF2_ITERATIONS));
    const db = c.var.db;
    await db.batch([
      db.update(schema.users).set({ passwordHash: hash, updatedAt: Date.now() }).where(eq(schema.users.id, me.id)),
      // Sign out every other device.
      db.delete(schema.sessions).where(and(eq(schema.sessions.userId, me.id), ne(schema.sessions.id, c.var.session!.id))),
    ]);
    return c.json({ ok: true });
  })
  .get('/me/sessions', requireUser, async (c) => {
    const rows = await c.var.db.query.sessions.findMany({
      where: and(eq(schema.sessions.userId, c.var.user!.id), eq(schema.sessions.kind, 'user'), gt(schema.sessions.expiresAt, Date.now())),
      columns: { id: true, createdAt: true, lastSeenAt: true, userAgent: true, ip: true },
    });
    return c.json(rows.map((r) => ({ ...r, current: r.id === c.var.session!.id })));
  })
  .delete('/me/sessions/:id', requireUser, async (c) => {
    await c.var.db.delete(schema.sessions).where(and(eq(schema.sessions.id, c.req.param('id')), eq(schema.sessions.userId, c.var.user!.id)));
    return c.json({ ok: true });
  })
  .post('/me/delete', requireUser, async (c) => {
    const body = await parseBody(c, DeleteAccountSchema);
    const me = c.var.user!;
    const db = c.var.db;
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, me.id) });
    if (!u || !(await verifyPassword(body.password, u.passwordHash))) fail(400, 'invalid_credentials', 'password is incorrect');
    const seated = await db.query.tableSessions.findFirst({ where: and(eq(schema.tableSessions.userId, me.id), eq(schema.tableSessions.status, 'seated')) });
    if (seated) fail(409, 'seated', 'leave all tables before deleting the account');
    const tomb = `deleted-${me.id}`;
    await db.batch([
      db
        .update(schema.users)
        .set({ status: 'deleted', email: `${tomb}@deleted.invalid`, nickname: tomb.slice(0, 24), avatarUrl: null, passwordHash: 'disabled', birthDate: null, lastLoginAt: null, updatedAt: Date.now() })
        .where(eq(schema.users.id, me.id)),
      db.delete(schema.sessions).where(eq(schema.sessions.userId, me.id)),
      // Friends, pending requests and blocks (made by or against the account) go with it.
      db.delete(schema.friendships).where(or(eq(schema.friendships.userA, me.id), eq(schema.friendships.userB, me.id))),
      db.delete(schema.userBlocks).where(or(eq(schema.userBlocks.blockerId, me.id), eq(schema.userBlocks.blockedId, me.id))),
      // 1:1 conversations both ways: the other member can no longer open them, so nothing is kept for anyone. A report
      // already filed keeps its own copy of the reported messages (reports.context) for review.
      db.delete(schema.directMessages).where(or(eq(schema.directMessages.senderId, me.id), eq(schema.directMessages.recipientId, me.id))),
      db.delete(schema.messages).where(eq(schema.messages.userId, me.id)),
      db.delete(schema.academyProgress).where(eq(schema.academyProgress.userId, me.id)),
      db.delete(schema.userBadges).where(eq(schema.userBadges.userId, me.id)),
      db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, me.id)),
      // Administrators' internal notes about the member (sanction reasons stay in the audit log).
      db.delete(schema.adminNotes).where(eq(schema.adminNotes.userId, me.id)),
      // Days the member was active (operations statistics; the day totals already counted stay).
      db.delete(schema.activeDays).where(eq(schema.activeDays.userId, me.id)),
      // The member's referral code stops working. Their referrals stay (ledger rows name them) but close: as the new
      // member, sides not paid yet are not paid; as the referrer, their side is skipped (the new member is still paid).
      db.delete(schema.referralCodes).where(eq(schema.referralCodes.userId, me.id)),
      // The member's own bookmarks, tags and memos on hands (the hands themselves stay, below).
      db.delete(schema.handNotes).where(eq(schema.handNotes.userId, me.id)),
      // Account settings and favourite tables, with what a reset kept to undo it.
      db.delete(schema.userSettings).where(eq(schema.userSettings.userId, me.id)),
      db
        .update(schema.referrals)
        .set({
          inviteeStatus: sql`CASE invitee_status WHEN 'pending' THEN 'unpaid' ELSE invitee_status END`,
          referrerStatus: sql`CASE referrer_status WHEN 'pending' THEN 'unpaid' ELSE referrer_status END`,
          status: sql`CASE WHEN invitee_status = 'paid' OR referrer_status = 'paid' THEN 'settled' ELSE 'unpaid' END`,
          failureCode: 'invitee_deleted',
          updatedAt: Date.now(),
        })
        .where(and(eq(schema.referrals.inviteeId, me.id), inArray(schema.referrals.status, ['pending', 'review']))),
      db
        .update(schema.referrals)
        .set({ referrerStatus: 'skipped', failureCode: 'referrer_deleted', updatedAt: Date.now() })
        .where(and(eq(schema.referrals.referrerId, me.id), eq(schema.referrals.referrerStatus, 'pending'), inArray(schema.referrals.status, ['pending', 'review']))),
      // Kept, under the pseudonymous id only: chip ledger, hands and seats (integrity), posts and comments (shown as
      // a withdrawn member), and reports. See docs/PRIVACY_OPERATIONS.md.
    ]);
    await destroySession(c, 'user');
    return c.json({ ok: true });
  });
