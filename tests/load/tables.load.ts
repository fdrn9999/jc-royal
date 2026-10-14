/**
 * Local load scenario: several tables played at once over WebSocket, with spectators and a lobby poller,
 * against one local `wrangler dev` (workerd) process.
 *
 * What it measures: action round-trip and fan-out latency, messages per hand, D1 rows added per hand,
 * and whether chips are conserved afterwards. What it does not show: Cloudflare edge behaviour, isolate
 * placement, network latency, or billing. See docs/LOAD_TEST.md before quoting any number.
 */
import type { LegalOption, ServerMessage } from '@jc/types';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { Client, newUser, sharedAdmin } from '../support/client';
import { root } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';
import { loadConfig } from './config';

const cfg = loadConfig();
const BUY_IN = 1_000;
const START_BALANCE = 10_000;

const sockets: TableSocket[] = [];
afterAll(() => {
  for (const s of sockets) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the local D1 directly (like an operator console); asynchronous so the HTTP keep-alive stays healthy. */
async function d1<T = Record<string, number>>(sql: string): Promise<T[]> {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const { stdout } = await promisify(execFile)(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', process.env.LOAD_STATE!, '-c', 'apps/api/wrangler.jsonc', '--json', '--command', sql], { cwd: root, encoding: 'utf8' });
  return (JSON.parse(stdout.slice(stdout.indexOf('['))) as { results: T[] }[]).flatMap((x) => x.results);
}

const COUNTED = ['hands', 'hand_players', 'chip_ledger', 'table_sessions', 'rate_limits', 'sessions', 'admin_audit_log', 'reconciliation_events'] as const;
const rowCounts = async () => (await d1(`SELECT ${COUNTED.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ')}`))[0]!;

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

/** Arrival time of every state message on one socket, for fan-out latency. */
interface Arrivals {
  log: { at: number; handId: string | null; seq: number }[];
  cursor: number;
}
function track(s: TableSocket): Arrivals {
  const a: Arrivals = { log: [], cursor: 0 };
  s.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as ServerMessage;
    if (m.t === 'state') a.log.push({ at: performance.now(), handId: m.state.hand?.id ?? null, seq: m.state.hand?.seq ?? -1 });
  });
  return a;
}
/** When this socket first saw the result of the action (handId, seq) sent at t0. */
function seenAt(a: Arrivals, t0: number, handId: string, seq: number): number | null {
  for (let i = a.cursor; i < a.log.length; i++) {
    const e = a.log[i]!;
    if (e.at < t0) {
      a.cursor = i + 1;
      continue;
    }
    if (e.handId !== handId || e.seq > seq) return e.at;
  }
  return null;
}

type User = Awaited<ReturnType<typeof newUser>>;
interface Seat {
  user: User;
  ws: TableSocket;
}

const m = {
  signupMs: [] as number[],
  connectMs: [] as number[],
  sitMs: [] as number[],
  actionMs: [] as number[],
  fanoutMs: [] as number[],
  leaveMs: [] as number[],
  lobbyMs: [] as number[],
  lobbyFailures: 0,
  sent: 0,
  actions: 0,
  raises: 0,
  missedFanout: 0,
  errors: [] as string[],
  /** Tables that ran out of funded players before the requested hands. */
  shortTables: [] as { tableId: string; hands: number }[],
};

async function playTable(tableId: string, players: Seat[], watchers: TableSocket[]) {
  const everyone = [...players.map((p) => p.ws), ...watchers];
  const arrivals = everyone.map(track);

  // Hands finished as seen by the first player: a hand is done once it settles or the next one replaces it.
  const done = new Set<string>();
  let current: string | null = null;
  players[0]!.ws.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    if (msg.t !== 'state') return;
    const h = msg.state.hand;
    if (current && (!h || h.id !== current)) done.add(current);
    if (h?.stage === 'settled') done.add(h.id);
    current = h?.id ?? null;
  });

  for (const [i, p] of players.entries()) {
    const t0 = performance.now();
    const r = await p.ws.request({ t: 'sit', seatIndex: i, buyIn: BUY_IN });
    m.sitMs.push(performance.now() - t0);
    m.sent++;
    if (r.t !== 'ack') m.errors.push(`${tableId} sit: ${JSON.stringify(r)}`);
  }

  const act = async (p: Seat) => {
    const legal = p.ws.state!.you.legal;
    const raise = legal.find((o): o is Extract<LegalOption, { type: 'bet' | 'raise' }> => o.type === 'bet' || o.type === 'raise');
    let type: string;
    let amount: number | undefined;
    if (raise && Math.random() < cfg.raiseChance) {
      type = raise.type;
      amount = raise.min;
      m.raises++;
    } else if (legal.some((o) => o.type === 'check')) type = 'check';
    else if (legal.some((o) => o.type === 'call')) type = 'call';
    else type = legal.some((o) => o.type === 'allin') ? 'allin' : 'fold';
    const t0 = performance.now();
    const { result, seq, handId } = await p.ws.act(type, amount);
    m.actionMs.push(performance.now() - t0);
    m.sent++;
    m.actions++;
    if (result.t === 'error') {
      m.errors.push(`${tableId} ${type}: ${JSON.stringify(result)}`);
      return;
    }
    // Fan-out: the slowest socket at the table (players and spectators) to see the new state.
    let last = 0;
    for (const a of arrivals) {
      let at = seenAt(a, t0, handId, seq);
      for (let w = 0; at === null && w < 100; w++) {
        await sleep(10);
        at = seenAt(a, t0, handId, seq);
      }
      if (at === null) m.missedFanout++;
      else last = Math.max(last, at - t0);
    }
    m.fanoutMs.push(last);
  };

  const deadline = Date.now() + 10 * 60_000;
  let leaving = false;
  // Busted players are stood up; with fewer than two funded players left no new hand can start.
  let shortSince: number | null = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${tableId}: timed out after ${done.size} hands`);
    const view = players[0]!.ws.state;
    const funded = view ? view.seats.filter((x) => x.userId && x.stack > 0 && x.state !== 'sittingOut').length : 2;
    shortSince = view && view.status !== 'playing' && funded < 2 ? (shortSince ?? Date.now()) : null;
    if (!leaving && shortSince !== null && Date.now() - shortSince > 6_000) {
      // Stop early and say so in the report; the last funded player stands up.
      m.shortTables.push({ tableId, hands: done.size });
      leaving = true;
      for (const p of players.filter((x) => x.ws.state?.you.seatIndex !== null)) {
        const r = await p.ws.request({ t: 'leave' });
        m.sent++;
        if (r.t !== 'ack') m.errors.push(`${tableId} leave: ${JSON.stringify(r)}`);
      }
    }
    if (!leaving && done.size >= cfg.hands) {
      leaving = true;
      // Everyone stands up together; anyone caught in a new hand leaves when it ends.
      await Promise.all(
        players.map(async (p) => {
          const t0 = performance.now();
          const r = await p.ws.request({ t: 'leave' });
          m.leaveMs.push(performance.now() - t0);
          m.sent++;
          if (r.t !== 'ack') m.errors.push(`${tableId} leave: ${JSON.stringify(r)}`);
        }),
      );
    }
    if (leaving && players.every((p) => p.ws.state?.you.seatIndex === null)) break;
    const actor = players.find((p) => p.ws.state && isMyTurn(p.ws.state));
    if (actor) await act(actor);
    else await sleep(15);
  }
  return done.size;
}

it(`${cfg.tables} tables × ${cfg.players} players + ${cfg.spectators} spectators, ${cfg.hands} hands each`, async () => {
  const startedAt = performance.now();
  const admin = sharedAdmin();
  const perTable = cfg.players + cfg.spectators;

  // 1. Accounts (PBKDF2 is lowered to 1,000 iterations locally, so this is not the production sign-up cost).
  const users = await pool(cfg.tables * perTable, 8, async () => {
    const t0 = performance.now();
    const u = await newUser();
    m.signupMs.push(performance.now() - t0);
    return u;
  });
  const before = await rowCounts();

  // 2. Lobby polling the whole time, like open lobby tabs (one request per second).
  let polling = true;
  const lobby = new Client();
  lobby.cookies = users[0]!.client.cookies;
  const poller = (async () => {
    while (polling) {
      const t0 = performance.now();
      try {
        const r = await lobby.get('/api/tables');
        if (r.status === 200) m.lobbyMs.push(performance.now() - t0);
        else m.lobbyFailures++;
      } catch {
        m.lobbyFailures++;
      }
      await sleep(1_000);
    }
  })();

  // 3. Connect everyone (players and spectators), all tables at once.
  const connectStart = performance.now();
  const tables = await Promise.all(
    Array.from({ length: cfg.tables }, async (_, t) => {
      const id = `load-${t}`;
      const mine = users.slice(t * perTable, (t + 1) * perTable);
      const open = async (u: User) => {
        const t0 = performance.now();
        const ws = await TableSocket.open(u.client, id);
        m.connectMs.push(performance.now() - t0);
        sockets.push(ws);
        return ws;
      };
      const players: Seat[] = [];
      for (const u of mine.slice(0, cfg.players)) players.push({ user: u, ws: await open(u) });
      const watchers = await Promise.all(mine.slice(cfg.players).map(open));
      return { id, players, watchers };
    }),
  );
  const connectedIn = performance.now() - connectStart;

  // 4. Play.
  const playStart = performance.now();
  const handsSeen = await Promise.all(tables.map((t) => playTable(t.id, t.players, t.watchers)));
  const playMs = performance.now() - playStart;
  polling = false;
  await poller;

  // 5. Correctness after the load: nothing lost, nothing left open.
  const all = tables.flatMap((t) => [...t.players.map((p) => p.ws), ...t.watchers]);
  const unexpectedCloses = all.filter((s) => s.closed).map((s) => s.closed);
  const serverErrors = all.flatMap((s) => s.messages.filter((x) => x.t === 'error'));
  const balances = await pool(users.length, 8, async (i) => (await users[i]!.client.get('/api/auth/me')).body.balance as number);
  const playerIdx = new Set(tables.flatMap((_, t) => Array.from({ length: cfg.players }, (_, k) => t * perTable + k)));
  const playerSum = balances.filter((_, i) => playerIdx.has(i)).reduce((a, b) => a + b, 0);
  const spectatorBalances = balances.filter((_, i) => !playerIdx.has(i));
  const reconcile = await admin.post('/api/admin/reconcile/run');
  const after = await rowCounts();
  const perTableHands = await d1<{ table_id: string; n: number }>(`SELECT table_id, COUNT(*) AS n FROM hands GROUP BY table_id`);
  const hands = after.hands! - before.hands!;
  const delta = Object.fromEntries(COUNTED.map((k) => [k, after[k]! - before[k]!]));

  const received = all.map((s) => s.messages.length);
  const receivedBytes = all.reduce((sum, s) => sum + s.messages.reduce((b, x) => b + JSON.stringify(x).length, 0), 0);
  const report = {
    environment: 'local wrangler dev (workerd) on the developer machine, one process for every table; not the Cloudflare edge',
    when: new Date().toISOString(),
    config: cfg,
    sockets: all.length,
    durationMs: { total: Math.round(performance.now() - startedAt), connectAll: Math.round(connectedIn), play: Math.round(playMs) },
    hands: {
      recordedInD1: hands,
      perTableInD1: perTableHands.map((r) => r.n),
      seenByClients: handsSeen,
      perSecond: +(hands / (playMs / 1000)).toFixed(2),
      stoppedEarly: m.shortTables,
    },
    actions: { total: m.actions, raises: m.raises, perHand: +(m.actions / hands).toFixed(1) },
    latencyMs: {
      signup: stats(m.signupMs),
      wsConnect: stats(m.connectMs),
      sit: stats(m.sitMs),
      actionRoundTrip: stats(m.actionMs),
      fanoutSlowestSocket: stats(m.fanoutMs),
      leave: stats(m.leaveMs),
      lobbyList: stats(m.lobbyMs),
    },
    messages: {
      clientToServer: m.sent,
      serverToClient: received.reduce((a, b) => a + b, 0),
      serverToClientPerHand: Math.round(received.reduce((a, b) => a + b, 0) / hands),
      serverToClientBytes: receivedBytes,
      missedFanout: m.missedFanout,
    },
    d1RowsAdded: delta,
    d1RowsAddedPerHand: { hands: +(delta.hands! / hands).toFixed(2), hand_players: +(delta.hand_players! / hands).toFixed(2) },
    problems: {
      clientErrors: m.errors,
      serverErrorMessages: serverErrors.length,
      unexpectedCloses: unexpectedCloses.length,
      lobbyFailures: m.lobbyFailures,
    },
    conservation: {
      playerWallets: playerSum,
      expected: cfg.tables * cfg.players * START_BALANCE,
      spectatorsUntouched: spectatorBalances.every((b) => b === START_BALANCE),
      reconcileMismatches: reconcile.body.mismatches?.length,
      openTableSessions: reconcile.body.tables?.length,
    },
  };
  writeFileSync(resolve(root, 'tests/.state/load-report.json'), JSON.stringify(report, null, 2));
  console.log(`[load] report (tests/.state/load-report.json)\n${JSON.stringify(report, null, 2)}`);

  expect(m.errors).toEqual([]);
  expect(serverErrors).toEqual([]);
  expect(unexpectedCloses).toEqual([]);
  expect(m.missedFanout).toBe(0);
  expect(m.lobbyFailures).toBe(0);
  expect(reconcile.status).toBe(200);
  expect(report.conservation.reconcileMismatches).toBe(0);
  expect(report.conservation.openTableSessions).toBe(0);
  expect(playerSum).toBe(report.conservation.expected);
  expect(report.conservation.spectatorsUntouched).toBe(true);
  // Every table played the requested hands (unless it ran out of funded players, reported above);
  // each recorded hand has players and is zero-sum.
  expect(perTableHands).toHaveLength(cfg.tables);
  const short = new Set(m.shortTables.map((x) => x.tableId));
  for (const r of perTableHands) if (!short.has(r.table_id)) expect(r.n).toBeGreaterThanOrEqual(cfg.hands);
  expect(short.size, 'every table stopped early').toBeLessThan(cfg.tables);
  expect(await d1(`SELECT h.id FROM hands h LEFT JOIN hand_players p ON p.hand_id = h.id GROUP BY h.id HAVING COUNT(p.user_id) < 2 OR SUM(p.net) != 0`)).toEqual([]);
  // Each seat session is one buy-in plus one cash-out (none for a stack of 0), and no more.
  const [s] = await d1<{ sessions: number; paid: number }>(`SELECT COUNT(*) AS sessions, SUM(cash_out > 0) AS paid FROM table_sessions WHERE status = 'closed'`);
  expect(s!.sessions).toBe(cfg.tables * cfg.players);
  expect(delta.chip_ledger).toBe(s!.sessions + s!.paid);
});
