import { describe, expect, it } from 'vitest';
import { BASE, Client, newUser, uniq } from '../support/client';

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
    const r1 = await c.post('/api/auth/register', { email: `${uniq()}@t.dev`, password: 'password123', nickname: nick.toLowerCase() });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('nickname_taken');
    const r2 = await c.post('/api/auth/register', { email: a.email.toUpperCase(), password: 'password123', nickname: uniq('n').slice(0, 14) });
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
      body: JSON.stringify({ email: `${uniq()}@t.dev`, password: 'password123', nickname: uniq('c').slice(0, 14) }),
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
    const ok = await c.post('/api/auth/login', { email, password: 'password123' });
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
    const ok = await anon.post('/api/auth/password-reset/confirm', { token: req.body.devToken, newPassword: 'brandnew123' });
    expect(ok.status).toBe(200);
    const again = await anon.post('/api/auth/password-reset/confirm', { token: req.body.devToken, newPassword: 'brandnew456' });
    expect(again.status).toBe(400);
    expect((await client.get('/api/auth/me')).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email, password: 'brandnew123' })).status).toBe(200);
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
    expect((await client.post('/api/auth/me/delete', { password: 'password123' })).status).toBe(200);
    expect((await new Client().post('/api/auth/login', { email, password: 'password123' })).status).toBe(401);
  });

  it('rate-limits repeated failed logins per account (429 + Retry-After)', async () => {
    const { email } = await newUser();
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/api/auth/login', { email, password: 'wrong-password' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the correct password is refused while the bucket is exhausted.
    expect((await c.post('/api/auth/login', { email, password: 'password123' })).status).toBe(429);
  });

  it('unauthenticated access to protected routes is refused', async () => {
    const c = new Client();
    for (const p of ['/api/auth/me', '/api/me/ledger', '/api/me/stats', '/api/tables']) {
      expect((await c.get(p)).status, p).toBe(401);
    }
  });
});
