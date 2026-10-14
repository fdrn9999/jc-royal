import { describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

const room = (over: Record<string, unknown> = {}) => ({ name: '테스트 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(0, 300)}`);
    await sleep(300);
  }
}

const lobbyIds = async (c: Client) => ((await c.get('/api/tables')).body as { id: string }[]).map((t) => t.id);
const balance = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;
const ledgerSum = async (c: Client) => ((await c.get('/api/me/ledger')).body as { amount: number }[]).reduce((s, l) => s + l.amount, 0);

describe('member rooms', () => {
  it('validates the stakes and lets a member keep at most two rooms open', async () => {
    const u = await newUser();
    expect((await new Client().post('/api/rooms', room())).status).toBe(401);
    for (const bad of [{ bigBlind: 30 }, { maxSeats: 10 }, { minBuyIn: 100 }, { maxBuyIn: 5000 }, { minBuyIn: 2000, maxBuyIn: 1000 }, { isPrivate: true }, { name: 'x' }]) {
      expect((await u.client.post('/api/rooms', room(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const a = await u.client.post('/api/rooms', room());
    const b = await u.client.post('/api/rooms', room({ name: '두 번째 방' }));
    expect([a.status, b.status]).toEqual([201, 201]);
    const third = await u.client.post('/api/rooms', room({ name: '세 번째 방' }));
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('room_limit');

    // The lobby shows them after the official tables, marked as members' rooms with their host.
    const lobby = (await u.client.get('/api/tables')).body as { id: string; roomType: string; host: unknown; smallBlind: number; bigBlind: number }[];
    expect(lobby.find((t) => t.id === a.body.id)).toMatchObject({ roomType: 'member', host: { id: u.me.id, nickname: u.me.nickname }, smallBlind: 10, bigBlind: 20 });
    const firstMember = lobby.findIndex((t) => t.roomType === 'member');
    expect(lobby.slice(firstMember).every((t) => t.roomType === 'member')).toBe(true);
    expect(lobby.slice(0, firstMember).every((t) => t.host === null)).toBe(true);

    // Closing one frees a slot.
    expect((await u.client.post(`/api/rooms/${b.body.id}/close`, {})).body).toMatchObject({ ok: true, closed: true });
    expect(await lobbyIds(u.client)).not.toContain(b.body.id);
    expect((await u.client.post('/api/rooms', room({ name: '세 번째 방' }))).status).toBe(201);
  });

  it('only the host changes the room, and only its name, spectating and join code', async () => {
    const host = await newUser();
    const other = await newUser();
    const { id } = (await host.client.post('/api/rooms', room())).body;
    expect((await other.client.patch(`/api/rooms/${id}`, { name: '내 방이다' })).status).toBe(403);
    expect((await other.client.post(`/api/rooms/${id}/close`, {})).status).toBe(403);
    // Official tables are not members' rooms, for anyone.
    expect((await host.client.patch('/api/rooms/it-six-5', { name: '내 방이다' })).status).toBe(404);
    expect((await host.client.post('/api/rooms/it-six-5/close', {})).status).toBe(404);
    expect((await host.client.patch('/api/rooms/nope-nope', { name: '내 방이다' })).status).toBe(404);
    // Private needs a code.
    expect((await host.client.patch(`/api/rooms/${id}`, { isPrivate: true })).status).toBe(400);
    // Stakes are not the host's to change: those fields are ignored.
    expect((await host.client.patch(`/api/rooms/${id}`, { bigBlind: 2, minBuyIn: 1, maxBuyIn: 999_999 })).status).toBe(200);
    const after = (await host.client.get(`/api/tables/${id}`)).body;
    expect(after).toMatchObject({ bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 });

    expect((await host.client.patch(`/api/rooms/${id}`, { name: '비밀 방', isPrivate: true, joinCode: 'open-sesame' })).status).toBe(200);
    expect((await host.client.get(`/api/tables/${id}`)).body).toMatchObject({ name: '비밀 방', isPrivate: true });
    // The room checks the code: a wrong one cannot sit, the right one can.
    const wrong = await TableSocket.open(other.client, id, { code: 'wrong-code' });
    expect(wrong.state!.you.canSit).toBe(false);
    expect(await wrong.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'error', code: 'forbidden' });
    wrong.close();
    const right = await TableSocket.open(other.client, id, { code: 'open-sesame' });
    expect(right.state!.you.canSit).toBe(true);
    expect(right.state!.table).toMatchObject({ roomType: 'member', hostId: host.me.id });
    expect(await right.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(await right.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    right.close();
    expect(await balance(other.client)).toBe(10000);
  });

  it('the host closes the room: the hand in play finishes, then every seated player gets their chips back', async () => {
    const host = await newUser();
    const guest = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ maxSeats: 2, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000 }))).body;
    const wh = await TableSocket.open(host.client, id);
    const wg = await TableSocket.open(guest.client, id);
    expect(await wh.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await wg.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const live = await wh.waitState((s) => !!s.hand && s.hand.stage !== 'settled' && s.hand.actorSeat !== null, 15_000, 'hand dealt');
    // The host sees their own cards and nobody else's.
    expect(live.seats[0]!.holeCards).toHaveLength(2);
    expect(live.seats[1]!.holeCards ?? null).toBeNull();

    const close = await host.client.post(`/api/rooms/${id}/close`, {});
    expect(close.status).toBe(200);
    expect(close.body.closed).toBe(false);
    // No new players while it closes.
    const late = await newUser();
    const wl = await TableSocket.open(late.client, id);
    expect(await wl.request({ t: 'sit', seatIndex: 1, buyIn: 100 })).toMatchObject({ t: 'error' });
    wl.close();

    // Finish the hand.
    await wg.waitState((s) => s.hand?.id === live.hand!.id);
    const actor = isMyTurn(wh.state!) ? wh : wg;
    await actor.act('fold');
    await until(() => lobbyIds(host.client), (ids) => !ids.includes(id), 'room closed');
    const [hb, gb] = await until(() => Promise.all([balance(host.client), balance(guest.client)]), ([h, g]) => h !== 9500 && g !== 9700, 'cash-out');
    // Chips are conserved between the two, and each wallet still matches its ledger.
    expect(hb + gb).toBe(20000);
    expect(await ledgerSum(host.client)).toBe(hb);
    expect(await ledgerSum(guest.client)).toBe(gb);
    const outs = ((await guest.client.get('/api/me/ledger')).body as { type: string; tableId: string }[]).filter((l) => l.type === 'cash_out' && l.tableId === id);
    expect(outs).toHaveLength(1);
    // A closed room cannot be changed or reopened.
    expect((await host.client.patch(`/api/rooms/${id}`, { name: '다시 열기' })).status).toBe(404);
    expect((await host.client.post(`/api/rooms/${id}/close`, {})).status).toBe(404);
    wh.close();
    wg.close();
  });

  it('a room nobody sits in closes by itself; a room with someone seated stays open', async () => {
    // The integration worker runs with MEMBER_IDLE_CLOSE_MS=8000 (10 minutes in production).
    const host = await newUser();
    const idle = (await host.client.post('/api/rooms', room({ name: '빈 방' }))).body.id as string;
    const busy = (await host.client.post('/api/rooms', room({ name: '앉은 방' }))).body.id as string;
    const ws = await TableSocket.open(host.client, busy);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(await lobbyIds(host.client)).toEqual(expect.arrayContaining([idle, busy]));
    await until(() => lobbyIds(host.client), (ids) => !ids.includes(idle), 'empty room closed itself');
    expect(await lobbyIds(host.client)).toContain(busy);
    // The closed room no longer counts toward the limit.
    expect((await host.client.post('/api/rooms', room({ name: '새 방' }))).status).toBe(201);
    // Once its last player leaves, the other room closes itself too, after cashing them out.
    expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(await balance(host.client)).toBe(10000);
    await until(() => lobbyIds(host.client), (ids) => !ids.includes(busy), 'room closed after it emptied');
    ws.close();
  });

  it('suspended members cannot open rooms', async () => {
    const admin = sharedAdmin();
    const u = await newUser();
    const reauthUntil = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
    if (!reauthUntil || reauthUntil - Date.now() < 60_000) expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${u.me.id}/suspend`, { reason: 'room abuse' })).status).toBe(200);
    expect((await u.client.post('/api/rooms', room())).status).toBe(401);
  });
});
