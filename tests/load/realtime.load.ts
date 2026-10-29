/**
 * Local load scenario for the platform realtime hubs (docs/REALTIME.md), against one local `wrangler dev` (workerd)
 * process: RT_VIEWERS lobby pages, each a member with a realtime socket on the lobby topic, while
 *   1. seats are taken and given up, one table at a time (the table room's lobby.table.changed),
 *   2. a member opens a room and closes it (the api's lobby.table.updated and lobby.table.removed),
 *   3. RT_BURST spectators open one table at the same moment and leave it together (the room's one-second feed),
 *   4. an administrator grants chips to RT_GRANTEES members with RT_DEVICES pages each, then repeats every grant.
 *
 * What it measures: from the moment the change is sent to the moment each page has the event (p50/p95/p99), events
 * missed and received twice, sockets lost, and whether D1 ends as the events said. With TEST_D1_STATS=1 it also reads
 * how many D1 rows each polled endpoint reads per request (apps/api/src/lib/d1-stats.ts); a run with it on runs some
 * reads twice, so its timings are not quoted. What it does not show: the edge, where each hub is its own Durable
 * Object (here every hub shares one process), network latency, or billing. See docs/LOAD_TEST.md before quoting.
 */
import type { RealtimeEvent } from '@jc/types';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin, uniq, WEB_ORIGIN } from '../support/client';
import { RealtimeSocket } from '../support/realtime';
import { root } from '../support/worker';
import { TableSocket } from '../support/ws';
import { realtimeConfig } from './config';

const rc = realtimeConfig();
const BUY_IN = 1_000;
const GRANT = 500;
const START_BALANCE = 10_000;

const realtime: RealtimeSocket[] = [];
const tables: TableSocket[] = [];
afterAll(() => {
  for (const s of realtime) s.close();
  for (const s of tables) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function d1<T = Record<string, number>>(sql: string): Promise<T[]> {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const { stdout } = await promisify(execFile)(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', process.env.LOAD_STATE!, '-c', 'apps/api/wrangler.jsonc', '--json', '--command', sql], { cwd: root, encoding: 'utf8' });
  return (JSON.parse(stdout.slice(stdout.indexOf('['))) as { results: T[] }[]).flatMap((x) => x.results);
}

async function pool<T>(n: number, limit: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, n) }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: Math.round(s[s.length - 1]!) };
}

/** Every event one socket got, with when it arrived. */
type Log = { at: number; e: RealtimeEvent }[];
const logs = new Map<RealtimeSocket, Log>();
function watch(s: RealtimeSocket): Log {
  const log: Log = [];
  s.ws.addEventListener('message', (ev) => {
    const f = JSON.parse(String(ev.data)) as { t: string; e?: RealtimeEvent };
    if (f.t === 'event' && f.e) log.push({ at: performance.now(), e: f.e });
  });
  logs.set(s, log);
  return log;
}

/** How long after t0 each log first had a matching event (waiting up to `ms` for all of them). */
async function arrivals(of: Log[], t0: number, match: (e: RealtimeEvent) => boolean, ms = 20_000) {
  const found = (log: Log) => log.find((x) => x.at >= t0 && match(x.e));
  const deadline = performance.now() + ms;
  while (performance.now() < deadline && !of.every(found)) await sleep(20);
  const out: number[] = [];
  let missed = 0;
  for (const log of of) {
    const x = found(log);
    if (x) out.push(x.at - t0);
    else missed++;
  }
  return { ms: out, missed };
}

const card = (id: string, pred: (p: Record<string, unknown>) => boolean) => (e: RealtimeEvent) =>
  e.type === 'lobby.table.changed' && e.resourceId === id && pred(e.payload as unknown as Record<string, unknown>);

/** One request's D1 row counts, from the x-d1-* headers (present only when the worker runs with D1_STATS=1). */
async function rowsOf(client: Client, path: string) {
  const res = await fetch(`${BASE()}${path}`, { headers: { Cookie: client.cookieHeader(), Origin: WEB_ORIGIN } });
  await res.arrayBuffer();
  const h = (k: string) => (res.headers.has(k) ? Number(res.headers.get(k)) : null);
  return { path, status: res.status, queries: h('x-d1-queries'), rowsRead: h('x-d1-rows-read'), rowsWritten: h('x-d1-rows-written'), unmeasured: h('x-d1-unmeasured') };
}

