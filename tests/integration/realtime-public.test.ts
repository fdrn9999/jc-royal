// Public realtime events (docs/REALTIME.md): the lobby's cards and counts, notices and maintenance, tournaments. They
// carry only what every lobby card or status page shows (never who sits or waits, nor a join code or its hash); a lobby
// or tournament event reaches only pages that asked for its topic; a member's own place at a table goes to that member.
// Each follows a committed D1 write, so the page reading after it gets the same thing (the revision says which).
import type { RealtimeEvent, TournamentStructure } from '@jc/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { RealtimeSocket } from '../support/realtime';
import { TableSocket } from '../support/ws';

const admin = sharedAdmin();
const HOUR = 3_600_000;
const room = (over: Record<string, unknown> = {}) => ({ name: uniq('실시간 방').slice(0, 20), maxSeats: 2, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, ...over });

const open: RealtimeSocket[] = [];
const tables: TableSocket[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const s of tables.splice(0)) s.close();
});
afterAll(async () => {
  for (const f of cleanups.splice(0)) await f().catch(() => undefined);
});

async function rt(client: Client, opts: Parameters<typeof RealtimeSocket.open>[1] = {}) {
  const s = await RealtimeSocket.open(client, opts);
  open.push(s);
  return s;
}
async function sock(client: Client, tableId: string, opts: Parameters<typeof TableSocket.open>[2] = {}) {
  const s = await TableSocket.open(client, tableId, opts);
  tables.push(s);
  return s;
}

const about = (s: RealtimeSocket, id: string) => s.events.filter((e) => 'resourceId' in e && e.resourceId === id);
const count = (s: RealtimeSocket, type: RealtimeEvent['type'], id?: string) => s.events.filter((e) => e.type === type && (!id || ('resourceId' in e && e.resourceId === id))).length;

/** No more such events reach the socket: the hub answers a ping only after what it was sent before it. */
async function quiet(s: RealtimeSocket, type: RealtimeEvent['type'], expected: number, id?: string) {
  await s.ping();
  await new Promise((r) => setTimeout(r, 1_500));
  expect(count(s, type, id)).toBe(expected);
}

