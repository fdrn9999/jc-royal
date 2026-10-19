// Sending pushes (apps/api/src/lib/notify.ts) to a local stand-in for the push services (tests/support/push-sink.ts),
// decrypted as the browser would: what each event sends and opens, generic words only, in the member's language, signed
// with the server's key; nothing without consent or with the type off, nothing at night without night consent (and
// nothing held for the morning); everything checked again when it goes out (a block, a withdrawal, an expiry); a friend's
// messages a minute apart, none for the conversation being read; a browser that is gone is dropped, a busy one tried
// again, and the action stands whatever the push does. A mocked push service, not a real browser or device.
import { isKstNight, type TournamentStructure, type TournamentTemplateDto, type AdminTournamentRow, type TableView } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { browserSubscription, decrypt, eventually, received, runPushCron, subscribe, type BrowserSubscription } from '../support/push';
import type { SinkRecord } from '../support/push-sink';
import { TABLES } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

type Member = Awaited<ReturnType<typeof newUser>>;
const ALL_DAY = { service: true, night: true };

type Pushed = Member & { sub: BrowserSubscription };
/** A browser registered for the member, answering as `behaviour` says. */
async function attach(u: Member, behaviour: 'ok' | 'gone' | 'busy' | 'bad' = 'ok'): Promise<Pushed> {
  const sub = await browserSubscription(behaviour);
  const r = await subscribe(u.client, sub);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...u, sub };
}
/** A member with pushes on (night too, so the time the suite runs at changes nothing) and one browser registered. */
const member = async (extra: Record<string, unknown> = {}) => attach(await newUser(undefined, { pushConsent: ALL_DAY, ...extra }));

/** What reached the browser, decrypted; of one kind only with `t` (making friends sends pushes of its own). */
async function got(s: BrowserSubscription, t?: string): Promise<{ rec: SinkRecord; p: Record<string, unknown> }[]> {
  const all = await Promise.all((await received(s)).map(async (rec) => ({ rec, p: await decrypt(s, rec) })));
  return t ? all.filter((x) => x.p.t === t) : all;
}
const waitGot = (s: BrowserSubscription, t: string, n = 1) => eventually(() => got(s, t), (r) => r.length >= n);

async function befriend(a: Member, b: Member) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

interface EventRow {
  type: string;
  status: string;
  reason: string | null;
  attempts: number;
  url: string;
  next_attempt_at: number;
  dedupe_key: string;
}
const events = (uid: string, type?: string) =>
  d1<EventRow>(
    `SELECT type, status, reason, attempts, url, next_attempt_at, dedupe_key FROM notification_events WHERE user_id = '${uid}'${type ? ` AND type = '${type}'` : ''} ORDER BY created_at, id`,
  );
/** The events once none is pending (or after a while). */
const settled = (uid: string, n: number, type?: string) => eventually(() => events(uid, type), (r) => r.length >= n && r.every((e) => e.status !== 'pending'), 10_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An event put in the outbox directly, for what changes between queuing and sending. */
async function queueRaw(userId: string, type: string, o: { coalesce?: string; url?: string; createdAt?: number; expiresAt?: number } = {}) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const at = o.createdAt ?? Date.now();
  await d1(
    `INSERT INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, expires_at, created_at)
     VALUES ('${id}', 'test:${id}', '${userId}', '${type}', '${o.url ?? '/friends'}', ${o.coalesce ? `'${o.coalesce}'` : 'NULL'}, 'pending', 0, ${at}, ${o.expiresAt ?? Date.now() + 3_600_000}, ${at})`,
  );
  return id;
}
const eventById = async (id: string) => (await d1<EventRow>(`SELECT type, status, reason, attempts, url, next_attempt_at, dedupe_key FROM notification_events WHERE id = '${id}'`))[0];

/** The Authorization header's VAPID token: its claims, and whether the server's public key signed it. */
async function vapid(header: string) {
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  expect(m, header).toBeTruthy();
  const [, h, p, sig, k] = m!;
  const key = await crypto.subtle.importKey('raw', Buffer.from(k!, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig!, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
  return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(p!, 'base64url').toString()), k: k!, valid };
}

