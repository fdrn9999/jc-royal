import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, sharedAdmin, uniq, WEB_ORIGIN } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

/** The admin dashboard's live figures (GET /api/admin/ops/live) and the counters behind them (ops_metrics). */

type Counts = { ws_retry: number; ws_drop: number; room_error: number; api_error: number; action_dup: number; recover_fail: number; web_error: number };
interface Live {
  tables: Record<'official' | 'member', { tables: number; connections: number; seated: number; occupied: number; playing: number }>;
  top: { id: string; status: string; connections: number; seated: number; lastIssue: string | null; liveUpdatedAt: number | null }[];
  onlineUsers: number;
  ops: { slotMs: number; trend: (Counts & { at: number })[]; last5m: Counts; lastHour: Counts };
  reports: { open: number; oldest: number | null; byReason: Record<string, number> };
  warnings: { reconciliation: { open: number; oldest: number | null }; stuckClosing: { id: string }[]; seatedOnClosed: { id: string; n: number }[] };
  rowsRead: number;
  server: { d1LatencyMs: number; at: number };
}

const admin = sharedAdmin();
const sockets: TableSocket[] = [];
const cleanup: string[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (cleanup.length) await d1(cleanup.join('; '));
});

async function live(): Promise<Live> {
  const r = await admin.get('/api/admin/ops/live');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Live;
}

/** Polls until `ok` holds: the rooms write their counters with their next stats write (within 10 s when idle). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(v).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Sum of a counter since `from` straight from D1, to check what the endpoint shows. */
async function counted(metric: keyof Counts, from: number) {
  const [row] = await d1<{ n: number | null }>(`SELECT SUM(n) AS n FROM ops_metrics WHERE metric = '${metric}' AND bucket >= ${from}`);
  return row?.n ?? 0;
}
const minute = (at: number) => Math.floor(at / 60_000) * 60_000;

/**
 * Opens a table socket over a raw TCP connection and cuts the connection without a close frame, as a lost network
 * does. Resolves once the server has answered the upgrade and the room has sent its first frame.
 */
