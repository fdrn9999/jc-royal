import { beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { TableSocket } from '../support/ws';

let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

const counts = async (c: Client) => (await c.get('/api/messages/unread-count')).body as { unread: number; dmUnread: number; friendRequests: number };
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe('friends', () => {
  it('request by nickname → accept; decline, cancel and unfriend remove the link', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    // Unknown nickname, self, and validation.
    expect((await a.client.post('/api/friends/requests', { nickname: 'no-such-player-xyz' })).status).toBe(404);
    expect((await a.client.post('/api/friends/requests', { nickname: a.me.nickname })).body.error.code).toBe('friend_self');
    expect((await a.client.post('/api/friends/requests', {})).status).toBe(400);

    // Nicknames match case-insensitively.
    const sent = await a.client.post('/api/friends/requests', { nickname: b.me.nickname.toUpperCase() });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'pending', user: { id: b.me.id, nickname: b.me.nickname } });
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).body.error.code).toBe('already_requested');
    expect(ids((await a.client.get('/api/friends')).body.outgoing)).toEqual([b.me.id]);
    expect((await counts(b.client)).friendRequests).toBe(1);
    const bView = (await b.client.get('/api/friends')).body;
    expect(bView.incoming).toHaveLength(1);
    expect(bView.incoming[0]).toMatchObject({ id: a.me.id, nickname: a.me.nickname });
    expect(bView.incoming[0].email).toBeUndefined();

    // The requester cannot accept their own request; the recipient can.
    expect((await a.client.post(`/api/friends/${b.me.id}/accept`)).status).toBe(404);
    expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
    expect((await counts(b.client)).friendRequests).toBe(0);
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const v = (await x.client.get('/api/friends')).body;
      expect(ids(v.friends)).toEqual([y.me.id]);
      expect(v.incoming).toHaveLength(0);
      expect(v.outgoing).toHaveLength(0);
    }
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).body.error.code).toBe('already_friends');

    // Crossing requests: C asks A, then A asks C → accepted at once.
    expect((await c.client.post('/api/friends/requests', { userId: a.me.id })).status).toBe(201);
    const cross = await a.client.post('/api/friends/requests', { userId: c.me.id });
    expect(cross.body.status).toBe('accepted');
    expect(ids((await c.client.get('/api/friends')).body.friends)).toEqual([a.me.id]);

    // Unfriend (either side), then a fresh request can be declined or cancelled.
    expect((await b.client.req('DELETE', `/api/friends/${a.me.id}`)).status).toBe(200);
    expect(ids((await a.client.get('/api/friends')).body.friends)).toEqual([c.me.id]);
    await a.client.post('/api/friends/requests', { userId: b.me.id });
    expect((await b.client.req('DELETE', `/api/friends/${a.me.id}`)).status).toBe(200); // decline
    expect((await a.client.get('/api/friends')).body.outgoing).toHaveLength(0);
    await a.client.post('/api/friends/requests', { userId: b.me.id });
    expect((await a.client.req('DELETE', `/api/friends/${b.me.id}`)).status).toBe(200); // cancel
    expect((await b.client.get('/api/friends')).body.incoming).toHaveLength(0);
    expect((await a.client.req('DELETE', `/api/friends/${b.me.id}`)).status).toBe(404);
  });

  it('deleting an account removes its friendships, pending requests and unread-message badge', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await a.client.post('/api/friends/requests', { userId: b.me.id });
    await b.client.post(`/api/friends/${a.me.id}/accept`);
    await a.client.post('/api/friends/requests', { userId: c.me.id });
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'bye' });
    expect((await counts(b.client)).dmUnread).toBe(1);
    expect((await a.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect((await b.client.get('/api/friends')).body.friends).toHaveLength(0);
    // The conversation is gone with the account, so its unread messages no longer count.
    expect((await b.client.get(`/api/dm/${a.me.id}`)).status).toBe(404);
    expect((await counts(b.client)).dmUnread).toBe(0);
    expect((await counts(c.client)).friendRequests).toBe(0);
    expect((await b.client.post('/api/friends/requests', { userId: a.me.id })).status).toBe(404);
  });
});

