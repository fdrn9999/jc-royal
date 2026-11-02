// The notification inbox (packages/types/src/inbox.ts, apps/api/src/routes/inbox.ts): what puts an item in a member's
// list, the unread count every page reads with the others, marking read (one item, all, a filter), what an answered or
// stale item shows, sign-ins and password changes as account security items, and what a withdrawal takes with it.
import type { InboxItemDto, InboxPageDto } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';

type User = Awaited<ReturnType<typeof newUser>>;

const inbox = async (c: Client, q = '') => {
  const r = await c.get<InboxPageDto>(`/api/notifications${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const of = (p: InboxPageDto, kind: InboxItemDto['kind']) => p.items.filter((i) => i.kind === kind);
const counted = async (c: Client) => (await c.get<{ notifications: number }>('/api/messages/unread-count')).body.notifications;

async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

/** Signs in again as `u` from a browser this `ua` names, the session kept in `u.client` (a new device, or the same). */
async function signInAs(u: User, ua: string) {
  const res = await fetch(BASE() + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: WEB_ORIGIN, 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ email: u.email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.getSetCookie().find((s) => s.startsWith('jc_sid='))!.split(';')[0]!.split('=');
  u.client.cookies.set(sid[0]!, sid.slice(1).join('='));
}

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

describe('notification inbox', () => {
  it('needs a member, and takes only its own filters, cursors and read bodies', async () => {
    const anon = new Client();
    expect((await anon.get('/api/notifications')).status).toBe(401);
    expect((await anon.post('/api/notifications/read', { all: true })).status).toBe(401);
    const u = await newUser();
    expect((await u.client.get('/api/notifications?filter=everything')).status).toBe(400);
    expect((await u.client.get('/api/notifications?before=yesterday')).status).toBe(400);
    expect((await u.client.get('/api/notifications?limit=500')).status).toBe(400);
    expect((await u.client.post('/api/notifications/read', {})).status).toBe(400);
    expect((await u.client.post('/api/notifications/read', { all: false })).status).toBe(400);
    expect((await u.client.post('/api/notifications/read', { ids: [] })).status).toBe(400);
    // A new member's sign-up is its own device: the only unread item is the welcome 쪽지 (routes/auth.ts).
    const first = await inbox(u.client);
    expect(first.items.filter((i) => i.readAt === null).map((i) => i.kind)).toEqual(['message']);
    expect(first.unread).toBe(1);
    expect(of(first, 'security').every((i) => i.readAt !== null)).toBe(true);
    expect(await counted(u.client)).toBe(1);
  });

  it('a friend request, then its answer: one item each, the request showing what became of it, read on accepting', async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
    const got = await inbox(b.client, '?filter=social');
    const [req] = of(got, 'friend_request');
    expect(req).toMatchObject({ actor: { id: a.me.id, nickname: a.me.nickname }, state: 'open', readAt: null, href: '/friends' });
    expect(got.unread).toBeGreaterThanOrEqual(1);
    expect(await counted(b.client)).toBe(got.unread);
    // Nothing of the other's private record (an e-mail) rides on the item.
    expect(JSON.stringify(req)).not.toContain(a.email);

    expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
    const after = of(await inbox(b.client), 'friend_request')[0]!;
    expect(after.state).toBe('done');
    expect(after.readAt).not.toBeNull();
    const [acc] = of(await inbox(a.client), 'friend_accepted');
    expect(acc).toMatchObject({ actor: { id: b.me.id }, readAt: null });
    // A second accept (a retry) changes nothing.
    await b.client.post(`/api/friends/${a.me.id}/accept`);
    expect(of(await inbox(a.client), 'friend_accepted')).toHaveLength(1);
  });

  it('messages from a friend are one item, counted until read, and reading the conversation reads it', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    for (const text of ['one', 'two', 'three']) expect((await a.client.post(`/api/dm/${b.me.id}`, { text })).status).toBe(201);
    const [dm] = of(await inbox(b.client), 'dm');
    expect(dm).toMatchObject({ actor: { id: a.me.id }, count: 3, readAt: null, href: `/friends/${a.me.id}` });
    // The text of a message is never on the item.
    expect(JSON.stringify(dm)).not.toContain('three');
    expect((await b.client.post(`/api/dm/${a.me.id}/read`)).status).toBe(200);
    expect(of(await inbox(b.client), 'dm')[0]!.readAt).not.toBeNull();
    // A new one after reading starts over at one.
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'four' });
    expect(of(await inbox(b.client), 'dm')[0]).toMatchObject({ count: 1, readAt: null });
  });

  it('marking read: by id (never another member\'s), all of a filter, and all', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await a.client.post('/api/friends/requests', { userId: c.me.id });
    await b.client.post('/api/friends/requests', { userId: c.me.id });
    const items = of(await inbox(c.client), 'friend_request');
    expect(items).toHaveLength(2);
    // Another member cannot read c's items.
    expect((await a.client.post('/api/notifications/read', { ids: [items[0]!.id] })).body).toEqual({ read: 0 });
    expect(of(await inbox(c.client, '?unread=1'), 'friend_request')).toHaveLength(2);

    expect((await c.client.post('/api/notifications/read', { ids: [items[0]!.id] })).body).toEqual({ read: 1 });
    // Again: already read.
    expect((await c.client.post('/api/notifications/read', { ids: [items[0]!.id] })).body).toEqual({ read: 0 });
    expect(of(await inbox(c.client, '?unread=1'), 'friend_request').map((i) => i.id)).toEqual([items[1]!.id]);

    // A filter reads only its kinds.
    expect((await c.client.post('/api/notifications/read', { all: true, filter: 'service' })).status).toBe(200);
    expect(of(await inbox(c.client, '?unread=1'), 'friend_request')).toHaveLength(1);
    expect((await c.client.post('/api/notifications/read', { all: true, filter: 'social' })).body.read).toBeGreaterThanOrEqual(1);
    expect((await inbox(c.client, '?unread=1&filter=social')).items).toHaveLength(0);
    await c.client.post('/api/notifications/read', { all: true });
    expect((await inbox(c.client)).unread).toBe(0);
    expect(await counted(c.client)).toBe(0);
  });

  it('pages: newest first, each page after the last, none twice', async () => {
    const c = await newUser();
    const others = await Promise.all([1, 2, 3, 4, 5].map(() => newUser()));
    for (const o of others) await o.client.post('/api/friends/requests', { userId: c.me.id });
    const seen: string[] = [];
    let page = await inbox(c.client, '?filter=social&limit=2');
    for (;;) {
      seen.push(...page.items.map((i) => i.id));
      for (let i = 1; i < page.items.length; i++) expect(page.items[i - 1]!.at).toBeGreaterThanOrEqual(page.items[i]!.at);
      if (!page.next) break;
      page = await inbox(c.client, `?filter=social&limit=2&before=${encodeURIComponent(page.next)}`);
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('a sign-in from a new device is news; the same device again is not; a password change is', async () => {
    const u = await newUser();
    await signInAs(u, FIREFOX_LINUX);
    const signIns = of(await inbox(u.client, '?filter=account'), 'security').filter((i) => i.params.event === 'sign_in');
    const fresh = signIns.find((i) => i.params.device === 'Firefox · Linux');
    expect(fresh).toMatchObject({ readAt: null, href: '/me' });
    // Nothing of the session (its id, the address) is on the item.
    expect(Object.keys(fresh!.params).sort()).toEqual(['device', 'event']);
    await u.client.post('/api/notifications/read', { ids: [fresh!.id] });
    // The same browser and system again, while it is signed in there: nothing new.
    await signInAs(u, FIREFOX_LINUX);
    // (The account filter also lists the 쪽지 item, unread here with the welcome 쪽지.)
    expect(of(await inbox(u.client, '?unread=1&filter=account'), 'security')).toHaveLength(0);

    // The session that changed it stays signed in (the others end).
    expect((await u.client.post('/api/auth/me/password', { currentPassword: PASSWORD, newPassword: 'changed123!' })).status).toBe(200);
    const sec = of(await inbox(u.client, '?filter=account'), 'security');
    expect(sec.find((i) => i.params.event === 'password_change')).toMatchObject({ readAt: null, href: '/me' });
  });

  it('a VIP change by an administrator is an account item; withdrawing takes the member\'s items and those about it', async () => {
    const admin = sharedAdmin();
    const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
    if (!until || until - Date.now() < 60_000) expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const m = await newUser();
    const version = (await admin.get(`/api/admin/users/${m.me.id}/vip`)).body.version as number;
    const r = await admin.patch(`/api/admin/users/${m.me.id}/vip`, { enabled: true, color: 'rose', reason: 'inbox test', expectedVersion: version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(of(await inbox(m.client, '?filter=account'), 'vip')[0]).toMatchObject({ params: { color: 'rose' }, readAt: null });

    const a = await newUser();
    await befriend(m, a);
    await m.client.post(`/api/dm/${a.me.id}`, { text: 'hello' });
    expect(of(await inbox(a.client), 'dm')).toHaveLength(1);
    expect((await m.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    // Nothing of m is left: its own items and those it is the actor of.
    expect(await d1(`SELECT id FROM notifications WHERE user_id = '${m.me.id}' OR actor_id = '${m.me.id}'`)).toEqual([]);
    const left = await inbox(a.client);
    expect(left.items.some((i) => i.actor?.id === m.me.id)).toBe(false);
  });
});