describe('what each event sends', () => {
  it('a message: one push, generic words, signed by the server, opening the conversation; never the text or the sender', async () => {
    const [a, b] = await Promise.all([member(), member()]);
    await befriend(a, b);
    const text = `secret-${uniq('m')}`;
    const sent = await a.client.post(`/api/dm/${b.me.id}`, { text });
    expect(sent.status).toBe(201);
    const [first] = await waitGot(b.sub, 'dm');
    expect(first, 'a push reached the stand-in').toBeTruthy();
    const { rec, p } = first!;
    expect(rec.status).toBe(201);
    expect(rec.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', urgency: 'high' });
    expect(Number(rec.headers.ttl)).toBeGreaterThan(0);
    expect(Number(rec.headers.ttl)).toBeLessThanOrEqual(3600);
    expect(rec.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    const token = await vapid(rec.headers.authorization!);
    expect(token.valid).toBe(true);
    expect(token.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(token.claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://jc-royal.site' });
    expect(token.claims.exp * 1000).toBeGreaterThan(Date.now());
    expect(token.claims.exp * 1000).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    expect(token.k).toBe((await b.client.get('/api/me/notifications/push-key')).body.publicKey);

    expect(p).toMatchObject({ t: 'dm', title: '새 메시지', body: '친구가 1:1 메시지를 보냈습니다.', lang: 'ko', url: `/friends/${a.me.id}`, to: b.me.id, tag: `dm:${a.me.id}` });
    const shown = JSON.stringify(p);
    for (const leak of [text, a.me.nickname, a.email]) expect(shown).not.toContain(leak);
    // The sender's own browser gets nothing for it.
    expect(await got(a.sub, 'dm')).toEqual([]);
    expect((await settled(b.me.id, 1, 'dm'))[0]).toMatchObject({ type: 'dm', status: 'sent', attempts: 1 });
    // A push never marks the message read.
    const convo = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(convo.messages.at(-1)).toMatchObject({ body: text, readAt: null });
  });

  it('in the member’s language', async () => {
    const [a, b] = await Promise.all([member(), member({ locale: 'en' })]);
    await befriend(a, b);
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'hi' });
    const [x] = await waitGot(b.sub, 'dm');
    expect(x?.p).toMatchObject({ t: 'dm', title: 'New message', body: 'A friend sent you a message.', lang: 'en' });
  });

  it('an invite opens the conversation with its join card (the table still decides who may sit)', async () => {
    const [a, b] = await Promise.all([member(), member()]);
    await befriend(a, b);
    const r = await a.client.post(`/api/friends/${b.me.id}/invite`, { tableId: TABLES[0]!.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [x] = await waitGot(b.sub, 'invite');
    expect(x?.p).toMatchObject({ t: 'invite', url: `/friends/${a.me.id}`, to: b.me.id, tag: `invite:${a.me.id}` });
    expect(JSON.stringify(x?.p)).not.toContain(TABLES[0]!.id);
  });

  it('a friend request, only when it is made; the same request again is not told twice', async () => {
    const [a, b] = await Promise.all([member(), member()]);
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
    const [x] = await waitGot(b.sub, 'friendRequest');
    expect(x?.p).toMatchObject({ t: 'friendRequest', url: '/friends', to: b.me.id, tag: `fr:${a.me.id}` });
    // Asked again while pending: refused, nothing new. Withdrawn and asked again: still one push.
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(409);
    expect((await a.client.req('DELETE', `/api/friends/${b.me.id}`)).status).toBe(200);
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
    await sleep(1500);
    expect(await received(b.sub)).toHaveLength(1);
    expect(await events(b.me.id, 'friend_request')).toHaveLength(1);
  });

  it('an accepted request tells the one who asked, opening the new friend', async () => {
    const [a, b] = await Promise.all([member(), member()]);
    await befriend(a, b);
    const [x] = await waitGot(a.sub, 'friendAccepted');
    expect(x?.p).toMatchObject({ t: 'friendAccepted', url: `/friends/${b.me.id}`, to: a.me.id, tag: `fa:${b.me.id}` });
    expect(await got(b.sub, 'friendAccepted')).toEqual([]);
  });
});

describe('who gets one', () => {
  it('nothing without service consent, or with the type off (nothing is even queued)', async () => {
    const a = await member();
    const off = await member();
    const v = (await off.client.get('/api/me/notifications/settings')).body.version as number;
    expect((await off.client.req('PUT', '/api/me/notifications/settings', { expectedVersion: v, types: { dm: false } })).status).toBe(200);
    const none = await newUser();
    await befriend(a, off);
    await befriend(a, none);
    expect((await a.client.post(`/api/dm/${off.me.id}`, { text: 'x' })).status).toBe(201);
    expect((await a.client.post(`/api/dm/${none.me.id}`, { text: 'x' })).status).toBe(201);
    await sleep(1500);
    expect(await got(off.sub, 'dm')).toEqual([]);
    expect(await events(off.me.id, 'dm')).toEqual([]);
    expect(await events(none.me.id)).toEqual([]);
  });

  it('at night (21:00–08:00 in Korea) only with night consent; a night event is never sent in the morning', async () => {
    const a = await member();
    const day = await member({ pushConsent: { service: true, night: false } });
    await befriend(a, day);
    expect((await a.client.post(`/api/dm/${day.me.id}`, { text: 'x' })).status).toBe(201);
    const [ev] = await settled(day.me.id, 1, 'dm');
    // The suite runs at any hour: what is right depends on the hour in Korea now (the boundaries are unit tests).
    if (isKstNight(Date.now())) expect(ev).toMatchObject({ status: 'skipped', reason: 'night' });
    else expect(ev).toMatchObject({ status: 'sent' });
    // Made at 22:00 in Korea last night, still within its lifetime: dropped, whatever the time is now.
    const kstMidnight = Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
    const id = await queueRaw(day.me.id, 'tournament_result', { url: '/tournaments/x', createdAt: kstMidnight - 2 * 3_600_000, expiresAt: Date.now() + 3_600_000 });
    await runPushCron();
    expect(await eventById(id)).toMatchObject({ status: 'skipped', reason: 'night' });
    expect(await got(day.sub, 'tournamentResult')).toEqual([]);
  });

  it('checked again when it goes out: a block, an unfriending, a withdrawn account, a type turned off, an expiry', async () => {
    const [a, b, c, gone, typed] = await Promise.all([member(), member(), member(), member(), member()]);
    await befriend(a, b);
    // Queued while friends (making friends sends what is due for them at once), then blocked: the block wins.
    const blocked = await queueRaw(b.me.id, 'dm', { coalesce: `dm:${a.me.id}` });
    expect((await b.client.req('PUT', `/api/blocks/${a.me.id}`)).status).toBe(200);
    // Never friends.
    const unfriended = await queueRaw(c.me.id, 'invite', { coalesce: `invite:${a.me.id}` });
    const expired = await queueRaw(a.me.id, 'friend_request', { coalesce: `fr:${c.me.id}`, expiresAt: Date.now() - 1000 });
    expect((await gone.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    const withdrawn = await queueRaw(gone.me.id, 'tournament_result', { url: '/tournaments/x' });
    const v = (await typed.client.get('/api/me/notifications/settings')).body.version as number;
    const offLater = await queueRaw(typed.me.id, 'tournament_result', { url: '/tournaments/x' });
    expect((await typed.client.req('PUT', '/api/me/notifications/settings', { expectedVersion: v, types: { tournamentResult: false } })).status).toBe(200);
    await runPushCron();
    expect(await eventById(blocked)).toMatchObject({ status: 'skipped', reason: 'no_relation' });
    expect(await eventById(unfriended)).toMatchObject({ status: 'skipped', reason: 'no_relation' });
    expect(await eventById(expired)).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(await eventById(withdrawn)).toMatchObject({ status: 'skipped', reason: 'inactive' });
    expect(await eventById(offLater)).toMatchObject({ status: 'skipped', reason: 'type_off' });
    expect(await got(b.sub, 'dm')).toEqual([]);
    expect(await got(c.sub, 'invite')).toEqual([]);
    expect(await got(a.sub, 'friendRequest')).toEqual([]);
    expect(await received(gone.sub)).toEqual([]);
    expect(await received(typed.sub)).toEqual([]);
  });

  it('a browser now signed in to another account gets that account’s pushes only; once signed out, none', async () => {
    const [a, b, friend, other] = await Promise.all([member(), member(), member(), member()]);
    await befriend(friend, a);
    await befriend(friend, b);
    await befriend(other, a);
    // b's browser, where a has signed in since: it is a's now.
    const shared = b.sub;
    expect((await subscribe(a.client, shared)).status).toBe(201);
    expect((await friend.client.post(`/api/dm/${b.me.id}`, { text: 'to b' })).status).toBe(201);
    await sleep(1500);
    expect(await got(shared, 'dm'), 'nothing for b on the browser a now uses').toEqual([]);
    expect(await events(b.me.id, 'dm'), 'b has no browser left: nothing queued').toEqual([]);
    expect((await friend.client.post(`/api/dm/${a.me.id}`, { text: 'to a' })).status).toBe(201);
    const recs = await waitGot(shared, 'dm');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.p).toMatchObject({ to: a.me.id });
    // Signed out: the registration went with the sign-in.
    expect((await a.client.post('/api/auth/logout')).status).toBe(200);
    await eventually(() => d1(`SELECT id FROM push_subscriptions WHERE user_id = '${a.me.id}'`), (r) => r.length === 0);
    expect((await other.client.post(`/api/dm/${a.me.id}`, { text: 'after' })).status).toBe(201);
    await sleep(1500);
    expect(await got(shared, 'dm')).toHaveLength(1);
  });
});

describe('how often', () => {
  it('a friend’s messages: one push a minute (the next ones are not sent); another friend’s still are', async () => {
    const [a, b, c] = await Promise.all([member(), member(), member()]);
    await befriend(a, b);
    await befriend(c, b);
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: '1' })).status).toBe(201);
    await settled(b.me.id, 1, 'dm');
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: '2' })).status).toBe(201);
    expect((await c.client.post(`/api/dm/${b.me.id}`, { text: '3' })).status).toBe(201);
    const evs = await settled(b.me.id, 3, 'dm');
    expect(evs.map((e) => [e.url, e.status, e.reason])).toEqual([
      [`/friends/${a.me.id}`, 'sent', null],
      [`/friends/${a.me.id}`, 'skipped', 'cooldown'],
      [`/friends/${c.me.id}`, 'sent', null],
    ]);
    expect((await got(b.sub, 'dm')).map((x) => x.p.tag)).toEqual([`dm:${a.me.id}`, `dm:${c.me.id}`]);
  });

  it('none for the conversation being read on a device now; one for another conversation', async () => {
    const [a, b, c] = await Promise.all([member(), member(), member()]);
    await befriend(a, b);
    await befriend(c, b);
    const conn = `push-${Date.now().toString(36)}`;
    expect((await b.client.post('/api/me/presence/heartbeat', { conn, idleMs: 0, visible: true, view: `dm:${a.me.id}` })).status).toBe(200);
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'seen' })).status).toBe(201);
    expect((await c.client.post(`/api/dm/${b.me.id}`, { text: 'not seen' })).status).toBe(201);
    const evs = await settled(b.me.id, 2, 'dm');
    expect(evs.find((e) => e.url === `/friends/${a.me.id}`)).toMatchObject({ status: 'skipped', reason: 'viewing' });
    expect(evs.find((e) => e.url === `/friends/${c.me.id}`)).toMatchObject({ status: 'sent' });
    expect((await got(b.sub, 'dm')).map((x) => x.p.tag)).toEqual([`dm:${c.me.id}`]);
  });

  it('sent once however many senders run at the same time', async () => {
    const b = await member();
    const id = await queueRaw(b.me.id, 'tournament_result', { url: '/tournaments/x', coalesce: 'tournament_result:x' });
    await Promise.all([runPushCron(), runPushCron(), runPushCron()]);
    expect(await eventById(id)).toMatchObject({ status: 'sent', attempts: 1 });
    await sleep(500);
    expect(await received(b.sub)).toHaveLength(1);
  });
});