describe('1:1 messages', () => {
  it('friends only; unread counts, read receipts, polling with ?after and paging with ?before', async () => {
    const a = await newUser();
    const b = await newUser();
    // Not friends yet: cannot send.
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'hi' })).body.error.code).toBe('not_friends');
    await a.client.post('/api/friends/requests', { userId: b.me.id });
    await b.client.post(`/api/friends/${a.me.id}/accept`);

    const m1 = await a.client.post(`/api/dm/${b.me.id}`, { text: '  hello there  ' });
    expect(m1.status).toBe(201);
    expect(m1.body).toMatchObject({ fromMe: true, body: 'hello there', readAt: null });
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: '' })).status).toBe(400);
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'x'.repeat(501) })).status).toBe(400);
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'second' });

    expect((await counts(b.client)).dmUnread).toBe(2);
    const friendRow = (await b.client.get('/api/friends')).body.friends[0];
    expect(friendRow).toMatchObject({ id: a.me.id, unread: 2, lastMessage: { body: 'second', fromMe: false } });

    const conv = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(conv).toMatchObject({ user: { id: a.me.id }, isFriend: true, hasMore: false });
    expect(conv.messages.map((m: { body: string; fromMe: boolean }) => [m.body, m.fromMe])).toEqual([
      ['hello there', false],
      ['second', false],
    ]);
    expect((await b.client.post(`/api/dm/${a.me.id}/read`)).status).toBe(200);
    expect((await counts(b.client)).dmUnread).toBe(0);
    // The sender sees the read receipt.
    expect((await a.client.get(`/api/dm/${b.me.id}`)).body.messages.every((m: { readAt: number | null }) => m.readAt !== null)).toBe(true);

    // Polling: ?after returns the boundary message and anything newer.
    const last = conv.messages[1].at;
    await b.client.post(`/api/dm/${a.me.id}`, { text: 'reply' });
    const polled = (await a.client.get(`/api/dm/${b.me.id}?after=${last}`)).body.messages.map((m: { body: string }) => m.body);
    expect(polled).toEqual(['second', 'reply']);

    // A third player sees none of this thread.
    const c = await newUser();
    expect((await c.client.get(`/api/dm/${a.me.id}`)).body.messages).toHaveLength(0);

    // Paging back over more than one page.
    // Both sides take turns so neither hits the per-minute send limit.
    for (let i = 0; i < 52; i++) {
      const [from, to] = i % 2 ? [b, a] : [a, b];
      expect((await from.client.post(`/api/dm/${to.me.id}`, { text: `bulk ${i}` })).status).toBe(201);
    }
    const page1 = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(page1.messages).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.at(-1).body).toBe('bulk 51');
    // The cursor is (time, id) of the oldest message held, so messages sharing its millisecond are not skipped.
    const first = page1.messages[0];
    const page2 = (await b.client.get(`/api/dm/${a.me.id}?before=${first.at}&beforeId=${first.id}`)).body;
    expect(page2.hasMore).toBe(false);
    expect(page2.messages.map((m: { body: string }) => m.body)).toEqual(['hello there', 'second', 'reply', 'bulk 0', 'bulk 1']);
    expect(new Set(ids([...page2.messages, ...page1.messages])).size).toBe(55);

    // After unfriending, history stays readable but sending is refused.
    await a.client.req('DELETE', `/api/friends/${b.me.id}`);
    const after = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(after.isFriend).toBe(false);
    expect(after.messages.length).toBeGreaterThan(0);
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: 'still there?' })).body.error.code).toBe('not_friends');
  });
});