async function cutConnection(client: Client, tableId: string) {
  const base = new URL(BASE());
  const sock = connect(Number(base.port), base.hostname);
  await once(sock, 'connect');
  const answered = new Promise<string>((resolve, reject) => {
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      // Headers, then at least the first WebSocket frame (the room's state).
      if (end >= 0 && buf.length > end + 4) resolve(buf.slice(0, buf.indexOf('\r\n')));
    });
    sock.on('error', reject);
  });
  sock.write(
    [
      `GET /ws/tables/${tableId} HTTP/1.1`,
      `Host: ${base.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      `Origin: ${WEB_ORIGIN}`,
      `Cookie: ${client.cookieHeader()}`,
      '',
      '',
    ].join('\r\n'),
  );
  expect(await answered).toMatch(/^HTTP\/1\.1 101/);
  sock.destroy();
}

describe('admin live dashboard', () => {
  it('is admin-only and reports live figures from the rooms and sessions in one bounded read', async () => {
    const u = await newUser();
    const viaPlayer = new Client('http://localhost:5174');
    viaPlayer.cookies = u.client.cookies;
    expect((await viaPlayer.get('/api/admin/ops/live')).status).toBe(401);
    const fromWeb = new Client(WEB_ORIGIN);
    fromWeb.cookies = admin.cookies;
    expect((await fromWeb.get('/api/admin/ops/live')).status).toBe(403);

    const ws = await TableSocket.open(u.client, 'it-ops-0');
    sockets.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const d = await eventually(live, (x) => x.top.some((t) => t.id === 'it-ops-0' && t.connections >= 1 && t.seated === 1), 'it-ops-0 in the busy tables');
    // The member just made requests, so they count as online.
    expect(d.onlineUsers).toBeGreaterThanOrEqual(1);
    expect(d.tables.official.tables).toBeGreaterThan(10);
    expect(d.tables.official.connections).toBeGreaterThanOrEqual(1);
    expect(d.tables.official.occupied).toBeGreaterThanOrEqual(1);
    expect(d.top.length).toBeLessThanOrEqual(12);
    expect(d.top.find((t) => t.id === 'it-ops-0')!.liveUpdatedAt).toBeGreaterThan(Date.now() - 60_000);
    // One hour in twelve 5-minute slots, the last ending with the current minute.
    expect(d.ops.slotMs).toBe(300_000);
    expect(d.ops.trend).toHaveLength(12);
    expect(d.ops.trend[11]!.at).toBe(minute(d.server.at) - 4 * 60_000);
    expect(d.ops.last5m).toEqual(d.ops.trend[11]);
    expect(d.rowsRead).toBeGreaterThan(0);
    console.log(`ops/live rowsRead=${d.rowsRead} d1LatencyMs=${d.server.d1LatencyMs}`);
  });

  it('counts reconnects (?r=1) but not first connections', async () => {
    const from = minute(Date.now());
    const before = (await live()).ops.lastHour.ws_retry;
    const u = await newUser();
    const first = await TableSocket.open(u.client, 'it-ops-0');
    sockets.push(first);
    first.close();
    const again = await TableSocket.open(u.client, 'it-ops-0', { query: '?r=1' });
    sockets.push(again);
    const d = await eventually(live, (x) => x.ops.lastHour.ws_retry >= before + 1, 'ws_retry +1');
    expect(d.ops.lastHour.ws_retry).toBe(before + 1);
    expect(await counted('ws_retry', from)).toBe(1);
  });

  it('counts a connection that ended without a close frame, and not one that closed normally', async () => {
    const from = minute(Date.now());
    const before = (await live()).ops.lastHour.ws_drop;
    const u = await newUser();
    const clean = await TableSocket.open(u.client, 'it-ops-0');
    clean.close();
    await clean.waitClose();
    await cutConnection(u.client, 'it-ops-0');
    const d = await eventually(live, (x) => x.ops.lastHour.ws_drop >= before + 1, 'ws_drop +1');
    expect(d.ops.lastHour.ws_drop).toBe(before + 1);
    expect(await counted('ws_drop', from)).toBe(1);
  });

  it('counts a failed room operation and shows it as the table issue once D1 is back', async () => {
    const from = minute(Date.now());
    const u = await newUser();
    const ws = await TableSocket.open(u.client, 'it-ops-1');
    sockets.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await ws.waitState((s) => s.you.seatIndex === 0);
    const release = holdD1WriteLock();
    try {
      // The top-up's D1 batch fails: the room answers internal, counts it, and keeps it as the table's latest problem.
      expect(await ws.request({ t: 'topUp', amount: 200 })).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      release();
    }
    // Nothing else happens at the table: the room's flush timer writes the count and the issue.
    const d = await eventually(live, (x) => !!x.top.find((t) => t.id === 'it-ops-1')?.lastIssue?.includes('command failed'), 'it-ops-1 issue');
    expect(await counted('room_error', from)).toBeGreaterThanOrEqual(1);
    expect(d.ops.lastHour.room_error).toBeGreaterThanOrEqual(1);
    expect(d.top.find((t) => t.id === 'it-ops-1')!.lastIssue).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z command failed: D1_ERROR/);
  });

  it('counts an action sent again after it was applied: only the answer is repeated, the hand does not move twice', async () => {
    const from = minute(Date.now());
    const before = (await live()).ops.lastHour.action_dup;
    // (Other files send an action again too, multiplayer's in the same minute as this one at times.)
    const minuteBefore = await counted('action_dup', from);
    const [x, y] = await Promise.all([newUser(), newUser()]);
    const a = await TableSocket.open(x.client, 'it-ops-2');
    const b = await TableSocket.open(y.client, 'it-ops-2');
    sockets.push(a, b);
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await Promise.all([a, b].map((w) => w.waitState((s) => !!s.hand && s.hand.stage === 'preflop', 20_000, 'a hand')));
    const me = [a, b].find((w) => isMyTurn(w.state!))!;
    // Heads-up, preflop: the small blind calls, and the hand goes on to the big blind.
    const type = me.state!.you.legal.some((l) => l.type === 'check') ? 'check' : 'call';
    const { result, intentId, seq, handId } = await me.act(type);
    expect(result).toMatchObject({ t: 'state' });
    const moved = me.state!.hand!.seq;
    const again = me.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === intentId, 15_000, 'ack again');
    me.send({ t: 'action', intentId, handId, seq, type });
    expect(await again).toMatchObject({ t: 'ack' });
    expect(me.state!.hand!.seq).toBe(moved);
    const d = await eventually(live, (v) => v.ops.lastHour.action_dup >= before + 1, 'action_dup +1');
    expect(d.ops.lastHour.action_dup).toBe(before + 1);
    expect(await counted('action_dup', from)).toBe(minuteBefore + 1);
  });

  it('counts errors a member page reports, nothing about them, and only from signed-in members', async () => {
    const from = minute(Date.now());
    const before = (await live()).ops.lastHour.web_error;
    expect((await new Client(WEB_ORIGIN).post('/api/me/web-error', {})).status).toBe(401);
    const u = await newUser();
    expect((await u.client.post('/api/me/web-error', {})).status).toBe(204);
    const d = await eventually(live, (v) => v.ops.lastHour.web_error >= before + 1, 'web_error +1');
    expect(d.ops.lastHour.web_error).toBe(before + 1);
    expect(await counted('web_error', from)).toBe(1);
    // A page in a loop of errors is cut off well before it costs anything.
    for (let i = 1; i < 10; i++) expect((await u.client.post('/api/me/web-error', {})).status).toBe(204);
    expect((await u.client.post('/api/me/web-error', {})).status).toBe(429);
  });

  it('warns about open mismatches, unfinished closes and seats left on closed tables, and lists open reports', async () => {
    const now = Date.now();
    const tag = uniq('ops');
    const u = await newUser();
    const author = await newUser();
    const before = await live();
    await d1(
      [
        `INSERT INTO reconciliation_events (id, scope, subject_id, expected, actual, created_at) VALUES ('${tag}-rec', 'table', 'nowhere', 100, 90, ${now - 3_600_000})`,
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, entry_blocked, updated_at) VALUES ('${tag}-closing', 'ops closing', 6, 5, 10, 100, 1000, 'closing', 1, ${now - 20 * 60_000})`,
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('${tag}-closed', 'ops closed', 6, 5, 10, 100, 1000, 'closed')`,
        `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${tag}-seat', '${tag}-closed', '${u.me.id}', 0, 300, 'seated')`,
        // More busy open tables than the list holds.
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, live_seated, live_connections) VALUES ${Array.from(
          { length: 13 },
          (_, i) => `('${tag}-busy-${i}', 'ops busy ${i}', 6, 5, 10, 100, 1000, 3, 50)`,
        ).join(', ')}`,
      ].join('; '),
    );
    cleanup.push(
      `DELETE FROM reconciliation_events WHERE id = '${tag}-rec'`,
      `DELETE FROM table_sessions WHERE id = '${tag}-seat'`,
      `DELETE FROM tables WHERE id IN ('${tag}-closing', '${tag}-closed') OR id LIKE '${tag}-busy-%'`,
    );
    const post = await author.client.post('/api/board/posts', { title: `ops report ${tag}`, body: 'spam body' });
    expect(post.status).toBe(201);
    expect((await u.client.post('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'spam', detail: 'ops test' })).status).toBe(201);
    cleanup.push(`UPDATE reports SET status = 'dismissed' WHERE target_id = '${post.body.id}'`);

    const d = await live();
    expect(d.warnings.reconciliation.open).toBe(before.warnings.reconciliation.open + 1);
    expect(d.warnings.reconciliation.oldest).toBeLessThanOrEqual(now - 3_600_000);
    expect(d.warnings.stuckClosing.map((t) => t.id)).toContain(`${tag}-closing`);
    expect(d.warnings.seatedOnClosed).toContainEqual(expect.objectContaining({ id: `${tag}-closed`, n: 1 }));
    expect(d.reports.open).toBe(before.reports.open + 1);
    expect(d.reports.byReason.spam).toBe((before.reports.byReason.spam ?? 0) + 1);
    // Tables being closed come first among the busy tables, ahead of the thirteen busier open ones, so the admin can
    // follow a close from there.
    const at = d.top.findIndex((t) => t.id === `${tag}-closing`);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(d.top.slice(0, at).every((t) => t.status === 'closing')).toBe(true);
  });
});
