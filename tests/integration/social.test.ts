import { beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

/** Blocking entry is an emergency control: the password is confirmed first (re-confirmation is rate limited per account). */
async function reauth() {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
}

const counts = async (c: Client) => (await c.get('/api/messages/unread-count')).body as { unread: number; dmUnread: number; friendRequests: number };
const ids = (list: { id: string }[]) => list.map((x) => x.id);
type User = Awaited<ReturnType<typeof newUser>>;
async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}
const relation = async (x: User, y: User) => (await x.client.get(`/api/friends/${y.me.id}/relation`)).body.relation as string;

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

describe('1:1 message sync by seq', () => {
  type Msg = { id: string; seq: number; body: string; at: number; fromMe: boolean; readAt: number | null };
  type Conv = { messages: Msg[]; hasMore: boolean; peerRead: { seq: number; at: number } | null };
  const conv = async (x: User, y: User, q = '') => (await x.client.get(`/api/dm/${y.me.id}${q}`)).body as Conv;
  const seqs = (r: Conv) => r.messages.map((m) => m.seq);
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('a burst from both sides while one of them polls: every message once, in seq order, nothing missed', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    // B polls from the last seq it received, as the page does, the whole time both are sending.
    const seen: Msg[] = [];
    let cursor = 0;
    const drain = async () => {
      for (;;) {
        const r = await conv(b, a, `?afterSeq=${cursor}`);
        seen.push(...r.messages);
        if (r.messages.length) cursor = r.messages.at(-1)!.seq;
        if (!r.hasMore) return;
      }
    };
    let sending = true;
    const poller = (async () => {
      while (sending) await drain();
    })();
    const sent = await Promise.all(
      range(0, 23).map((i) => {
        const [from, to] = i % 2 ? [b, a] : [a, b];
        return from.client.post(`/api/dm/${to.me.id}`, { text: `burst ${i}` });
      }),
    );
    sending = false;
    await poller;
    await drain();
    expect(sent.map((r) => r.status)).toEqual(Array(24).fill(201));
    // Each message got its own seq, 1–24 without gaps, and the poller saw each one exactly once, in order.
    expect(sent.map((r) => r.body.seq as number).sort((x, y) => x - y)).toEqual(range(1, 24));
    expect(seen.map((m) => m.seq)).toEqual(range(1, 24));
    expect(new Set(ids(seen)).size).toBe(24);
    // Both sides' full conversation matches what was polled.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const)
      expect(ids((await conv(x, y)).messages)).toEqual(ids(seen));
    // Clock times inside a burst can tie or run backwards; the order above holds either way.
    const prev = (i: number) => seen[i - 1]!.at;
    const ties = seen.filter((m, i) => i > 0 && m.at === prev(i)).length;
    const backwards = seen.filter((m, i) => i > 0 && m.at < prev(i)).length;
    console.info(`dm burst: of 23 neighbouring pairs, ${ties} share a millisecond and ${backwards} run backwards in clock time`);
  });

  it('afterSeq and beforeSeq page across the 50-message boundary with no gap or repeat', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    // Both take turns so neither hits the per-minute send limit.
    for (let i = 0; i < 55; i++) {
      const [from, to] = i % 2 ? [b, a] : [a, b];
      expect((await from.client.post(`/api/dm/${to.me.id}`, { text: `m${i}` })).body.seq).toBe(i + 1);
    }
    // Forward from the start, as a page that was offline catches up.
    const up1 = await conv(b, a, '?afterSeq=0');
    expect([seqs(up1), up1.hasMore]).toEqual([range(1, 50), true]);
    const up2 = await conv(b, a, '?afterSeq=50');
    expect([seqs(up2), up2.hasMore]).toEqual([range(51, 55), false]);
    expect(await conv(b, a, '?afterSeq=55')).toMatchObject({ messages: [], hasMore: false });
    // Back from the latest page.
    const down1 = await conv(b, a);
    expect([seqs(down1), down1.hasMore]).toEqual([range(6, 55), true]);
    const down2 = await conv(b, a, `?beforeSeq=${down1.messages[0]!.seq}`);
    expect([seqs(down2), down2.hasMore]).toEqual([range(1, 5), false]);
    expect(down2.messages.map((m) => m.body)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    // A cursor that is not a number counts as 0.
    expect(seqs(await conv(b, a, '?afterSeq=abc'))[0]).toBe(1);
  });

  it('reading up to a seq leaves a later message unread; the sender sees how far, even in a poll with nothing new', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'one' });
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'two' });
    const shown = (await conv(b, a)).messages;
    // This one lands after B's page fetched, so B's page marks only what it showed.
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'three' });
    expect((await conv(a, b)).peerRead).toBeNull();
    expect((await b.client.post(`/api/dm/${a.me.id}/read`, { upToSeq: shown.at(-1)!.seq })).status).toBe(200);
    expect((await counts(b.client)).dmUnread).toBe(1);
    const mine = await conv(a, b);
    expect(mine.peerRead).toMatchObject({ seq: 2 });
    expect(mine.messages.map((m) => m.readAt !== null)).toEqual([true, true, false]);
    expect(await conv(a, b, '?afterSeq=3')).toMatchObject({ messages: [], peerRead: { seq: 2 } });
    // A lower mark changes nothing, a bad one is refused, and an empty body (pages from before seq) marks everything.
    await b.client.post(`/api/dm/${a.me.id}/read`, { upToSeq: 1 });
    expect((await counts(b.client)).dmUnread).toBe(1);
    expect((await b.client.post(`/api/dm/${a.me.id}/read`, { upToSeq: -1 })).status).toBe(400);
    expect((await b.client.req('POST', `/api/dm/${a.me.id}/read`)).status).toBe(200);
    expect((await counts(b.client)).dmUnread).toBe(0);
    expect((await conv(a, b)).peerRead).toMatchObject({ seq: 3 });
    // B has sent nothing, so nothing of B's has been read.
    expect((await conv(b, a)).peerRead).toBeNull();
  });
});

