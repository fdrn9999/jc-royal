// Referral rewards (apps/api/src/lib/referral.ts, routes/admin-referral.ts): both members are paid once through the
// ledger whoever settles and however often, a code must be an active member's, one inbox is rewarded once, the
// referrer's caps hold even when signups arrive together, the new member's hands are waited for under the terms they
// signed up with, a burst from one network waits for an operator, off and paused pay nothing, withdrawal closes or
// skips a side, and the policy, the overview and the member panel keep to the permission table.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin, signupBody, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, nextState, TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
const GRANT = 10_000;

interface Policy { version: number; enabled: boolean; paused: boolean; referrerAmount: number; inviteeAmount: number; dailyCap: number; totalCap: number; minHands: number; burstLimit: number }
type Terms = Omit<Policy, 'version' | 'paused'>;
const KEYS = ['enabled', 'referrerAmount', 'inviteeAmount', 'dailyCap', 'totalCap', 'minHands', 'burstLimit'] as const;
/** What this file runs under unless a test says otherwise: no hands asked, caps and review threshold out of the way. */
const ON: Terms = { enabled: true, referrerAmount: 1000, inviteeAmount: 700, dailyCap: 20, totalCap: 100, minHands: 0, burstLimit: 1000 };

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

let plain: Promise<{ c: Client; id: string }> | null = null;
/** An administrator who is not the super admin (the permission table gives them the page, pausing and reviews). */
function plainAdmin() {
  plain ??= (async () => {
    const u = await newUser();
    await d1(promoteSql(`id = '${u.me.id}'`));
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return { c, id: u.me.id };
  })();
  return plain;
}

const policy = async () => (await admin.get('/api/admin/referrals')).body.policy as Policy;
const terms = (p: Policy): Terms => Object.fromEntries(KEYS.map((k) => [k, p[k]])) as Terms;
async function setPolicy(change: Partial<Terms>, reason = 'referral test') {
  await reauth();
  const p = await policy();
  const next = { ...terms(p), ...change };
  if (KEYS.every((k) => next[k] === p[k])) return p;
  const r = await admin.req('PUT', '/api/admin/referrals/policy', { baseVersion: p.version, ...next, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.policy as Policy;
}
async function resume() {
  if (!(await policy()).paused) return;
  await reauth();
  expect((await admin.post('/api/admin/referrals/resume', { reason: 'referral test' })).status).toBe(200);
}

let before: Terms | null = null;
beforeAll(async () => {
  const p = await policy();
  before = terms(p);
  await resume();
  await setPolicy(ON, 'referral test start');
});
const sockets: TableSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  // A test that failed half way leaves neither a pause nor its own terms to the next one.
  await resume();
  await setPolicy(ON, 'referral test reset');
});
afterAll(async () => {
  await resume();
  if (before) await setPolicy(before, 'referral test done');
});

interface Row {
  id: string;
  status: string;
  referrerStatus: string;
  inviteeStatus: string;
  failure: string | null;
  sameIp: number;
  referrerAmount: number;
  inviteeAmount: number;
  minHands: number;
  policyVersion: number;
  ipHash: string | null;
}
const referralOf = async (inviteeId: string) =>
  (
    await d1<Row>(
      `SELECT id, status, referrer_status AS referrerStatus, invitee_status AS inviteeStatus, failure_code AS failure, same_ip AS sameIp,
              referrer_amount AS referrerAmount, invitee_amount AS inviteeAmount, min_hands AS minHands, policy_version AS policyVersion, ip_hash AS ipHash
         FROM referrals WHERE invitee_id = '${inviteeId}'`,
    )
  )[0];
const paidRows = (userId: string) =>
  d1<{ key: string; amount: number; refId: string; memo: string }>(
    `SELECT idempotency_key AS key, amount, ref_id AS refId, memo FROM chip_ledger WHERE user_id = '${userId}' AND type = 'referral' ORDER BY created_at`,
  );
