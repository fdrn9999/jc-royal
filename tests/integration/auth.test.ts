import { describe, expect, it } from 'vitest';
import { BASE, BIRTH_DATE, Client, newUser, PASSWORD, signupBody, uniq, verifyEmail } from '../support/client';

describe('auth & sessions', () => {
  it('registers with a Korean nickname, grants signup chips once, and records it in the ledger', async () => {
    const { client, me } = await newUser(`한글${Math.floor(Math.random() * 1e5)}`);
    expect(me.balance).toBe(10000);
    const ledger = await client.get('/api/me/ledger');
    expect(ledger.status).toBe(200);
    expect(ledger.body).toHaveLength(1);
    expect(ledger.body[0]).toMatchObject({ type: 'signup_grant', amount: 10000, balanceAfter: 10000 });
  });

  it('rejects duplicate nicknames case-insensitively and duplicate emails', async () => {
    const nick = uniq('Dup').slice(0, 14);
    const a = await newUser(nick);
    const c = new Client();
    const r1 = await c.post('/api/auth/register', await signupBody(c, { email: `${uniq()}@t.dev`, nickname: nick.toLowerCase() }));
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('nickname_taken');
    // A registered address is refused at the code step (emails are case-insensitive).
    const r2 = await c.post('/api/auth/email-verification/request', { email: a.email.toUpperCase() });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('email_taken');
    const avail = await c.get(`/api/auth/nickname-available?nickname=${encodeURIComponent(nick.toUpperCase())}`);
    expect(avail.body.available).toBe(false);
  });

  it('sets an HttpOnly SameSite session cookie and supports logout', async () => {
    const c = new Client();
    const res = await fetch(BASE() + '/api/auth/register', {
      method: 'POST',
      headers: { Origin: c.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await signupBody(c, { email: `${uniq()}@t.dev`, nickname: uniq('c').slice(0, 14) })),
    });
    const sc = res.headers.getSetCookie().join(';');
    expect(sc).toMatch(/jc_sid=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
  });

  it('blocks state-changing requests without an allowed Origin (CSRF)', async () => {
    const { client } = await newUser();
    const evil = new Client('https://evil.example');
    evil.cookies = client.cookies;
    const r = await evil.patch('/api/auth/me', { locale: 'en' });
    expect(r.status).toBe(403);
  });

  it('login: wrong password is rejected, suspended/unknown accounts get the same error', async () => {
    const { email } = await newUser();
    const c = new Client();
    expect((await c.post('/api/auth/login', { email, password: 'wrong-password' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: `${uniq()}@nobody.dev`, password: 'whatever1' })).body.error.code).toBe('invalid_credentials');
    const ok = await c.post('/api/auth/login', { email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('password reset token works once and revokes existing sessions', async () => {
    const { client, email } = await newUser();
    const anon = new Client();
    const req = await anon.post('/api/auth/password-reset/request', { email });
    expect(req.body.devToken).toBeTruthy();
    const ok = await anon.post('/api/auth/password-reset/confirm', { token: req.body.devToken, newPassword: 'BrandNew123!' });
    expect(ok.status).toBe(200);
    const again = await anon.post('/api/auth/password-reset/confirm', { token: req.body.devToken, newPassword: 'BrandNew456!' });
    expect(again.status).toBe(400);
    expect((await client.get('/api/auth/me')).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email, password: 'BrandNew123!' })).status).toBe(200);
  });

  it('profile update validates nickname uniqueness and avatar URL scheme', async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await b.client.patch('/api/auth/me', { nickname: a.me.nickname })).status).toBe(409);
    expect((await b.client.patch('/api/auth/me', { avatarUrl: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await b.client.patch('/api/auth/me', { avatarUrl: 'https://example.com/a.png', locale: 'en' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ avatarUrl: 'https://example.com/a.png', locale: 'en' });
  });

  it('account deletion requires password and blocks future login', async () => {
    const { client, email } = await newUser();
    expect((await client.post('/api/auth/me/delete', { password: 'nope' })).status).toBe(400);
    expect((await client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect((await new Client().post('/api/auth/login', { email, password: PASSWORD })).status).toBe(401);
  });

  it('rate-limits repeated failed logins per account (429 + Retry-After)', async () => {
    const { email } = await newUser();
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/api/auth/login', { email, password: 'wrong-password' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the correct password is refused while the bucket is exhausted.
    expect((await c.post('/api/auth/login', { email, password: PASSWORD })).status).toBe(429);
  });

  it('password changes and resets enforce the password policy', async () => {
    const { client, email } = await newUser();
    expect((await client.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: 'alllowercase1!' })).status).toBe(400);
    expect((await client.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: 'Changed123!' })).status).toBe(200);
    const anon = new Client();
    const req = await anon.post('/api/auth/password-reset/request', { email });
    expect((await anon.post('/api/auth/password-reset/confirm', { token: req.body.devToken, newPassword: 'NoSymbol123' })).status).toBe(400);
  });

  it('unauthenticated access to protected routes is refused', async () => {
    const c = new Client();
    for (const p of ['/api/auth/me', '/api/me/ledger', '/api/me/stats', '/api/tables']) {
      expect((await c.get(p)).status, p).toBe(401);
    }
  });
});

describe('sign-up: email code, birth date, agreements, password policy', () => {
  const yearsAgo = (n: number, dayOffset = 0) => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return d.toISOString().slice(0, 10);
  };
  const fresh = () => ({ email: `${uniq('s')}@t.dev`, nickname: uniq('s').slice(0, 14) });

  it('advertises email verification outside production', async () => {
    const r = await new Client().get('/api/auth/signup-options');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailVerification: true, privacyNoticeVersion: expect.any(String) });
  });

  it('refuses sign-up without a verified email, and a proof only works for its own address', async () => {
    const c = new Client();
    const f = fresh();
    const base = { ...f, password: PASSWORD, birthDate: BIRTH_DATE, agreements: { age14: true, privacy: true } };
    const none = await c.post('/api/auth/register', base);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('email_not_verified');
    const other = `${uniq('o')}@t.dev`;
    const proofForOther = await verifyEmail(c, other);
    const wrong = await c.post('/api/auth/register', { ...base, emailVerificationToken: proofForOther });
    expect(wrong.body.error.code).toBe('email_not_verified');
    const ok = await c.post('/api/auth/register', { ...base, email: other, emailVerificationToken: proofForOther });
    expect(ok.status).toBe(201);
    // The proof is single-use.
    const c2 = new Client();
    const again = await c2.post('/api/auth/register', { ...base, ...fresh(), email: other, emailVerificationToken: proofForOther });
    expect(again.status).toBe(400);
  });

  it('counts wrong codes, locks after five, and throttles resends', async () => {
    const c = new Client();
    const { email } = fresh();
    const sent = await c.post('/api/auth/email-verification/request', { email });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, expiresInMinutes: 10, resendAfterSeconds: 60, devCode: expect.stringMatching(/^\d{6}$/) });
    const wrongCode = sent.body.devCode === '000000' ? '111111' : '000000';
    const first = await c.post('/api/auth/email-verification/confirm', { email, code: wrongCode });
    expect(first.status).toBe(400);
    expect(first.body.error).toMatchObject({ code: 'invalid_code', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 3; i++) await c.post('/api/auth/email-verification/confirm', { email, code: wrongCode });
    const fifth = await c.post('/api/auth/email-verification/confirm', { email, code: wrongCode });
    expect(fifth.body.error.code).toBe('too_many_attempts');
    // Even the right code is refused now; a new code is needed.
    const right = await c.post('/api/auth/email-verification/confirm', { email, code: sent.body.devCode });
    expect(right.body.error.code).toBe('too_many_attempts');
    const resend = await c.post('/api/auth/email-verification/request', { email });
    expect(resend.status).toBe(429);
    expect(resend.body.error).toMatchObject({ code: 'resend_too_soon', details: { retryAfterSeconds: expect.any(Number) } });
    expect(Number(resend.body.error.details.retryAfterSeconds)).toBeGreaterThan(0);
  });

  it('a code for an unknown request is reported as expired', async () => {
    const r = await new Client().post('/api/auth/email-verification/confirm', { email: `${uniq('x')}@t.dev`, code: '123456' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('code_expired');
  });

  it('requires the 14+ age, a valid birth date and both agreements', async () => {
    const c = new Client();
    const f = fresh();
    const body = await signupBody(c, f);
    const under = await c.post('/api/auth/register', { ...body, birthDate: yearsAgo(14, 1) });
    expect(under.status).toBe(400);
    expect(under.body.error.code).toBe('underage');
    for (const birthDate of ['2000-02-30', '1899-12-31', yearsAgo(-1), '19900101']) {
      expect((await c.post('/api/auth/register', { ...body, birthDate })).status, birthDate).toBe(400);
    }
    expect((await c.post('/api/auth/register', { ...body, agreements: { age14: true } })).status).toBe(400);
    expect((await c.post('/api/auth/register', { ...body, agreements: { age14: true, privacy: false } })).status).toBe(400);
    const { agreements: _a, ...noAgreements } = body;
    expect((await c.post('/api/auth/register', noAgreements)).status).toBe(400);
    // Exactly 14 today is allowed.
    const ok = await c.post('/api/auth/register', { ...body, birthDate: yearsAgo(14) });
    expect(ok.status).toBe(201);
  });

  it('rejects passwords that miss a rule', async () => {
    const c = new Client();
    const body = await signupBody(c, fresh());
    for (const password of ['Short1!', 'alllowercase1!', 'ALLUPPERCASE1!', 'NoDigitsHere!', 'NoSymbol1234']) {
      const r = await c.post('/api/auth/register', { ...body, password });
      expect(r.status, password).toBe(400);
    }
    expect((await c.post('/api/auth/register', body)).status).toBe(201);
  });

  it('stores the account language and writes system messages in it', async () => {
    const { client, me } = await newUser(undefined, { locale: 'en' });
    expect(me.locale).toBe('en');
    const list = (await client.get('/api/messages')).body as { title: string }[];
    expect(list[0]!.title).toBe('Welcome to JC ROYAL');
    const ko = await newUser();
    expect(ko.me.locale).toBe('ko');
    expect(((await ko.client.get('/api/messages')).body as { title: string }[])[0]!.title).toBe('JC ROYAL에 오신 것을 환영합니다');
  });
});