describe('when the push service says no', () => {
  /** Friends first, then the browser (making friends would already have reached it). */
  async function pair(behaviour: 'gone' | 'busy') {
    const a = await member();
    const u = await newUser(undefined, { pushConsent: ALL_DAY });
    await befriend(a, u);
    return { a, b: await attach(u, behaviour) };
  }

  it('a browser that is gone (410) is dropped; the message is saved either way', async () => {
    const { a, b } = await pair('gone');
    const r = await a.client.post(`/api/dm/${b.me.id}`, { text: 'kept' });
    expect(r.status).toBe(201);
    expect((await settled(b.me.id, 1, 'dm'))[0]).toMatchObject({ status: 'failed', reason: 'gone' });
    expect(await d1(`SELECT id FROM push_subscriptions WHERE user_id = '${b.me.id}'`)).toEqual([]);
    expect((await b.client.get(`/api/dm/${a.me.id}`)).body.messages.at(-1)).toMatchObject({ body: 'kept' });
  });

  it('a busy push service (503) is tried again later, never at once; the message is saved', async () => {
    const { a, b } = await pair('busy');
    const before = Date.now();
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'kept' })).status).toBe(201);
    const [ev] = await eventually(() => events(b.me.id, 'dm'), (r) => r[0]?.reason === 'retry');
    expect(ev).toMatchObject({ status: 'pending', reason: 'retry', attempts: 1 });
    expect(ev!.next_attempt_at).toBeGreaterThanOrEqual(before + 60_000);
    // The minute run does not send it before then.
    await runPushCron();
    expect(await got(b.sub, 'dm')).toHaveLength(1);
    expect((await events(b.me.id, 'dm'))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    const [dev] = await d1<{ failures: number; last_failure_at: number | null }>(`SELECT failures, last_failure_at FROM push_subscriptions WHERE user_id = '${b.me.id}'`);
    expect(dev).toMatchObject({ failures: 1 });
    expect(dev!.last_failure_at).toBeGreaterThan(0);
    expect((await b.client.get(`/api/dm/${a.me.id}`)).body.messages.at(-1)).toMatchObject({ body: 'kept' });
  });

  it('a browser refused three times in a row is dropped; a push reaching any browser is sent', async () => {
    const b = await attach(await newUser(undefined, { pushConsent: ALL_DAY }), 'bad');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await queueRaw(b.me.id, 'tournament_result', { url: '/tournaments/x' }));
      await runPushCron();
    }
    for (const id of ids) expect(await eventById(id)).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(await d1(`SELECT id FROM push_subscriptions WHERE user_id = '${b.me.id}'`)).toEqual([]);

    const c = await member();
    expect((await subscribe(c.client, await browserSubscription('gone'))).status).toBe(201);
    const id = await queueRaw(c.me.id, 'tournament_result', { url: '/tournaments/y' });
    await runPushCron();
    expect(await eventById(id)).toMatchObject({ status: 'sent' });
    expect(await received(c.sub)).toHaveLength(1);
    expect(await d1(`SELECT id FROM push_subscriptions WHERE user_id = '${c.me.id}'`)).toHaveLength(1);
  });
});