async function reauth() {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** The counts a lobby card shows, nothing more (LobbyLivePatchSchema). */
const PATCH_KEYS = ['bots', 'id', 'playing', 'rev', 'seated', 'spectators', 'status', 'waitlist'];

describe('realtime lobby', () => {
  it("a seat taken reaches every lobby as counts; only the player hears that their own place moved", async () => {
    const [host, player, watcher, elsewhere] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    const [sw, sp, se] = await Promise.all([rt(watcher.client, { topics: ['lobby'] }), rt(player.client), rt(elsewhere.client)]);
    const made = await host.client.post('/api/rooms', room());
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;

    // The new card, as GET /api/tables lists it but with nobody's own place in it.
    const card = await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id);
    expect(card.scope).toBe('lobby');
    expect(card.payload).toMatchObject({ id, roomType: 'member', isPrivate: false, status: 'open', seated: 0 });
    expect(card.payload).not.toHaveProperty('myParticipation');
    const listed = ((await watcher.client.get('/api/tables')).body as { id: string; rev: number }[]).find((t) => t.id === id);
    expect(card.payload.rev).toBe(listed!.rev);

    const ws = await sock(player.client, id);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const seat = await sw.event('lobby.table.changed', 15_000, (e) => e.resourceId === id && e.payload.seated === 1);
    expect(Object.keys(seat.payload).sort()).toEqual(PATCH_KEYS);
    expect(seat.payload).toMatchObject({ id, seated: 1, bots: 0, waitlist: 0, status: 'open' });
    // the revision is the one the next REST read reports
    const after = ((await watcher.client.get('/api/tables')).body as { id: string; liveRev: number; seated: number }[]).find((t) => t.id === id)!;
    expect(after.seated).toBe(1);
    expect(after.liveRev).toBeGreaterThanOrEqual(seat.payload.rev);

    // The player's own pages read their place again; nobody else is told anything about whose place moved.
    await sp.event('lobby.mine.changed', 15_000, (e) => e.resourceId === id);
    expect((await player.client.get(`/api/tables/${id}`)).body.myParticipation).toEqual({ status: 'seated' });
    await quiet(sw, 'lobby.mine.changed', 0);
    // A page that did not ask for the lobby hears none of it, and the player's page (no lobby topic) no counts.
    await quiet(se, 'lobby.table.changed', 0);
    expect(about(se, id)).toEqual([]);
    expect(count(sp, 'lobby.table.changed')).toBe(0);

    // Standing up: the counts again, and the player's note again.
    const notes = count(sp, 'lobby.mine.changed', id);
    expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await sw.until(() => sw.events.some((e) => e.type === 'lobby.table.changed' && e.resourceId === id && e.payload.seated === 0 && e.payload.rev > seat.payload.rev), 15_000, 'seat freed');
    await sp.until(() => count(sp, 'lobby.mine.changed', id) > notes, 15_000, 'own place moved again');
  });

  it("a full private table's waitlist is a count: no one's id or place, no code or hash, reaches a lobby", async () => {
    const CODE = 'rt-secret-77';
    const [host, a, b, w, watcher] = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);
    const sw = await rt(watcher.client, { topics: ['lobby'] });
    const sWait = await rt(w.client);
    const made = await host.client.post('/api/rooms', room({ isPrivate: true, joinCode: CODE, allowSpectators: false }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    const card = await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id);
    expect(card.payload).toMatchObject({ isPrivate: true, allowSpectators: false });

    const wa = await sock(a.client, id, { code: CODE });
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const wb = await sock(b.client, id, { code: CODE });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const ww = await sock(w.client, id, { code: CODE });
    expect(await ww.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'ack' });
    await sw.event('lobby.table.changed', 20_000, (e) => e.resourceId === id && e.payload.seated === 2 && e.payload.waitlist === 1);
    // the waiting member is told to read their own place (only they learn it)
    await sWait.event('lobby.mine.changed', 15_000, (e) => e.resourceId === id);
    await quiet(sw, 'lobby.mine.changed', 0);

    // A rename to the private card as well: the code and its hash never travel.
    expect((await host.client.patch(`/api/rooms/${id}`, { name: '이름 바뀐 방' })).status).toBe(200);
    await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id && e.payload.name === '이름 바뀐 방');

    const hash = (await d1<{ h: string }>(`SELECT join_code_hash AS h FROM tables WHERE id = '${id}'`))[0]!.h;
    expect(hash).toBeTruthy();
    const packets = JSON.stringify(about(sw, id));
    for (const secret of [a.me.id, b.me.id, w.me.id, CODE, hash, 'myParticipation', 'waitlistUsers', 'live_waitlist_users', 'liveWaitlistUsers', 'joinCode', 'codeHash']) {
      expect(packets, secret).not.toContain(secret);
    }
  });

  it("a host's rename and close reach every lobby as the card, then its removal once the room has closed", async () => {
    const [host, watcher] = await Promise.all([newUser(), newUser()]);
    const sw = await rt(watcher.client, { topics: ['lobby'] });
    const { id } = (await host.client.post('/api/rooms', room())).body as { id: string };
    const first = await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id);
    expect((await host.client.patch(`/api/rooms/${id}`, { allowSpectators: false })).status).toBe(200);
    const patched = await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id && e.payload.allowSpectators === false);
    expect(patched.payload.rev).toBeGreaterThanOrEqual(first.payload.rev!);

    expect((await host.client.post(`/api/rooms/${id}/close`, {})).status).toBe(200);
    // closing (shown as closed), then gone when the empty room has finished
    await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id && e.payload.status === 'closed');
    await sw.event('lobby.table.removed', 20_000, (e) => e.resourceId === id);
    expect(((await watcher.client.get('/api/tables')).body as { id: string }[]).some((t) => t.id === id)).toBe(false);
  });

  it("an administrator's new table, entry block and close reach every lobby; a pause, which no card shows, sends nothing", async () => {
    const watcher = await newUser();
    const sw = await rt(watcher.client, { topics: ['lobby'] });
    const made = await admin.post('/api/admin/tables', { name: `실시간 ${Date.now() % 10_000}`, maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 1000 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    cleanups.push(() => admin.post(`/api/admin/tables/${id}/close`, {}));
    await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id && e.payload.roomType === 'official');

    await reauth();
    expect((await admin.post(`/api/admin/tables/${id}/control`, { action: 'block', reason: 'realtime test' })).status).toBe(200);
    await sw.event('lobby.table.updated', 15_000, (e) => e.resourceId === id && e.payload.entryBlocked === true);
    const cards = count(sw, 'lobby.table.updated', id);
    expect((await admin.post(`/api/admin/tables/${id}/control`, { action: 'pause', reason: 'realtime test' })).status).toBe(200);
    await quiet(sw, 'lobby.table.updated', cards, id);

    expect((await admin.post(`/api/admin/tables/${id}/close`, {})).status).toBe(200);
    await sw.event('lobby.table.removed', 20_000, (e) => e.resourceId === id);
  });
});

