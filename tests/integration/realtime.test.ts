// Platform realtime (GET /ws/realtime, docs/REALTIME.md): only a signed-in page from an allowed origin gets a socket,
// a member's events reach only that member's pages, a sign-out (here, on other devices, by an administrator, by a
// suspension) ends the sockets it ends, and nothing a page sends changes anything. Events only say what changed: the
// page reads the balance again, so a grant counted once in D1 is shown once however often its event comes.
//
// Its own worker and state, not the shared one: every table room of a worker tells the hubs of its lobby counts, and
// the rooms other files leave playing on the shared worker keep waking them. A page hears of a close the hub made only
// once the hub has been idle for about ten seconds (tests/support/realtime.ts), so there it could take any time (after
// fold-leave.test.ts, a hub that closed a socket at once was sent 16 publishes in the next 22 s, never 10 s apart).
import http from 'node:http';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupBody, uniq, WEB_ORIGIN } from '../support/client';
import { d1 as d1At } from '../support/d1';
import { RealtimeSocket } from '../support/realtime';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { TableSocket } from '../support/ws';

let own: RunningWorker | undefined;
/** This file's worker and the local D1 it writes. */
let where: { base: string; state: string };
let admin: Client;

beforeAll(async () => {
  const state = resolve(root, 'tests/.state/realtime');
  await prepareState(state, TABLES.filter((t) => t.id === 'it-rt-0'));
  // The hubs check their sockets' sign-ins every 15 s, as on the shared worker (tests/support/global-setup.ts).
  own = await startWorker(8817, state, { REALTIME_SWEEP_MS: '15000' });
  where = { base: own.url, state };
  admin = await superAdmin();
}, 240_000);

afterAll(async () => {
  await own?.stop();
});

/** SQL on this file's D1. */
const d1 = <T = Record<string, unknown>>(sql: string) => d1At<T>(sql, where.state);

/** A new member of this file's worker, signed in on the member site. */
async function newUser() {
  const client = new Client(WEB_ORIGIN, where.base);
  const email = `${uniq('e')}@test.dev`;
  const r = await client.post('/api/auth/register', await signupBody(client, { email, nickname: uniq('p').slice(0, 14) }));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { client, me: r.body as { id: string; nickname: string; balance: number; locale: string }, email };
}

/** Another page (a device) on this file's worker, signed in to nothing yet. */
const device = () => new Client(WEB_ORIGIN, where.base);

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
  const s = await RealtimeSocket.open(client, { base: where.base, ...opts });
  open.push(s);
  return s;
}

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** A super admin (a member promoted in D1, signed in to the console), with the password confirmed. */
async function superAdmin() {
  const u = await newUser();
  await d1(`UPDATE users SET role = 'super_admin' WHERE id = '${u.me.id}'`);
  const c = new Client('http://localhost:5174', where.base);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  await reauth(c);
  return c;
}