const balance = async (id: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${id}'`))[0]!.balance;
const audits = (action: string, targetId: string) => d1<{ actor_id: string; detail: string }>(`SELECT actor_id, detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}'`);
const cron = async () => expect((await fetch(`${BASE()}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('30 18 * * *')}`)).status).toBe(200);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each member's wallet equals the sum of their ledger rows: nothing was paid outside the ledger, or twice. */
async function ledgerMatches(ids: string[]) {
  const rows = await d1<{ id: string; balance: number; total: number }>(
    `SELECT u.id, u.balance, COALESCE((SELECT SUM(amount) FROM chip_ledger l WHERE l.user_id = u.id), 0) AS total FROM users u WHERE u.id IN (${ids.map((i) => `'${i}'`).join(', ')})`,
  );
  expect(rows).toHaveLength(ids.length);
  for (const r of rows) expect(r.total, r.id).toBe(r.balance);
}

/** A member's referral code (made the first time their card is opened). */
const codeOf = async (c: Client) => (await c.get('/api/me/referral')).body.code as string;

/** Signs up with `code` (or none); the e-mail is verified, as the local server asks. */
async function join(code: string | null, opts: { email?: string; locale?: 'ko' | 'en' } = {}) {
  const client = new Client();
  const email = opts.email ?? `${uniq('r')}@test.dev`;
  const nickname = uniq('rf').slice(0, 14);
  const r = await client.post('/api/auth/register', await signupBody(client, { email, nickname, ...(code === null ? {} : { referralCode: code }), ...(opts.locale ? { locale: opts.locale } : {}) }));
  return { r, client, email, nickname, id: r.body?.id as string };
}
async function joined(code: string, opts: { email?: string; locale?: 'ko' | 'en' } = {}) {
  const j = await join(code, opts);
  expect(j.r.status, JSON.stringify(j.r.body)).toBe(201);
  return j;
}

describe('referral rewards', () => {
  it('pays both members once, through the ledger, however many times and by whomever it is settled', async () => {
    const ref = await newUser(undefined, { locale: 'en' });
    const card = await ref.client.get('/api/me/referral');
    expect(card.status).toBe(200);
    const code = card.body.code as string;
    expect(code).toMatch(/^JC[A-Z2-9]{5}$/);
    expect(card.body).toMatchObject({ link: `http://localhost:5173/register?ref=${code}`, counts: { invited: 0, paid: 0, pending: 0, unpaid: 0 }, earned: 0, waiting: 0, invitedBy: null, recent: [], paidNow: 0 });
    expect(card.body.policy).toMatchObject({ enabled: true, paused: false, referrerAmount: 1000, inviteeAmount: 700, minHands: 0 });
    // The same code every time; the card asks for a signed-in member.
    expect(await codeOf(ref.client)).toBe(code);
    expect((await new Client().get('/api/me/referral')).status).toBe(401);

    // The signup form's check: typed in lower case with spaces it is the same code; nothing about the inviter but the nickname.
    const check = await new Client().get(`/api/auth/referral/${encodeURIComponent(` ${code.toLowerCase()} `)}`);
    expect(check.body).toEqual({ valid: true, inviter: ref.me.nickname, reward: { amount: 700, minHands: 0, paused: false } });
    expect((await new Client().get('/api/auth/referral/JC22')).body).toEqual({ valid: false, inviter: null, reward: null });

    const inv = await joined(code.toLowerCase());
    // Paid at signup: the welcome chips and the reward are separate ledger rows.
    expect(inv.r.body.balance).toBe(GRANT + 700);
    expect(await balance(ref.me.id)).toBe(ref.me.balance + 1000);
    const row = (await referralOf(inv.id))!;
    expect(row).toMatchObject({ status: 'settled', referrerStatus: 'paid', inviteeStatus: 'paid', failure: null, referrerAmount: 1000, inviteeAmount: 700, minHands: 0 });
    // The referrer signed in from the same network (every local client does): a signal only, nothing was refused.
    expect(row.sameIp).toBe(1);

    // Everyone at once: two operators settling, both members' cards, the cron. Nothing more is paid.
    const again = await Promise.all([
      admin.post(`/api/admin/referrals/${row.id}/settle`),
      admin.post(`/api/admin/referrals/${row.id}/settle`),
      ref.client.get('/api/me/referral'),
      inv.client.get('/api/me/referral'),
      cron(),
    ]);
    expect(again[0]!.body).toMatchObject({ ok: true, paid: { invitee: 0, referrer: 0 } });
    expect(again[1]!.body).toMatchObject({ ok: true, paid: { invitee: 0, referrer: 0 } });
    expect(again[2]!.body.paidNow).toBe(0);
    expect(again[3]!.body.paidNow).toBe(0);
    expect(await paidRows(inv.id)).toEqual([{ key: `referral:${row.id}:invitee`, amount: 700, refId: row.id, memo: 'referral reward (invited)' }]);
    expect(await paidRows(ref.me.id)).toEqual([{ key: `referral:${row.id}:referrer`, amount: 1000, refId: row.id, memo: 'referral reward (referrer)' }]);
    await ledgerMatches([inv.id, ref.me.id]);

    // What each card shows.
    const mine = (await ref.client.get('/api/me/referral')).body;
    expect(mine).toMatchObject({ counts: { invited: 1, paid: 1, pending: 0, unpaid: 0 }, earned: 1000, waiting: 0, invitedBy: null });
    expect(mine.recent).toEqual([expect.objectContaining({ status: 'settled', side: 'paid', amount: 1000, nickname: inv.nickname, handsLeft: null })]);
    const theirs = (await inv.client.get('/api/me/referral')).body;
    expect(theirs.invitedBy).toMatchObject({ status: 'settled', side: 'paid', amount: 700, nickname: ref.me.nickname, handsLeft: 0, failure: null });
    expect(theirs.code).not.toBe(code);

    // Both were told once, each in their own language.
    const told = async (c: Client) => ((await c.get('/api/messages')).body as { category: string; title: string; body: string }[]).filter((m) => m.category === 'system' && /추천 보상|Referral reward/.test(m.title));
    expect(await told(ref.client)).toEqual([expect.objectContaining({ title: 'Referral reward paid', body: expect.stringContaining('+1,000') })]);
    expect(await told(inv.client)).toEqual([expect.objectContaining({ title: '추천 보상 지급 안내', body: expect.stringContaining('+700') })]);
  });

  it("refuses a code that is not an active member's at signup and creates no account; an empty code is no code", async () => {
    const gone = await newUser();
    const goneCode = await codeOf(gone.client);
    expect((await gone.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    const held = await newUser();
    const heldCode = await codeOf(held.client);
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${held.me.id}'`);
    try {
      for (const bad of ['JCNOPE22', 'hello', goneCode, heldCode]) {
        const j = await join(bad);
        expect(j.r.status, bad).toBe(400);
        expect(j.r.body.error.code, bad).toBe('referral_invalid');
        expect(await d1(`SELECT id FROM users WHERE email = '${j.email}'`), bad).toEqual([]);
        expect((await new Client().get(`/api/auth/referral/${bad}`)).body.valid, bad).toBe(false);
      }
    } finally {
      await d1(`UPDATE users SET status = 'active' WHERE id = '${held.me.id}'`);
    }
    const plainSignup = await joined('');
    expect(plainSignup.r.body.balance).toBe(GRANT);
    expect(await referralOf(plainSignup.id)).toBeUndefined();
  });

  it("rewards one inbox once: the referrer's own address with a tag, and a member who withdrew and signs up again, are recorded unpaid", async () => {
    const local = uniq('self');
    const ref = await joined('', { email: `${local}@test.dev` });
    const code = await codeOf(ref.client);
    const before = await balance(ref.id);

    const alias = await joined(code, { email: `${local}+second@test.dev` });
    expect(await referralOf(alias.id)).toMatchObject({ status: 'unpaid', referrerStatus: 'unpaid', inviteeStatus: 'unpaid', failure: 'repeat_email' });
    expect(alias.r.body.balance).toBe(GRANT);

    const other = await newUser();
    const otherCode = await codeOf(other.client);
    const first = await joined(otherCode);
    expect((await referralOf(first.id))!.status).toBe('settled');
    expect((await first.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    // The paid referral stays as it was (its ledger rows name it).
    expect((await referralOf(first.id))!).toMatchObject({ status: 'settled', inviteeStatus: 'paid', referrerStatus: 'paid' });
    const back = await joined(code, { email: first.email });
    const tagged = await joined(otherCode, { email: first.email.replace('@', '+again@') });
    for (const j of [back, tagged]) {
      expect(await referralOf(j.id)).toMatchObject({ status: 'unpaid', failure: 'repeat_email' });
      expect(await paidRows(j.id)).toEqual([]);
    }
    expect(await balance(ref.id)).toBe(before);
    expect(await paidRows(other.me.id)).toHaveLength(1);
  });

  it("caps the referrer per day and in total even when signups arrive at once; the new members are paid all the same", async () => {
    await setPolicy({ dailyCap: 1, totalCap: 2 });
    const ref = await newUser();
    const code = await codeOf(ref.client);
    const three = await Promise.all([joined(code), joined(code), joined(code)]);
    const rows = await Promise.all(three.map((j) => referralOf(j.id)));
    expect(rows.map((r) => r!.inviteeStatus)).toEqual(['paid', 'paid', 'paid']);
    expect(rows.map((r) => r!.status)).toEqual(['settled', 'settled', 'settled']);
    expect(rows.map((r) => r!.referrerStatus).sort()).toEqual(['capped', 'capped', 'paid']);
    expect(rows.filter((r) => r!.referrerStatus === 'capped').map((r) => r!.failure)).toEqual(['daily_cap', 'daily_cap']);
    expect(await paidRows(ref.me.id)).toHaveLength(1);

    // A capped side is final; the total cap counts what was paid (a daily cap may not exceed it).
    await setPolicy({ dailyCap: 2, totalCap: 2 });
    for (const r of rows) expect((await admin.post(`/api/admin/referrals/${r!.id}/settle`)).body.paid).toEqual({ invitee: 0, referrer: 0 });
    const fourth = await joined(code);
    expect(await referralOf(fourth.id)).toMatchObject({ referrerStatus: 'paid', inviteeStatus: 'paid' });
    const fifth = await joined(code);
    expect(await referralOf(fifth.id)).toMatchObject({ referrerStatus: 'capped', inviteeStatus: 'paid', failure: 'total_cap', status: 'settled' });
    expect(await balance(ref.me.id)).toBe(ref.me.balance + 2000);
    await ledgerMatches([ref.me.id, ...[...three, fourth, fifth].map((j) => j.id)]);
    const mine = (await ref.client.get('/api/me/referral')).body;
    expect(mine).toMatchObject({ counts: { invited: 5, paid: 2, pending: 0, unpaid: 3 }, earned: 2000 });
  });

  it('waits for the hands the new member signed up under, whatever the policy says later, and pays once a hand is finished', async () => {
    await setPolicy({ minHands: 1 });
    const ref = await newUser();
    const code = await codeOf(ref.client);
    const inv = await joined(code);
    expect(inv.r.body.balance).toBe(GRANT);
    expect(await referralOf(inv.id)).toMatchObject({ status: 'pending', referrerStatus: 'pending', inviteeStatus: 'pending', failure: 'hands', minHands: 1, inviteeAmount: 700 });
    expect((await inv.client.get('/api/me/referral')).body.invitedBy).toMatchObject({ status: 'pending', side: 'pending', amount: 700, handsLeft: 1, failure: 'hands' });
    expect((await ref.client.get('/api/me/referral')).body).toMatchObject({ counts: { invited: 1, paid: 0, pending: 1, unpaid: 0 }, waiting: 1000 });

    // A later change applies to signups from then on: this referral keeps one hand and its amounts.
    await setPolicy({ minHands: 3, inviteeAmount: 300, referrerAmount: 500 });

    const opp = await newUser();
    const wa = await TableSocket.open(inv.client, 'it-ref-0');
    const wb = await TableSocket.open(opp.client, 'it-ref-0');
    sockets.push(wa, wb);
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 100 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 100 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => !!s.hand && s.hand.stage !== 'settled', 20_000, 'a hand dealt');
    for (let i = 0; i < 40; i++) {
      const s = wa.state!;
      if (!s.hand || s.hand.stage === 'settled') break;
      const me = [wa, wb].find((w) => isMyTurn(w.state!));
      if (me) await me.act(me.state!.you.legal.some((l) => l.type === 'fold') ? 'fold' : 'check');
      else await nextState([wa, wb]);
    }
    for (const w of [wa, wb]) expect(await w.request({ t: 'leave' })).toMatchObject({ t: 'ack' });

    // The new member's card settles it (the hand is written when it ends).
    let card: { paidNow: number; invitedBy: { side: string } } | null = null;
    for (let i = 0; i < 40; i++) {
      card = (await inv.client.get('/api/me/referral')).body;
      if (card!.invitedBy.side === 'paid') break;
      await pause(500);
    }
    expect(card!.invitedBy).toMatchObject({ side: 'paid', status: 'settled', handsLeft: 0 });
    expect(await paidRows(inv.id)).toEqual([expect.objectContaining({ amount: 700 })]);
    expect(await paidRows(ref.me.id)).toEqual([expect.objectContaining({ amount: 1000 })]);
    await ledgerMatches([inv.id, ref.me.id, opp.me.id]);
  });

  it('holds a burst of signups for one referrer from one network for review; approving pays and rejecting closes, once each and audited', async () => {
    await setPolicy({ burstLimit: 2 });
    const ref = await newUser();
    const code = await codeOf(ref.client);
    const a = await joined(code);
    const b = await joined(code);
    const c = await joined(code);
    expect((await referralOf(a.id))!.status).toBe('settled');
    const [rb, rc] = [(await referralOf(b.id))!, (await referralOf(c.id))!];
    for (const r of [rb, rc]) expect(r).toMatchObject({ status: 'review', failure: 'burst', sameIp: 1, referrerStatus: 'pending', inviteeStatus: 'pending' });
    expect(b.r.body.balance).toBe(GRANT);

    // Neither settling, the cards nor the cron pay a referral under review.
    expect((await admin.post(`/api/admin/referrals/${rb.id}/settle`)).body).toMatchObject({ paid: { invitee: 0, referrer: 0 }, referral: { status: 'review' } });
    await b.client.get('/api/me/referral');
    await cron();
    expect(await paidRows(b.id)).toEqual([]);

    // Listed for review with the network signal; never an e-mail address or the network itself.
    const list = await admin.get(`/api/admin/referrals/list?status=review&user=${ref.me.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id).sort()).toEqual([rb.id, rc.id].sort());
    expect(list.body.items.every((i: { sameIp: boolean; failure: string }) => i.sameIp === true && i.failure === 'burst')).toBe(true);
    const shown = JSON.stringify(list.body);
    for (const leak of [b.email, c.email, ref.email, rb.ipHash!, '127.0.0.1']) expect(shown).not.toContain(leak);
    expect((await admin.get('/api/admin/referrals/list?status=nope')).status).toBe(400);

    // A plain administrator may review, after confirming the password.
    const staff = await plainAdmin();
    const noPassword = await staff.c.post(`/api/admin/referrals/${rb.id}/approve`, { reason: 'checked it' });
    expect([noPassword.status, noPassword.body.error.code]).toEqual([401, 'reauth_required']);
    await reauth(staff.c);
    expect((await staff.c.post(`/api/admin/referrals/${rb.id}/approve`, {})).status).toBe(400);

    // Two approvals at once: one pays both sides, the other is told it is no longer under review.
    const both = await Promise.all([staff.c.post(`/api/admin/referrals/${rb.id}/approve`, { reason: 'one dormitory' }), staff.c.post(`/api/admin/referrals/${rb.id}/approve`, { reason: 'one dormitory' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const won = both.find((r) => r.status === 200)!;
    expect(won.body).toMatchObject({ paid: { invitee: 700, referrer: 1000 }, referral: { status: 'settled', reviewReason: 'one dormitory' } });
    expect(both.find((r) => r.status === 409)!.body.error.code).toBe('referral_not_in_review');
    expect(await paidRows(b.id)).toHaveLength(1);

    const rejected = await staff.c.post(`/api/admin/referrals/${rc.id}/reject`, { reason: 'same person twice' });
    expect(rejected.body.referral).toMatchObject({ status: 'unpaid', referrerStatus: 'unpaid', inviteeStatus: 'unpaid', failure: 'rejected' });
    expect((await staff.c.post(`/api/admin/referrals/${rc.id}/approve`, { reason: 'changed mind' })).body.error.code).toBe('referral_not_in_review');
    expect((await staff.c.post(`/api/admin/referrals/${rc.id}/reject`, { reason: 'again' })).body.error.code).toBe('referral_final');
    expect(await paidRows(c.id)).toEqual([]);
    expect(await balance(ref.me.id)).toBe(ref.me.balance + 2000);

    // Audited with the reason and both sides' states, nothing about the members.
    const [approved] = await audits('referral.approve', rb.id);
    expect(approved!.actor_id).toBe(staff.id);
    expect(JSON.parse(approved!.detail)).toMatchObject({
      reason: 'one dormitory',
      before: { status: 'review', failure: 'burst' },
      after: { status: 'settled', referrerStatus: 'paid', inviteeStatus: 'paid' },
      paid: { invitee: 700, referrer: 1000 },
    });
    const [closed] = await audits('referral.reject', rc.id);
    expect(JSON.parse(closed!.detail)).toMatchObject({ reason: 'same person twice', after: { status: 'unpaid', failure: 'rejected' } });
    for (const d of [approved!.detail, closed!.detail]) for (const leak of [b.email, c.email, ref.email]) expect(d).not.toContain(leak);
    await ledgerMatches([ref.me.id, a.id, b.id, c.id]);
  });

  it('off: signups are recorded and never paid; paused: payouts wait, any administrator pauses and only a super admin resumes', async () => {
    const ref = await newUser();
    const code = await codeOf(ref.client);
    await setPolicy({ enabled: false });
    expect((await new Client().get(`/api/auth/referral/${code}`)).body).toMatchObject({ valid: true, reward: null });
    const off = await joined(code);
    expect(await referralOf(off.id)).toMatchObject({ status: 'unpaid', referrerStatus: 'unpaid', inviteeStatus: 'unpaid', failure: 'off', referrerAmount: 0, inviteeAmount: 0 });
    // Switching back on does not reach a signup made while off.
    await setPolicy({ enabled: true });
    expect((await admin.post(`/api/admin/referrals/${(await referralOf(off.id))!.id}/settle`)).body.referral.status).toBe('unpaid');
    expect(await paidRows(off.id)).toEqual([]);

    const staff = await plainAdmin();
    await reauth(staff.c);
    expect((await staff.c.post('/api/admin/referrals/pause', { reason: 'x' })).status).toBe(400);
    const paused = await staff.c.post('/api/admin/referrals/pause', { reason: 'looking into a burst' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.policy.paused).toBe(true);
    expect((await staff.c.post('/api/admin/referrals/pause', { reason: 'again' })).body.error.code).toBe('referral_already_paused');
    expect((await new Client().get(`/api/auth/referral/${code}`)).body.reward).toEqual({ amount: 700, minHands: 0, paused: true });

    const held = await joined(code);
    expect(held.r.body.balance).toBe(GRANT);
    const row = (await referralOf(held.id))!;
    expect(row).toMatchObject({ status: 'pending', failure: 'paused', referrerStatus: 'pending', inviteeStatus: 'pending' });
    expect((await held.client.get('/api/me/referral')).body).toMatchObject({ paidNow: 0, invitedBy: { side: 'pending', failure: 'paused' } });
    await cron();
    expect(await paidRows(held.id)).toEqual([]);

    const refused = await staff.c.post('/api/admin/referrals/resume', { reason: 'all clear' });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'forbidden']);
    expect((await policy()).paused).toBe(true);
    await reauth();
    expect((await admin.post('/api/admin/referrals/resume', { reason: 'all clear' })).status).toBe(200);
    expect((await admin.post('/api/admin/referrals/resume', { reason: 'all clear' })).body.error.code).toBe('referral_not_paused');

    // The daily cron pays what waited.
    await cron();
    expect(await referralOf(held.id)).toMatchObject({ status: 'settled', failure: null, referrerStatus: 'paid', inviteeStatus: 'paid' });
    expect(await paidRows(held.id)).toHaveLength(1);
    expect(await paidRows(ref.me.id)).toHaveLength(1);
    const pausedBy = await d1<{ actor_id: string; action: string }>(`SELECT actor_id, action FROM admin_audit_log WHERE action IN ('referral.pause', 'referral.resume') ORDER BY created_at DESC LIMIT 2`);
    expect(pausedBy.map((a) => a.action)).toEqual(['referral.resume', 'referral.pause']);
    expect(pausedBy[1]!.actor_id).toBe(staff.id);
    expect(pausedBy[0]!.actor_id).not.toBe(staff.id);
  });

  it('withdrawal: a new member who leaves is not paid; a referrer who leaves is skipped while the new member is still paid', async () => {
    const ref = await newUser();
    const code = await codeOf(ref.client);
    const ref2 = await newUser();
    const code2 = await codeOf(ref2.client);
    await reauth();
    expect((await admin.post('/api/admin/referrals/pause', { reason: 'hold for the test' })).status).toBe(200);
    const leaver = await joined(code);
    const stays = await joined(code2);

    expect((await leaver.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await referralOf(leaver.id)).toMatchObject({ status: 'unpaid', referrerStatus: 'unpaid', inviteeStatus: 'unpaid', failure: 'invitee_deleted' });

    expect((await ref2.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await referralOf(stays.id)).toMatchObject({ status: 'pending', referrerStatus: 'skipped', inviteeStatus: 'pending', failure: 'referrer_deleted' });
    // The code of a member who left no longer works.
    expect((await new Client().get(`/api/auth/referral/${code2}`)).body.valid).toBe(false);
    expect((await join(code2)).r.body.error.code).toBe('referral_invalid');

    await resume();
    const card = (await stays.client.get('/api/me/referral')).body;
    expect(card.paidNow).toBe(700);
    // The inviter's nickname is not shown once they left.
    expect(card.invitedBy).toMatchObject({ status: 'settled', side: 'paid', nickname: null });
    expect(await referralOf(stays.id)).toMatchObject({ status: 'settled', referrerStatus: 'skipped', inviteeStatus: 'paid', failure: 'referrer_deleted' });
    expect(await paidRows(ref2.me.id)).toEqual([]);
    expect(await paidRows(leaver.id)).toEqual([]);
    expect(await paidRows(ref.me.id)).toEqual([]);
  });

  it('the policy: super admins only, with a reason, a preview and a conflict when two edit at once; the overview agrees with the ledger', async () => {
    await reauth();
    const p = await policy();
    const body = { baseVersion: p.version, ...terms(p), referrerAmount: p.referrerAmount + 100 };
    const preview = await admin.req('PUT', '/api/admin/referrals/policy', { ...body, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, from: { version: p.version, referrerAmount: p.referrerAmount }, to: { version: p.version + 1, referrerAmount: p.referrerAmount + 100, paused: false }, appliesFrom: { terms: 'next_signup', caps: 'next_payout' } });
    expect(typeof preview.body.waiting).toBe('number');
    expect((await policy()).version).toBe(p.version);

    const code = async (b: Record<string, unknown>) => {
      const r = await admin.req('PUT', '/api/admin/referrals/policy', b);
      return [r.status, r.body.error?.code];
    };
    expect(await code(body)).toEqual([400, 'bad_request']);
    expect(await code({ ...body, baseVersion: p.version - 1, reason: 'stale' })).toEqual([409, 'referral_policy_conflict']);
    expect(await code({ ...body, referrerAmount: p.referrerAmount, reason: 'same' })).toEqual([400, 'referral_no_change']);
    expect(await code({ ...body, referrerAmount: 0, inviteeAmount: 0, reason: 'pays nobody' })).toEqual([400, 'referral_nothing_to_pay']);
    expect(await code({ ...body, dailyCap: 10, totalCap: 9, reason: 'caps' })).toEqual([400, 'referral_caps_order']);
    expect(await code({ ...body, referrerAmount: 1_000_001, reason: 'too much' })).toEqual([400, 'bad_request']);
    expect(await code({ ...body, burstLimit: 1, reason: 'too low' })).toEqual([400, 'bad_request']);
    const staff = await plainAdmin();
    await reauth(staff.c);
    const notMine = await staff.c.req('PUT', '/api/admin/referrals/policy', { ...body, reason: 'not mine' });
    expect([notMine.status, notMine.body.error.code]).toEqual([403, 'forbidden']);

    // Two super-admin edits from the same version: the second is told, with the current policy.
    const [x, y] = await Promise.all([
      admin.req('PUT', '/api/admin/referrals/policy', { ...body, reason: 'first edit' }),
      admin.req('PUT', '/api/admin/referrals/policy', { ...body, referrerAmount: p.referrerAmount + 200, reason: 'second edit' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const lost = [x, y].find((r) => r.status === 409)!;
    expect(lost.body.error).toMatchObject({ code: 'referral_policy_conflict', details: { policy: { version: p.version + 1 } } });
    const now = await policy();
    expect(now.version).toBe(p.version + 1);
    const audit = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = 'referral.policy' ORDER BY created_at DESC LIMIT 1`);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ from: { version: p.version, referrerAmount: p.referrerAmount }, to: { version: p.version + 1, referrerAmount: now.referrerAmount } });

    // The overview: every payout row is linked to its referral and the sums agree with the ledger and the economy page.
    const o = (await admin.get('/api/admin/referrals?days=7')).body;
    expect(o.integrity).toMatchObject({ unlinked: 0, ok: true });
    const [sum] = await d1<{ n: number; s: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM chip_ledger WHERE type = 'referral'`);
    expect([o.integrity.ledgerRows, o.integrity.ledgerSum]).toEqual([sum!.n, sum!.s]);
    expect(o.paid.chips).toBe(sum!.s);
    expect(o.period.created).toBeGreaterThanOrEqual(10);
    // Why referrals of this file went unpaid (an approved one no longer says burst).
    for (const [failure, n] of Object.entries({ repeat_email: 3, rejected: 1, off: 1, invitee_deleted: 1, referrer_deleted: 1, daily_cap: 2, total_cap: 1 })) {
      expect(o.period.failures[failure] ?? 0, failure).toBeGreaterThanOrEqual(n);
    }
    expect(o.versions[0].version).toBe(now.version);
    expect((await admin.get('/api/admin/economy?days=7&tz=540')).body.issued.referral).toBe(sum!.s);
    for (const days of [0, 91]) expect((await admin.get(`/api/admin/referrals?days=${days}`)).status).toBe(400);

    // The member panel reads only: a member who never opened their card gets no code from it.
    const quiet = await newUser();
    const panel = await admin.get(`/api/admin/users/${quiet.me.id}/referral`);
    expect(panel.body).toMatchObject({ code: null, invitedBy: null, items: [], hasMore: false });
    expect(await d1(`SELECT code FROM referral_codes WHERE user_id = '${quiet.me.id}'`)).toEqual([]);
    expect((await admin.get('/api/admin/users/nobody-here/referral')).status).toBe(404);
  });
});
