import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, uniq } from '../support/client';
import { root } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
const BOOTSTRAP = 'test-bootstrap-token-0123456789';

/** Registers a user on the player site, then returns a client speaking from the admin origin with the same password. */
async function adminClient(email: string, password = 'password123') {
  const c = new Client(ADMIN_ORIGIN);
  const r = await c.post('/api/admin/auth/login', { email, password });
  return { c, r };
}

let superAdmin: { c: Client; email: string; id: string };

beforeAll(async () => {
  const u = await newUser();
  const anon = new Client(ADMIN_ORIGIN);
  expect((await anon.post('/api/admin/auth/bootstrap', { token: 'wrong-token-wrong-token', email: u.email })).status).toBe(403);
  const b = await anon.post('/api/admin/auth/bootstrap', { token: BOOTSTRAP, email: u.email });
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  const again = await anon.post('/api/admin/auth/bootstrap', { token: BOOTSTRAP, email: u.email });
  expect(again.status).toBe(409);
  const { c, r } = await adminClient(u.email);
  expect(r.status).toBe(200);
  superAdmin = { c, email: u.email, id: u.me.id };
});

async function reauth(c: Client, password = 'password123') {
  const r = await c.post('/api/admin/auth/reauth', { password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('admin authentication & access control', () => {
  it('regular users cannot log in to the admin console or use its API', async () => {
    const u = await newUser();
    const { r } = await adminClient(u.email);
    expect(r.status).toBe(401);
    // a player session cookie is not an admin session
    const viaPlayer = new Client(ADMIN_ORIGIN);
    viaPlayer.cookies = u.client.cookies;
    expect((await viaPlayer.get('/api/admin/dashboard')).status).toBe(401);
    // from the player origin the request is refused before session checks (origin guard)
    expect([401, 403]).toContain((await u.client.get('/api/admin/users')).status);
  });

  it('admin API rejects requests from the player-site origin', async () => {
    const fromWeb = new Client('http://localhost:5173');
    fromWeb.cookies = superAdmin.c.cookies;
    expect((await fromWeb.get('/api/admin/dashboard')).status).toBe(403);
  });

  it('sets a separate SameSite=Strict admin cookie', async () => {
    const res = await fetch(`${process.env.TEST_BASE_URL}/api/admin/auth/login`, {
      method: 'POST',
      headers: { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: superAdmin.email, password: 'password123' }),
    });
    const sc = res.headers.getSetCookie().join(';');
    expect(sc).toMatch(/jc_asid=/);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/HttpOnly/i);
  });

  it('dashboard reports platform figures', async () => {
    const d = await superAdmin.c.get('/api/admin/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.users).toBeGreaterThan(0);
    expect(d.body.tables.total).toBeGreaterThan(0);
    expect(d.body.server.env).toBe('development');
  });
});

describe('member management', () => {
  it('chip adjustment requires password re-confirmation, is idempotent, and cannot go negative', async () => {
    const u = await newUser();
    const key = uniq('adj');
    const first = await superAdmin.c.post(`/api/admin/users/${u.me.id}/chips`, { amount: 500, memo: 'event bonus', idempotencyKey: key });
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('reauth_required');
    expect((await superAdmin.c.post('/api/admin/auth/reauth', { password: 'wrong-password' })).status).toBe(401);
    await reauth(superAdmin.c);
    const ok = await superAdmin.c.post(`/api/admin/users/${u.me.id}/chips`, { amount: 500, memo: 'event bonus', idempotencyKey: key });
    expect(ok.body).toMatchObject({ ok: true, duplicate: false, balanceAfter: 10500 });
    const dup = await superAdmin.c.post(`/api/admin/users/${u.me.id}/chips`, { amount: 500, memo: 'event bonus', idempotencyKey: key });
    expect(dup.body).toMatchObject({ duplicate: true, balanceAfter: 10500 });
    const neg = await superAdmin.c.post(`/api/admin/users/${u.me.id}/chips`, { amount: -999_999, memo: 'too much', idempotencyKey: uniq('neg') });
    expect(neg.status).toBe(409);
    expect((await u.client.get('/api/auth/me')).body.balance).toBe(10500);
    const ledger = (await u.client.get('/api/me/ledger')).body;
    expect(ledger[0]).toMatchObject({ type: 'admin_adjust', amount: 500, memo: 'event bonus' });
    const detail = await superAdmin.c.get(`/api/admin/users/${u.me.id}`);
    expect(detail.body.ledgerConsistent).toBe(true);
    expect(detail.body.user.passwordHash).toBeUndefined();
  });

  it('suspension revokes sessions and blocks login until lifted', async () => {
    const u = await newUser();
    await reauth(superAdmin.c);
    expect((await superAdmin.c.post(`/api/admin/users/${u.me.id}/suspend`, { reason: 'abuse report' })).status).toBe(200);
    expect((await u.client.get('/api/auth/me')).status).toBe(401);
    const login = await new Client().post('/api/auth/login', { email: u.email, password: 'password123' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('suspended');
    expect((await superAdmin.c.post(`/api/admin/users/${u.me.id}/unsuspend`, {})).status).toBe(200);
    expect((await new Client().post('/api/auth/login', { email: u.email, password: 'password123' })).status).toBe(200);
  });

  it('only super admins change roles; demotion ends existing admin sessions immediately', async () => {
    const u = await newUser();
    await reauth(superAdmin.c);
    expect((await superAdmin.c.post(`/api/admin/users/${u.me.id}/role`, { role: 'admin' })).status).toBe(200);
    const { c: adminC, r } = await adminClient(u.email);
    expect(r.status).toBe(200);
    expect((await adminC.get('/api/admin/dashboard')).status).toBe(200);
    // a plain admin cannot change roles
    await reauth(adminC);
    expect((await adminC.post(`/api/admin/users/${superAdmin.id}/role`, { role: 'user' })).status).toBe(403);
    // demote
    expect((await superAdmin.c.post(`/api/admin/users/${u.me.id}/role`, { role: 'user' })).status).toBe(200);
    expect((await adminC.get('/api/admin/dashboard')).status).toBe(401);
  });

  it('issues a one-time password reset link for a member', async () => {
    const u = await newUser();
    await reauth(superAdmin.c);
    const r = await superAdmin.c.post(`/api/admin/users/${u.me.id}/reset-link`, {});
    expect(r.body.path).toMatch(/^\/reset\?token=/);
    const token = decodeURIComponent(r.body.path.split('token=')[1]);
    expect((await new Client().post('/api/auth/password-reset/confirm', { token, newPassword: 'fromadmin123' })).status).toBe(200);
    expect((await new Client().post('/api/auth/login', { email: u.email, password: 'fromadmin123' })).status).toBe(200);
  });
});

describe('table management & game audit', () => {
  it('creates tables with validation; they appear in the lobby', async () => {
    const bad = await superAdmin.c.post('/api/admin/tables', { name: 'Bad', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 50, maxBuyIn: 500 });
    expect(bad.status).toBe(400);
    const ten = await superAdmin.c.post('/api/admin/tables', { name: 'Ten', maxSeats: 10, smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 500 });
    expect(ten.status).toBe(400);
    const ok = await superAdmin.c.post('/api/admin/tables', { name: '로열 테스트', maxSeats: 9, smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000, isPrivate: true, joinCode: 'secret-01' });
    expect(ok.status).toBe(201);
    const u = await newUser();
    const lobby = (await u.client.get('/api/tables')).body as { id: string; isPrivate: boolean }[];
    expect(lobby.find((t) => t.id === ok.body.id)).toMatchObject({ isPrivate: true });
    expect(JSON.stringify(lobby)).not.toMatch(/joinCode|join_code/);
  });

  it('closing a table finishes at a safe point and refunds seated players', async () => {
    const p = await newUser();
    const ws = await TableSocket.open(p.client, 'it-admin-0');
    expect(await ws.request({ t: 'sit', seatIndex: 2, buyIn: 600 })).toMatchObject({ t: 'ack' });
    expect((await p.client.get('/api/auth/me')).body.balance).toBe(9400);
    const live = await superAdmin.c.get('/api/admin/tables/it-admin-0');
    expect(live.body.live.seats.filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify(live.body)).not.toMatch(/holeCards|remainingDeck/);
    const noReauth = new Client(ADMIN_ORIGIN);
    noReauth.cookies = (await adminClient(superAdmin.email)).c.cookies;
    expect((await noReauth.post('/api/admin/tables/it-admin-0/close', {})).status).toBe(401);
    await reauth(superAdmin.c);
    const close = await superAdmin.c.post('/api/admin/tables/it-admin-0/close', {});
    expect(close.status).toBe(200);
    expect(close.body.live).toMatchObject({ closed: true });
    expect((await p.client.get('/api/auth/me')).body.balance).toBe(10000);
    const lobby = (await p.client.get('/api/tables')).body as { id: string }[];
    expect(lobby.some((t) => t.id === 'it-admin-0')).toBe(false);
    ws.close();
  });

  it('audits finished hands (with re-confirmation) and never exposes hands in progress', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await TableSocket.open(a.client, 'it-admin-1');
    const wb = await TableSocket.open(b.client, 'it-admin-1');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.status === 'playing', 15_000);
    await wb.waitState((s) => s.status === 'playing');
    // before the hand ends there is no record to read
    const none = await superAdmin.c.get('/api/admin/hands?tableId=it-admin-1');
    expect(none.body).toEqual([]);
    const actor = isMyTurn(wa.state!) ? wa : wb;
    await actor.act('fold');
    await wa.waitState((s) => s.hand?.stage === 'settled' || (s.hand?.number ?? 0) > 1, 15_000);
    await new Promise((r) => setTimeout(r, 500));
    const list = await superAdmin.c.get('/api/admin/hands?tableId=it-admin-1');
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const id = encodeURIComponent(list.body[list.body.length - 1].id);
    const fresh = (await adminClient(superAdmin.email)).c;
    expect((await fresh.get(`/api/admin/hands/${id}`)).status).toBe(401);
    await reauth(fresh);
    const detail = await fresh.get(`/api/admin/hands/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.settlementBalanced).toBe(true);
    expect(detail.body.players).toHaveLength(2);
    for (const p of detail.body.players) expect(p.holeCards).toHaveLength(2);
    const audit = (await superAdmin.c.get('/api/admin/audit')).body as { action: string }[];
    expect(audit.some((x) => x.action === 'hand.view_sensitive')).toBe(true);
    wa.close();
    wb.close();
  });

  it('reconciliation detects a wallet that no longer matches its ledger', async () => {
    const u = await newUser();
    const clean = await superAdmin.c.post('/api/admin/reconcile/run', {});
    expect(clean.body.mismatches.some((m: { userId: string }) => m.userId === u.me.id)).toBe(false);
    // Simulate corruption outside the application (direct DB write).
    const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
    const r = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', resolve(root, 'tests/.state/main'), '-c', 'apps/api/wrangler.jsonc', '--command', `UPDATE users SET balance = balance + 777 WHERE id = '${u.me.id}'`], { cwd: root, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const run = await superAdmin.c.post('/api/admin/reconcile/run', {});
    expect(run.body.mismatches).toContainEqual(expect.objectContaining({ userId: u.me.id, balance: 10777, ledgerSum: 10000 }));
    const events = (await superAdmin.c.get('/api/admin/reconcile')).body as { id: string; subjectId: string; resolvedAt: number | null }[];
    const ev = events.find((e) => e.subjectId === u.me.id && !e.resolvedAt)!;
    expect(ev).toBeTruthy();
    // running again does not duplicate the open event
    await superAdmin.c.post('/api/admin/reconcile/run', {});
    expect(((await superAdmin.c.get('/api/admin/reconcile')).body as { subjectId: string }[]).filter((e) => e.subjectId === u.me.id)).toHaveLength(1);
    await reauth(superAdmin.c);
    expect((await superAdmin.c.post(`/api/admin/reconcile/${ev.id}/resolve`, { note: 'investigated' })).status).toBe(200);
  });

  it('records administrator actions in the audit log', async () => {
    const audit = (await superAdmin.c.get('/api/admin/audit')).body as { action: string }[];
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['admin.bootstrap', 'admin.login', 'admin.reauth', 'user.chips', 'user.suspend', 'user.role', 'table.create', 'table.close', 'reconcile.run']) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});