// Tournaments: started, called off (before and after the start) and finished, to registered members only, once each.
const admin = sharedAdmin();
async function reauth(c: Client = admin) {
  const valid = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const FAST: TournamentStructure = {
  name: 'fast',
  capacity: 2,
  minPlayers: 2,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
  ],
  levelMinutes: 1,
  turnSeconds: 10,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};
const opened: string[] = [];
const sockets: TableSocket[] = [];
async function tournament(over: Partial<TournamentStructure> = {}): Promise<AdminTournamentRow> {
  await reauth();
  const tpl = await admin.post('/api/admin/tournament-templates', { ...FAST, name: uniq('tpl'), ...over, reason: 'push test' });
  expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
  const t = tpl.body.template as TournamentTemplateDto;
  const r = await admin.post('/api/admin/tournaments', { templateId: t.id, templateVersion: t.version, name: uniq('T') });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  opened.push(r.body.tournament.id);
  return r.body.tournament;
}
const adminRow = async (id: string): Promise<AdminTournamentRow> => (await admin.get(`/api/admin/tournaments/${id}`)).body.tournament;
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const id of opened) {
    const t = await adminRow(id).catch(() => null);
    if (!t) continue;
    await reauth();
    if (t.status === 'running') await admin.post(`/api/admin/tournaments/${id}/abort`, { baseVersion: t.version, reason: 'push test done', confirmName: t.name });
    else if (t.status === 'registering' || t.status === 'closed') await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'push test done' });
  }
});