describe('reports', () => {
  it('posts and comments: one open report per member, evidence snapshot, admin resolves and hides', async () => {
    const author = await newUser();
    const r1 = await newUser();
    const r2 = await newUser();
    const post = (await author.client.post('/api/board/posts', { title: 'Spammy title', body: 'buy chips here' })).body;
    const cm = (await author.client.post(`/api/board/posts/${post.id}/comments`, { body: 'rude words' })).body;

    expect((await author.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).body.error.code).toBe('report_self');
    expect((await r1.client.post('/api/reports', { targetType: 'post', targetId: 'nope', reason: 'spam' })).status).toBe(404);
    expect((await r1.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'nonsense' })).status).toBe(400);
    expect((await r1.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam', tableId: 'x' })).status).toBe(400);

    const rep = await r1.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam', detail: 'advertising' });
    expect(rep.status).toBe(201);
    expect((await r1.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'abuse' })).body.error.code).toBe('already_reported');
    expect((await r2.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'inappropriate' })).status).toBe(201);
    expect((await r1.client.post('/api/reports', { targetType: 'comment', targetId: cm.id, reason: 'abuse' })).status).toBe(201);

    // Members have no access to the queue.
    expect((await r1.client.get('/api/admin/reports')).status).toBe(403);

    const list = (await admin.get(`/api/admin/reports?userId=${author.me.id}`)).body;
    expect(list.openCount).toBeGreaterThanOrEqual(3);
    expect(list.items).toHaveLength(3);
    const postReport = list.items.find((r: { id: string }) => r.id === rep.body.id);
    expect(postReport).toMatchObject({
      targetType: 'post',
      reason: 'spam',
      detail: 'advertising',
      status: 'open',
      reporter: { id: r1.me.id },
      target: { id: author.me.id, status: 'active' },
      context: { kind: 'post', title: 'Spammy title', body: 'buy chips here' },
      contentStatus: 'visible',
    });

    // Resolving with hideContent hides the post and closes both reports on it.
    const res = await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'resolved', hideContent: true, note: 'ad spam' });
    expect(res.body).toMatchObject({ ok: true, closed: 2 });
    expect((await r1.client.get(`/api/board/posts/${post.id}`)).status).toBe(404);
    expect((await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'dismissed' })).body.error.code).toBe('report_closed');
    const closed = (await admin.get(`/api/admin/reports?status=resolved&userId=${author.me.id}`)).body.items;
    expect(closed).toHaveLength(2);
    expect(closed[0]).toMatchObject({ status: 'resolved', note: 'ad spam', contentStatus: 'hidden', handledBy: { nickname: expect.any(String) } });

    // Dismissing keeps the comment visible; the member can report it again later.
    const cmReport = list.items.find((r: { targetType: string }) => r.targetType === 'comment');
    expect((await admin.post(`/api/admin/reports/${cmReport.id}`, { status: 'dismissed' })).status).toBe(200);
    expect((await r1.client.post('/api/reports', { targetType: 'comment', targetId: cm.id, reason: 'abuse' })).status).toBe(201);

    // Handling is audited.
    const auditLog = (await admin.get('/api/admin/audit?limit=50')).body;
    expect(JSON.stringify(auditLog)).toContain('report.resolved');
  });

  it('players: only someone at the same table; the server attaches their recent table chat', async () => {
    const a = await newUser();
    const b = await newUser();
    const outsider = await newUser();
    const wa = await TableSocket.open(a.client, 'it-report-0');
    const wb = await TableSocket.open(b.client, 'it-report-0');
    wb.send({ t: 'chat', text: 'you are terrible' });
    await wa.wait((m) => m.t === 'chat' && m.message.text === 'you are terrible');

    const body = { targetType: 'player', targetId: b.me.id, tableId: 'it-report-0', reason: 'abuse' };
    expect((await a.client.post('/api/reports', { ...body, tableId: undefined })).status).toBe(400);
    expect((await outsider.client.post('/api/reports', body)).body.error.code).toBe('not_at_table');
    expect((await a.client.post('/api/reports', { ...body, targetId: a.me.id })).body.error.code).toBe('report_self');
    expect((await a.client.post('/api/reports', { ...body, targetId: outsider.me.id })).body.error.code).toBe('not_at_table');
    const rep = await a.client.post('/api/reports', { ...body, detail: 'insults in chat' });
    expect(rep.status).toBe(201);

    const item = (await admin.get(`/api/admin/reports?userId=${b.me.id}`)).body.items[0];
    expect(item).toMatchObject({
      id: rep.body.id,
      targetType: 'player',
      contentStatus: null,
      context: { kind: 'player', tableId: 'it-report-0', chat: [{ text: 'you are terrible' }] },
    });
    // Players cannot be "hidden".
    expect((await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'resolved', hideContent: true })).status).toBe(400);
    expect((await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'resolved' })).status).toBe(200);
    wa.ws.close();
    wb.ws.close();
  });
});
