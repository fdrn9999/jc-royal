// Administrator permissions and the audit trail: the permission table's refusals, failed attempts on the audit log, the
// audit log's search and pages, console sessions, role and status changes applied on the next request, and previews
// that write nothing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { root } from '../support/worker';
import { TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
/** The bootstrapped super admin. */
const admin = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** Re-confirms the password unless the window is still open (re-confirmation is rate limited per account). */
async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function signIn(email: string) {
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

/** A new member made a plain administrator in D1, signed in to the console. */
async function plainAdmin() {
  const u = await newUser();
  await d1(`UPDATE users SET role = 'admin' WHERE id = '${u.me.id}'`);
  return { ...u, c: await signIn(u.email) };
}

type Row = { action: string; outcome: string; actor: string; target: string | null; detail: string | null };
const rows = (where: string) =>
  d1<Row>(`SELECT action, outcome, actor_id AS actor, target_id AS target, detail FROM admin_audit_log WHERE ${where} ORDER BY created_at, rowid`);
const del = (c: Client, p: string) => c.req('DELETE', p);
const meId = async (c: Client) => (await c.get('/api/admin/auth/me')).body.user.id as string;

describe('permission table', () => {
  it('refuses super-admin-only actions to plain administrators and records each attempt as failed', async () => {
    const staff = await plainAdmin();
    const member = await newUser();
    await reauth(staff.c);
    const role = await staff.c.post(`/api/admin/users/${member.me.id}/role`, { role: 'admin', reason: 'promote me please' });
    expect(role.status).toBe(403);
    expect(role.body.error.message).toBe('super admin only');
    expect((await staff.c.post('/api/admin/users/export', { userIds: [member.me.id] })).status).toBe(403);

    const failed = await rows(`actor_id = '${staff.me.id}' AND outcome = 'failed'`);
    const roleRow = failed.find((r) => r.action === 'user.role.failed')!;
    expect(roleRow).toMatchObject({ target: member.me.id });
    expect(JSON.parse(roleRow.detail!)).toMatchObject({ status: 403, code: 'forbidden', message: 'super admin only', route: 'POST /users/:id/role' });
    // The request body is never kept.
    expect(roleRow.detail).not.toContain('promote me');
    expect(failed.some((r) => r.action === 'user.export.failed')).toBe(true);

    // What the console shows: the role's abilities and the read-only table.
    const me = (await staff.c.get('/api/admin/auth/me')).body;
    expect(me.permissions).toEqual([]);
    const table = (await staff.c.get('/api/admin/security/permissions')).body;
    expect(table.role).toBe('admin');
    expect(table.features.find((f: { feature: string }) => f.feature === 'roles')).toMatchObject({ admin: 'none', reauth: 'all' });
    expect(table.features.find((f: { feature: string }) => f.feature === 'dashboard')).toMatchObject({ admin: 'all', reauth: 'none' });
    expect((await admin.get('/api/admin/auth/me')).body.permissions).toEqual(expect.arrayContaining(['members.export', 'audit.all', 'sessions.all']));
  });

  it('every admin route refuses the wrong caller: no session, a member session, the player site, a plain admin on super-admin routes, and no fresh password', async () => {
    // The permission table lists every admin route (a unit test holds the two together), so walking it walks them all.
    const source = readFileSync(resolve(root, 'apps/api/src/lib/permissions.ts'), 'utf8');
    const routes = [...source.matchAll(/^\s+'(GET|POST|PUT|PATCH|DELETE) (\/[^']*)': r\('[^']+', '[^']+'(.*)\),?\r?$/gm)].map((m) => ({
      method: m[1]!,
      path: m[2]!,
      superOnly: /role: CAPABILITIES/.test(m[3]!),
      reauth: /\breauth\b/.test(m[3]!),
    }));
    expect(routes.length).toBe(source.match(/^\s+'(GET|POST|PUT|PATCH|DELETE) /gm)!.length);
    expect(routes.length).toBeGreaterThan(55);
    expect(routes.filter((r) => r.superOnly).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['POST /referrals/resume', 'POST /refill/resume', 'POST /tournament-templates', 'POST /tournament-templates/:id/status', 'POST /users/:id/role', 'POST /users/export', 'PUT /bots/policy', 'PUT /referrals/policy', 'PUT /refill/policy', 'PUT /time-bank/policy', 'PUT /tournament-templates/:id']);

    const member = await newUser();
    const staff = await plainAdmin();
    // A valid console session, but from the player site.
    const fromWeb = new Client('http://localhost:5173');
    fromWeb.cookies = admin.cookies;
    // A member's own (player) session, presented to the console.
    const memberAtConsole = new Client(ADMIN_ORIGIN);
    memberAtConsole.cookies = member.client.cookies;
    const nobody = new Client(ADMIN_ORIGIN);
    const call = (c: Client, r: (typeof routes)[number]) => {
      const path = `/api/admin${r.path.replace(':noteId', 'sweep-note').replace(':id', r.path.startsWith('/users/') ? member.me.id : 'sweep-missing')}`;
      return c.req(r.method, path, r.method === 'GET' ? undefined : {});
    };
    const wrong: string[] = [];
    const expectStatus = (who: string, r: (typeof routes)[number], got: { status: number; body: any }, status: number, code?: string) => {
      if (got.status !== status || (code && got.body?.error?.code !== code)) wrong.push(`${who} ${r.method} ${r.path}: ${got.status} ${JSON.stringify(got.body?.error ?? null)}`);
    };
    for (const r of routes) {
      expectStatus('nobody', r, await call(nobody, r), 401);
      expectStatus('member', r, await call(memberAtConsole, r), 401);
      expectStatus('player site', r, await call(fromWeb, r), 403);
      // A plain administrator who has not confirmed the password: super-admin routes first, then the password.
      if (r.superOnly) expectStatus('plain admin', r, await call(staff.c, r), 403, 'forbidden');
      else if (r.reauth) expectStatus('plain admin', r, await call(staff.c, r), 401, 'reauth_required');
    }
    expect(wrong).toEqual([]);

    // None of it changed the member, and the plain administrator's only records are the refused super-admin calls.
    expect(await d1(`SELECT status, role, balance, suspended_reason AS reason FROM users WHERE id = '${member.me.id}'`)).toEqual([{ status: 'active', role: 'user', balance: member.me.balance, reason: null }]);
    expect((await member.client.get('/api/auth/me')).status).toBe(200);
    expect((await rows(`actor_id = '${staff.me.id}' AND action <> 'admin.login'`)).map((r) => `${r.action} ${r.outcome}`).sort()).toEqual(['bots.policy.failed failed', 'referral.policy.failed failed', 'referral.resume.failed failed', 'refill.policy.failed failed', 'refill.resume.failed failed', 'timebank.policy.failed failed', 'tournament_template.create.failed failed', 'tournament_template.status.failed failed', 'tournament_template.update.failed failed', 'user.export.failed failed', 'user.role.failed failed']);
  });

  it('records failed changes and refusals, but not a missing password confirmation or a read that found nothing', async () => {
    const staff = await plainAdmin();
    const [member, other] = [await newUser(), await newUser()];
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${other.me.id}'`);

    // 401: the console asks for the password and retries; nothing is recorded.
    expect((await staff.c.post(`/api/admin/users/${member.me.id}/suspend`, { reason: 'spam links' })).status).toBe(401);
    expect(await rows(`actor_id = '${staff.me.id}' AND target_id = '${member.me.id}'`)).toEqual([]);
    // A read that found nothing: not recorded.
    expect((await staff.c.get('/api/admin/users/no-such-member')).status).toBe(404);
    // A refusal by the route (an administrator as the target), and a change the input stopped.
    await reauth(staff.c);
    expect((await staff.c.post(`/api/admin/users/${other.me.id}/suspend`, { reason: 'under review' })).status).toBe(403);
    expect((await staff.c.post('/api/admin/tables', { name: 'x' })).status).toBe(400);

    const failed = await rows(`actor_id = '${staff.me.id}' AND outcome = 'failed'`);
    expect(failed.map((r) => r.action).sort()).toEqual(['table.create.failed', 'user.suspend.failed']);
    expect(JSON.parse(failed.find((r) => r.action === 'user.suspend.failed')!.detail!)).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'only a super admin can suspend administrators',
    });
    expect(JSON.parse(failed.find((r) => r.action === 'table.create.failed')!.detail!)).toMatchObject({ status: 400, code: 'bad_request' });
    // A route that writes its own refusal is not recorded twice.
    const key = uniq('adj');
    expect((await staff.c.post(`/api/admin/users/${member.me.id}/chips`, { amount: 100_000, memo: 'too much', idempotencyKey: key })).status).toBe(403);
    const chips = await rows(`actor_id = '${staff.me.id}' AND target_id = '${member.me.id}'`);
    expect(chips.map((r) => [r.action, r.outcome])).toEqual([['user.chips_refused', 'failed']]);
  });

  it('blocking entry through the settings route asks for the password like the table control does; other settings do not', async () => {
    const staff = await plainAdmin();
    const table = 'it-perm-0';
    const blocked = async () => (await d1<{ b: number }>(`SELECT entry_blocked AS b FROM tables WHERE id = '${table}'`))[0]!.b;
    const refused = await staff.c.patch(`/api/admin/tables/${table}`, { entryBlocked: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(refused.body.error.code).toBe('reauth_required');
    expect(await blocked()).toBe(0);
    // A setting that is not an emergency control: no password.
    expect((await staff.c.patch(`/api/admin/tables/${table}`, { name: 'it-perm-0 renamed' })).status).toBe(200);
    // With the password confirmed, the same change goes through, and is undone the same way.
    await reauth(staff.c);
    expect((await staff.c.patch(`/api/admin/tables/${table}`, { entryBlocked: true })).status).toBe(200);
    expect(await blocked()).toBe(1);
    expect((await staff.c.patch(`/api/admin/tables/${table}`, { entryBlocked: false, name: table })).status).toBe(200);
    expect(await blocked()).toBe(0);
  });
});

describe('role and status changes apply on the next request', () => {
  it('a member whose role was taken away in the database is refused and recorded; demotion and suspension end the session', async () => {
    const a = await plainAdmin();
    expect((await a.c.get('/api/admin/dashboard')).status).toBe(200);
    await d1(`UPDATE users SET role = 'user' WHERE id = '${a.me.id}'`);
    const denied = await a.c.get('/api/admin/dashboard');
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe('not an administrator');
    const row = (await rows(`actor_id = '${a.me.id}' AND action = 'admin.access_denied'`))[0]!;
    expect(row.outcome).toBe('failed');
    expect(JSON.parse(row.detail!)).toMatchObject({ status: 403, route: 'GET /dashboard' });

    // Through the console: the role change ends the console sessions at once.
    const b = await plainAdmin();
    await reauth();
    const preview = await admin.post(`/api/admin/users/${b.me.id}/role`, { preview: true, role: 'user' });
    expect(preview.body).toMatchObject({ preview: true, from: 'admin', to: 'user', console: { from: true, to: false }, adminSessions: 1, capabilities: { gained: [], lost: [] } });
    expect((await b.c.get('/api/admin/dashboard')).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${b.me.id}/role`, { role: 'user', reason: 'left the team' })).status).toBe(200);
    expect((await b.c.get('/api/admin/dashboard')).status).toBe(401);

    // A suspended administrator's session ends on the next request too.
    const c = await plainAdmin();
    expect((await admin.post(`/api/admin/users/${c.me.id}/suspend`, { reason: 'account review' })).status).toBe(200);
    expect((await c.c.get('/api/admin/dashboard')).status).toBe(401);
    expect((await admin.post(`/api/admin/users/${c.me.id}/unsuspend`, { reason: 'review done' })).status).toBe(200);
  });
});

describe('console sessions', () => {
  it('lists and ends your own sessions; only a super admin sees and ends other administrators’ sessions', async () => {
    const staff = await plainAdmin();
    const second = await signIn(staff.email);
    const third = await signIn(staff.email);
    const mine = (await staff.c.get('/api/admin/security/sessions')).body;
    expect(mine.scope).toBe('own');
    expect(mine.items).toHaveLength(3);
    expect(mine.items.every((s: { user: { id: string } }) => s.user.id === staff.me.id)).toBe(true);
    expect(mine.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/token/i);

    // Someone else's session: refused (and recorded).
    const superId = await meId(admin);
    const all = (await admin.get('/api/admin/security/sessions')).body;
    expect(all.scope).toBe('all');
    const superSession = all.items.find((s: { user: { id: string }; current: boolean }) => s.user.id === superId && s.current);
    expect(superSession).toBeTruthy();
    expect(all.items.filter((s: { user: { id: string } }) => s.user.id === staff.me.id)).toHaveLength(3);
    const refused = await del(staff.c, `/api/admin/security/sessions/${superSession.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("only a super admin can end other administrators' sessions");
    expect((await rows(`actor_id = '${staff.me.id}' AND action = 'admin.session.end.failed'`))).toHaveLength(1);

    // One of your own: that sign-in ends at once.
    const secondId = mine.items.find((s: { current: boolean; id: string }) => !s.current).id;
    expect((await del(staff.c, `/api/admin/security/sessions/${secondId}`)).body).toMatchObject({ ok: true, current: false });
    const stillIn = [(await second.get('/api/admin/dashboard')).status, (await third.get('/api/admin/dashboard')).status].sort();
    expect(stillIn).toEqual([200, 401]);
    // The others: ended, this one stays.
    expect((await staff.c.post('/api/admin/security/sessions/end-others')).body).toMatchObject({ ok: true, ended: 1 });
    expect((await second.get('/api/admin/dashboard')).status).toBe(401);
    expect((await third.get('/api/admin/dashboard')).status).toBe(401);
    expect((await staff.c.get('/api/admin/dashboard')).status).toBe(200);

    // A super admin ends a plain administrator's session.
    const own = (await staff.c.get('/api/admin/security/sessions')).body.items[0];
    expect((await del(admin, `/api/admin/security/sessions/${own.id}`)).status).toBe(200);
    expect((await staff.c.get('/api/admin/dashboard')).status).toBe(401);
    const ended = await rows(`action = 'admin.session.end' AND target_id = '${staff.me.id}'`);
    expect(ended.map((r) => JSON.parse(r.detail!))).toEqual([
      { sessionId: secondId, own: true, current: false },
      { sessionId: own.id, own: false, current: false },
    ]);
    expect(await rows(`action = 'admin.session.end_others' AND target_id = '${staff.me.id}'`)).toHaveLength(1);
    // Member sessions are not console sessions.
    expect((await del(admin, '/api/admin/security/sessions/no-such-session')).status).toBe(404);
  });
});

describe('audit log search', () => {
  it('filters by actor, action family, outcome, target, time and text, pages by cursor and counts the first page', async () => {
    const staff = await plainAdmin();
    const member = await newUser();
    const t = uniq('memo');
    await reauth(staff.c);
    // Five entries on one member: three adjustments, a note and a refused (large) adjustment.
    for (const n of [1, 2, 3]) expect((await staff.c.post(`/api/admin/users/${member.me.id}/chips`, { amount: n, memo: `${t} ${n}`, idempotencyKey: uniq('k') })).status).toBe(200);
    expect((await staff.c.post(`/api/admin/users/${member.me.id}/notes`, { body: 'handover note' })).status).toBe(200);
    expect((await staff.c.post(`/api/admin/users/${member.me.id}/chips`, { amount: 100_000, memo: `${t} big`, idempotencyKey: uniq('k') })).status).toBe(403);

    const q = (c: Client, s: string) => c.get(`/api/admin/audit?paged=1&${s}`);
    const target = `targetType=user&targetId=${member.me.id}`;
    const first = (await q(admin, `${target}&limit=2`)).body;
    expect(first).toMatchObject({ scope: 'all', total: 5, totalCapped: false });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({ action: 'user.chips_refused', outcome: 'failed', actor: { id: staff.me.id, role: 'admin' }, target: { type: 'user', id: member.me.id, label: member.me.nickname } });
    // Pages: no overlap, no gap, no count after the first.
    const seen = first.items.map((i: { id: string }) => i.id);
    let cursor = first;
    while (cursor.nextBefore) {
      cursor = (await q(admin, `${target}&limit=2&before=${cursor.nextBefore}&beforeId=${cursor.nextBeforeId}`)).body;
      expect(cursor.total).toBeUndefined();
      seen.push(...cursor.items.map((i: { id: string }) => i.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    expect((await q(admin, `${target}&action=user.chips`)).body.total).toBe(3);
    expect((await q(admin, `${target}&action=user.*`)).body.total).toBe(4);
    expect((await q(admin, `${target}&outcome=failed`)).body.items.map((i: { action: string }) => i.action)).toEqual(['user.chips_refused']);
    expect((await q(admin, `actor=${staff.me.id}&q=${encodeURIComponent(t)}`)).body.total).toBe(4);
    expect((await q(admin, `q=${member.me.id}&action=note.create`)).body.total).toBe(1);
    // LIKE wildcards are plain text.
    expect((await q(admin, `${target}&q=${encodeURIComponent('%_')}`)).body.total).toBe(0);
    const later = Date.now() + 60_000;
    expect((await q(admin, `${target}&from=${later}`)).body.total).toBe(0);
    expect((await q(admin, `${target}&to=${later}`)).body.total).toBe(5);
  });

  it('shows a plain administrator only their own entries', async () => {
    const staff = await plainAdmin();
    const member = await newUser();
    await reauth();
    expect((await admin.post(`/api/admin/users/${member.me.id}/notes`, { body: 'note by the super admin' })).status).toBe(200);
    expect((await staff.c.post(`/api/admin/users/${member.me.id}/notes`, { body: 'note by staff' })).status).toBe(200);
    const superId = await meId(admin);
    const mine = (await staff.c.get(`/api/admin/audit?paged=1&targetType=user&targetId=${member.me.id}&actor=${superId}`)).body;
    expect(mine.scope).toBe('own');
    expect(mine.total).toBe(1);
    expect(mine.items[0].actor.id).toBe(staff.me.id);
    const legacy = (await staff.c.get('/api/admin/audit?limit=200')).body as { actorId: string }[];
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((r) => r.actorId === staff.me.id)).toBe(true);
    expect((await admin.get(`/api/admin/audit?paged=1&targetType=user&targetId=${member.me.id}`)).body.total).toBe(2);
  });
});

describe('previews write nothing', () => {
  it('chip adjustment: balance before and after, the duplicate key, and refusals without a refused-adjustment row', async () => {
    const member = await newUser();
    const key = uniq('adj');
    await reauth();
    const body = { amount: 700, memo: 'event prize', idempotencyKey: key };
    const before = await admin.post(`/api/admin/users/${member.me.id}/chips`, { ...body, preview: true });
    expect(before.body).toMatchObject({ preview: true, amount: 700, balanceBefore: 10000, balanceAfter: 10700, large: false, duplicate: false });
    expect(await d1(`SELECT id FROM chip_ledger WHERE idempotency_key = 'admin:${key}'`)).toEqual([]);
    expect((await member.client.get('/api/auth/me')).body.balance).toBe(10000);
    // The same key goes through once; a second preview says it was applied.
    expect((await admin.post(`/api/admin/users/${member.me.id}/chips`, body)).body).toMatchObject({ ok: true, duplicate: false, balanceAfter: 10700 });
    expect((await admin.post(`/api/admin/users/${member.me.id}/chips`, { ...body, preview: true })).body).toMatchObject({ duplicate: true, balanceBefore: 10700, balanceAfter: 10700 });
    const neg = await admin.post(`/api/admin/users/${member.me.id}/chips`, { amount: -50_000, memo: 'too much', idempotencyKey: uniq('neg'), preview: true });
    expect(neg.status).toBe(409);
    const logged = await rows(`target_id = '${member.me.id}' AND action LIKE 'user.chips%'`);
    expect(logged.map((r) => [r.action, r.outcome])).toEqual([
      ['user.chips', 'ok'],
      ['user.chips.failed', 'failed'],
    ]);
    expect(JSON.parse(logged[1]!.detail!)).toMatchObject({ status: 409, code: 'insufficient_balance', preview: true });
  });

  it('suspension, disconnection and table closing: the effect is listed, nothing changes', async () => {
    const t = await admin.post('/api/admin/tables', { name: `미리보기 ${Date.now() % 1000}`, maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 1000 });
    expect(t.status).toBe(201);
    const p = await newUser();
    const ws = await TableSocket.open(p.client, t.body.id);
    open.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 3, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await reauth();

    const suspend = (await admin.post(`/api/admin/users/${p.me.id}/suspend`, { preview: true })).body;
    expect(suspend).toMatchObject({ preview: true, member: { status: 'active' }, sessions: { user: 1, admin: 0 }, seats: [{ tableId: t.body.id, seatIndex: 3, buyIn: 500 }], buyIns: 500 });
    const disconnect = (await admin.post(`/api/admin/users/${p.me.id}/disconnect`, { preview: true, removeFromTable: true })).body;
    expect(disconnect).toMatchObject({ preview: true, removeFromTable: true, seats: [{ tableId: t.body.id }] });
    const close = (await admin.post(`/api/admin/tables/${t.body.id}/close`, { preview: true })).body;
    expect(close).toMatchObject({ preview: true, table: { id: t.body.id, status: 'open' }, seats: [{ userId: p.me.id, seatIndex: 3, buyIn: 500, stack: 500 }], roomAnswered: true });
    // Never another player's cards or the deck.
    expect(JSON.stringify(close)).not.toMatch(/holeCards|remainingDeck|deck/i);

    // Still signed in, seated and open; no sanction or close on record.
    expect((await p.client.get('/api/auth/me')).body.balance).toBe(9500);
    expect((await p.client.get('/api/tables')).body.some((x: { id: string }) => x.id === t.body.id)).toBe(true);
    expect(await rows(`target_id IN ('${p.me.id}', '${t.body.id}') AND action IN ('user.suspend', 'user.disconnect', 'table.close')`)).toEqual([]);

    const closed = await admin.post(`/api/admin/tables/${t.body.id}/close`, {});
    expect(closed.status).toBe(200);
    expect((await p.client.get('/api/auth/me')).body.balance).toBe(10000);
  });

  it('a preview is shown before the password is asked again; the change itself still asks, and the role is checked for both', async () => {
    const staff = await plainAdmin();
    const member = await newUser();
    // Signed in just now, password not confirmed again.
    expect((await staff.c.get('/api/admin/auth/me')).body.reauthValidUntil).toBeNull();
    const preview = await staff.c.post(`/api/admin/users/${member.me.id}/suspend`, { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, member: { status: 'active' } });
    const real = await staff.c.post(`/api/admin/users/${member.me.id}/suspend`, { reason: 'cold session' });
    expect(real.status).toBe(401);
    expect(real.body.error.code).toBe('reauth_required');
    // A route without a preview is not opened by asking for one.
    const link = await staff.c.post(`/api/admin/users/${member.me.id}/reset-link`, { preview: true });
    expect(link.status).toBe(401);
    // Super-admin-only stays so for previews.
    const role = await staff.c.post(`/api/admin/users/${member.me.id}/role`, { preview: true, role: 'admin' });
    expect(role.status).toBe(403);
    expect((await member.client.get('/api/auth/me')).status).toBe(200);
  });
});
