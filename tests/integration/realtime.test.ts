// Platform realtime (GET /ws/realtime, docs/REALTIME.md): only a signed-in page from an allowed origin gets a socket,
// a member's events reach only that member's pages, a sign-out (here, on other devices, by an administrator, by a
// suspension) ends the sockets it ends, and nothing a page sends changes anything. Events only say what changed: the
// page reads the balance again, so a grant counted once in D1 is shown once however often its event comes.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { RealtimeSocket } from '../support/realtime';
import { TableSocket } from '../support/ws';

const admin = sharedAdmin();
const open: RealtimeSocket[] = [];
const tables: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const s of tables.splice(0)) s.close();
});

const count = (s: RealtimeSocket, type: string) => s.events.filter((e) => e.type === type).length;

/** No more events of this type reach the socket: the hub answers a ping only after what it was sent before it. */
async function quiet(s: RealtimeSocket, type: string, expected: number) {
  await s.ping();
  await new Promise((r) => setTimeout(r, 500));
  expect(count(s, type)).toBe(expected);
}

async function rt(client: Client, opts: Parameters<typeof RealtimeSocket.open>[1] = {}) {
  const s = await RealtimeSocket.open(client, opts);
  open.push(s);
  return s;
}

async function reauth() {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** The status the api answers a handshake with, 101 when it opens (fetch() forbids the Upgrade header). */
function handshake(client: Client, origin = 'http://localhost:5173'): Promise<number> {
  const u = new URL(`${process.env.TEST_BASE_URL}/ws/realtime`);
  const headers: Record<string, string> = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: origin };
  if (client.cookies.size) headers.Cookie = client.cookieHeader();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('realtime socket: who may open one', () => {
  it('refuses a page without a sign-in and a page from another site', async () => {
    expect(await handshake(new Client())).toBe(401);
    const u = await newUser();
    expect(await handshake(u.client, 'https://evil.example')).toBe(403);
    // a plain request is not a socket
    expect((await u.client.get('/ws/realtime')).status).toBe(426);
    const s = await rt(u.client);
    expect(s.hello).toBe(true);
  });

  it('a console sign-in is not a member sign-in', async () => {
    // the admin session cookie (jc_asid) opens nothing here
    expect(await handshake(admin, 'http://localhost:5174')).toBe(401);
  });
});

describe('realtime socket: personal events', () => {
  it('an admin grant tells only that member, once in D1 however often it is sent', async () => {
    const [target, other] = await Promise.all([newUser(), newUser()]);
    const [mine, second, theirs] = await Promise.all([rt(target.client), rt(target.client), rt(other.client)]);
    await reauth();
    const key = uniq('rt-grant');
    const grant = { amount: 700, memo: 'realtime event bonus', idempotencyKey: key };
    const ok = await admin.post(`/api/admin/users/${target.me.id}/chips`, grant);
    expect(ok.body).toMatchObject({ ok: true, duplicate: false, balanceAfter: 10_700 });
    const e = await mine.event('wallet.changed');
    expect(e).toMatchObject({ scope: 'user', type: 'wallet.changed' });
    // the event says that the wallet changed, never by how much: the page reads the balance
    expect(JSON.stringify(e)).not.toContain('700');
    await mine.event('message.changed');
    // every page of the member, none of another member
    await second.event('wallet.changed');
    await theirs.ping();
    await new Promise((r) => setTimeout(r, 500));
    expect(theirs.events).toEqual([]);

    // The retry (a double click, a lost answer): nothing moves again, so nothing is announced again.
    const before = mine.events.length;
    const dup = await admin.post(`/api/admin/users/${target.me.id}/chips`, grant);
    expect(dup.body).toMatchObject({ ok: true, duplicate: true, balanceAfter: 10_700 });
    await new Promise((r) => setTimeout(r, 500));
    expect(mine.events.length).toBe(before);
    const rows = await d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${target.me.id}' AND type = 'admin_adjust'`);
    expect(rows[0]!.n).toBe(1);
    expect((await target.client.get('/api/auth/me')).body.balance).toBe(10_700);
    // the grant is on record once, with its ledger row
    const audits = await d1<{ n: number }>(`SELECT count(*) AS n FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`);
    expect(audits[0]!.n).toBe(1);
  });

  it('a first try whose audit row was lost gets it on the retry, and still counts once', async () => {
    const target = await newUser();
    await reauth();
    const grant = { amount: 300, memo: 'late audit check', idempotencyKey: uniq('rt-late') };
    expect((await admin.post(`/api/admin/users/${target.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: false });
    // as if the audit insert had failed after the ledger committed
    await d1(`DELETE FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`);
    expect((await admin.post(`/api/admin/users/${target.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: true, balanceAfter: 10_300 });
    const audits = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.detail)).toMatchObject({ amount: 300, late: true });
    const rows = await d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${target.me.id}' AND type = 'admin_adjust'`);
    expect(rows[0]!.n).toBe(1);
  });

  it('nothing a page sends is published or changes anything', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const [sa, sb] = await Promise.all([rt(a.client), rt(b.client)]);
    const forged = { t: 'event', e: { eventId: 'x', occurredAt: Date.now(), scope: 'user', type: 'wallet.changed' } };
    sa.send(forged);
    sa.send({ t: 'publish', users: [b.me.id], event: forged.e });
    sa.send({ t: 'sub', topics: ['admin'] });
    sa.send('not json');
    await sa.ping();
    await sb.ping();
    await new Promise((r) => setTimeout(r, 300));
    expect(sb.events).toEqual([]);
    expect(sa.events).toEqual([]);
    expect(sa.closed).toBeNull();
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(10_000);
  });

  it('a page that floods the socket is closed', async () => {
    const u = await newUser();
    const s = await rt(u.client);
    for (let i = 0; i < 40; i++) s.send({ t: 'sub', topics: ['lobby'] });
    expect(await s.waitClose()).toBe(1008);
  });
});