/** The status the api answers a handshake with, 101 when it opens (fetch() forbids the Upgrade header). */
function handshake(client: Client, origin = 'http://localhost:5173'): Promise<number> {
  const u = new URL(`${where.base}/ws/realtime`);
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
    expect(await handshake(device())).toBe(401);
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

  it('a first try whose audit row was lost gets it on the retry, from its ledger row, and still counts once', async () => {
    const target = await newUser();
    await reauth();
    const adminId = (await admin.get('/api/admin/auth/me')).body.user.id;
    const grant = { amount: 300, memo: 'late audit check', idempotencyKey: uniq('rt-late') };
    expect((await admin.post(`/api/admin/users/${target.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: false });
    // as if the audit insert had failed after the ledger committed
    await d1(`DELETE FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`);
    const recorded = () => d1<{ detail: string; actor_id: string; ip: string | null }>(`SELECT detail, actor_id, ip FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`);
    // The key with other details is not that grant again: refused, and no record of a grant made from them.
    const altered = await admin.post(`/api/admin/users/${target.me.id}/chips`, { ...grant, memo: 'a memo it never had' });
    expect(altered.status, JSON.stringify(altered.body)).toBe(409);
    expect(altered.body.error.code).toBe('idempotency_conflict');
    expect(await recorded()).toEqual([]);
    // The same request from another administrator: the record is the grant's, by the one who made it.
    const second = await superAdmin();
    expect((await second.post(`/api/admin/users/${target.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: true, balanceAfter: 10_300 });
    const audits = await recorded();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.detail)).toMatchObject({ amount: 300, memo: 'late audit check', late: true });
    expect(audits[0]!.actor_id).toBe(adminId);
    // a third repeat writes no second record
    expect((await admin.post(`/api/admin/users/${target.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: true });
    expect(await recorded()).toHaveLength(1);
    const rows = await d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${target.me.id}' AND type = 'admin_adjust'`);
    expect(rows[0]!.n).toBe(1);
  });

  it('a grant whose record cannot be written is not made: the chips and their record commit together, and the retry makes both once', async () => {
    const target = await newUser();
    const s = await rt(target.client);
    await reauth();
    const grant = { amount: 500, memo: 'atomic audit check', idempotencyKey: uniq('rt-atomic') };
    const ledger = async () => (await d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${target.me.id}' AND type = 'admin_adjust'`))[0]!.n;
    const recorded = async () => (await d1<{ n: number }>(`SELECT count(*) AS n FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${target.me.id}'`))[0]!.n;
    // The audit log refuses this member's grant record (as a failing write would), for this test only.
    const trigger = `audit_down_${target.me.id.replace(/[^A-Za-z0-9]/g, '')}`;
    await d1(`CREATE TRIGGER ${trigger} BEFORE INSERT ON admin_audit_log WHEN NEW.action = 'user.chips' AND NEW.target_id = '${target.me.id}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
    try {
      const failed = await admin.post(`/api/admin/users/${target.me.id}/chips`, grant);
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(500);
      // no chips moved without their record, nor is a change announced
      expect(await ledger()).toBe(0);
      expect(await recorded()).toBe(0);
      expect((await target.client.get('/api/auth/me')).body.balance).toBe(10_000);
      await quiet(s, 'wallet.changed', 0);
    } finally {
      await d1(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    // The console keeps the key after a failure: the same request is then the grant, once, with its record.
    const ok = await admin.post(`/api/admin/users/${target.me.id}/chips`, grant);
    expect(ok.body).toMatchObject({ ok: true, duplicate: false, balanceAfter: 10_500 });
    await s.event('wallet.changed');
    expect(await ledger()).toBe(1);
    expect(await recorded()).toBe(1);
  });

  it("a key already used for one member's grant is refused for another member or another amount, and moves or records nothing for them", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await reauth();
    const grant = { amount: 400, memo: 'key reuse check', idempotencyKey: uniq('rt-reuse') };
    expect((await admin.post(`/api/admin/users/${a.me.id}/chips`, grant)).body).toMatchObject({ ok: true, duplicate: false, balanceAfter: 10_400 });
    for (const [who, body] of [
      [b.me.id, grant],
      [a.me.id, { ...grant, amount: 900 }],
    ] as const) {
      // the preview says so before the password is asked
      const preview = await admin.post(`/api/admin/users/${who}/chips`, { ...body, preview: true });
      expect(preview.status, JSON.stringify(preview.body)).toBe(409);
      expect(preview.body.error.code).toBe('idempotency_conflict');
      const r = await admin.post(`/api/admin/users/${who}/chips`, body);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.code).toBe('idempotency_conflict');
    }
    // A refused preview is the failed request on record (as any refused preview is); the refusal itself, once.
    const records = (who: string) =>
      d1<{ action: string; outcome: string; reason: string | null; code: string | null }>(
        `SELECT action, outcome, json_extract(detail, '$.reason') AS reason, json_extract(detail, '$.code') AS code FROM admin_audit_log WHERE target_id = '${who}' AND action LIKE 'user.chips%' ORDER BY created_at, rowid`,
      );
    const refused = [
      { action: 'user.chips.failed', outcome: 'failed', code: 'idempotency_conflict' },
      { action: 'user.chips_refused', outcome: 'failed', reason: 'idempotency_conflict' },
    ];
    expect(await records(b.me.id)).toMatchObject(refused);
    expect(await records(a.me.id)).toMatchObject([{ action: 'user.chips', outcome: 'ok' }, ...refused]);
    const ledger = (who: string) => d1<{ n: number }>(`SELECT count(*) AS n FROM chip_ledger WHERE user_id = '${who}' AND type = 'admin_adjust'`);
    expect((await ledger(a.me.id))[0]!.n).toBe(1);
    expect((await ledger(b.me.id))[0]!.n).toBe(0);
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(10_400);
    expect((await b.client.get('/api/auth/me')).body.balance).toBe(10_000);
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

  it("other members' pages hear a VIP color they would see, as the member's id and the color alone; a suspended member's change tells nobody", async () => {
    const [m, other] = await Promise.all([newUser(), newUser()]);
    const theirs = await rt(other.client);
    await reauth();
    const set = async (body: Record<string, unknown>) => {
      const version = (await admin.get(`/api/admin/users/${m.me.id}/vip`)).body.version as number;
      const r = await admin.patch(`/api/admin/users/${m.me.id}/vip`, { ...body, reason: 'public vip reason', expectedVersion: version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { changed: boolean; vip: { version: number } };
    };
    const heard = () => theirs.events.filter((e) => e.type === 'member.vip.changed' && e.resourceId === m.me.id);
    const made = await set({ enabled: true });
    const e = await theirs.event('member.vip.changed', 15_000, (x) => x.resourceId === m.me.id);
    // the frame as it arrived: these fields and nothing else (no reason, administrator, nickname or e-mail)
    expect(Object.keys(e).sort()).toEqual(['eventId', 'occurredAt', 'payload', 'resourceId', 'revision', 'scope', 'type']);
    expect(e).toMatchObject({ scope: 'service', payload: { vip: 'gold' }, revision: made.vip.version });
    const adminId = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    for (const secret of ['public vip reason', adminId, m.email, m.me.nickname]) expect(JSON.stringify(e)).not.toContain(secret);
    // a color change is heard with a newer revision; the color it already has tells nobody
    const recolored = await set({ enabled: true, color: 'rose' });
    await theirs.until(() => heard().length === 2, 15_000, 'second member.vip.changed');
    expect(heard()[1]).toMatchObject({ payload: { vip: 'rose' }, revision: recolored.vip.version });
    expect(recolored.vip.version).toBeGreaterThan(made.vip.version);
    expect(await set({ enabled: true, color: 'rose' })).toMatchObject({ changed: false });
    // suspended: others see no color either way, so neither a new color nor its end says anything
    expect((await admin.post(`/api/admin/users/${m.me.id}/suspend`, { reason: 'public vip check' })).status).toBe(200);
    expect(await set({ enabled: true, color: 'emerald' })).toMatchObject({ changed: true });
    expect(await set({ enabled: false })).toMatchObject({ changed: true });
    await theirs.ping();
    await new Promise((r) => setTimeout(r, 500));
    expect(heard()).toHaveLength(2);
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
    const phone = device();
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
    const ws = await TableSocket.open(m.client, 'it-rt-0', { base: where.base });
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

/** Two members who are friends (b accepted a's request). */
async function friends() {
  const [a, b] = await Promise.all([newUser(), newUser()]);
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`, {})).status).toBe(200);
  return [a, b] as const;
}

describe('realtime socket: friends and 1:1 messages', () => {
  it('a request, its acceptance and an unfriending tell the two players, nobody else', async () => {
    const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
    const [sa, sb, sc] = await Promise.all([rt(a.client), rt(b.client), rt(c.client)]);
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
    await sb.event('social.friend.changed');
    await sa.event('social.friend.changed');
    // the same request again is refused and writes nothing: nothing is announced
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).body.error.code).toBe('already_requested');
    await quiet(sb, 'social.friend.changed', 1);
    expect((await b.client.post(`/api/friends/${a.me.id}/accept`, {})).status).toBe(200);
    await sa.until(() => count(sa, 'social.friend.changed') === 2, 15_000, 'accepted');
    await sb.until(() => count(sb, 'social.friend.changed') === 2, 15_000, 'accepted (mine)');
    expect((await a.client.req('DELETE', `/api/friends/${b.me.id}`)).status).toBe(200);
    await sb.until(() => count(sb, 'social.friend.changed') === 3, 15_000, 'unfriended');
    // the event names nobody: who did what is read from /api/friends
    expect(JSON.stringify(sb.events.filter((e) => e.type === 'social.friend.changed'))).not.toContain(a.me.id);
    await quiet(sc, 'social.friend.changed', 0);
    expect(sc.events).toEqual([]);
  });

  it('a block tells the blocked player nothing unless a friendship they saw ended', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const [sa, sb] = await Promise.all([rt(a.client), rt(b.client)]);
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    // the blocker's own pages read their list again; the blocked player learns nothing
    await sa.event('social.friend.changed');
    await quiet(sb, 'social.friend.changed', 0);
    expect(sb.events).toEqual([]);
    expect((await a.client.req('DELETE', `/api/blocks/${b.me.id}`)).status).toBe(200);
    await sa.until(() => count(sa, 'social.friend.changed') === 2, 15_000, 'unblocked');
    await quiet(sb, 'social.friend.changed', 0);

    // Friends: the friendship ends with the block, which they see as an unfriending.
    const [c, d] = await friends();
    const [sc, sd] = await Promise.all([rt(c.client), rt(d.client)]);
    expect((await c.client.req('PUT', `/api/blocks/${d.me.id}`)).status).toBe(200);
    await sd.event('social.friend.changed');
    await sc.event('social.friend.changed');
    expect((await d.client.get('/api/friends')).body.friends).toEqual([]);
  });

  it("a 1:1 message reaches the other player and the sender's other device, and reading it tells both", async () => {
    const [a, b] = await friends();
    const outsider = await newUser();
    const phone = device();
    expect((await phone.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    const [sa, saPhone, sb, so] = await Promise.all([rt(a.client), rt(phone), rt(b.client), rt(outsider.client)]);
    const sent = await a.client.post(`/api/dm/${b.me.id}`, { text: 'realtime hello' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const seq = sent.body.seq as number;
    const got = await sb.event('social.dm.created');
    expect(got.payload).toEqual({ peerId: a.me.id, seq });
    // only where and which: the text is read from the conversation
    expect(JSON.stringify(got)).not.toContain('realtime hello');
    expect((await saPhone.event('social.dm.created')).payload).toEqual({ peerId: b.me.id, seq });
    await sa.event('social.dm.created');
    const conv = await b.client.get(`/api/dm/${a.me.id}?afterSeq=${seq - 1}`);
    expect(conv.body.messages.map((m: { body: string }) => m.body)).toEqual(['realtime hello']);

    expect((await b.client.post(`/api/dm/${a.me.id}/read`, { upToSeq: seq })).status).toBe(200);
    expect((await sa.event('social.dm.read')).payload).toEqual({ peerId: b.me.id, readerId: b.me.id, seq });
    expect((await sb.event('social.dm.read')).payload).toEqual({ peerId: a.me.id, readerId: b.me.id, seq });
    // read again: nothing newly read, nothing announced
    expect((await b.client.post(`/api/dm/${a.me.id}/read`, { upToSeq: seq })).status).toBe(200);
    await quiet(sa, 'social.dm.read', 1);
    await quiet(so, 'social.dm.created', 0);
    expect(so.events).toEqual([]);
  });

  it('a table invite is a 1:1 message like any other', async () => {
    const [a, b] = await friends();
    const sb = await rt(b.client);
    const r = await a.client.post(`/api/friends/${b.me.id}/invite`, { tableId: 'it-rt-0' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await sb.event('social.dm.created')).payload).toEqual({ peerId: a.me.id, seq: r.body.seq });
    // it grants nothing: no seat, no waitlist place, no chips moved
    expect((await b.client.get('/api/auth/me')).body.balance).toBe(10_000);
    expect(await d1(`SELECT 1 FROM table_sessions WHERE user_id = '${b.me.id}'`)).toEqual([]);
  });
});

describe('realtime socket: the inbox', () => {
  it("reading or deleting a message reaches the member's other devices; reading nothing new tells nobody", async () => {
    const m = await newUser();
    const phone = device();
    expect((await phone.post('/api/auth/login', { email: m.email, password: PASSWORD })).status).toBe(200);
    const [here, there] = await Promise.all([rt(m.client), rt(phone)]);
    for (const n of [1, 2]) expect((await admin.post('/api/admin/messages', { userIds: [m.me.id], category: 'notice', title: `rt ${n}`, body: 'IT' })).status).toBe(201);
    await there.until(() => count(there, 'message.changed') === 2, 15_000, 'two sends');
    const list = (await m.client.get('/api/messages')).body as { id: string }[];
    expect((await m.client.post(`/api/messages/${list[0]!.id}/read`, {})).status).toBe(200);
    await there.until(() => count(there, 'message.changed') === 3, 15_000, 'read');
    expect((await m.client.req('DELETE', `/api/messages/${list[0]!.id}`)).status).toBe(200);
    await there.until(() => count(there, 'message.changed') === 4, 15_000, 'deleted');
    expect((await m.client.post('/api/messages/read-all', {})).status).toBe(200);
    await there.until(() => count(there, 'message.changed') === 5, 15_000, 'read all');
    // everything is read already: nothing changed, nothing announced
    expect((await m.client.post('/api/messages/read-all', {})).status).toBe(200);
    await quiet(there, 'message.changed', 5);
    expect((await phone.get('/api/messages/unread-count')).body.unread).toBe(0);
    // the device that did it hears of it too (its other tabs), as many times
    await quiet(here, 'message.changed', 5);
  });

  it('a message to some members tells only them, and a notice to every inbox is one public event', async () => {
    const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
    const [sa, sb, sc] = await Promise.all([rt(a.client), rt(b.client), rt(c.client)]);
    const sent = await admin.post('/api/admin/messages', { userIds: [a.me.id, b.me.id], category: 'event', title: 'rt event', body: 'IT' });
    expect(sent.status).toBe(201);
    const e = await sa.event('message.changed');
    // a few recipients read at once; the message itself is read from the inbox
    expect(e.payload).toEqual({ spreadMs: 0 });
    expect(JSON.stringify(e)).not.toContain('rt event');
    await sb.event('message.changed');
    await quiet(sc, 'message.changed', 0);

    await reauth();
    // (a new account starts with its welcome message unread)
    const unread = async () => (await c.client.get('/api/messages/unread-count')).body.unread as number;
    const before = await unread();
    const n = await admin.post('/api/admin/service/notices', { kind: 'general', titleKo: '실시간 공지', titleEn: 'Realtime notice', bodyKo: '본문', bodyEn: 'Body', sendInbox: true });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    try {
      const sentTo = n.body.sent as number;
      expect(sentTo).toBeGreaterThan(2);
      // one event for every page, not one per member; the reads it asks for are spread by how many were sent
      const b1 = await sc.event('inbox.broadcast');
      expect(b1).toMatchObject({ scope: 'service', payload: { spreadMs: Math.min(30_000, Math.max(0, sentTo - 20) * 10) } });
      await sa.event('inbox.broadcast');
      await quiet(sc, 'message.changed', 0);
      expect(await unread()).toBe(before + 1);
    } finally {
      await admin.req('DELETE', `/api/admin/service/notices/${n.body.id}`);
    }
  });

  it('closing a report tells the members it sent a notice to, nobody else', async () => {
    const [author, reporter, other] = await Promise.all([newUser(), newUser(), newUser()]);
    const [sr, sa, so] = await Promise.all([rt(reporter.client), rt(author.client), rt(other.client)]);
    const post = (await author.client.post('/api/board/posts', { title: `rt report ${Date.now()}`, body: 'buy chips here' })).body as { id: string };
    const made = await reporter.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const closed = await admin.post(`/api/admin/reports/${made.body.id}`, { status: 'resolved', notifyReporter: true, notifyTarget: true, note: 'IT' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.notified).toEqual({ reporters: 1, target: 1 });
    await sr.event('message.changed');
    await sa.event('message.changed');
    await quiet(so, 'message.changed', 0);
  });
});

describe('realtime socket: sign-outs', () => {
  it('logging out ends this device; "other devices" keeps the device that asked', async () => {
    const u = await newUser();
    const phone = device();
    expect((await phone.post('/api/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    const laptop = device();
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

  it('a sign-out the hub never heard of ends the socket at its next check of D1, and only that one', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const phone = device();
    expect((await phone.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    const [sa, sPhone, sb] = await Promise.all([rt(a.client), rt(phone), rt(b.client)]);
    // A revoke lost on the way: the sign-in ends in D1 alone. The first of a's two sessions goes (the phone's, on the
    // same hub, stays); b's account stops being active.
    await d1(`DELETE FROM sessions WHERE id = (SELECT id FROM sessions WHERE user_id = '${a.me.id}' ORDER BY created_at LIMIT 1)`);
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${b.me.id}'`);
    // This file's hubs read their sockets' sessions every 15 s (REALTIME_SWEEP_MS; 5 min in production).
    expect(await Promise.all([sa.waitClose(50_000), sb.waitClose(50_000)])).toEqual([4401, 4401]);
    // the phone's socket outlived the sweep that ended the other, and still gets a's events
    await reauth();
    await admin.post(`/api/admin/users/${a.me.id}/chips`, { amount: 1, memo: 'sweep check', idempotencyKey: uniq('rt-sweep') });
    await sPhone.event('wallet.changed');
    expect(sPhone.closed).toBeNull();
    expect(sa.events).toEqual([]);
    expect(sb.events).toEqual([]);
  }, 90_000);

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
