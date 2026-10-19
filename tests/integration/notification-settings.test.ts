// Push consent and settings (routes/notifications.ts, lib/notification-settings.ts): the account's, off unless given,
// recorded with every change (never an IP address), and changed only from the version the device showed, so a device
// that has not seen a withdrawal made elsewhere cannot give it back. Sending is tests/integration/push.test.ts.
import { NOTIFICATION_CONSENT_VERSION } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD } from '../support/client';
import { d1 } from '../support/d1';

const settings = async (c: Client) => {
  const r = await c.get('/api/me/notifications/settings');
  expect(r.status).toBe(200);
  return r.body;
};
const save = (c: Client, body: Record<string, unknown>) => c.req('PUT', '/api/me/notifications/settings', body);
const consents = (uid: string) =>
  d1<{ kind: string; agreed: number; source: string; policy_version: string }>(
    `SELECT kind, agreed, source, policy_version FROM notification_consents WHERE user_id = '${uid}' ORDER BY created_at, kind`,
  );
const ALL_ON = { dm: true, invite: true, friendRequest: true, friendAccepted: true, tournamentStart: true, tournamentCancel: true, tournamentResult: true };

describe('push consent at signup', () => {
  it('off unless ticked: no consent, no record, every type ready for when it is given', async () => {
    const u = await newUser();
    expect(await settings(u.client)).toMatchObject({ service: false, night: false, types: ALL_ON, version: 0, serviceAt: null, nightAt: null });
    expect(await consents(u.me.id)).toEqual([]);
  });

  it('both ticked: recorded with the wording shown, as given at signup', async () => {
    const u = await newUser(undefined, { pushConsent: { service: true, night: true } });
    const s = await settings(u.client);
    expect(s).toMatchObject({ service: true, night: true, version: 1 });
    expect(s.serviceAt).toEqual(expect.any(Number));
    expect(s.nightAt).toBe(s.serviceAt);
    expect(await consents(u.me.id)).toEqual([
      { kind: 'night', agreed: 1, source: 'signup', policy_version: NOTIFICATION_CONSENT_VERSION },
      { kind: 'service', agreed: 1, source: 'signup', policy_version: NOTIFICATION_CONSENT_VERSION },
    ]);
    // What is recorded: the kind, the answer, the wording's version, where and when. No address, device or browser.
    const cols = (await d1<{ name: string }>(`SELECT name FROM pragma_table_info('notification_consents')`)).map((c) => c.name);
    expect(cols.sort()).toEqual(['agreed', 'created_at', 'id', 'kind', 'policy_version', 'source', 'user_id']);
  });

  it('night alone counts for nothing; service alone leaves night off', async () => {
    const nightOnly = await newUser(undefined, { pushConsent: { service: false, night: true } });
    expect(await settings(nightOnly.client)).toMatchObject({ service: false, night: false, version: 0 });
    expect(await consents(nightOnly.me.id)).toEqual([]);
    const day = await newUser(undefined, { pushConsent: { service: true, night: false } });
    expect(await settings(day.client)).toMatchObject({ service: true, night: false, nightAt: null, version: 1 });
    expect((await consents(day.me.id)).map((c) => c.kind)).toEqual(['service']);
  });

  it('anything else in the consent is refused, and the signup with it', async () => {
    await expect(newUser(undefined, { pushConsent: { service: true, night: false, marketing: true } })).rejects.toThrow(/register failed 400/);
  });
});

