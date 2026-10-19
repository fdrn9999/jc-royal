// Push subscriptions (routes/notifications.ts): a browser registers for the member and the sign-in it is made in, only
// at a known push service, only with service consent; one browser is one member's; the list never shows an endpoint;
// sign-outs, a password change and withdrawing consent take them away. Sending is push.test.ts.
import { PUSH_MAX_DEVICES } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD } from '../support/client';
import { d1 } from '../support/d1';
import { browserSubscription, eventually, subscribe, subscriptionBody } from '../support/push';

const withConsent = () => newUser(undefined, { pushConsent: { service: true, night: true } });
const devices = async (c: Client) => {
  const r = await c.get('/api/me/notifications/devices');
  expect(r.status).toBe(200);
  return r.body.devices as { id: string; label: string | null; current: boolean }[];
};
const rows = (uid: string) => d1<{ id: string; session_id: string; updated_at: number }>(`SELECT id, session_id, updated_at FROM push_subscriptions WHERE user_id = '${uid}'`);
const signIn = async (email: string) => {
  const c = new Client();
  expect((await c.post('/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
};

describe('push key and registration', () => {
  it('the public key, to signed-in members only: a P-256 point', async () => {
    const u = await newUser();
    const r = await u.client.get('/api/me/notifications/push-key');
    expect(r.status).toBe(200);
    const raw = Buffer.from(r.body.publicKey, 'base64url');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    expect((await new Client().get('/api/me/notifications/push-key')).status).toBe(401);
  });

  it('needs service consent: refused without it, nothing stored', async () => {
    const u = await newUser();
    const r = await subscribe(u.client, await browserSubscription());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('push_consent_required');
    expect(await rows(u.me.id)).toEqual([]);
  });

  it('only a known push service over HTTPS, with keys a browser makes', async () => {
    const u = await withConsent();
    const s = await browserSubscription();
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x1234567890',
      'https://evil.example/fcm/send/x1234567890',
      'https://fcm.googleapis.com:8443/fcm/send/x1234567890',
      'https://user:pw@fcm.googleapis.com/fcm/send/x123456',
      'https://127.0.0.1/fcm/send/x1234567890123',
      'https://fcm.googleapis.com.evil.example/send/x123',
    ]) {
      const r = await u.client.post('/api/me/notifications/subscriptions', { endpoint, keys: s.keys });
      expect(r.status, endpoint).toBe(400);
      expect(r.body.error.code, endpoint).toBe('push_endpoint_refused');
    }
    // A key that is not a P-256 point (right length, wrong content) or an auth secret of the wrong size.
    const bad = await u.client.post('/api/me/notifications/subscriptions', { endpoint: s.endpoint, keys: { p256dh: 'B'.repeat(87), auth: s.keys.auth } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_push_keys');
    for (const body of [{ endpoint: s.endpoint }, { ...subscriptionBody(s), extra: 1 }, { endpoint: s.endpoint, keys: { ...s.keys, p256dh: 'not base64url!' } }]) {
      expect((await u.client.post('/api/me/notifications/subscriptions', body)).status).toBe(400);
    }
    expect(await rows(u.me.id)).toEqual([]);
  });

  it('registers this browser for this sign-in; the same again writes nothing', async () => {
    const u = await withConsent();
    const s = await browserSubscription();
    const first = await subscribe(u.client, s);
    expect(first.status).toBe(201);
    expect(first.body.device).toMatchObject({ current: true, lastSuccessAt: null });
    expect(first.body.publicKey).toBe((await u.client.get('/api/me/notifications/push-key')).body.publicKey);
    const [before] = await rows(u.me.id);
    const again = await subscribe(u.client, s);
    expect(again.status).toBe(200);
    expect(again.body.device.id).toBe(first.body.device.id);
    const after = await rows(u.me.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.updated_at).toBe(before!.updated_at);
  });

  it('the list shows devices, never an endpoint or keys; "current" is this sign-in', async () => {
    const u = await withConsent();
    const other = await signIn(u.email);
    const s1 = await browserSubscription();
    const s2 = await browserSubscription();
    expect((await subscribe(u.client, s1)).status).toBe(201);
    expect((await subscribe(other, s2)).status).toBe(201);
    const r = await u.client.get('/api/me/notifications/devices');
    const text = JSON.stringify(r.body);
    for (const secret of [s1.endpoint, s2.endpoint, s1.keys.p256dh, s1.keys.auth, 'fcm.googleapis.com']) expect(text).not.toContain(secret);
    expect(r.body.devices.map((d: { current: boolean }) => d.current).sort()).toEqual([false, true]);
    expect(Object.keys(r.body.devices[0]).sort()).toEqual(['createdAt', 'current', 'id', 'label', 'lastFailureAt', 'lastSuccessAt']);
  });

  it('a browser another account registered before is this member’s from now on (a new device id)', async () => {
    const a = await withConsent();
    const b = await withConsent();
    const s = await browserSubscription();
    const forA = await subscribe(a.client, s);
    const forB = await subscribe(b.client, s);
    expect(forB.status).toBe(201);
    expect(forB.body.device.id).not.toBe(forA.body.device.id);
    expect(await devices(a.client)).toEqual([]);
    expect((await devices(b.client)).map((d) => d.id)).toEqual([forB.body.device.id]);
  });

  it(`at most ${PUSH_MAX_DEVICES} devices: the oldest goes`, async () => {
    const u = await withConsent();
    const ids: string[] = [];
    for (let i = 0; i <= PUSH_MAX_DEVICES; i++) {
      const r = await subscribe(u.client, await browserSubscription());
      expect(r.status).toBe(201);
      ids.push(r.body.device.id);
    }
    const left = (await devices(u.client)).map((d) => d.id);
    expect(left).toHaveLength(PUSH_MAX_DEVICES);
    expect(left).not.toContain(ids[0]);
    expect(left).toContain(ids[PUSH_MAX_DEVICES]);
  });
});

describe('removing devices', () => {
  it('a member removes their own device from the list; another member’s is not found', async () => {
    const a = await withConsent();
    const b = await withConsent();
    const mine = (await subscribe(a.client, await browserSubscription())).body.device.id as string;
    const theirs = (await subscribe(b.client, await browserSubscription())).body.device.id as string;
    expect((await a.client.req('DELETE', `/api/me/notifications/subscriptions/${theirs}`)).status).toBe(404);
    expect((await devices(b.client)).map((d) => d.id)).toEqual([theirs]);
    expect((await a.client.req('DELETE', `/api/me/notifications/subscriptions/${mine}`)).status).toBe(200);
    expect(await devices(a.client)).toEqual([]);
    expect((await a.client.req('DELETE', `/api/me/notifications/subscriptions/${mine}`)).status).toBe(404);
  });

  it('this browser stops by its endpoint', async () => {
    const u = await withConsent();
    const s = await browserSubscription();
    await subscribe(u.client, s);
    expect((await u.client.post('/api/me/notifications/subscriptions/remove', { endpoint: s.endpoint })).status).toBe(200);
    expect(await rows(u.me.id)).toEqual([]);
  });

  it('signing out removes this sign-in’s devices only; a password change removes the others’', async () => {
    const u = await withConsent();
    const phone = await signIn(u.email);
    const tablet = await signIn(u.email);
    await subscribe(u.client, await browserSubscription());
    await subscribe(phone, await browserSubscription());
    await subscribe(tablet, await browserSubscription());
    expect(await rows(u.me.id)).toHaveLength(3);
    expect((await phone.post('/api/auth/logout')).status).toBe(200);
    expect(await eventually(() => rows(u.me.id), (r) => r.length === 2)).toHaveLength(2);
    expect((await u.client.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: 'Password456!' })).status).toBe(200);
    const left = await eventually(() => rows(u.me.id), (r) => r.length === 1);
    expect(left).toHaveLength(1);
    expect((await devices(u.client)).map((d) => d.current)).toEqual([true]);
  });

  it('withdrawing service consent removes every device; registering again is refused', async () => {
    const u = await withConsent();
    const s = await browserSubscription();
    await subscribe(u.client, s);
    const v = (await u.client.get('/api/me/notifications/settings')).body.version as number;
    expect((await u.client.req('PUT', '/api/me/notifications/settings', { expectedVersion: v, service: false })).status).toBe(200);
    expect(await rows(u.me.id)).toEqual([]);
    expect((await subscribe(u.client, s)).body.error.code).toBe('push_consent_required');
  });

  it('withdrawing the account removes its devices', async () => {
    const u = await withConsent();
    await subscribe(u.client, await browserSubscription());
    expect((await u.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await eventually(() => rows(u.me.id), (r) => r.length === 0)).toEqual([]);
  });

  it('tells the service worker who this browser is signed in as (the id only), and nothing once signed out', async () => {
    const u = await newUser();
    const other = await newUser();
    const phone = await signIn(u.email);
    const r = await phone.get('/api/me/notifications/recipient');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: u.me.id });
    // Another account in another browser is that account (a push for this one is not shown there).
    expect((await other.client.get('/api/me/notifications/recipient')).body).toEqual({ id: other.me.id });
    expect((await phone.post('/api/auth/logout')).status).toBe(200);
    expect((await phone.get('/api/me/notifications/recipient')).status).toBe(401);
    expect((await new Client().get('/api/me/notifications/recipient')).status).toBe(401);
  });

  it('signed-in members only, from the site only', async () => {
    const s = await browserSubscription();
    const anon = new Client();
    expect((await anon.post('/api/me/notifications/subscriptions', subscriptionBody(s))).status).toBe(401);
    expect((await anon.get('/api/me/notifications/devices')).status).toBe(401);
    expect((await anon.req('DELETE', '/api/me/notifications/subscriptions/x')).status).toBe(401);
    const u = await withConsent();
    const elsewhere = new Client('https://evil.example');
    elsewhere.cookies = u.client.cookies;
    expect((await elsewhere.post('/api/me/notifications/subscriptions', subscriptionBody(s))).status).toBe(403);
    expect((await elsewhere.req('DELETE', '/api/me/notifications/subscriptions/x')).status).toBe(403);
    expect(await rows(u.me.id)).toEqual([]);
  });
});
