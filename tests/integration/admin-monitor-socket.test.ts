// The control center's socket (GET /ws/admin/monitor, docs/CONTROL_CENTER.md): only a console sign-in of an
// administrator with table duty, from the console's origin, opens one; it carries the grid's counts and rows and, for
// the rooms a page follows, their summaries, with no card anyone holds and no waiting member; a page's frames change
// nothing; and every way a console sign-in or its duty ends closes it, at once or at the hub's next check.
import { afterEach, describe, expect, it } from 'vitest';
import { MONITOR_PRIVATE_KEYS, type TournamentStructure } from '@jc/types';
import { ADMIN_ORIGIN, AdminMonitorSocket, monitorHandshake } from '../support/admin-monitor';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { ALL_GRANTS, promoteSql } from '../support/grants';
import { TableSocket } from '../support/ws';

const TABLE = 'it-mon-ws';
const admin = sharedAdmin();
const open: AdminMonitorSocket[] = [];
const seats: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const s of seats.splice(0)) s.close();
});

async function monitor(c: Client, headers?: Record<string, string>) {
  const s = await AdminMonitorSocket.open(c, { headers });
  open.push(s);
  return s;
}

async function sock(c: Client, tableId: string) {
  const s = await TableSocket.open(c, tableId);
  seats.push(s);
  return s;
}

