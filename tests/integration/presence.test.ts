// Friends' status (routes/presence.ts, GET /api/friends/presence, the presence hub in the game worker): only accepted
// friends see it, the server decides it from each device's beats, the account's mode applies on every device, and a
// request, a block, an unfriending, a suspension or a withdrawal shows nothing, the same as a stranger.
import { PRESENCE_AWAY_MS } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD } from '../support/client';
import { d1 } from '../support/d1';

type User = Awaited<ReturnType<typeof newUser>>;

async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

let n = 0;
const conn = () => `dev-${Date.now().toString(36)}-${++n}`;
const beat = (c: Client, body: Record<string, unknown>) => c.post('/api/me/presence/heartbeat', { idleMs: 0, visible: true, ...body });
const friendsSee = async (c: Client) => {
  const r = await c.get('/api/friends/presence');
  expect(r.status).toBe(200);
  return r.body as { presence: Record<string, string> };
};

/** A sign-out reaches the hub after the answer (waitUntil): wait a little for it. */
async function eventually(check: () => Promise<boolean>, ms = 5_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('friends status', () => {
  it('a friend sees online, then away after five idle minutes; strangers and requests see nothing', async () => {
    const [a, b, stranger, asker] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    await befriend(a, b);
    // A pending request either way shows nothing.
    expect((await asker.client.post('/api/friends/requests', { userId: a.me.id })).status).toBe(201);

    const first = await beat(a.client, { conn: conn() });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ mode: 'auto', state: 'online' });

    expect(await friendsSee(b.client)).toEqual({ presence: { [a.me.id]: 'online' } });
    expect(await friendsSee(stranger.client)).toEqual({ presence: {} });
    expect(await friendsSee(asker.client)).toEqual({ presence: {} });
    // a's own view lists b (offline: no device) and never the member who asked to be friends.
    expect(await friendsSee(a.client)).toEqual({ presence: { [b.me.id]: 'offline' } });

    // The device says how long the member has been idle; the server decides the state.
    const idle = conn();
    const away = await beat(a.client, { conn: idle, idleMs: PRESENCE_AWAY_MS });
    expect(away.body.state).toBe('online'); // the first device is still active
    const solo = await newUser();
    await befriend(solo, b);
    expect((await beat(solo.client, { conn: conn(), idleMs: PRESENCE_AWAY_MS })).body).toEqual({ mode: 'auto', state: 'away' });
    expect((await friendsSee(b.client)).presence[solo.me.id]).toBe('away');
  });

  it('only online, away or offline: no time last seen, no device, no other field', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await befriend(a, b);
    await beat(a.client, { conn: conn() });
    const r = await b.client.get('/api/friends/presence');
    expect(Object.keys(r.body)).toEqual(['presence']);
    expect(r.body.presence).toEqual({ [a.me.id]: 'online' });
    expect(JSON.stringify(r.body)).not.toMatch(/last|seen|at"|device|session/i);
  });

  it('the account mode applies on every device: invisible is offline, away is away, auto follows the devices', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await befriend(a, b);
    const phone = conn();
    await beat(a.client, { conn: phone });
    expect((await a.client.get('/api/me/presence')).body).toEqual({ mode: 'auto', state: 'online' });

    const inv = await a.client.req('PUT', '/api/me/presence', { mode: 'invisible' });
    expect(inv.status).toBe(200);
    expect(inv.body).toEqual({ mode: 'invisible', state: 'offline' });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('offline');
    // Another device of the same account learns the mode from its next beat.
    const laptop = new Client();
    expect((await laptop.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    expect((await beat(laptop, { conn: conn() })).body).toEqual({ mode: 'invisible', state: 'offline' });

    expect((await a.client.req('PUT', '/api/me/presence', { mode: 'away' })).body).toEqual({ mode: 'away', state: 'away' });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('away');
    expect((await a.client.req('PUT', '/api/me/presence', { mode: 'auto' })).body).toEqual({ mode: 'auto', state: 'online' });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('online');

    expect((await a.client.req('PUT', '/api/me/presence', { mode: 'busy' })).status).toBe(400);
    expect((await a.client.req('PUT', '/api/me/presence', { mode: 'auto', extra: 1 })).status).toBe(400);
  });

  it('a block, an unfriending, a suspension or a withdrawal hides the status at once', async () => {
    const [a, b, c, d, e] = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);
    for (const x of [b, c, d, e]) await befriend(a, x);
    for (const x of [a, b, c, d, e]) await beat(x.client, { conn: conn() });
    expect(Object.keys((await friendsSee(a.client)).presence).sort()).toEqual([b, c, d, e].map((x) => x.me.id).sort());

    // b blocks a; a unfriends c; d is suspended; e withdraws.
    expect((await b.client.req('PUT', `/api/blocks/${a.me.id}`)).status).toBe(200);
    expect((await a.client.req('DELETE', `/api/friends/${c.me.id}`)).status).toBe(200);
    await d1(`UPDATE users SET status = 'suspended', suspended_reason = 'presence test' WHERE id = '${d.me.id}'`);
    expect((await e.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);

    expect(await friendsSee(a.client)).toEqual({ presence: {} });
    for (const x of [b, c]) expect(await friendsSee(x.client)).toEqual({ presence: {} });
    // The suspended member's sign-in no longer counts: a beat is refused, like any signed-out request.
    expect((await beat(d.client, { conn: conn() })).status).toBe(401);
  });

  it('signing out takes the device off at once; a password change signs out the other devices', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await befriend(a, b);
    const second = new Client();
    expect((await second.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    await beat(a.client, { conn: conn() });
    await beat(second, { conn: conn(), idleMs: PRESENCE_AWAY_MS });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('online');

    // The active device signs out: only the idle one is left.
    expect((await a.client.post('/api/auth/logout')).status).toBe(200);
    await eventually(async () => (await friendsSee(b.client)).presence[a.me.id] === 'away');
    expect((await beat(a.client, { conn: conn() })).status).toBe(401);

    // From the remaining device: a password change ends every other sign-in; this one stays.
    const third = new Client();
    expect((await third.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    await beat(third, { conn: conn() });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('online');
    expect((await second.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: `${PASSWORD}x` })).status).toBe(200);
    await eventually(async () => (await friendsSee(b.client)).presence[a.me.id] === 'away');
  });

  it('a closed page leaves at once', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await befriend(a, b);
    const tab = conn();
    await beat(a.client, { conn: tab });
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('online');
    expect((await a.client.post('/api/me/presence/leave', { conn: tab })).status).toBe(200);
    expect((await friendsSee(b.client)).presence[a.me.id]).toBe('offline');
  });

  it('a beat checks the sign-in without keeping it alive, and refuses what is not a beat', async () => {
    const a = await newUser();
    const [s] = await d1<{ id: string }>(`SELECT id FROM sessions WHERE user_id = '${a.me.id}'`);
    const past = Date.now() - 10 * 60_000;
    await d1(`UPDATE sessions SET last_seen_at = ${past} WHERE id = '${s!.id}'`);
    expect((await beat(a.client, { conn: conn() })).status).toBe(200);
    expect(await d1(`SELECT last_seen_at AS at FROM sessions WHERE id = '${s!.id}'`)).toEqual([{ at: past }]);
    // Any other request slides it as before.
    expect((await a.client.get('/api/auth/me')).status).toBe(200);
    expect((await d1<{ at: number }>(`SELECT last_seen_at AS at FROM sessions WHERE id = '${s!.id}'`))[0]!.at).toBeGreaterThan(past);

    expect((await beat(new Client(), { conn: conn() })).status).toBe(401);
    expect((await beat(a.client, { conn: 'short' })).status).toBe(400);
    expect((await beat(a.client, { conn: conn(), idleMs: -1 })).status).toBe(400);
    expect((await beat(a.client, { conn: conn(), view: 'https://example.com/' })).status).toBe(400);
    expect((await beat(a.client, { conn: conn(), lastSeen: 1 })).status).toBe(400);
    // Cross-site: the origin check refuses it before anything else.
    expect((await new Client('https://evil.example').post('/api/me/presence/heartbeat', { conn: conn(), idleMs: 0, visible: true })).status).toBe(403);
  });

  it('a member beating far faster than a page does is told to slow down', async () => {
    const a = await newUser();
    const device = conn();
    const codes: number[] = [];
    for (let i = 0; i < 45; i++) codes.push((await beat(a.client, { conn: device })).status);
    expect(codes.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(codes).toContain(429);
  });
});