describe('tournaments', () => {
  it('called off before the start: each registered member once, opening the tournament', async () => {
    const t = await tournament({ capacity: 3, autoStart: false });
    const [a, b] = await Promise.all([member(), member()]);
    expect((await a.client.post(`/api/tournaments/${t.id}/register`)).status).toBe(200);
    await reauth();
    const r = await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: (await adminRow(t.id)).version, reason: 'push test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [x] = await waitGot(a.sub, 'tournamentCancel');
    expect(x?.p).toMatchObject({ t: 'tournamentCancel', title: '토너먼트 취소', url: `/tournaments/${t.id}`, to: a.me.id, tag: `tournament_cancel:${t.id}` });
    await sleep(1000);
    expect(await received(a.sub)).toHaveLength(1);
    expect(await received(b.sub), 'not registered').toEqual([]);
  });

  it('started: each player once, opening the table; stopped by an operator: told it was called off', async () => {
    const t = await tournament();
    const [a, b] = await Promise.all([member(), member()]);
    expect((await a.client.post(`/api/tournaments/${t.id}/register`)).status).toBe(200);
    const second = await b.client.post(`/api/tournaments/${t.id}/register`);
    expect(second.body).toMatchObject({ started: true, tableId: `sng-${t.id}` });
    for (const m of [a, b]) {
      const [x] = await waitGot(m.sub, 'tournamentStart');
      expect(x?.p).toMatchObject({ t: 'tournamentStart', url: `/table/sng-${t.id}`, to: m.me.id, tag: `tournament_start:${t.id}` });
      expect(x!.rec.headers.urgency).toBe('high');
    }
    await reauth();
    const row = await adminRow(t.id);
    const r = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: row.version, reason: 'push test', confirmName: row.name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const m of [a, b]) {
      const recs = await waitGot(m.sub, 'tournamentCancel');
      expect(recs).toHaveLength(1);
      expect(recs[0]!.p).toMatchObject({ t: 'tournamentCancel', url: `/tournaments/${t.id}`, to: m.me.id, tag: `tournament_abort:${t.id}` });
      expect(await got(m.sub, 'tournamentStart'), 'started once').toHaveLength(1);
    }
  }, 60_000);

  it('finished: each player once, opening the result (sent by the minute run)', async () => {
    const t = await tournament();
    const [a, b] = await Promise.all([member(), member()]);
    expect((await a.client.post(`/api/tournaments/${t.id}/register`)).status).toBe(200);
    const second = await b.client.post(`/api/tournaments/${t.id}/register`);
    const tableId = second.body.tableId as string;
    const ws = [await TableSocket.open(a.client, tableId), await TableSocket.open(b.client, tableId)];
    sockets.push(...ws);
    let on = true;
    const busy = new Set<TableSocket>();
    const play = (async () => {
      while (on) {
        for (const w of ws) {
          const s = w.state as TableView | null;
          if (busy.has(w) || w.closed || !s || !isMyTurn(s)) continue;
          const has = (type: string) => s.you.legal.some((o) => o.type === type);
          busy.add(w);
          void w
            .act(has('allin') ? 'allin' : has('call') ? 'call' : 'check')
            .catch(() => undefined)
            .finally(() => busy.delete(w));
        }
        await sleep(100);
      }
    })();
    await ws[0]!.waitState((x) => x.tournament?.status === 'finished', 180_000, 'the tournament to finish');
    on = false;
    await play;
    await eventually(() => events(a.me.id, 'tournament_result'), (r) => r.length === 1, 20_000);
    await runPushCron();
    for (const m of [a, b]) {
      const recs = await waitGot(m.sub, 'tournamentResult');
      expect(recs).toHaveLength(1);
      expect(recs[0]!.p).toMatchObject({ t: 'tournamentResult', url: `/tournaments/${t.id}`, to: m.me.id });
    }
    // The minute run again: nothing more.
    await runPushCron();
    expect(await got(a.sub, 'tournamentResult')).toHaveLength(1);
  }, 240_000);
});