async function signIn(email: string) {
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

/** A new member made a plain administrator with `grants`, signed in to the console. */
async function staffWith(grants: readonly string[]) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  return { ...u, c: await signIn(u.email) };
}

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  expect((await c.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
}

/** No more events of this type reach the socket: the hub answers a ping only after what it was sent before it. */
async function quiet(s: AdminMonitorSocket, type: string) {
  await s.ping();
  await new Promise((r) => setTimeout(r, 500));
  expect(s.events.filter((e) => e.type === type)).toEqual([]);
}

const PRIVATE_KEYS = [...MONITOR_PRIVATE_KEYS, 'holeCards', 'joinCodeHash', 'join_code_hash', 'live_waitlist_users', 'waitlistUsers'];
const scan = (s: AdminMonitorSocket) => s.frames.join('\n');

describe('who may open the control center socket', () => {
  it('a console sign-in with table duty, from the console origin, and nothing else', async () => {
    // No sign-in; a plain request; another site or no origin at all with the administrator's cookie.
    expect(await monitorHandshake(new Client(ADMIN_ORIGIN))).toBe(401);
    expect((await admin.get('/ws/admin/monitor')).status).toBe(426);
    expect(await monitorHandshake(admin, 'https://evil.example')).toBe(403);
    expect(await monitorHandshake(admin, 'http://localhost:5173')).toBe(403);
    expect(await monitorHandshake(admin, null)).toBe(403);
    // A member's own sign-in is not a console one, from either origin.
    const member = await newUser();
    expect(await monitorHandshake(member.client, 'http://localhost:5173')).toBe(403);
    const asConsole = new Client(ADMIN_ORIGIN);
    asConsole.cookies = new Map(member.client.cookies);
    expect(await monitorHandshake(asConsole)).toBe(401);
    // Every feature but table duty is not enough; table duty alone is.
    expect(await monitorHandshake((await staffWith(ALL_GRANTS.filter((g) => g !== 'tables'))).c)).toBe(403);
    expect((await monitor((await staffWith(['tables'])).c)).hello).toBe(true);
    expect((await monitor(admin)).hello).toBe(true);
  });

  it('keeps at most five pages an administrator, closing the oldest', async () => {
    const staff = await staffWith(['tables']);
    const first = await monitor(staff.c);
    const rest = [];
    for (let i = 0; i < 5; i++) rest.push(await monitor(staff.c));
    expect(await first.waitClose()).toBe(4008);
    for (const s of rest) await s.ping();
    expect(rest.every((s) => !s.closed)).toBe(true);
  });
});

describe('what the socket carries', () => {
  it('the counts a room writes and a followed room’s summaries, with nobody’s cards and no waiting member', async () => {
    const watching = await monitor(admin);
    const grid = await monitor((await staffWith(['tables'])).c);
    const a = await newUser();
    const b = await newUser();
    const w = await newUser();
    const wa = await sock(a.client, TABLE);
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    // Every console page has the grid's counts as the room wrote them to D1.
    for (const s of [watching, grid]) {
      const e = await s.event('admin.monitor.counts', 20_000, (x) => x.resourceId === TABLE && x.counts.seated === 1);
      expect(e.counts).toMatchObject({ bots: 0, playing: false, status: 'open' });
    }

    // One page follows the room (as the page does: the rooms read with follow, then the socket's watch).
    await watching.watch([TABLE]);
    const read = await admin.post('/api/admin/monitor/rooms', { ids: [TABLE], follow: true });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const wb = await sock(b.client, TABLE);
    const ww = await sock(w.client, TABLE);
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await ww.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.hand?.stage === 'preflop' && s.waitlist.length === 1, 20_000, 'a hand and a waitlist');
    const held = [...(wa.state!.seats[0]!.holeCards ?? []), ...((await wb.waitState((s) => !!s.seats[1]?.holeCards?.length)).seats[1]!.holeCards ?? [])];
    expect(held).toHaveLength(4);
    const e = await watching.event('admin.monitor.room', 20_000, (x) => x.resourceId === TABLE && x.room.hand?.stage === 'preflop' && x.room.waitlist === 1);
    expect(e.room.seats.map((s) => [s.userId, s.hasCards])).toEqual([
      [a.me.id, true],
      [b.me.id, true],
    ]);
    expect(e.room.hand!.potTotal).toBe(wa.state!.hand!.potTotal);
    expect(e.revision).toBe(e.room.version);
    await watching.event('admin.monitor.counts', 20_000, (x) => x.resourceId === TABLE && x.counts.seated === 2 && x.counts.waitlist === 1);

    // The page that follows nothing has the counts only; neither page has a card, a private field or who waits.
    await quiet(grid, 'admin.monitor.room');
    for (const s of [watching, grid]) {
      const raw = scan(s);
      for (const card of held) expect(raw).not.toContain(`"${card}"`);
      for (const k of PRIVATE_KEYS) expect(raw).not.toContain(`"${k}"`);
      expect(raw).not.toContain(w.me.id);
      expect(raw).not.toContain(w.me.nickname);
    }
    // Watching is not spectating: the room counted no one (the waiting member is not a spectator either).
    expect((await d1<{ n: number }>(`SELECT live_spectators AS n FROM tables WHERE id = '${TABLE}'`))[0]!.n).toBe(0);
    expect(wa.state!.spectatorCount).toBe(0);

    // A table switch from the existing control route reaches every page as the row D1 now has.
    await reauth();
    const block = await admin.post(`/api/admin/tables/${TABLE}/control`, { action: 'block', reason: '관제 소켓 확인' });
    expect(block.status, JSON.stringify(block.body)).toBe(200);
    for (const s of [watching, grid]) {
      const row = await s.event('admin.monitor.table', 15_000, (x) => x.resourceId === TABLE && x.table.entryBlocked);
      expect(row.table.flags).toContain('blocked');
      expect(JSON.stringify(row)).not.toContain('join_code');
    }
    expect((await admin.post(`/api/admin/tables/${TABLE}/control`, { action: 'unblock', reason: '관제 소켓 확인 끝' })).status).toBe(200);
    await grid.event('admin.monitor.table', 15_000, (x) => x.resourceId === TABLE && !x.table.entryBlocked);

    // The table left empty: a room still playing keeps publishing, and the local runtime sends the hub's closes (the
    // tests below) only once the hub has been idle for about ten seconds.
    expect(await ww.request({ t: 'waitlist', join: false })).toMatchObject({ t: 'ack' });
    for (const s of [wa, wb]) expect(await s.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await grid.event('admin.monitor.counts', 30_000, (x) => x.resourceId === TABLE && x.counts.seated === 0 && x.counts.waitlist === 0);
  });

  it('a page’s frames change nothing: no control, no event to other pages, no room it may not follow', async () => {
    const s = await monitor(admin);
    const other = await monitor(admin);
    const before = await d1(`SELECT hands_paused, entry_blocked, status FROM tables WHERE id = 'it-mon-priv'`);
    s.send({ t: 'control', action: 'pause', tables: ['it-mon-priv'] });
    s.send({ t: 'event', e: { type: 'admin.monitor.table', resourceId: 'it-mon-priv', table: { id: 'it-mon-priv', status: 'closed' } } });
    s.send('not json');
    s.send({ t: 'watch', tables: ['a', 'b', 'c', 'd', 'e'] });
    await s.ping();
    await quiet(other, 'admin.monitor.table');
    expect(s.closed).toBeNull();
    expect(await d1(`SELECT hands_paused, entry_blocked, status FROM tables WHERE id = 'it-mon-priv'`)).toEqual(before);
  });
});

/** Sets a member's VIP state as a console page does, from the version it read. */
async function setVip(id: string, reason: string) {
  await reauth();
  const version = (await admin.get(`/api/admin/users/${id}/vip`)).body.version as number;
  const r = await admin.patch(`/api/admin/users/${id}/vip`, { enabled: true, reason, expectedVersion: version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.vip.version as number;
}

const TOURNAMENT: TournamentStructure = {
  name: 'mon',
  capacity: 3,
  minPlayers: 2,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
  ],
  levelMinutes: 5,
  turnSeconds: 10,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};

describe('what a page hears of other administrators’ changes', () => {
  it('a VIP change reaches the pages with the VIP permission, as the version alone; a page cannot ask for more itself', async () => {
    const [vip, tablesOnly, m] = await Promise.all([staffWith(['tables', 'vip']), staffWith(['tables']), newUser()]);
    const [hears, deaf] = [await monitor(vip.c), await monitor(tablesOnly.c)];
    // The list of what a page hears of is the api's, from the grants: one a client sends itself is replaced.
    const forged = await AdminMonitorSocket.open(tablesOnly.c, { headers: { 'x-jc-monitor-kinds': '["vip","tournament"]' } });
    open.push(forged);
    expect(forged.hello).toBe(true);
    const reason = uniq('관제 동기화 사유');
    const version = await setVip(m.me.id, reason);
    const e = await hears.event('admin.monitor.changed', 15_000, (x) => x.resourceId === m.me.id);
    expect(e).toMatchObject({ kind: 'vip', revision: version });
    // The frame as it came: which member and which version, never the color, the reason or who changed it.
    expect(Object.keys(e).sort()).toEqual(['eventId', 'kind', 'occurredAt', 'resourceId', 'revision', 'type']);
    const frame = hears.frames.find((f) => f.includes(e.eventId))!;
    for (const no of [reason, 'gold', (await admin.get('/api/admin/auth/me')).body.user.id as string]) expect(frame).not.toContain(no);
    expect(scan(hears)).not.toContain(reason);
    await quiet(deaf, 'admin.monitor.changed');
    await quiet(forged, 'admin.monitor.changed');
  });

  it('a tournament change reaches the pages with the tournament permission, at each version', async () => {
    const [tn, tablesOnly] = await Promise.all([staffWith(['tables', 'tournaments']), staffWith(['tables'])]);
    const [hears, deaf] = [await monitor(tn.c), await monitor(tablesOnly.c)];
    await reauth();
    const tpl = await admin.post('/api/admin/tournament-templates', { ...TOURNAMENT, name: uniq('mon tpl'), reason: '관제 동기화 확인' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const made = await admin.post('/api/admin/tournaments', { templateId: tpl.body.template.id, templateVersion: tpl.body.template.version, name: uniq('MON') });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const { id, version } = made.body.tournament as { id: string; version: number };
    expect((await hears.event('admin.monitor.changed', 15_000, (x) => x.kind === 'tournament' && x.resourceId === id)).revision).toBe(version);
    const cancel = await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: version, reason: '관제 동기화 확인 끝' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const after = (await admin.get(`/api/admin/tournaments/${id}`)).body.tournament.version as number;
    expect(after).toBeGreaterThan(version);
    await hears.event('admin.monitor.changed', 15_000, (x) => x.resourceId === id && x.revision === after);
    await quiet(deaf, 'admin.monitor.changed');
  });

  it('a permission given closes the page to check again, and the next one hears of what it allows', async () => {
    const staff = await staffWith(['tables']);
    const s = await monitor(staff.c);
    await reauth();
    const { version } = (await admin.get(`/api/admin/security/admins/${staff.me.id}`)).body.admin;
    const put = await admin.req('PUT', `/api/admin/security/admins/${staff.me.id}/grants`, { grants: ['tables', 'vip'], baseVersion: version, reason: 'VIP 업무 추가' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await s.waitClose()).toBe(4000);
    const again = await monitor(staff.c);
    const m = await newUser();
    const v = await setVip(m.me.id, '권한 추가 뒤 확인');
    expect((await again.event('admin.monitor.changed', 15_000, (x) => x.resourceId === m.me.id)).revision).toBe(v);
  });
});

describe('when a console sign-in or its duty ends', () => {
  it('a logout closes that page for good', async () => {
    const staff = await staffWith(['tables']);
    const s = await monitor(staff.c);
    expect((await staff.c.post('/api/admin/auth/logout')).status).toBe(200);
    expect(await s.waitClose()).toBe(4401);
    expect(await monitorHandshake(staff.c)).toBe(401);
  });

  it('switching table duty off closes the page to check again, and the check refuses', async () => {
    const staff = await staffWith(['tables', 'vip']);
    const s = await monitor(staff.c);
    await reauth();
    const { version } = (await admin.get(`/api/admin/security/admins/${staff.me.id}`)).body.admin;
    const put = await admin.req('PUT', `/api/admin/security/admins/${staff.me.id}/grants`, { grants: ['vip'], baseVersion: version, reason: '관제 업무 해제' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await s.waitClose()).toBe(4000);
    expect(await monitorHandshake(staff.c)).toBe(403);
  });

  it('a role taken away ends the console sign-in and its page', async () => {
    const staff = await staffWith(['tables']);
    const s = await monitor(staff.c);
    await reauth();
    const role = await admin.post(`/api/admin/users/${staff.me.id}/role`, { role: 'user', reason: '운영진 해제' });
    expect(role.status, JSON.stringify(role.body)).toBe(200);
    expect(await s.waitClose()).toBe(4401);
    expect(await monitorHandshake(staff.c)).toBe(401);
  });

  it('a suspension, or a disconnect by a super admin, ends the console sign-in and its page at once', async () => {
    const [suspended, disconnected] = await Promise.all([staffWith(['tables']), staffWith(['tables'])]);
    const [a, b] = [await monitor(suspended.c), await monitor(disconnected.c)];
    await reauth();
    const s = await admin.post(`/api/admin/users/${suspended.me.id}/suspend`, { reason: uniq('관제 정지 확인') });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const d = await admin.post(`/api/admin/users/${disconnected.me.id}/disconnect`, { reason: uniq('관제 접속 종료 확인'), removeFromTable: false });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(await Promise.all([a.waitClose(), b.waitClose()])).toEqual([4401, 4401]);
    expect(await monitorHandshake(suspended.c)).toBe(401);
    expect(await monitorHandshake(disconnected.c)).toBe(401);
  });

  it('ending the other sessions keeps the page that asked', async () => {
    const staff = await staffWith(['tables']);
    const here = await monitor(staff.c);
    const there = await monitor(await signIn(staff.email));
    const ended = await staff.c.post('/api/admin/security/sessions/end-others');
    expect(ended.body).toEqual({ ok: true, ended: 1 });
    expect(await there.waitClose()).toBe(4401);
    await here.ping();
    expect(here.closed).toBeNull();
  });

  it('a sign-in or a duty gone from D1 without a revoke is found by the hub’s check', async () => {
    const staff = [];
    for (let i = 0; i < 5; i++) staff.push(await staffWith(['tables']));
    const [gone, offDuty, moreDuty, expired, suspended] = staff.map((s) => s.me.id);
    const pages = [];
    // Each page asks the hub to check far less often (5 min): the api replaces what a page says of it, so the test's
    // 15 s stays, and the closes below arrive in time only so.
    for (const s of staff) pages.push(await monitor(s.c, { 'x-jc-sweep-ms': '300000' }));
    await d1(`DELETE FROM sessions WHERE user_id = '${gone}' AND kind = 'admin'`);
    await d1(`UPDATE admin_permissions SET grants = '["vip"]' WHERE user_id = '${offDuty}'`);
    // A permission added the same way changes what the page may hear of: it too is checked again.
    await d1(`UPDATE admin_permissions SET grants = '["tables","vip"]' WHERE user_id = '${moreDuty}'`);
    // A sign-in run out, and an account no longer active, are not live sign-ins either.
    await d1(`UPDATE sessions SET expires_at = ${Date.now() - 1000} WHERE user_id = '${expired}' AND kind = 'admin'`);
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${suspended}'`);
    // The hub checks every REALTIME_SWEEP_MS (15 s here); the close reaches the client ten seconds later.
    expect(await Promise.all(pages.map((s) => s.waitClose(50_000)))).toEqual([4401, 4000, 4000, 4401, 4401]);
  }, 70_000);
});