describe('blocking and receive settings', () => {
  it('a block ends the friendship, stops requests and messages both ways, and unblocking restores nothing', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'hi' })).status).toBe(201);

    expect((await a.client.req('PUT', `/api/blocks/${a.me.id}`)).body.error.code).toBe('block_self');
    expect((await a.client.req('PUT', '/api/blocks/no-such-user')).status).toBe(404);
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200); // idempotent

    // The friendship is gone on both sides.
    expect((await a.client.get('/api/friends')).body.friends).toHaveLength(0);
    expect((await b.client.get('/api/friends')).body.friends).toHaveLength(0);
    // No new messages either way; the history stays readable.
    expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'x' })).body.error.code).toBe('not_friends');
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: 'x' })).body.error.code).toBe('not_friends');
    expect((await b.client.get(`/api/dm/${a.me.id}`)).body.messages).toHaveLength(1);
    // No new friend requests either way. The blocked side is told only that the request is not possible, the same
    // answer a member who accepts no requests gives, and sees no trace of the block.
    const theirs = await b.client.post('/api/friends/requests', { userId: a.me.id });
    expect(theirs.status).toBe(403);
    expect(theirs.body.error.code).toBe('request_unavailable');
    expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).body.error.code).toBe('blocked_user');
    expect(await relation(a, b)).toBe('blocked');
    expect(await relation(b, a)).toBe('none');
    const bConv = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(bConv.blocked).toBe(false);
    expect((await a.client.get(`/api/dm/${b.me.id}`)).body.blocked).toBe(true);

    // Each member sees only their own block list.
    const list = (await a.client.get('/api/blocks')).body;
    expect(list).toEqual([expect.objectContaining({ id: b.me.id, nickname: b.me.nickname, at: expect.any(Number) })]);
    expect(JSON.stringify(list)).not.toContain('@');
    expect((await b.client.get('/api/blocks')).body).toEqual([]);

    // Unblocking does not bring the friendship back, but requests work again.
    expect((await a.client.req('DELETE', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect((await a.client.req('DELETE', `/api/blocks/${b.me.id}`)).status).toBe(404);
    expect(await relation(a, b)).toBe('none');
    expect((await a.client.get('/api/friends')).body.friends).toHaveLength(0);
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: 'x' })).body.error.code).toBe('not_friends');
    await befriend(b, a);
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: 'friends again' })).status).toBe(201);
  });

  it('a block drops pending requests, and a request racing a block never gets through', async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await b.client.post('/api/friends/requests', { userId: a.me.id })).status).toBe(201);
    expect((await counts(a.client)).friendRequests).toBe(1);
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect((await a.client.get('/api/friends')).body.incoming).toHaveLength(0);
    expect((await b.client.get('/api/friends')).body.outgoing).toHaveLength(0);
    expect((await counts(a.client)).friendRequests).toBe(0);
    // Accepting the dropped request is not possible either.
    expect((await a.client.post(`/api/friends/${b.me.id}/accept`)).status).toBe(404);

    for (let i = 0; i < 4; i++) {
      const x = await newUser();
      const y = await newUser();
      const [req, block] = await Promise.all([y.client.post('/api/friends/requests', { userId: x.me.id }), x.client.req('PUT', `/api/blocks/${y.me.id}`)]);
      expect([201, 403]).toContain(req.status);
      // (Checked too, so a failed block is told apart from a request that got past one.)
      expect(block.status, JSON.stringify(block.body)).toBe(200);
      // Whichever landed first, nothing is left between them except the block.
      expect((await x.client.get('/api/friends')).body).toMatchObject({ friends: [], incoming: [], outgoing: [] });
      expect((await y.client.get('/api/friends')).body).toMatchObject({ friends: [], incoming: [], outgoing: [] });
      expect(await relation(x, y)).toBe('blocked');
    }
  });

  it('receive settings: nobody can send requests; message notifications can be turned off; blocked senders never count', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    expect((await a.client.get('/api/friends/settings')).body).toEqual({ friendRequests: 'everyone', dmNotifications: true });
    expect((await a.client.patch('/api/friends/settings', {})).status).toBe(400);
    expect((await a.client.patch('/api/friends/settings', { friendRequests: 'friends' })).status).toBe(400);
    expect((await a.client.patch('/api/friends/settings', { friendRequests: 'nobody' })).body).toEqual({ friendRequests: 'nobody', dmNotifications: true });
    expect((await b.client.post('/api/friends/requests', { userId: a.me.id })).body.error.code).toBe('request_unavailable');
    // The member can still send requests themselves.
    await befriend(a, b);
    await befriend(a, c);
    expect((await a.client.patch('/api/friends/settings', { friendRequests: 'everyone' })).status).toBe(200);

    await b.client.post(`/api/dm/${a.me.id}`, { text: 'one' });
    await c.client.post(`/api/dm/${a.me.id}`, { text: 'two' });
    expect((await counts(a.client)).dmUnread).toBe(2);
    expect((await a.client.patch('/api/friends/settings', { dmNotifications: false })).status).toBe(200);
    expect((await counts(a.client)).dmUnread).toBe(0);
    // The messages themselves are still delivered and listed as unread in the conversation list.
    expect((await a.client.get('/api/friends')).body.friends.map((f: { unread: number }) => f.unread)).toEqual([1, 1]);
    expect((await a.client.patch('/api/friends/settings', { dmNotifications: true })).status).toBe(200);
    expect((await counts(a.client)).dmUnread).toBe(2);
    // Unread messages from someone I block stop counting.
    await a.client.req('PUT', `/api/blocks/${b.me.id}`);
    expect((await counts(a.client)).dmUnread).toBe(1);
  });
});