describe('push settings', () => {
  it('a change raises the version and records each consent given or withdrawn; nothing changed is no new version', async () => {
    const u = await newUser();
    const on = await save(u.client, { expectedVersion: 0, service: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ service: true, night: false, version: 1, types: ALL_ON });
    const off = await save(u.client, { expectedVersion: 1, types: { dm: false, tournamentResult: false } });
    expect(off.body).toMatchObject({ version: 2, types: { ...ALL_ON, dm: false, tournamentResult: false } });
    const same = await save(u.client, { expectedVersion: 2, service: true, types: { dm: false } });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(2);
    expect(await settings(u.client)).toEqual(same.body);
    expect(await consents(u.me.id)).toEqual([{ kind: 'service', agreed: 1, source: 'settings', policy_version: NOTIFICATION_CONSENT_VERSION }]);
  });

  it('night needs service: refused alone; withdrawing service withdraws night too', async () => {
    const u = await newUser(undefined, { pushConsent: { service: true, night: true } });
    const alone = await newUser();
    const r = await save(alone.client, { expectedVersion: 0, night: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('night_needs_service');
    const w = await save(u.client, { expectedVersion: 1, service: false });
    expect(w.body).toMatchObject({ service: false, night: false, version: 2 });
    expect((await consents(u.me.id)).filter((c) => c.source === 'settings')).toEqual([
      { kind: 'night', agreed: 0, source: 'settings', policy_version: NOTIFICATION_CONSENT_VERSION },
      { kind: 'service', agreed: 0, source: 'settings', policy_version: NOTIFICATION_CONSENT_VERSION },
    ]);
    // Given again, service comes back without night.
    expect((await save(u.client, { expectedVersion: 2, service: true })).body).toMatchObject({ service: true, night: false, version: 3 });
  });

  it('a device that has not seen a withdrawal made on another cannot undo it by saving', async () => {
    const phone = await newUser(undefined, { pushConsent: { service: true, night: true } });
    const laptop = new Client();
    expect((await laptop.post('/api/auth/login', { email: phone.email, password: PASSWORD })).status).toBe(200);
    const shown = await settings(laptop);
    expect(shown.version).toBe(1);
    // Withdrawn on the phone.
    expect((await save(phone.client, { expectedVersion: 1, service: false })).body.version).toBe(2);
    // The laptop still shows version 1: whatever it saves from there is refused, with the account's settings to show.
    for (const body of [{ service: true }, { night: true }, { types: { dm: true } }, { service: true, night: true }]) {
      const r = await save(laptop, { expectedVersion: 1, ...body });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('stale_settings');
      expect(r.body.error.details).toMatchObject({ service: false, night: false, version: 2 });
    }
    expect(await settings(phone.client)).toMatchObject({ service: false, night: false, version: 2 });
  });

  it('two devices saving at once from the same version: one is saved, the other told to look again', async () => {
    const u = await newUser();
    const other = new Client();
    expect((await other.post('/api/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    const [a, b] = await Promise.all([save(u.client, { expectedVersion: 0, service: true }), save(other, { expectedVersion: 0, service: true, types: { dm: false } })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const s = await settings(u.client);
    expect(s.version).toBe(1);
    expect((await consents(u.me.id)).length).toBe(1);
  });

  it('signed-in members only, from the site only, in the shape given', async () => {
    const anon = new Client();
    expect((await anon.get('/api/me/notifications/settings')).status).toBe(401);
    expect((await save(anon, { expectedVersion: 0, service: true })).status).toBe(401);
    const u = await newUser();
    const elsewhere = new Client('https://evil.example');
    elsewhere.cookies = u.client.cookies;
    expect((await save(elsewhere, { expectedVersion: 0, service: true })).status).toBe(403);
    for (const body of [{ service: true }, { expectedVersion: 0, service: 'yes' }, { expectedVersion: 0, marketing: true }, { expectedVersion: 0, types: { chat: true } }, { expectedVersion: -1 }]) {
      expect((await save(u.client, body)).status).toBe(400);
    }
    expect((await settings(u.client)).version).toBe(0);
  });

  it('go with the account at withdrawal; the record of consents stays', async () => {
    const u = await newUser(undefined, { pushConsent: { service: true, night: false } });
    expect((await u.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await d1(`SELECT user_id FROM notification_settings WHERE user_id = '${u.me.id}'`)).toEqual([]);
    expect(await consents(u.me.id)).toHaveLength(1);
  });
});
