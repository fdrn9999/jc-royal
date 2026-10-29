// The control center's reads (routes/admin-monitor.ts): the grid from D1 and a few rooms' live summaries. Only an
// administrator with table duty reads them, from the console's origin; nothing a player holds, no join code (or its
// hash) and no waiting member leaves; and watching a room is not spectating it.
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorRoom, MonitorRoomsResponse, MonitorTablesResponse } from '@jc/types';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { ALL_GRANTS, promoteSql } from '../support/grants';
import { TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function sock(c: Client, tableId: string) {
  const s = await TableSocket.open(c, tableId);
  open.push(s);
  return s;
}

/** A new member made a plain administrator with `grants`, signed in to the console. */
async function staffWith(grants: readonly string[]) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  return c;
}

/** The same cookies sent from another origin. */
function from(origin: string, c: Client) {
  const other = new Client(origin);
  other.cookies = new Map(c.cookies);
  return other;
}

const tables = async (c: Client = admin, query = '') => {
  const r = await c.get(`/api/admin/monitor/tables${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { body: r.body as MonitorTablesResponse, raw: JSON.stringify(r.body) };
};
const rooms = async (ids: string[], c: Client = admin) => {
  const r = await c.post('/api/admin/monitor/rooms', { ids });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { body: r.body as MonitorRoomsResponse, raw: JSON.stringify(r.body) };
};
const live = async (id: string) =>
  (await d1<{ spectators: number; waitlist: number; users: string | null }>(`SELECT live_spectators AS spectators, live_waitlist AS waitlist, live_waitlist_users AS users FROM tables WHERE id = '${id}'`))[0]!;

/** Field names that would carry a held card, a shown card, a hand's result, a join code or who is waiting. */
const PRIVATE_KEYS = ['holeCards', 'shown', 'showdown', 'result', 'joinCode', 'joinCodeHash', 'join_code_hash', 'liveWaitlistUsers', 'live_waitlist_users'];

describe('who may read the control center', () => {
  it('needs table duty, an administrator session and the console origin', async () => {
    // Every feature but table duty: refused at both routes, whatever else the account may do.
    const noTables = await staffWith(ALL_GRANTS.filter((g) => g !== 'tables'));
    for (const r of [await noTables.get('/api/admin/monitor/tables'), await noTables.post('/api/admin/monitor/rooms', { ids: ['it-mon-0'] })]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('permission_off');
    }
    // Table duty alone is enough to read (the buttons are tableControl's, on the existing routes).
    const reader = await staffWith(['tables']);
    expect((await reader.get('/api/admin/monitor/tables')).status).toBe(200);
    expect((await reader.post('/api/admin/monitor/rooms', { ids: ['it-mon-priv'] })).status).toBe(200);

    // A member's own session is no console session, from either origin.
    const member = await newUser();
    expect((await member.client.get('/api/admin/monitor/tables')).status).toBe(403);
    const asConsole = from(ADMIN_ORIGIN, member.client);
    const signedIn = await asConsole.get('/api/admin/monitor/tables');
    expect(signedIn.status).toBe(401);
    expect((await asConsole.post('/api/admin/monitor/rooms', { ids: ['it-mon-0'] })).status).toBe(401);
    // An administrator's cookies sent from another site are refused.
    const elsewhere = from('https://evil.example', admin);
    expect((await elsewhere.get('/api/admin/monitor/tables')).status).toBe(403);
    expect((await elsewhere.post('/api/admin/monitor/rooms', { ids: ['it-mon-0'] })).status).toBe(403);
  });

  it('asks at most MONITOR_ROOMS_MAX rooms at once and checks the ids', async () => {
    const tooMany = await admin.post('/api/admin/monitor/rooms', { ids: Array.from({ length: 25 }, (_, i) => `it-hu-${i}`) });
    expect(tooMany.status).toBe(400);
    expect((await admin.post('/api/admin/monitor/rooms', { ids: [] })).status).toBe(400);
    expect((await admin.post('/api/admin/monitor/rooms', { ids: ['x'.repeat(65)] })).status).toBe(400);
  });
});

describe('the grid and the rooms', () => {
  it('lists open tables from D1 with no join code, and narrows by name, id or a seated member', async () => {
    const { body, raw } = await tables();
    const priv = body.items.find((t) => t.id === 'it-mon-priv')!;
    expect(priv).toMatchObject({ isPrivate: true, status: 'open', roomType: 'official', maxSeats: 6, hostNickname: null, flags: [] });
    for (const k of PRIVATE_KEYS) expect(raw).not.toContain(`"${k}"`);
    expect(body.items.every((t) => t.status !== 'closed')).toBe(true);
    expect(body.totals.tables).toBe(body.items.length);
    expect(body.d1Ms).toBeGreaterThanOrEqual(0);

    // By name (a LIKE pattern's wildcards are matched as written) and by exact id.
    expect((await tables(admin, '?q=it-mon-pr')).body.items.map((t) => t.id)).toEqual(['it-mon-priv']);
    expect((await tables(admin, '?q=it-mon%25priv')).body.items).toEqual([]);
    expect((await tables(admin, '?q=it_mon')).body.items).toEqual([]);
    expect((await tables(admin, '?q=it-mon-0')).body.items.map((t) => t.id)).toEqual(['it-mon-0']);

    // Closed tables only when asked for; a table closed before its room ever woke stays asleep (below).
    await d1(`UPDATE tables SET status = 'closed' WHERE id = 'it-mon-closed'`);
    expect((await tables()).body.items.some((t) => t.id === 'it-mon-closed')).toBe(false);
    expect((await tables(admin, '?scope=closed')).body.items.some((t) => t.id === 'it-mon-closed')).toBe(true);
  });

  it('a room in a hand: its board, pot and turn with nobody’s cards, no waiting member, and no spectator added', async () => {
    const a = await newUser();
    const b = await newUser();
    const w = await newUser();
    const v = await newUser();
    const wa = await sock(a.client, 'it-mon-0');
    const wb = await sock(b.client, 'it-mon-0');
    const ww = await sock(w.client, 'it-mon-0');
    await sock(v.client, 'it-mon-0');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await ww.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'ack' });
    const dealt = await wa.waitState((s) => s.hand?.stage === 'preflop' && s.waitlist.length === 1, 20_000, 'a hand and a waitlist');
    const held = [...(dealt.seats[0]!.holeCards ?? []), ...((await wb.waitState((s) => !!s.seats[1]?.holeCards?.length)).seats[1]!.holeCards ?? [])];
    expect(held).toHaveLength(4);
    // The room has written its counts: one waiting member, recorded by id (never sent below), and one spectator (v; a
    // member on the waitlist is not one).
    await expect.poll(async () => (await live('it-mon-0')).waitlist, { timeout: 15_000 }).toBe(1);
    const before = await live('it-mon-0');
    expect(before.users).toContain(w.me.id);
    expect(before.spectators).toBe(1);
    const view = wa.state!;

    const { body, raw } = await rooms(['it-mon-0', 'it-mon-closed', 'it-no-such-table', 'it-mon-0']);
    expect(Object.keys(body.rooms).sort()).toEqual(['it-mon-0', 'it-mon-closed', 'it-no-such-table']);
    expect(body.rooms['it-mon-closed']).toEqual({ error: 'closed' });
    expect(body.rooms['it-no-such-table']).toEqual({ error: 'not_found' });
    const entry = body.rooms['it-mon-0']!;
    expect('room' in entry).toBe(true);
    const room = (entry as { room: MonitorRoom; ms: number }).room;
    expect(room).toMatchObject({ tableId: 'it-mon-0', status: 'playing', waitlist: 1, spectators: 1, connections: 4, paused: false, entryBlocked: false, tournament: null });
    // What everyone at the table sees: the same pot, actor and bets as a player's own view.
    expect(room.hand).toMatchObject({ stage: 'preflop', board: [], potTotal: view.hand!.potTotal, actorSeat: view.hand!.actorSeat, buttonSeat: view.hand!.buttonSeat });
    expect(room.hand!.turn).toMatchObject({ baseMs: 60_000, deadline: view.hand!.deadline });
    expect(room.hand!.turn!.deadline).toBeGreaterThan(Date.now());
    expect(room.seats.map((s) => [s.seatIndex, s.userId ?? null, s.hasCards, s.connected, s.stack, s.streetBet])).toEqual(
      view.seats.map((s) => [s.seatIndex, s.userId ?? null, true, true, s.stack, s.streetBet]),
    );
    expect(room.seats.map((s) => s.userId)).toEqual([a.me.id, b.me.id]);
    expect(room.seats.reduce((n, s) => n + s.streetBet, 0)).toBe(15);
    expect(room.issues).toEqual([]);
    // Nothing anyone holds, under any name or as a bare card; nobody's place in the queue.
    for (const card of held) expect(raw).not.toContain(`"${card}"`);
    for (const k of PRIVATE_KEYS) expect(raw).not.toContain(`"${k}"`);
    expect(raw).not.toContain(w.me.id);
    expect(raw).not.toContain(w.me.nickname);

    // Watching is not spectating: the room and D1 still count the one spectator, and the players saw no one join.
    await rooms(['it-mon-0']);
    const after = await live('it-mon-0');
    expect(after.spectators).toBe(before.spectators);
    expect((await rooms(['it-mon-0'])).body.rooms['it-mon-0']).toMatchObject({ room: { spectators: 1, connections: 4 } });
    expect(wa.state!.spectatorCount).toBe(dealt.spectatorCount);

    // A seated member is found by nickname, exactly.
    const byMember = (await tables(admin, `?member=${encodeURIComponent(a.me.nickname.toUpperCase())}`)).body;
    expect(byMember.memberTables).toEqual(['it-mon-0']);
    expect(byMember.items.map((t) => t.id)).toEqual(['it-mon-0']);
    expect((await tables(admin, `?member=${encodeURIComponent(w.me.nickname)}`)).body.memberTables).toEqual([]);
    // The grid has the counts the room wrote, and no waiting member either.
    const row = await tables(admin, '?q=it-mon-0');
    expect(row.body.items[0]).toMatchObject({ seated: 2, bots: 0, playing: true, waitlist: 1 });
    expect(row.raw).not.toContain(w.me.id);
  });
});