describe('realtime socket: the account and the wallet', () => {
  it('a VIP change tells only that member, and choosing the color it already has tells nobody', async () => {
    const [m, other] = await Promise.all([newUser(), newUser()]);
    const [mine, theirs] = await Promise.all([rt(m.client), rt(other.client)]);
    await reauth();
    const set = async (body: Record<string, unknown>) => {
      const version = (await admin.get(`/api/admin/users/${m.me.id}/vip`)).body.version as number;
      const r = await admin.patch(`/api/admin/users/${m.me.id}/vip`, { ...body, reason: 'realtime vip', expectedVersion: version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { changed: boolean };
    };
    expect(await set({ enabled: true })).toMatchObject({ changed: true });
    const e = await mine.event('account.changed');
    // what changed is read from /api/auth/me, not carried: no color, no reason, no administrator
    const adminId = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    expect(JSON.stringify(e)).not.toMatch(new RegExp(`gold|realtime vip|${adminId}`));
    expect((await m.client.get('/api/auth/me')).body.vip).toBe('gold');
    expect(await set({ enabled: true })).toMatchObject({ changed: false });
    await quiet(mine, 'account.changed', 1);
    await quiet(theirs, 'account.changed', 0);
  });

  it('a role change tells the member, whose own sign-in stays', async () => {
    const m = await newUser();
    const s = await rt(m.client);
    await reauth();
    expect((await admin.post(`/api/admin/users/${m.me.id}/role`, { role: 'admin', reason: 'realtime role' })).status).toBe(200);
    await s.event('account.changed');
    expect((await admin.post(`/api/admin/users/${m.me.id}/role`, { role: 'user', reason: 'realtime role' })).status).toBe(200);
    await s.until(() => count(s, 'account.changed') === 2, 15_000, 'second account.changed');
    expect(s.closed).toBeNull();
    expect((await m.client.get('/api/auth/me')).body.role).toBe('user');
  });

  it("a profile saved on one device reaches the member's other devices", async () => {
    const m = await newUser();
    const phone = new Client();
    expect((await phone.post('/api/auth/login', { email: m.email, password: PASSWORD })).status).toBe(200);
    const [here, there] = await Promise.all([rt(m.client), rt(phone)]);
    const nickname = uniq('rn').slice(0, 14);
    expect((await m.client.patch('/api/auth/me', { nickname })).status).toBe(200);
    await there.event('account.changed');
    await here.event('account.changed');
    expect((await phone.get('/api/auth/me')).body.nickname).toBe(nickname);
  });

  it('a free refill tells the other pages once, and a claim that pays nothing tells nobody', async () => {
    const m = await newUser();
    await reauth();
    // below the seeded threshold (1,000), with a recorded adjustment
    const down = await admin.post(`/api/admin/users/${m.me.id}/chips`, { amount: -9_500, memo: 'realtime refill', idempotencyKey: uniq('rt-rf') });
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    const s = await rt(m.client);
    const paid = await m.client.post('/api/me/refill', {});
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.duplicate).toBe(false);
    await s.event('wallet.changed');
    // the next claim is the same one seen again or one refused: nothing paid, nothing announced
    const again = await m.client.post('/api/me/refill', {});
    if (again.status === 200) expect(again.body.duplicate).toBe(true);
    else expect(['refill_refused', 'refill_changed'], JSON.stringify(again.body)).toContain(again.body.error.code);
    await quiet(s, 'wallet.changed', 1);
    expect((await d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${m.me.id}' AND type = 'free_refill'`))[0]!.n).toBe(1);
  });

  it('a buy-in and a cash-out at a table each tell the pages away from it', async () => {
    const m = await newUser();
    const s = await rt(m.client);
    const ws = await TableSocket.open(m.client, 'it-rt-0');
    tables.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    await s.event('wallet.changed');
    expect((await m.client.get('/api/auth/me')).body.balance).toBe(9_600);
    expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await s.until(() => count(s, 'wallet.changed') === 2, 15_000, 'cash-out wallet.changed');
    // the chips came back once, by the room's own settlement
    expect((await m.client.get('/api/auth/me')).body.balance).toBe(10_000);
    await quiet(s, 'wallet.changed', 2);
  });
});

describe('realtime socket: sign-outs', () => {
  it('logging out ends this device; "other devices" keeps the device that asked', async () => {
    const u = await newUser();
    const phone = new Client();
    expect((await phone.post('/api/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    const laptop = new Client();
    expect((await laptop.post('/api/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    const [sHere, sPhone, sLaptop] = await Promise.all([rt(u.client), rt(phone), rt(laptop)]);

    expect((await u.client.post('/api/auth/logout')).status).toBe(200);
    const hereClosed = sHere.waitClose();
    // the signed-out page cannot open another
    expect(await handshake(u.client)).toBe(401);

    // a password change on the phone signs out every other device (the laptop), not the phone
    expect((await phone.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: `${PASSWORD}x` })).status).toBe(200);
    const laptopClosed = sLaptop.waitClose();
    // The hub stops delivering at the sign-out, whenever the closed page hears of it: an event now reaches the phone only.
    await reauth();
    await admin.post(`/api/admin/users/${u.me.id}/chips`, { amount: 5, memo: 'after sign-out', idempotencyKey: uniq('rt-out') });
    await sPhone.event('wallet.changed');
    expect(await hereClosed).toBe(4401);
    expect(await laptopClosed).toBe(4401);
    expect(sHere.events).toEqual([]);
    expect(sLaptop.events).toEqual([]);
    await sPhone.ping();
    expect(sPhone.closed).toBeNull();
  });

  it('an administrator disconnecting or suspending the member ends every page of theirs', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const [sa, sb] = await Promise.all([rt(a.client), rt(b.client)]);
    await reauth();
    expect((await admin.post(`/api/admin/users/${a.me.id}/disconnect`, { reason: 'realtime check' })).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${b.me.id}/suspend`, { reason: 'realtime check' })).status).toBe(200);
    expect(await Promise.all([sa.waitClose(), sb.waitClose()])).toEqual([4401, 4401]);
    expect(await handshake(b.client)).toBe(401);
  });

  it('a socket past its sign-in is closed for a fresh check, and the expired sign-in opens nothing', async () => {
    const u = await newUser();
    // The session ends in a few seconds; the handshake tells the hub so (it reads the session without sliding it).
    await d1(`UPDATE sessions SET expires_at = ${Date.now() + 4_000} WHERE user_id = '${u.me.id}'`);
    const s = await rt(u.client);
    await new Promise((r) => setTimeout(r, 4_500));
    await reauth();
    await admin.post(`/api/admin/users/${u.me.id}/chips`, { amount: 1, memo: 'expiry check', idempotencyKey: uniq('rt-exp') });
    // the hub closes it for a fresh check rather than deliver past that expiry, and the check finds the sign-in gone
    expect(await s.waitClose()).toBe(4000);
    expect(s.events).toEqual([]);
    expect(await handshake(u.client)).toBe(401);
  });
});