describe('table invites', () => {
  it('friends only, open tables only; the card carries no join code, and the table still checks seats and codes', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await befriend(a, b);
    const invite = (from: User, to: User, tableId: string) => from.client.post(`/api/friends/${to.me.id}/invite`, { tableId });

    // Not a friend; no such table; a table that is not taking players.
    expect((await invite(a, c, 'it-invite-0')).body.error.code).toBe('not_friends');
    expect((await invite(a, b, 'no-such-table')).body.error.code).toBe('table_unavailable');
    expect((await a.client.post(`/api/friends/${b.me.id}/invite`, {})).status).toBe(400);
    await reauth();
    expect((await admin.patch('/api/admin/tables/it-invite-1', { entryBlocked: true })).status).toBe(200);
    expect((await invite(a, b, 'it-invite-1')).body.error.code).toBe('table_unavailable');

    // A friend gets a 1:1 invite card for an open table.
    const sent = await invite(a, b, 'it-invite-0');
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ kind: 'invite', tableId: 'it-invite-0', body: 'it-invite-0', fromMe: true, readAt: null });
    const conv = (await b.client.get(`/api/dm/${a.me.id}`)).body;
    expect(conv.messages.at(-1)).toMatchObject({ id: sent.body.id, kind: 'invite', tableId: 'it-invite-0', fromMe: false });
    expect((await counts(b.client)).dmUnread).toBe(1);
    const last = (await b.client.get('/api/friends')).body.friends.find((f: { id: string }) => f.id === a.me.id).lastMessage;
    expect(last).toMatchObject({ kind: 'invite', body: 'it-invite-0', fromMe: false });
    // Plain messages say they are text.
    expect((await b.client.post(`/api/dm/${a.me.id}`, { text: '좋아요' })).body).toMatchObject({ kind: 'text', tableId: null });

    // A private table: the invite works, but sitting still needs the code.
    const priv = await invite(a, b, 'it-invite-priv');
    expect(priv.status).toBe(201);
    expect(JSON.stringify(priv.body)).not.toMatch(/invite-42|joinCode|code/i);
    const noCode = await TableSocket.open(b.client, 'it-invite-priv');
    expect(noCode.state!.you).toMatchObject({ canSit: false, needsCode: true });
    expect(await noCode.request({ t: 'sit', seatIndex: 0, buyIn: 200 })).toMatchObject({ t: 'error', code: 'join_code_required' });
    noCode.close();
    const withCode = await TableSocket.open(b.client, 'it-invite-priv', { code: 'invite-42' });
    expect(withCode.state!.you.canSit).toBe(true);
    withCode.close();

    // The table fills up after the invite: the invited friend can watch but not sit.
    const x = await newUser();
    const y = await newUser();
    const wx = await TableSocket.open(x.client, 'it-invite-0');
    const wy = await TableSocket.open(y.client, 'it-invite-0');
    expect(await wx.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wy.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const wb = await TableSocket.open(b.client, 'it-invite-0');
    expect(wb.state!.you.canSit).toBe(false);
    expect(await wb.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'error', code: 'seat_taken' });
    let lobby = (await b.client.get('/api/tables/it-invite-0')).body;
    for (let i = 0; i < 20 && lobby.seated < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
      lobby = (await b.client.get('/api/tables/it-invite-0')).body;
    }
    expect(lobby).toMatchObject({ seated: 2, maxSeats: 2, roomType: 'official', host: null });
    wb.close();
    for (const w of [wx, wy]) expect((await w.request({ t: 'leave' })).t).toBe('ack');
    for (const w of [wx, wy]) {
      await w.waitState((s) => s.you.seatIndex === null, 30_000);
      w.close();
    }

    // After a block there are no more invites either way.
    expect((await b.client.req('PUT', `/api/blocks/${a.me.id}`)).status).toBe(200);
    expect((await invite(a, b, 'it-invite-0')).body.error.code).toBe('not_friends');
    expect((await invite(b, a, 'it-invite-0')).body.error.code).toBe('not_friends');
    await reauth();
    expect((await admin.patch('/api/admin/tables/it-invite-1', { entryBlocked: false })).status).toBe(200);
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
      target: { id: author.me.id, status: 'active', locale: 'ko' },
      context: { kind: 'post', title: 'Spammy title', body: 'buy chips here' },
      contentStatus: 'visible',
    });
    // The member's language comes with it, as it is now: a suspension given from the report is written in it.
    expect((await author.client.patch('/api/auth/me', { locale: 'en' })).status).toBe(200);
    const again = (await admin.get(`/api/admin/reports?userId=${author.me.id}`)).body.items.find((r: { id: string }) => r.id === rep.body.id);
    expect(again.target).toMatchObject({ id: author.me.id, locale: 'en' });

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

    // Deleted by its author: the open report keeps its snapshot, and nobody can file a new one.
    expect((await author.client.req('DELETE', `/api/board/comments/${cm.id}`)).status).toBe(200);
    expect((await r2.client.post('/api/reports', { targetType: 'comment', targetId: cm.id, reason: 'abuse' })).status).toBe(404);
    const pending = (await admin.get(`/api/admin/reports?userId=${author.me.id}`)).body.items.find((r: { targetType: string }) => r.targetType === 'comment');
    expect(pending).toMatchObject({ status: 'open', context: { kind: 'comment', body: 'rude words' }, contentStatus: 'deleted' });

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

  it('1:1 messages: only someone in the conversation can report one, and the text is the server copy', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await befriend(a, b);
    await b.client.post(`/api/dm/${a.me.id}`, { text: 'hello' });
    await b.client.post(`/api/dm/${a.me.id}`, { text: 'you are awful' });
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'stop it' });
    const msgs = (await a.client.get(`/api/dm/${b.me.id}`)).body.messages as { id: string; body: string; fromMe: boolean }[];
    const awful = msgs.find((m) => m.body === 'you are awful')!;
    const mine = msgs.find((m) => m.fromMe)!;
    const dm = (id: string, extra: Record<string, unknown> = {}) => ({ targetType: 'dm', targetId: id, reason: 'abuse', ...extra });

    // Outsiders cannot tell the message exists; nobody reports their own message.
    expect((await c.client.post('/api/reports', dm(awful.id))).body.error.code).toBe('not_found');
    expect((await b.client.post('/api/reports', dm(awful.id))).body.error.code).toBe('report_self');
    expect((await a.client.post('/api/reports', dm(mine.id))).body.error.code).toBe('report_self');
    expect((await a.client.post('/api/reports', dm('no-such-message'))).status).toBe(404);
    expect((await a.client.post('/api/reports', dm(awful.id, { tableId: 'it-report-0' }))).status).toBe(400);
    // A body sent by the client is ignored.
    const rep = await a.client.post('/api/reports', dm(awful.id, { detail: 'keeps insulting me', body: 'forged text' }));
    expect(rep.status).toBe(201);
    expect((await a.client.post('/api/reports', dm(awful.id))).body.error.code).toBe('already_reported');

    const item = (await admin.get(`/api/admin/reports?userId=${b.me.id}`)).body.items[0];
    expect(item).toMatchObject({
      id: rep.body.id,
      targetType: 'dm',
      targetId: awful.id,
      reporter: { id: a.me.id },
      target: { id: b.me.id },
      contentStatus: null,
      context: { kind: 'dm', messageId: awful.id, senderId: b.me.id, recipientId: a.me.id, body: 'you are awful', at: expect.any(Number), earlier: [{ body: 'hello' }] },
      priorReports: { total: 0, resolved: 0 },
    });
    expect(JSON.stringify(item)).not.toContain('forged text');
    // A message cannot be "hidden".
    expect((await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'resolved', hideContent: true })).status).toBe(400);

    // Blocking the sender does not stop the report of another message.
    await a.client.req('PUT', `/api/blocks/${b.me.id}`);
    const hello = msgs.find((m) => m.body === 'hello')!;
    expect((await a.client.post('/api/reports', dm(hello.id))).status).toBe(201);
    // Earlier reports on the same member show up as history.
    const second = (await admin.get(`/api/admin/reports?userId=${b.me.id}`)).body.items.find((r: { targetId: string }) => r.targetId === hello.id);
    expect(second.priorReports).toEqual({ total: 1, resolved: 0, reporters: 1 });
    expect(second.context.earlier).toEqual([]);

    // Messages leave with a deleted account, and can no longer be reported.
    const d = await newUser();
    await befriend(a, d);
    await d.client.post(`/api/dm/${a.me.id}`, { text: 'bye forever' });
    const gone = (await a.client.get(`/api/dm/${d.me.id}`)).body.messages[0].id;
    expect((await d.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect((await a.client.post('/api/reports', dm(gone))).status).toBe(404);
  });

  it('players: after leaving, a report is checked against seat history and carries no hidden cards', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const wa = await TableSocket.open(a.client, 'it-report-1');
    const wb = await TableSocket.open(b.client, 'it-report-1');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.status === 'playing', 15_000);
    await wb.waitState((s) => s.status === 'playing');
    wb.send({ t: 'chat', text: 'gg noob' });
    await wa.wait((m) => m.t === 'chat' && m.message.text === 'gg noob');
    await (isMyTurn(wa.state!) ? wa : wb).act('fold');
    await wa.waitState((s) => s.hand?.stage === 'settled' || (s.hand?.number ?? 0) > 1, 15_000);
    for (const w of [wa, wb]) {
      expect((await w.request({ t: 'leave' })).t).toBe('ack');
      await w.waitState((s) => s.you.seatIndex === null, 20_000);
      w.close();
    }
    // The first hand (oldest in the newest-first list) ended while both were seated.
    let hands: { id: string }[] = [];
    for (let i = 0; i < 20 && !hands.length; i++) {
      hands = (await a.client.get('/api/me/hands')).body;
      if (!hands.length) await new Promise((r) => setTimeout(r, 250));
    }
    const hand = hands.at(-1)!;
    const detail = (await a.client.get(`/api/me/hands/${hand.id}`)).body;
    expect(detail.tableId).toBe('it-report-1');
    expect(detail.players.map((p: { userId: string }) => p.userId).sort()).toEqual([a.me.id, b.me.id].sort());

    // Both left the table; the reporter is no longer there.
    const body = (targetId: string) => ({ targetType: 'player', targetId, tableId: 'it-report-1', reason: 'abuse' });
    const rep = await a.client.post('/api/reports', body(b.me.id));
    expect(rep.status).toBe(201);
    expect((await b.client.post('/api/reports', body(a.me.id))).status).toBe(201);
    const item = (await admin.get(`/api/admin/reports?userId=${b.me.id}`)).body.items.find((r: { id: string }) => r.id === rep.body.id);
    expect(item.context).toMatchObject({
      kind: 'player',
      tableId: 'it-report-1',
      tableName: 'it-report-1',
      basis: 'history',
      handId: expect.any(String),
      chat: [{ text: 'gg noob' }],
    });
    expect(item.context.overlap.from).toBeLessThan(item.context.overlap.to);
    expect(item.context.sharedHands.map((h: { id: string }) => h.id)).toContain(hand.id);
    expect(JSON.stringify(item)).not.toMatch(/holeCards|hole_cards|remainingDeck|deck/i);

    // Someone who only watched, or sat down after they left, cannot report them.
    const wc = await TableSocket.open(c.client, 'it-report-1');
    expect((await c.client.post('/api/reports', body(a.me.id))).body.error.code).toBe('not_at_table');
    expect(await wc.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect((await c.client.post('/api/reports', body(a.me.id))).body.error.code).toBe('not_at_table');
    expect((await wc.request({ t: 'leave' })).t).toBe('ack');
    await wc.waitState((s) => s.you.seatIndex === null);
    wc.close();
  });

  it('admins handling the same report at once: exactly one decision, one decision row, the others audited as refused', async () => {
    const author = await newUser();
    const r1 = await newUser();
    const r2 = await newUser();
    const post = (await author.client.post('/api/board/posts', { title: 'Race me', body: 'spam spam' })).body;
    const rep = (await r1.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).body;
    await r2.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' });
    const admins = [sharedAdmin(), sharedAdmin(), sharedAdmin()];
    const results = await Promise.all(admins.map((x, i) => x.post(`/api/admin/reports/${rep.id}`, { status: i ? 'dismissed' : 'resolved', hideContent: i ? undefined : true, note: `try ${i}` })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'report_closed')).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(ok[0]!.body.closed).toBe(2);

    const closed = (await admin.get(`/api/admin/reports?status=all&userId=${author.me.id}`)).body.items as { status: string; note: string; contentStatus: string }[];
    expect(closed).toHaveLength(2);
    // Both reports carry the single winning decision.
    expect(new Set(closed.map((r) => `${r.status}|${r.note}`)).size).toBe(1);
    const won = closed[0]!;
    expect(won.contentStatus).toBe(won.status === 'resolved' ? 'hidden' : 'visible');
    const audits = ((await admin.get('/api/admin/audit?limit=50')).body as { action: string; outcome: string; targetId: string; detail: unknown }[]).filter((x) => x.targetId === rep.id);
    const decided = audits.filter((x) => x.outcome === 'ok');
    expect(decided).toHaveLength(1);
    expect(JSON.stringify(decided[0]!.detail)).toContain('"closed":2');
    // The two losers are kept as refused attempts (409), not as decisions.
    const refused = audits.filter((x) => x.outcome === 'failed');
    expect(refused.map((x) => x.action)).toEqual(['report.resolve.failed', 'report.resolve.failed']);
    expect(refused.every((x) => JSON.stringify(x.detail).includes('"code":"report_closed"'))).toBe(true);
    expect(audits).toHaveLength(3);
  });
});
