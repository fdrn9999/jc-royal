/**
 * Local load scenario for the control center (docs/CONTROL_CENTER.md): administrators with the grid open while members
 * sit, stand and play, against one local `wrangler dev` (workerd) process.
 *
 * What it measures: the D1 rows each console read costs (TEST_D1_STATS=1), before and after a large closed history; how
 * long the grid's first reads and a rooms read take with every administrator at once; how fast a seat change reaches
 * each administrator's socket (the counts every table sends, and the summaries a followed room pushes); and the action
 * round trip of hands with no administrator following the room and with all of them. Every frame is read for private
 * keys. What it does not show: Cloudflare edge behaviour, isolate placement, network latency, the game worker's own D1
 * reads, or billing. See docs/LOAD_TEST.md before quoting any number.
 */
import {
  hasPrivateKey,
  MONITOR_ROOMS_MAX,
  type AdminMonitorEvent,
  type LegalOption,
  type MonitorRoomsResponse,
  type MonitorTablesResponse,
  type ServerMessage,
} from '@jc/types';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { ADMIN_ORIGIN, AdminMonitorSocket } from '../support/admin-monitor';
import { BASE, Client, newUser, PASSWORD } from '../support/client';
import { d1 } from '../support/d1';
import { promoteSql } from '../support/grants';
import { root } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';
import { loadConfig, monitorConfig } from './config';

const cfg = monitorConfig();
const seeded = loadConfig().tables;
const BUY_IN = 1_000;
/** The page asks a focused room to follow it again every minute; its follow lasts 75 s (routes/admin-monitor.ts). */
const REFOLLOW_MS = 50_000;