describe('realtime service status', () => {
  it('a notice or a maintenance window tells every page, with no topic, the revision GET /api/service/status then reports', async () => {
    const m = await newUser();
    const s = await rt(m.client);
    await reauth();
    const n = await admin.post('/api/admin/service/notices', { kind: 'general', titleKo: '실시간 상태 공지', titleEn: 'Realtime status notice' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const noticeId = n.body.id as string;
    cleanups.push(() => admin.req('DELETE', `/api/admin/service/notices/${noticeId}`));

    const e1 = await s.event('service.changed');
    expect(e1.scope).toBe('service');
    const st = (await m.client.get('/api/service/status')).body as { rev: number };
    expect(e1.payload.rev).toBe(st.rev);
    // the reads it asks for are spread by how many members could be reading, as for an announcement to every inbox
    const members = Number((await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND is_bot = 0`))[0]!.n);
    expect(e1.payload.spreadMs).toBe(Math.min(30_000, Math.max(0, members - 20) * 10));
    // nothing in it but the revision and the spread: the notice is read from the status
    expect(JSON.stringify(e1)).not.toContain('실시간 상태 공지');

    // A maintenance window planned ahead and then stopped: each a change.
    const startsAt = Date.now() + HOUR;
    const mw = await admin.post('/api/admin/service/maintenance', { startsAt, endsAt: startsAt + HOUR, messageKo: '실시간 점검', messageEn: 'Realtime maintenance', reason: 'realtime test' });
    expect(mw.status, JSON.stringify(mw.body)).toBe(201);
    const mwId = mw.body.id as string;
    cleanups.push(() => admin.post(`/api/admin/service/maintenance/${mwId}/stop`, { reason: 'test cleanup' }));
    await s.until(() => count(s, 'service.changed') >= 2, 15_000, 'maintenance service.changed');
    const e2 = s.events.filter((e) => e.type === 'service.changed').at(-1) as Extract<RealtimeEvent, { type: 'service.changed' }>;
    expect(e2.payload.rev).toBe(((await m.client.get('/api/service/status')).body as { rev: number }).rev);
    expect((await admin.post(`/api/admin/service/maintenance/${mwId}/stop`, { reason: 'realtime test done' })).status).toBe(200);
    await s.until(() => count(s, 'service.changed') >= 3, 15_000, 'stopped service.changed');
    expect(((await m.client.get('/api/service/status')).body as { maintenance: unknown }).maintenance).toBeNull();
  });
});

const FAST: TournamentStructure = {
  name: 'rt',
  capacity: 3,
  minPlayers: 2,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
  ],
  levelMinutes: 5,
  turnSeconds: 10,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};

describe('realtime tournaments', () => {
  it("opening, registrations and the cancel reach the tournament pages only; a change that wrote nothing sends nothing", async () => {
    const [m, watcher, other] = await Promise.all([newUser(), newUser(), newUser()]);
    const [st, sl, s0] = await Promise.all([rt(watcher.client, { topics: ['tournaments'] }), rt(other.client, { topics: ['lobby'] }), rt(m.client)]);
    await reauth();
    const tpl = await admin.post('/api/admin/tournament-templates', { ...FAST, name: uniq('rt tpl'), reason: 'realtime test' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const made = await admin.post('/api/admin/tournaments', { templateId: tpl.body.template.id, templateVersion: tpl.body.template.version, name: uniq('RT') });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const id = made.body.tournament.id as string;
    cleanups.push(async () => {
      await reauth();
      const t = (await admin.get(`/api/admin/tournaments/${id}`)).body.tournament;
      if (t && (t.status === 'registering' || t.status === 'closed')) await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'test cleanup' });
    });
    const opened = await st.event('tournament.changed', 15_000, (e) => e.resourceId === id);
    expect(opened.scope).toBe('lobby');
    // the id only: the page reads the tournament itself
    expect(Object.keys(opened).sort()).toEqual(['eventId', 'occurredAt', 'resourceId', 'scope', 'type']);

    expect((await m.client.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ ok: true, started: false });
    await st.until(() => count(st, 'tournament.changed', id) === 2, 15_000, 'registration');
    expect((await m.client.post(`/api/tournaments/${id}/unregister`)).status).toBe(200);
    await st.until(() => count(st, 'tournament.changed', id) === 3, 15_000, 'unregistration');
    // unregistering again changes no row: nothing is announced
    await m.client.post(`/api/tournaments/${id}/unregister`);
    await quiet(st, 'tournament.changed', 3, id);

    const t = (await admin.get(`/api/admin/tournaments/${id}`)).body.tournament;
    expect((await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'realtime test' })).status).toBe(200);
    await st.until(() => count(st, 'tournament.changed', id) === 4, 15_000, 'cancel');

    // pages without the topic heard none of it
    await quiet(sl, 'tournament.changed', 0);
    expect(count(s0, 'tournament.changed')).toBe(0);
  });
});