const m = {
  signupMs: [] as number[],
  connectMs: [] as number[],
  connectFailures: [] as string[],
  seat: { ackMs: [] as number[], deliveryMs: [] as number[], missed: 0 },
  room: { createMs: 0, created: [] as number[], closed: [] as number[], missed: 0, removedPerViewer: [] as number[] },
  burst: { joinMs: 0, settledMs: [] as number[], leftMs: [] as number[], missed: 0, eventsPerViewer: [] as number[], finalSpectators: { up: -1, down: -1 } },
  grants: { grantMs: [] as number[], deliveryMs: [] as number[], missed: 0, walletEventsPerSocket: [] as number[], retriedEvents: 0 },
  errors: [] as string[],
};

it(`${rc.viewers} lobby pages on realtime sockets: seats, a room, a burst of ${rc.burst} spectators, grants to ${rc.grantees} members × ${rc.devices} pages`, async () => {
  const startedAt = performance.now();

  // 1. Accounts (PBKDF2 is lowered to 1,000 iterations locally, so this is not the production sign-up cost).
  const users = await pool(rc.viewers, 16, async () => {
    const t0 = performance.now();
    const u = await newUser();
    m.signupMs.push(performance.now() - t0);
    return u;
  });
  const sitters = users.slice(0, rc.changes);
  const host = users[rc.changes]!;
  const grantees = users.slice(rc.changes + 1, rc.changes + 1 + rc.grantees);
  const spectators = users.slice(-rc.burst);
  const burstTable = `load-${rc.changes}`;

  // 2. What each request the pages poll reads from D1 (before any socket opens, so nothing else runs meanwhile).
  const [a, b] = users.slice(-2) as [(typeof users)[0], (typeof users)[0]];
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
  expect((await a.client.post(`/api/dm/${b.me.id}`, { text: 'load' })).status).toBe(201);
  const listed = (await a.client.get('/api/tournaments?status=active&limit=20')).body as { tournaments?: { id: string }[] };
  const tourney = listed.tournaments?.[0]?.id;
  const tableCount = ((await a.client.get('/api/tables')).body as unknown[]).length;
  const rows = [];
  for (const path of [
    '/api/tables',
    '/api/tables/load-0',
    '/api/messages/unread-count',
    '/api/auth/me',
    '/api/service/status',
    '/api/friends',
    '/api/friends/presence',
    `/api/dm/${a.me.id}?afterSeq=0`,
    '/api/tournaments?status=active&limit=20',
    ...(tourney ? [`/api/tournaments/${tourney}`] : []),
  ]) {
    // the second of two: the first may write what one request a minute writes (a session slid, a rate-limit row)
    await rowsOf(b.client, path);
    rows.push(await rowsOf(b.client, path));
  }

  // 3. Every page opens its realtime socket and asks for the lobby.
  const connectStart = performance.now();
  const viewers = await pool(users.length, 25, async (i) => {
    const t0 = performance.now();
    try {
      const s = await RealtimeSocket.open(users[i]!.client, { topics: ['lobby'] });
      m.connectMs.push(performance.now() - t0);
      realtime.push(s);
      watch(s);
      return s;
    } catch (e) {
      m.connectFailures.push(String(e));
      return null;
    }
  });
  const connectedIn = performance.now() - connectStart;
  const lobby = viewers.filter((s): s is RealtimeSocket => !!s).map((s) => logs.get(s)!);
  expect(m.connectFailures).toEqual([]);

  // 4. Seats: each sitter opens its table (which itself is a lobby change: one more spectator), then, one table at a
  // time and more than the feed's second after that table's last event (so no wait in the feed is measured), sits
  // down and later stands up.
  const sitSockets = await Promise.all(sitters.map((u, i) => TableSocket.open(u.client, `load-${i}`)));
  tables.push(...sitSockets);
  await sleep(1_500);
  for (const [phase, seated] of [
    ['sit', 1],
    ['leave', 0],
  ] as const) {
    for (const [i, ws] of sitSockets.entries()) {
      await sleep(1_100);
      const t0 = performance.now();
      const r = await ws.request(phase === 'sit' ? { t: 'sit', seatIndex: 0, buyIn: BUY_IN } : { t: 'leave' });
      m.seat.ackMs.push(performance.now() - t0);
      if (r.t !== 'ack') m.errors.push(`load-${i} ${phase}: ${JSON.stringify(r)}`);
      const got = await arrivals(lobby, t0, card(`load-${i}`, (p) => p.seated === seated));
      m.seat.deliveryMs.push(...got.ms);
      m.seat.missed += got.missed;
    }
  }

  // 5. A room opened and closed through the api.
  const name = `RT load ${Date.now() % 100_000}`;
  let t0 = performance.now();
  const made = await host.client.post('/api/rooms', { name, maxSeats: 6, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000 });
  m.room.createMs = performance.now() - t0;
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const roomId = (made.body as { id: string }).id;
  let got = await arrivals(lobby, t0, (e) => e.type === 'lobby.table.updated' && e.resourceId === roomId);
  m.room.created = got.ms;
  m.room.missed += got.missed;
  t0 = performance.now();
  expect((await host.client.post(`/api/rooms/${roomId}/close`)).status).toBe(200);
  got = await arrivals(lobby, t0, (e) => e.type === 'lobby.table.removed' && e.resourceId === roomId);
  m.room.closed = got.ms;
  m.room.missed += got.missed;

  // 6. The burst: every spectator opens the same table at once, then all leave together. Between the first and the
  // last arrival the pages get the counts at most once a second, and the last count they get is the table's.
  await sleep(1_500);
  const burstFrom = performance.now();
  t0 = burstFrom;
  const watchers = await Promise.all(spectators.map((u) => TableSocket.open(u.client, burstTable)));
  tables.push(...watchers);
  m.burst.joinMs = performance.now() - t0;
  got = await arrivals(lobby, t0, card(burstTable, (p) => p.spectators === rc.burst), 30_000);
  m.burst.settledMs = got.ms;
  m.burst.missed += got.missed;
  m.burst.finalSpectators.up = ((await a.client.get(`/api/tables/${burstTable}`)).body as { spectators: number }).spectators;
  await sleep(1_500);
  t0 = performance.now();
  for (const w of watchers) w.close();
  got = await arrivals(lobby, t0, card(burstTable, (p) => p.spectators === 0), 30_000);
  m.burst.leftMs = got.ms;
  m.burst.missed += got.missed;
  await sleep(1_500);
  m.burst.finalSpectators.down = ((await a.client.get(`/api/tables/${burstTable}`)).body as { spectators: number }).spectators;
  m.burst.eventsPerViewer = lobby.map((log) => log.filter((x) => x.at >= burstFrom && x.e.type === 'lobby.table.changed' && x.e.resourceId === burstTable).length);

  // 7. Grants: each grantee has RT_DEVICES pages (the lobby one and more), and each page gets the grant's
  // wallet.changed once; the same grants sent again change nothing and announce nothing.
  const devices = new Map<string, Log[]>();
  await pool(grantees.length, 8, async (i) => {
    const u = grantees[i]!;
    const own = [logs.get(viewers[rc.changes + 1 + i]!)!];
    for (let d = 1; d < rc.devices; d++) {
      const s = await RealtimeSocket.open(u.client);
      realtime.push(s);
      own.push(watch(s));
    }
    devices.set(u.me.id, own);
  });
  const admin = sharedAdmin();
  const re = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(re.status, JSON.stringify(re.body)).toBe(200);
  const keys = new Map<string, string>();
  const grantFrom = performance.now();
  await pool(grantees.length, 4, async (i) => {
    const u = grantees[i]!;
    const key = uniq('rt-load');
    keys.set(u.me.id, key);
    const t = performance.now();
    const r = await admin.post(`/api/admin/users/${u.me.id}/chips`, { amount: GRANT, memo: 'realtime load grant', idempotencyKey: key });
    m.grants.grantMs.push(performance.now() - t);
    if (r.status !== 200 || r.body.duplicate !== false) m.errors.push(`grant ${u.me.id}: ${r.status} ${JSON.stringify(r.body)}`);
    const g = await arrivals(devices.get(u.me.id)!, t, (e) => e.type === 'wallet.changed');
    m.grants.deliveryMs.push(...g.ms);
    m.grants.missed += g.missed;
  });
  const walletEvents = () => [...devices.values()].flat().map((log) => log.filter((x) => x.at >= grantFrom && x.e.type === 'wallet.changed').length);
  const beforeRetry = walletEvents().reduce((x, y) => x + y, 0);
  await pool(grantees.length, 4, async (i) => {
    const u = grantees[i]!;
    const r = await admin.post(`/api/admin/users/${u.me.id}/chips`, { amount: GRANT, memo: 'realtime load grant', idempotencyKey: keys.get(u.me.id)! });
    if (r.status !== 200 || r.body.duplicate !== true) m.errors.push(`grant retry ${u.me.id}: ${r.status} ${JSON.stringify(r.body)}`);
  });
  // the hub answers a ping only after what it was sent before it
  await Promise.all(realtime.filter((s) => !s.closed).map((s) => s.ping(30_000)));
  await sleep(500);
  m.grants.walletEventsPerSocket = walletEvents();
  m.grants.retriedEvents = m.grants.walletEventsPerSocket.reduce((x, y) => x + y, 0) - beforeRetry;
  const ledger = await d1<{ user_id: string; n: number }>(
    `SELECT user_id, COUNT(*) AS n FROM chip_ledger WHERE type = 'admin_adjust' AND user_id IN (${grantees.map((u) => `'${u.me.id}'`).join(',')}) GROUP BY user_id`,
  );
  const balances = await Promise.all(grantees.map(async (u) => (await u.client.get('/api/auth/me')).body.balance as number));

  // 8. Duplicates and lost sockets over the whole run.
  let received = 0;
  let duplicates = 0;
  for (const log of logs.values()) {
    received += log.length;
    duplicates += log.length - new Set(log.map((x) => x.e.eventId)).size;
  }
  const lost = realtime.filter((s) => s.closed).map((s) => s.closed);

  const report = {
    at: new Date().toISOString(),
    config: { ...rc, tablesListed: tableCount, d1Stats: process.env.TEST_D1_STATS === '1' },
    note: 'local wrangler dev (workerd) on one machine; every hub shares one process. Not edge latency, not billing.',
    durationMs: Math.round(performance.now() - startedAt),
    accounts: { n: users.length, signupMs: stats(m.signupMs) },
    connect: { inMs: Math.round(connectedIn), perSocketMs: stats(m.connectMs), failures: m.connectFailures.length, extraDeviceSockets: grantees.length * (rc.devices - 1) },
    d1RowsPerRequest: rows,
    seats: { changes: rc.changes * 2, ackMs: stats(m.seat.ackMs), deliveryMs: stats(m.seat.deliveryMs), missed: m.seat.missed },
    room: { createMs: Math.round(m.room.createMs), createdMs: stats(m.room.created), closedMs: stats(m.room.closed), missed: m.room.missed, removedEventsPerViewer: stats(lobby.map((log) => log.filter((x) => x.e.type === 'lobby.table.removed' && x.e.resourceId === roomId).length)) },
    burst: {
      spectators: rc.burst,
      openedAllMs: Math.round(m.burst.joinMs),
      lastCountMs: stats(m.burst.settledMs),
      emptiedMs: stats(m.burst.leftMs),
      missed: m.burst.missed,
      eventsPerViewer: stats(m.burst.eventsPerViewer),
      tableSaysSpectators: m.burst.finalSpectators,
    },
    grants: {
      members: grantees.length,
      pagesEach: rc.devices,
      grantMs: stats(m.grants.grantMs),
      deliveryMs: stats(m.grants.deliveryMs),
      missed: m.grants.missed,
      walletEventsPerPage: stats(m.grants.walletEventsPerSocket),
      eventsAfterRetry: m.grants.retriedEvents,
      ledgerRowsPerMember: stats(ledger.map((r) => r.n)),
      balances: stats(balances),
    },
    events: { received, duplicates },
    lostSockets: lost,
    errors: m.errors,
  };
  const out = resolve(root, `tests/.state/realtime-load-report-${rc.viewers}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`[load] realtime report: ${out}\n${JSON.stringify(report, null, 2)}`);

  expect(m.errors).toEqual([]);
  expect(m.seat.missed + m.room.missed + m.burst.missed + m.grants.missed).toBe(0);
  expect(duplicates).toBe(0);
  expect(lost).toEqual([]);
  expect(m.burst.finalSpectators).toEqual({ up: rc.burst, down: 0 });
  expect(m.grants.walletEventsPerSocket.every((n) => n === 1)).toBe(true);
  expect(m.grants.retriedEvents).toBe(0);
  expect(ledger.length).toBe(grantees.length);
  expect(ledger.every((r) => r.n === 1)).toBe(true);
  expect(balances.every((x) => x === START_BALANCE + GRANT)).toBe(true);
});
