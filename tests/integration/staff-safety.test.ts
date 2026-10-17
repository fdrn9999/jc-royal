// Members and staff: a member cannot block an administrator or the super admin, and cannot report the super admin
// (an administrator can be reported). A block made before the player became staff stays stored but has no effect
// while they are staff.
import { afterEach, describe, expect, it } from 'vitest';
import { newUser, PASSWORD, sharedAdmin } from '../support/client';
import { TableSocket } from '../support/ws';

/** The bootstrapped super admin. */
const admin = sharedAdmin();
type User = Awaited<ReturnType<typeof newUser>>;
const open: TableSocket[] = [];
const promoted: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  // Nobody made staff here stays staff for the other test files.
  for (const id of promoted.splice(0)) await setRole(id, 'user');
});

async function setRole(userId: string, role: 'user' | 'admin' | 'super_admin') {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (!until || until - Date.now() < 60_000) expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const r = await admin.post(`/api/admin/users/${userId}/role`, { role, reason: 'staffing change' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (role !== 'user' && !promoted.includes(userId)) promoted.push(userId);
}

const relation = async (x: User, y: User) => (await x.client.get(`/api/friends/${y.me.id}/relation`)).body.relation as string;
const blocked = async (x: User) => ((await x.client.get('/api/blocks')).body as { id: string }[]).map((b) => b.id);
const dmUnread = async (x: User) => (await x.client.get('/api/messages/unread-count')).body.dmUnread as number;

describe('blocking staff', () => {
  it('administrators and the super admin cannot be blocked', async () => {
    const a = await newUser();
    const mod = await newUser();
    const boss = await newUser();
    await setRole(mod.me.id, 'admin');
    await setRole(boss.me.id, 'super_admin');
    for (const s of [mod, boss]) {
      const r = await a.client.req('PUT', `/api/blocks/${s.me.id}`);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('block_staff');
      expect(await relation(a, s)).not.toBe('blocked');
    }
    expect(await blocked(a)).toEqual([]);
  });

  it('a block from before the promotion has no effect while they are staff, and applies again if they step down', async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
    expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: 'hello' })).status).toBe(201);
    expect(await dmUnread(a)).toBe(1);

    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect(await relation(a, b)).toBe('blocked');
    expect(await blocked(a)).toEqual([b.me.id]);
    expect(await dmUnread(a)).toBe(0);

    await setRole(b.me.id, 'admin');
    // Not listed, not counted against them: staff can reach the member (a friend request, the unread badge).
    expect(await relation(a, b)).toBe('none');
    expect(await relation(b, a)).toBe('none');
    expect(await blocked(a)).toEqual([]);
    expect(await dmUnread(a)).toBe(1);
    expect((await b.client.post('/api/friends/requests', { userId: a.me.id })).status).toBe(201);
    expect(await relation(a, b)).toBe('incoming');

    // Back to member: the stored block applies again (it came first, so it wins over the pending request).
    await setRole(b.me.id, 'user');
    expect(await relation(a, b)).toBe('blocked');
    expect(await blocked(a)).toEqual([b.me.id]);
    expect(await dmUnread(a)).toBe(0);
    expect((await a.client.req('DELETE', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect(await relation(a, b)).not.toBe('blocked');
  });
});

describe('reporting staff', () => {
  it('the super admin cannot be reported; an administrator can, like any member', async () => {
    const a = await newUser();
    const mod = await newUser();
    const boss = await newUser();
    await setRole(mod.me.id, 'admin');
    await setRole(boss.me.id, 'super_admin');
    for (const u of [a, mod, boss]) open.push(await TableSocket.open(u.client, 'it-staff-0'));
    const body = (targetId: string) => ({ targetType: 'player', targetId, tableId: 'it-staff-0', reason: 'abuse' });

    const refused = await a.client.post('/api/reports', body(boss.me.id));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('report_super_admin');
    const filed = await a.client.post('/api/reports', body(mod.me.id));
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    // The refusal applies to anyone reporting the super admin, staff included.
    expect((await mod.client.post('/api/reports', body(boss.me.id))).body.error.code).toBe('report_super_admin');

    const items = (await admin.get(`/api/admin/reports?userId=${boss.me.id}`)).body.items as unknown[];
    expect(items).toEqual([]);
  });
});