const closers: { close(): void }[] = [];
afterAll(() => {
  for (const s of closers) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = <T = Record<string, number>>(sql: string) => d1<T>(sql, process.env.LOAD_STATE!);

/** Runs fn for 0..n-1 with at most `limit` in flight. */
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

/** One request with the D1 counts the worker adds under TEST_D1_STATS=1 (null without them). */
async function measured(client: Client, method: 'GET' | 'POST', path: string, body?: unknown) {
  const headers: Record<string, string> = { Cookie: client.cookieHeader(), Origin: client.origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(`${BASE()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const ms = performance.now() - t0;
  const h = (k: string) => (res.headers.has(k) ? Number(res.headers.get(k)) : null);
  return { status: res.status, ms, text, queries: h('x-d1-queries'), rowsRead: h('x-d1-rows-read'), rowsWritten: h('x-d1-rows-written'), unmeasured: h('x-d1-unmeasured') };
}

/** Each socket's events with when they came. */
type Log = { at: number; e: AdminMonitorEvent }[];
function logOf(s: AdminMonitorSocket): Log {
  const log: Log = [];
  s.ws.addEventListener('message', (ev) => {
    const f = JSON.parse(String(ev.data)) as { t: string; e?: AdminMonitorEvent };
    if (f.t === 'event' && f.e) log.push({ at: performance.now(), e: f.e });
  });
  return log;
}

/** How long after t0 each socket first got an event `match` takes; the ones that did not within `ms` are missed. */
async function arrivals(logs: Log[], t0: number, match: (e: AdminMonitorEvent) => boolean, ms = 20_000) {
  const first = (l: Log) => l.find((x) => x.at >= t0 && match(x.e));
  const deadline = performance.now() + ms;
  while (performance.now() < deadline && !logs.every(first)) await sleep(10);
  const hits = logs.map(first);
  return { ms: hits.flatMap((h) => (h ? [h.at - t0] : [])), missed: hits.filter((h) => !h).length };
}

type User = Awaited<ReturnType<typeof newUser>>;
interface Seat {
  user: User;
  ws: TableSocket;
}

const m = {
  errors: [] as string[],
  rows: { before: [] as unknown[], after: [] as unknown[] },
  gridMs: { tables: [] as number[], ops: [] as number[] },
  rooms: {
    cold: { requestMs: [] as number[], roomMs: [] as number[], unavailable: 0, countsEvents: 0 },
    warm: { requestMs: [] as number[], roomMs: [] as number[], unavailable: 0, countsEvents: 0 },
  },
  unfollowed: { sitAckMs: [] as number[], leaveAckMs: [] as number[], countsMs: [] as number[], countsMissed: 0 },
  followed: { sitAckMs: [] as number[], leaveAckMs: [] as number[], countsMs: [] as number[], countsMissed: 0, roomMs: [] as number[], roomMissed: 0 },
  hands: {
    unfollowed: { hands: 0, actionMs: [] as number[], short: false, durationMs: 0 },
    followed: { hands: 0, actionMs: [] as number[], short: false, durationMs: 0, roomPushes: 0 },
  },
};

/** Two members play `hands` hands at `tableId` from seats 0 and 1, then stand up. */
async function playHands(tableId: string, players: Seat[], hands: number, out: { hands: number; actionMs: number[]; short: boolean }) {
  const done = new Set<string>();
  let current: string | null = null;
  const onMessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    if (msg.t !== 'state') return;
    const h = msg.state.hand;
    if (current && (!h || h.id !== current)) done.add(current);
    if (h?.stage === 'settled') done.add(h.id);
    current = h?.id ?? null;
  };
  players[0]!.ws.ws.addEventListener('message', onMessage);
  try {
    for (const [i, p] of players.entries()) {
      const r = await p.ws.request({ t: 'sit', seatIndex: i, buyIn: BUY_IN });
      if (r.t !== 'ack') m.errors.push(`${tableId} hands sit: ${JSON.stringify(r)}`);
    }
    const deadline = Date.now() + 10 * 60_000;
    let leaving = false;
    let shortSince: number | null = null;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${tableId}: timed out after ${done.size} hands`);
      const view = players[0]!.ws.state;
      const funded = view ? view.seats.filter((x) => x.userId && x.stack > 0 && x.state !== 'sittingOut').length : 2;
      shortSince = view && view.status !== 'playing' && funded < 2 ? (shortSince ?? Date.now()) : null;
      if (!leaving && (done.size >= hands || (shortSince !== null && Date.now() - shortSince > 6_000))) {
        out.short = done.size < hands;
        leaving = true;
        await Promise.all(
          players.map(async (p) => {
            const r = await p.ws.request({ t: 'leave' });
            if (r.t !== 'ack') m.errors.push(`${tableId} hands leave: ${JSON.stringify(r)}`);
          }),
        );
      }
      if (leaving && players.every((p) => p.ws.state?.you.seatIndex === null)) break;
      const actor = players.find((p) => p.ws.state && isMyTurn(p.ws.state));
      if (!actor) {
        await sleep(15);
        continue;
      }
      const legal = actor.ws.state!.you.legal;
      const raise = legal.find((o): o is Extract<LegalOption, { type: 'bet' | 'raise' }> => o.type === 'bet' || o.type === 'raise');
      let type: string;
      let amount: number | undefined;
      if (raise && Math.random() < 0.15) {
        type = raise.type;
        amount = raise.min;
      } else if (legal.some((o) => o.type === 'check')) type = 'check';
      else if (legal.some((o) => o.type === 'call')) type = 'call';
      else type = legal.some((o) => o.type === 'allin') ? 'allin' : 'fold';
      const t0 = performance.now();
      const { result } = await actor.ws.act(type, amount);
      out.actionMs.push(performance.now() - t0);
      if (result.t === 'error') m.errors.push(`${tableId} ${type}: ${JSON.stringify(result)}`);
    }
  } finally {
    players[0]!.ws.ws.removeEventListener('message', onMessage);
  }
  out.hands = done.size;
}

it(`control center: ${cfg.tables} open tables × ${cfg.admins} administrators, ${cfg.closed} closed in history`, async () => {
  const startedAt = performance.now();

  // 1. Idle open tables up to MON_TABLES (two-, six- and nine-seat), beside the setup's played ones.
  const open = (await db<{ n: number }>(`SELECT COUNT(*) AS n FROM tables WHERE status IN ('open', 'closing')`))[0]!.n;
  if (cfg.tables > open) {
    await db(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in) WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${cfg.tables - open}) SELECT 'mon-' || i, 'Monitor ' || i, CASE i % 3 WHEN 0 THEN 6 WHEN 1 THEN 9 ELSE 2 END, 5, 10, 100, 2000 FROM n`,
    );
  }

  // 2. Members (the sitters, then two players) and administrators with table duty, each with one socket.
  const sitTables = Array.from({ length: cfg.sits }, (_, i) => `load-${i}`);
  const handTable = sitTables[0]!;
  const sitters = await pool(cfg.sits, 4, () => newUser());
  const players = await pool(2, 2, () => newUser());
  const staff = await pool(cfg.admins, 4, () => newUser());
  await db(promoteSql(`id IN (${staff.map((s) => `'${s.me.id}'`).join(', ')})`, ['dashboard', 'tables', 'tableControl']));
  const admins = await pool(cfg.admins, 4, async (i) => {
    const c = new Client(ADMIN_ORIGIN);
    const r = await c.post('/api/admin/auth/login', { email: staff[i]!.email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`console sign-in ${r.status} ${JSON.stringify(r.body)}`);
    return c;
  });
  const socks = await Promise.all(admins.map((c) => AdminMonitorSocket.open(c)));
  closers.push(...socks);
  const logs = socks.map(logOf);
  const lobby = sitters[0]!.client;

  // 3. Rows each read costs (the second of two calls: the first may write what one request a minute writes).
  const reads = (): [Client, 'GET' | 'POST', string, unknown?][] => [
    [admins[0]!, 'GET', '/api/admin/monitor/tables'],
    [admins[0]!, 'GET', '/api/admin/monitor/tables?scope=closed'],
    [admins[0]!, 'GET', `/api/admin/monitor/tables?member=${encodeURIComponent(sitters[0]!.me.nickname)}`],
    [admins[0]!, 'GET', '/api/admin/ops/live'],
    [admins[0]!, 'GET', '/api/admin/tables?paged=1&limit=50&offset=0'],
    [admins[0]!, 'GET', '/api/admin/tables?paged=1&limit=50&offset=0&status=active'],
    [admins[0]!, 'POST', '/api/admin/monitor/rooms', { ids: sitTables }],
    [lobby, 'GET', '/api/tables'],
  ];
  const rowsOf = async () => {
    const out = [];
    for (const [c, method, path, body] of reads()) {
      await measured(c, method, path, body);
      const r = await measured(c, method, path, body);
      if (r.status !== 200) m.errors.push(`${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
      out.push({ method, path, status: r.status, queries: r.queries, rowsRead: r.rowsRead, rowsWritten: r.rowsWritten, unmeasured: r.unmeasured });
    }
    return out;
  };
  m.rows.before = await rowsOf();

  // 4. Closed history: tables older than every open one, and closed seats of the member searched for.
  if (cfg.closed > 0) {
    await db(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, created_at, updated_at) WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${cfg.closed}) SELECT 'old-' || i, 'Old ' || i, 6, 5, 10, 100, 2000, 'closed', 1700000000000 + i * 1000, 1700000000000 + i * 1000 FROM n`,
    );
    const seats = Math.min(cfg.closed, 2_000);
    await db(
      `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, cash_out, status, created_at, closed_at) WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${seats}) SELECT 'old-s-' || i, 'old-' || i, '${sitters[0]!.me.id}', 0, 1000, 1000, 'closed', 1700000000000 + i * 1000, 1700000000500 + i * 1000 FROM n`,
    );
  }
  m.rows.after = await rowsOf();

  // 5. Every administrator opens the grid at once, a few times: its list, and beside it the dashboard's summary (the
  // dashboard page reads it every 30 s; the control center counts from its list and does not).
  let list: MonitorTablesResponse | null = null;
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      admins.map(async (c) => {
        const [t, o] = await Promise.all([measured(c, 'GET', '/api/admin/monitor/tables'), measured(c, 'GET', '/api/admin/ops/live')]);
        if (t.status !== 200 || o.status !== 200) m.errors.push(`grid ${t.status}/${o.status}`);
        m.gridMs.tables.push(t.ms);
        m.gridMs.ops.push(o.ms);
        list ??= JSON.parse(t.text) as MonitorTablesResponse;
      }),
    );
  }
  const visible = list!.items.filter((t) => t.status !== 'closed').map((t) => t.id).slice(0, MONITOR_ROOMS_MAX);

  // 6. Rooms reads, as on-screen cards ask: every administrator at once, rooms never woken (cold), then again (warm).
  for (const phase of ['cold', 'warm'] as const) {
    const t0 = performance.now();
    await Promise.all(
      admins.map(async (c) => {
        const r = await measured(c, 'POST', '/api/admin/monitor/rooms', { ids: visible });
        if (r.status !== 200) return void m.errors.push(`rooms ${r.status} ${r.text.slice(0, 200)}`);
        m.rooms[phase].requestMs.push(r.ms);
        for (const x of Object.values((JSON.parse(r.text) as MonitorRoomsResponse).rooms)) {
          if ('room' in x) m.rooms[phase].roomMs.push(x.ms);
          else if (x.error === 'room_unavailable') m.rooms[phase].unavailable++;
        }
      }),
    );
    await sleep(3_000);
    m.rooms[phase].countsEvents = logs[0]!.filter((x) => x.at >= t0 && x.e.type === 'admin.monitor.counts').length;
  }

  // 7. Seat changes, one at a time: unfollowed, then with every administrator following the sit tables.
  const sitSocks = await Promise.all(sitters.map((u, i) => TableSocket.open(u.client, sitTables[i]!)));
  const handSocks = await Promise.all(players.map((u) => TableSocket.open(u.client, handTable)));
  closers.push(...sitSocks, ...handSocks);
  await sleep(1_500);
  const humans = (n: number, table: string) => (e: AdminMonitorEvent) => e.type === 'admin.monitor.counts' && e.resourceId === table && e.counts.seated - e.counts.bots === n;
  const seatChanges = async (into: typeof m.unfollowed | typeof m.followed, followed: boolean) => {
    for (const [i, table] of sitTables.entries()) {
      const uid = sitters[i]!.me.id;
      for (const step of ['sit', 'leave'] as const) {
        await sleep(1_100);
        const t0 = performance.now();
        const r = await sitSocks[i]!.request(step === 'sit' ? { t: 'sit', seatIndex: 0, buyIn: BUY_IN } : { t: 'leave' });
        (step === 'sit' ? into.sitAckMs : into.leaveAckMs).push(performance.now() - t0);
        if (r.t !== 'ack') m.errors.push(`${table} ${step}: ${JSON.stringify(r)}`);
        const counts = await arrivals(logs, t0, humans(step === 'sit' ? 1 : 0, table));
        into.countsMs.push(...counts.ms);
        into.countsMissed += counts.missed;
        if (followed && 'roomMs' in into) {
          const seated = (e: AdminMonitorEvent) => e.type === 'admin.monitor.room' && e.resourceId === table && e.room.seats.some((s) => s.userId === uid);
          const room = await arrivals(logs, t0, (e) => e.type === 'admin.monitor.room' && e.resourceId === table && (step === 'sit' ? seated(e) : !seated(e)));
          into.roomMs.push(...room.ms);
          into.roomMissed += room.missed;
        }
      }
    }
  };
  const hands = async (into: { hands: number; actionMs: number[]; short: boolean; durationMs: number }) => {
    if (!cfg.hands) return;
    const t0 = performance.now();
    await playHands(handTable, players.map((user, i) => ({ user, ws: handSocks[i]! })), cfg.hands, into);
    into.durationMs = Math.round(performance.now() - t0);
  };

  await seatChanges(m.unfollowed, false);
  await hands(m.hands.unfollowed);

  const follow = () =>
    Promise.all(
      admins.map(async (c) => {
        const r = await c.post('/api/admin/monitor/rooms', { ids: sitTables, follow: true });
        if (r.status !== 200) m.errors.push(`follow ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      }),
    );
  await follow();
  await Promise.all(socks.map((s) => s.watch(sitTables)));
  let following = true;
  const refollow = (async () => {
    while (following) {
      for (let w = 0; following && w < REFOLLOW_MS; w += 250) await sleep(250);
      if (following) await follow();
    }
  })();
  await seatChanges(m.followed, true);
  const pushesFrom = performance.now();
  await hands(m.hands.followed);
  m.hands.followed.roomPushes = logs[0]!.filter((x) => x.at >= pushesFrom && x.e.type === 'admin.monitor.room' && x.e.resourceId === handTable).length;
  following = false;
  await refollow;

  // 8. What every socket got: no event twice, nothing private in any frame, and no socket dropped.
  for (const s of socks) await s.ping();
  const duplicates = logs.reduce((n, l) => n + l.length - new Set(l.map((x) => x.e.eventId)).size, 0);
  const privateFrames = socks.flatMap((s) => s.frames).filter((f) => hasPrivateKey(JSON.parse(f))).length;
  const lostSockets = socks.filter((s) => s.closed).length;
  const events = logs.map((l) => l.length);

  const report = {
    at: new Date().toISOString(),
    config: { ...cfg, seededTables: seeded, d1Stats: process.env.TEST_D1_STATS === '1' },
    note: 'local wrangler dev (workerd) on one machine; every room and hub shares one process. Not edge latency, not billing. Timings with d1Stats on include its re-run reads.',
    durationMs: Math.round(performance.now() - startedAt),
    listed: { items: list!.items.length, truncated: list!.truncated },
    rows: m.rows,
    latencyMs: {
      gridTables: stats(m.gridMs.tables),
      gridOps: stats(m.gridMs.ops),
      roomsColdRequest: stats(m.rooms.cold.requestMs),
      roomsColdRoom: stats(m.rooms.cold.roomMs),
      roomsWarmRequest: stats(m.rooms.warm.requestMs),
      roomsWarmRoom: stats(m.rooms.warm.roomMs),
      unfollowedSitAck: stats(m.unfollowed.sitAckMs),
      unfollowedLeaveAck: stats(m.unfollowed.leaveAckMs),
      unfollowedCounts: stats(m.unfollowed.countsMs),
      followedSitAck: stats(m.followed.sitAckMs),
      followedLeaveAck: stats(m.followed.leaveAckMs),
      followedCounts: stats(m.followed.countsMs),
      followedRoom: stats(m.followed.roomMs),
      unfollowedAction: stats(m.hands.unfollowed.actionMs),
      followedAction: stats(m.hands.followed.actionMs),
    },
    roomsCalls: { perRead: visible.length, cold: m.rooms.cold.roomMs.length, warm: m.rooms.warm.roomMs.length, coldUnavailable: m.rooms.cold.unavailable, warmUnavailable: m.rooms.warm.unavailable, countsEventsAfterCold: m.rooms.cold.countsEvents, countsEventsAfterWarm: m.rooms.warm.countsEvents },
    hands: {
      unfollowed: { hands: m.hands.unfollowed.hands, actions: m.hands.unfollowed.actionMs.length, short: m.hands.unfollowed.short, durationMs: m.hands.unfollowed.durationMs },
      followed: { hands: m.hands.followed.hands, actions: m.hands.followed.actionMs.length, short: m.hands.followed.short, durationMs: m.hands.followed.durationMs, roomPushesToOneAdmin: m.hands.followed.roomPushes },
    },
    missed: { unfollowedCounts: m.unfollowed.countsMissed, followedCounts: m.followed.countsMissed, followedRoom: m.followed.roomMissed },
    events: { perSocket: stats(events), duplicates },
    privateFrames,
    lostSockets,
    errors: m.errors,
  };
  const file = resolve(root, `tests/.state/monitor-load-report-${cfg.tables}x${cfg.admins}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[load] monitor report: ${file}\n${JSON.stringify(report, null, 2)}`);

  expect(m.errors).toEqual([]);
  expect(report.missed).toEqual({ unfollowedCounts: 0, followedCounts: 0, followedRoom: 0 });
  expect(m.rooms.cold.unavailable + m.rooms.warm.unavailable).toBe(0);
  expect(duplicates).toBe(0);
  expect(privateFrames).toBe(0);
  expect(lostSockets).toBe(0);
});
