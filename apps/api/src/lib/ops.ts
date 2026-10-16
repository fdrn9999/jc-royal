import { OPS_BUCKET_MS, OPS_METRICS, opsBucket, opsUpserts, type OpsMetric } from '@jc/db';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { SWEEP_CLOSING_AFTER_MS } from './room';

/**
 * Adds one to an operations counter (packages/db/src/ops.ts) after the response, without delaying or failing it. When
 * the failure being counted is D1 itself, this write fails too and the event is only in the worker log.
 */
export function countOps(c: Context<AppEnv>, metric: OpsMetric) {
  const failed = (e: unknown) => console.error('ops counter', e instanceof Error ? e.message : String(e));
  let write: Promise<void>;
  try {
    const db = c.env.DB;
    write = db.batch(opsUpserts(db, [{ bucket: opsBucket(Date.now()), metric, n: 1 }])).then(() => undefined, failed);
  } catch (e) {
    // Called from the error handler: counting must never turn into a second error.
    failed(e);
    return;
  }
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    /* no execution context: the write still runs */
  }
}

/** A member counts as online when they made an API request within this window (sessions.last_seen_at). */
export const ONLINE_WINDOW_MS = 5 * 60_000;
const SLOT_MS = 5 * OPS_BUCKET_MS;
const SLOTS = 12;

type Counts = Record<OpsMetric, number>;
const zero = (): Counts => Object.fromEntries(OPS_METRICS.map((m) => [m, 0])) as Counts;
const isMetric = (m: string): m is OpsMetric => (OPS_METRICS as readonly string[]).includes(m);

interface TypeRow {
  type: 'official' | 'member';
  tables: number;
  closing: number;
  blocked: number;
  occupied: number;
  playing: number;
  /** Members seated; table bots are counted apart. */
  seated: number;
  bots: number;
  waitlist: number;
  spectators: number;
  connections: number;
}

/**
 * The admin dashboard's live figures, read in one D1 batch. Occupancy, hands in play and connections are what each
 * table room last wrote to its `tables` row (the room writes when they change); online members come from session
 * activity; error and connection counts from `ops_metrics`. Nothing is estimated: a figure the server does not have is
 * not returned. Every query reads through an index or a small table except the online count, which reads every
 * session row (an index on last_seen_at would cost a write each time a session is touched); `rowsRead` reports what
 * this call cost. Tables being closed are listed first among the busy tables, so a close can be watched to the end.
 */
export async function liveOps(db: D1Database, now = Date.now()) {
  const cur = opsBucket(now);
  const from = cur - (SLOTS * SLOT_MS - OPS_BUCKET_MS);
  const results = await db.batch([
    db.prepare(
      `SELECT room_type AS type, COUNT(*) AS tables,
         SUM(CASE WHEN status = 'closing' THEN 1 ELSE 0 END) AS closing,
         SUM(CASE WHEN entry_blocked = 1 THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN live_seated > 0 THEN 1 ELSE 0 END) AS occupied,
         SUM(live_playing) AS playing, SUM(live_seated - live_bots) AS seated, SUM(live_bots) AS bots, SUM(live_waitlist) AS waitlist,
         SUM(live_spectators) AS spectators, SUM(live_connections) AS connections
       FROM tables WHERE status IN ('open', 'closing') GROUP BY room_type`,
    ),
    db.prepare(
      `SELECT id, name, room_type AS type, status, entry_blocked AS entryBlocked, max_seats AS maxSeats, live_seated - live_bots AS seated,
         live_bots AS bots, live_playing AS playing, live_waitlist AS waitlist, live_spectators AS spectators, live_connections AS connections,
         live_updated_at AS liveUpdatedAt, last_issue AS lastIssue
       FROM tables WHERE status IN ('open', 'closing') AND (live_connections > 0 OR live_seated > 0 OR status = 'closing')
       ORDER BY status = 'closing' DESC, live_connections DESC, live_seated DESC LIMIT 12`,
    ),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE kind = 'user' AND last_seen_at > ?1`).bind(now - ONLINE_WINDOW_MS),
    db.prepare(`SELECT bucket, metric, n FROM ops_metrics WHERE bucket >= ?1`).bind(from),
    db.prepare(`SELECT reason, COUNT(*) AS n, MIN(created_at) AS oldest FROM reports WHERE status = 'open' GROUP BY reason`),
    db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM reconciliation_events WHERE resolved_at IS NULL`),
    db.prepare(`SELECT id, name, updated_at AS since FROM tables WHERE status = 'closing' AND updated_at < ?1 ORDER BY updated_at LIMIT 10`).bind(
      now - SWEEP_CLOSING_AFTER_MS,
    ),
    // CROSS JOIN keeps SQLite starting from the seated rows (a partial index, as many as people at tables) rather than
    // from every closed table, which only grows.
    db.prepare(
      `SELECT ts.table_id AS id, t.name AS name, COUNT(*) AS n FROM table_sessions ts CROSS JOIN tables t ON t.id = ts.table_id
       WHERE ts.status = 'seated' AND t.status = 'closed' GROUP BY ts.table_id LIMIT 10`,
    ),
  ]);
  const [types, top, online, ops, reports, recon, stuck, orphaned] = results;
  const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[];

  const byType = { official: emptyType('official'), member: emptyType('member') };
  for (const r of rows<TypeRow>(types)) byType[r.type] = { ...emptyType(r.type), ...nonNull(r) };

  const trend = Array.from({ length: SLOTS }, (_, i) => ({ at: from + i * SLOT_MS, ...zero() }));
  for (const r of rows<{ bucket: number; metric: string; n: number }>(ops)) {
    const i = Math.floor((r.bucket - from) / SLOT_MS);
    if (isMetric(r.metric) && i >= 0 && i < SLOTS) trend[i]![r.metric] += r.n;
  }
  const lastHour = zero();
  for (const s of trend) for (const m of OPS_METRICS) lastHour[m] += s[m];

  const reportRows = rows<{ reason: string; n: number; oldest: number }>(reports);
  const reconRow = rows<{ n: number; oldest: number | null }>(recon)[0];
  return {
    tables: byType,
    top: rows<Record<string, unknown>>(top).map((t) => ({ ...t, playing: Boolean(t.playing), entryBlocked: Boolean(t.entryBlocked) })),
    onlineUsers: rows<{ n: number }>(online)[0]?.n ?? 0,
    ops: { slotMs: SLOT_MS, trend, last5m: trend[SLOTS - 1]!, lastHour },
    reports: {
      open: reportRows.reduce((s, r) => s + r.n, 0),
      oldest: reportRows.length ? Math.min(...reportRows.map((r) => r.oldest)) : null,
      byReason: Object.fromEntries(reportRows.map((r) => [r.reason, r.n])),
    },
    warnings: {
      reconciliation: { open: reconRow?.n ?? 0, oldest: reconRow?.oldest ?? null },
      stuckClosing: rows<{ id: string; name: string; since: number }>(stuck),
      seatedOnClosed: rows<{ id: string; name: string; n: number }>(orphaned),
    },
    rowsRead: results.reduce((s, r) => s + (r.meta.rows_read ?? 0), 0),
  };
}

function emptyType(type: TypeRow['type']): TypeRow {
  return { type, tables: 0, closing: 0, blocked: 0, occupied: 0, playing: 0, seated: 0, bots: 0, waitlist: 0, spectators: 0, connections: 0 };
}

/** SUM over no rows is NULL. */
function nonNull<T extends object>(r: T): T {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? 0])) as T;
}
