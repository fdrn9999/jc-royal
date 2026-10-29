/**
 * Operations counters for the admin dashboard: events counted where they happen (the table room, the API worker),
 * summed per minute in `ops_metrics`. Only events that should be rare are counted, so a healthy service writes nothing
 * here; the table room adds its counts to the D1 batch it already sends with its live occupancy.
 *
 * - `ws_retry`: a table connection accepted that the client opened again after losing the previous one.
 * - `ws_drop`: a table connection that ended abnormally as the room saw it (close 1006, or a socket error).
 * - `room_error`: a table room operation that failed unexpectedly (D1 unreachable, a cash-out left for the retry...).
 * - `api_error`: an API request that ended in a server error (5xx).
 * - `cashout_fail`: a table room's attempt to pay a seat's chips back to the wallet that failed (the room retries; each
 *   failed attempt counts, so one stuck cash-out keeps counting until it goes through). Also counted as `room_error`.
 * - `autobuy_stop`: a seat's automatic rebuy or top-up that turned itself off, nothing taken (the wallet was short, or
 *   the charge would pass the player's limit or the table's range). A failed D1 call is a `room_error` instead.
 * - `autobuy_dup`: an automatic rebuy or top-up whose ledger key was already committed, so nothing was taken again.
 * - `autobuy_invalid`: a policy request (or a buy-in carrying one) the room refused as out of range.
 * - `action_dup`: a player's action sent again after it had already counted (its answer was lost on the way): only the
 *   answer is repeated. Many of them point at connections that drop answers.
 * - `recover_fail`: a table room waking up that could not finish the seats a restart left half way (it retries). Also
 *   counted as `room_error`.
 * - `web_error`: an error a signed-in member's page reported (a script error, a part of the page that did not load).
 *   Only the count is kept, at most a few per page.
 * - `rt_undelivered`: an event for the realtime hubs (members' pages, docs/REALTIME.md) or the control center's hub that
 *   a hub did not take (unreachable, or it refused): one per hub missed. Those pages lose the event and catch up on their
 *   next read or reconnect; what the write it reported did is unaffected. Only the publishers count it: a hub's own
 *   troubles (a session check that failed, a socket refused) are in the worker log only.
 * - `rt_revoke_fail`: a sign-out's closing of its live sockets (a member's, or a console sign-in's) that no hub took
 *   after the second try. Those sockets stay open until the hub's sweep finds the sign-in gone.
 */
export const OPS_METRICS = [
  'ws_retry',
  'ws_drop',
  'room_error',
  'api_error',
  'cashout_fail',
  'autobuy_stop',
  'autobuy_dup',
  'autobuy_invalid',
  'action_dup',
  'recover_fail',
  'web_error',
  'rt_undelivered',
  'rt_revoke_fail',
] as const;
export type OpsMetric = (typeof OPS_METRICS)[number];

export const OPS_BUCKET_MS = 60_000;
/** How long the counters are kept (the daily housekeeping deletes older minutes). */
export const OPS_RETENTION_MS = 14 * 24 * 60 * 60_000;

export const opsBucket = (at: number) => Math.floor(at / OPS_BUCKET_MS) * OPS_BUCKET_MS;

export interface OpsCount {
  bucket: number;
  metric: OpsMetric;
  n: number;
}

/** One statement per count: adds `n` to the minute's row (counts from several rooms and requests add up). */
export function opsUpserts(d1: D1Database, counts: OpsCount[]): D1PreparedStatement[] {
  return counts
    .filter((x) => x.n > 0)
    .map((x) =>
      d1
        .prepare(`INSERT INTO ops_metrics (bucket, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (bucket, metric) DO UPDATE SET n = n + excluded.n`)
        .bind(x.bucket, x.metric, x.n),
    );
}

/**
 * Adds `n` to a counter now, outside a table room (which carries its counts in its own writes). Never throws: a count
 * that cannot be written is only logged.
 */
export async function writeOps(d1: D1Database, metric: OpsMetric, n = 1, at = Date.now()): Promise<void> {
  try {
    await d1.batch(opsUpserts(d1, [{ bucket: opsBucket(at), metric, n }]));
  } catch (e) {
    console.error('ops counter', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Counts kept in memory until the next write that carries them; a failed write puts them back. While D1 stays
 * unreachable it keeps the latest MAX_PENDING minute rows and drops older ones, so one write never grows unbounded.
 */
export class OpsCounter {
  static readonly MAX_PENDING = 120;
  private pending = new Map<string, OpsCount>();

  add(metric: OpsMetric, n = 1, at = Date.now()) {
    const bucket = opsBucket(at);
    const k = `${bucket}:${metric}`;
    const cur = this.pending.get(k);
    if (cur) cur.n += n;
    else {
      this.pending.set(k, { bucket, metric, n });
      if (this.pending.size > OpsCounter.MAX_PENDING) {
        const oldest = [...this.pending.entries()].sort((a, b) => a[1].bucket - b[1].bucket)[0]!;
        this.pending.delete(oldest[0]);
      }
    }
  }

  get size() {
    return this.pending.size;
  }

  /** Empties the counter; pass the result back to `restore` if its write failed. */
  take(): OpsCount[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }

  restore(counts: OpsCount[]) {
    for (const x of counts) this.add(x.metric, x.n, x.bucket);
  }
}
