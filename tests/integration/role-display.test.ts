// Staff marks: the role other players see (seat, chat, hand history, friends, blocks, DM, board, lobby host) comes from
// `users.role` on the server, only for administrators, and a change made in the console reaches the tables where the
// member sits without them reconnecting.
import type { HandDetailDto, ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser, PASSWORD, sharedAdmin } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

/** The bootstrapped super admin. */
const admin = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function setRole(userId: string, role: 'user' | 'admin' | 'super_admin') {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (!until || until - Date.now() < 60_000) expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const r = await admin.post(`/api/admin/users/${userId}/role`, { role, reason: 'staffing change' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.tables as { tables: number; reached: number };
}

async function socket(client: Parameters<typeof TableSocket.open>[0]) {
  const ws = await TableSocket.open(client, 'it-role-0');
  open.push(ws);
  return ws;
}

const lastChat = new WeakMap<TableSocket, number>();
/** Sends a chat line from `from` and resolves with the line as `to` received it. A connection may chat once a second. */
async function chat(from: TableSocket, to: TableSocket, text: string, extra: Record<string, unknown> = {}) {
  const wait = (lastChat.get(from) ?? 0) + 1_100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastChat.set(from, Date.now());
  const got = to.waitNext((m) => m.t === 'chat' && m.message.text === text, 5_000, `chat ${text}`);
  const ack = await from.request({ t: 'chat', text, ...extra });
  expect(ack, JSON.stringify(ack)).toMatchObject({ t: 'ack' });
  return (got as Promise<Extract<ServerMessage, { t: 'chat' }>>).then((m) => m.message);
}

describe('staff marks', () => {
  it('a seated member shows the role the server holds, and a change in the console reaches the table at once', async () => {
    const a = await newUser();
    const b = await newUser();
    const watcher = await newUser();
    // Not seated anywhere yet: nothing to tell.
    expect(await setRole(a.me.id, 'admin')).toEqual({ tables: 0, reached: 0 });

    const [wa, wb, ws] = [await socket(a.client), await socket(b.client), await socket(watcher.client)];
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    const seated = (s: TableView) => s.seats[0]!.state !== 'empty' && s.seats[1]!.state !== 'empty';
    for (const w of [wa, wb, ws]) {
      const v = await w.waitState(seated);
      expect(v.seats[0]!.role).toBe('admin');
      expect('role' in v.seats[1]!).toBe(false);
    }
    expect((await chat(wa, ws, 'from staff')).role).toBe('admin');
    // A member's own claim is not read.
    expect('role' in (await chat(wb, ws, 'from a member', { role: 'super_admin' }))).toBe(false);
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 1000, role: 'super_admin' })).toMatchObject({ t: 'error' });
    expect('role' in wb.state!.seats[1]!).toBe(false);

    // One hand for the history: whoever acts first folds.
    const hand = await wa.waitState((s) => s.hand?.stage === 'preflop' && s.hand.actorSeat !== null, 20_000, 'hand start');
    const handId = hand.hand!.id;
    const actor = isMyTurn(wa.state!) ? wa : wb;
    await actor.waitState((s) => isMyTurn(s) && s.hand?.id === handId);
    await actor.act('fold');
    await wb.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 15_000, 'settled');

    // Promoted while seated: everyone at the table sees the crown without anyone reconnecting.
    const before = ws.state!.version;
    expect(await setRole(a.me.id, 'super_admin')).toEqual({ tables: 1, reached: 1 });
    for (const w of [wa, wb, ws]) expect((await w.waitState((s) => s.seats[0]!.role === 'super_admin', 3_000, 'promoted')).seats[0]!.role).toBe('super_admin');
    expect(ws.state!.version).toBeGreaterThan(before);
    // The open connection carries the new role into the next chat line; lines already sent keep theirs.
    expect((await chat(wa, wb, 'now the boss')).role).toBe('super_admin');
    expect(ws.messages.find((m) => m.t === 'chat' && m.message.text === 'from staff')).toMatchObject({ message: { role: 'admin' } });

    // The history shows the member's role now.
    let detail: HandDetailDto | null = null;
    for (let i = 0; i < 50 && !detail; i++) {
      const r = await b.client.get(`/api/me/hands/${handId}`);
      if (r.status === 200) detail = r.body as HandDetailDto;
      else await new Promise((res) => setTimeout(res, 200));
    }
    expect(detail!.players.find((p) => p.userId === a.me.id)!.role).toBe('super_admin');
    expect('role' in detail!.players.find((p) => p.userId === b.me.id)!).toBe(false);

    // Back to member: the mark goes from the seat and from new lines.
    expect(await setRole(a.me.id, 'user')).toEqual({ tables: 1, reached: 1 });
    const plain = await ws.waitState((s) => !('role' in s.seats[0]!), 3_000, 'demoted');
    expect(plain.seats[0]!.nickname).toBe(a.me.nickname);
    expect('role' in (await chat(wa, wb, 'just me again'))).toBe(false);
    expect('role' in (await b.client.get(`/api/me/hands/${handId}`)).body.players.find((p: { userId: string }) => p.userId === a.me.id)).toBe(false);
  });

  it('friends, requests, blocks, messages, the board and the lobby carry the role for staff only', async () => {
    const staff = await newUser();
    const member = await newUser();
    const other = await newUser();
    await setRole(staff.me.id, 'admin');

    // A request, then a friendship, both ways round.
    expect((await member.client.post('/api/friends/requests', { userId: staff.me.id })).status).toBe(201);
    expect((await member.client.get('/api/friends')).body.outgoing[0]).toMatchObject({ id: staff.me.id, role: 'admin' });
    const incoming = (await staff.client.get('/api/friends')).body.incoming[0];
    expect(incoming.id).toBe(member.me.id);
    expect('role' in incoming).toBe(false);
    expect((await staff.client.post(`/api/friends/${member.me.id}/accept`)).status).toBe(200);
    expect((await member.client.get('/api/friends')).body.friends[0]).toMatchObject({ id: staff.me.id, role: 'admin' });
    expect('role' in (await staff.client.get('/api/friends')).body.friends[0]).toBe(false);

    // The conversation header.
    expect((await member.client.get(`/api/dm/${staff.me.id}`)).body.user).toMatchObject({ id: staff.me.id, role: 'admin' });
    expect('role' in (await staff.client.get(`/api/dm/${member.me.id}`)).body.user).toBe(false);

    // The block list.
    expect((await other.client.req('PUT', `/api/blocks/${staff.me.id}`)).status).toBe(200);
    expect((await other.client.req('PUT', `/api/blocks/${member.me.id}`)).status).toBe(200);
    const blocked = (await other.client.get('/api/blocks')).body as { id: string; role?: string }[];
    expect(blocked.find((u) => u.id === staff.me.id)!.role).toBe('admin');
    expect('role' in blocked.find((u) => u.id === member.me.id)!).toBe(false);

    // The board: posts and comments.
    const post = await staff.client.post('/api/board/posts', { title: '운영 안내', body: '안녕하세요' });
    expect(post.status).toBe(201);
    expect((await member.client.post(`/api/board/posts/${post.body.id}/comments`, { body: '확인했습니다' })).status).toBe(201);
    expect((await staff.client.post(`/api/board/posts/${post.body.id}/comments`, { body: '감사합니다' })).status).toBe(201);
    const listed = (await member.client.get('/api/board/posts')).body.posts.find((p: { id: string }) => p.id === post.body.id);
    expect(listed.author).toMatchObject({ id: staff.me.id, role: 'admin', isAdmin: true });
    const detail = (await member.client.get(`/api/board/posts/${post.body.id}`)).body as { author: { role?: string }; comments: { author: { id: string; role?: string; isAdmin: boolean } }[] };
    expect(detail.author.role).toBe('admin');
    expect(detail.comments.map((c) => [c.author.id, c.author.role ?? null, c.author.isAdmin])).toEqual([
      [member.me.id, null, false],
      [staff.me.id, 'admin', true],
    ]);

    // The lobby's host line.
    const room = await staff.client.post('/api/rooms', { name: '운영자 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 });
    expect(room.status, JSON.stringify(room.body)).toBe(201);
    const lobby = (await member.client.get('/api/tables')).body as { id: string; host: { id: string; role?: string } | null }[];
    expect(lobby.find((t) => t.id === room.body.id)!.host).toMatchObject({ id: staff.me.id, role: 'admin' });
    await setRole(staff.me.id, 'user');
    const after = (await member.client.get('/api/tables')).body as { id: string; host: { id: string; role?: string } | null }[];
    expect('role' in after.find((t) => t.id === room.body.id)!.host!).toBe(false);
    expect((await staff.client.post(`/api/rooms/${room.body.id}/close`)).status).toBe(200);
  });
});
