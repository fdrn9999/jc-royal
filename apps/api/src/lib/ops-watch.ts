import { OPS_BUCKET_MS, opsBucket } from '@jc/db';
import {
  OPS_ROOM_ISSUES_LATE,
  OPS_SEVERITY_RANK,
  OPS_STALE_LONG_MS,
  roomIssueSeverity,
  type MonitorRoom,
  type OpsAlertCode,
  type OpsAlertDetail,
  type OpsEventKind,
  type OpsSeverity,
} from '@jc/types';
import type { Env } from '../env';
import { sendToAdmins } from './admin-monitor';
import { roomCallEnv, SWEEP_CLOSING_AFTER_MS } from './room';

/**
 * The control center's persistent alerts (docs/CONTROL_CENTER.md '지속 경고와 운영 기록'): every minute the api's cron
 * looks at what D1 says (seats on closed tables, closes overdue, the operations counters, the realtime outbox) and asks
 * the rooms of the tables in play for their own diagnosis, the same `monitor` read the console makes (read only: it
 * deals, seats or times out nothing). What it finds is kept in ops_alerts, one row per problem, and every change of it
 * in ops_events, so an administrator sees it after closing the console, and what was never looked at is not shown as
 * well: the check's own last run is in ops_watch.
 *
 * - A problem is open from its first sighting, or from its second in a row for a state that is usually gone within a
 *   minute (a seat being bought into, a cash-out being paid, a room that did not answer once).
 * - Seen again while open: the same alert, counted, and raised (never lowered) if it got worse.
 * - Resolved by the first check that looked and did not see it. A room that did not answer hides its problems, it does
 *   not end them: they stay open, with `table_stale`, until the room answers without them or the table is no longer in
 *   play.
 * - Nothing here acts on a table: an administrator does, from the console, with the usual permission and password.
 */

/** Rooms asked per check at most; tables with an open room alert are asked first. */
export const OPS_WATCH_ROOMS_MAX = 40;
/** How long a room may take to answer the check. */
export const OPS_PROBE_TIMEOUT_MS = 10_000;
/** The counters are summed over the last minutes up to now (the current minute included). */
export const OPS_WINDOW_MS = 5 * OPS_BUCKET_MS;
/** Realtime outbox events still pending this long after they were written are a backlog (the cron sends every minute). */
export const OUTBOX_BACKLOG_MS = 5 * 60_000;
/**
 * Thresholds in OPS_WINDOW_MS. Starting values from what a healthy service writes (nothing: these counters count only
 * what should be rare), to be tuned on what production shows.
 */
export const OPS_THRESHOLDS = {
  /** api 5xx and room failures together. */
  serverErrors: { warning: 20, error: 100 },
  /** Hub misses and outbox retries (any event given up is an error at once). */
  delivery: { warning: 10 },
  /** Table connections reopened after a loss or ended abnormally. */
  reconnects: { warning: 50 },
} as const;

/** A problem the check saw. `confirm`: a usually transient state, an alert only when the next check sees it too. */
export interface Observation {
  code: OpsAlertCode;
  severity: OpsSeverity;
  tableId: string | null;
  detail: OpsAlertDetail;
  confirm?: boolean;
}

/** One problem, wherever it was seen: its code, the room's issue for a room alert, and its table. */
export const dedupeKeyOf = (o: Pick<Observation, 'code' | 'tableId' | 'detail'>) => `${o.code}${o.detail.issue ? `:${o.detail.issue}` : ''}:${o.tableId ?? '-'}`;

/** What has to have been looked at this check for an open alert of this kind to be resolved by not being seen. */
export const scopeOf = (code: OpsAlertCode, tableId: string | null) => (code === 'room_issue' || code === 'table_stale' ? `room:${tableId}` : code === 'seated_on_closed' || code === 'close_overdue' ? 'tables' : 'metrics');

/** A short English line for the log (the console words it from the code and the detail). Numbers and codes only. */
export function summaryOf(o: Pick<Observation, 'code' | 'detail'>): string {
  const d = o.detail;
  const n = d.n !== undefined ? ` ${d.n}` : '';
  const win = d.windowMs ? ` in ${Math.round(d.windowMs / 60_000)} min` : '';
  switch (o.code) {
    case 'room_issue':
      return `room reports ${d.issue}`;
    case 'table_stale':
      return 'room did not answer the check';
    case 'seated_on_closed':
      return 'closed table still has seated rows';
    case 'close_overdue':
      return `close unfinished for ${Math.round((d.sinceMs ?? 0) / 60_000)} min`;
    case 'outbox_backlog':
      return `${d.n} realtime events pending over ${Math.round(OUTBOX_BACKLOG_MS / 60_000)} min`;
    default:
      return `${d.metric ?? o.code}${n}${win}`;
  }
}

/** What the check read: the D1 side and the rooms' answers (null: did not answer in time). */
export interface WatchInput {
  now: number;
  /** Closed tables with seated rows. */
  seatedOnClosed: string[];
  /** Closing tables and when they started closing (updated_at). */
  closing: { id: string; since: number }[];
  /** ops_metrics summed over OPS_WINDOW_MS. */
  metrics: Partial<Record<string, number>>;
  outboxBacklog: number;
  /** The rooms asked, with their answers. */
  rooms: Map<string, MonitorRoom | null>;
  /** Tables an open room alert names that are no longer in play (closed, gone, nobody playing): their room alerts end. */
  idle: string[];
}

/** The problems in what the check read. `staleSince`: when each table's open table_stale alert was confirmed. */
export function observe(input: WatchInput, staleSince: ReadonlyMap<string, number>): Observation[] {
  const out: Observation[] = [];
  const { now, metrics: m } = input;
  for (const id of input.seatedOnClosed) out.push({ code: 'seated_on_closed', severity: 'critical', tableId: id, detail: {} });
  for (const c of input.closing) {
    if (c.since < now - SWEEP_CLOSING_AFTER_MS) out.push({ code: 'close_overdue', severity: 'error', tableId: c.id, detail: { sinceMs: now - c.since } });
  }
  for (const [id, room] of input.rooms) {
    if (!room) {
      const since = staleSince.get(id);
      out.push({ code: 'table_stale', severity: since !== undefined && since <= now - OPS_STALE_LONG_MS ? 'critical' : 'error', tableId: id, detail: {}, confirm: true });
      continue;
    }
    if (room.status === 'closed') continue;
    for (const issue of new Set(room.issues)) {
      out.push({ code: 'room_issue', severity: roomIssueSeverity(issue), tableId: id, detail: { issue }, confirm: !OPS_ROOM_ISSUES_LATE.includes(issue) });
    }
  }
  const sum = (...k: string[]) => k.reduce((a, x) => a + (m[x] ?? 0), 0);
  const metric = (code: OpsAlertCode, severity: OpsSeverity, name: string, n: number, threshold: number) =>
    out.push({ code, severity, tableId: null, detail: { metric: name, n, threshold, windowMs: OPS_WINDOW_MS } });
  const T = OPS_THRESHOLDS;
  if (sum('cashout_fail') >= 1) metric('settlement_failed', 'error', 'cashout_fail', sum('cashout_fail'), 1);
  if (sum('recover_fail') >= 1) metric('recovery_failed', 'error', 'recover_fail', sum('recover_fail'), 1);
  const errors = sum('api_error', 'room_error');
  if (errors >= T.serverErrors.error) metric('server_errors', 'error', 'api_error+room_error', errors, T.serverErrors.error);
  else if (errors >= T.serverErrors.warning) metric('server_errors', 'warning', 'api_error+room_error', errors, T.serverErrors.warning);
  const missed = sum('rt_undelivered', 'rt_revoke_fail', 'rt_outbox_retry');
  if (sum('rt_outbox_failed') >= 1) metric('delivery_failed', 'error', 'rt_outbox_failed', sum('rt_outbox_failed'), 1);
  else if (missed >= T.delivery.warning) metric('delivery_failed', 'warning', 'rt_undelivered+rt_revoke_fail+rt_outbox_retry', missed, T.delivery.warning);
  const reconnects = sum('ws_retry', 'ws_drop');
  if (reconnects >= T.reconnects.warning) metric('reconnect_surge', 'warning', 'ws_retry+ws_drop', reconnects, T.reconnects.warning);
  if (input.outboxBacklog > 0) out.push({ code: 'outbox_backlog', severity: 'warning', tableId: null, detail: { n: input.outboxBacklog } });
  return out;
}

/** An unresolved ops_alerts row, as the check reads it. */
export interface OpenAlert {
  id: string;
  dedupe_key: string;
  code: OpsAlertCode;
  severity: OpsSeverity;
  table_id: string | null;
  confirmed_at: number | null;
}

/** The writes one check makes: alerts opened, counted, raised, resolved, and their log lines. */
export interface Change {
  kind: 'open' | 'sight' | 'confirm' | 'seen' | 'raise' | 'resolve' | 'drop';
  key: string;
  alertId: string;
  obs?: Observation;
  row?: OpenAlert;
}

/**
 * What to write, from what was seen and what is open. `checked`: the scopes this check looked at (scopeOf): an open
 * alert of a scope it did not look at (a room left unasked) stays as it is.
 */
export function reconcile(open: readonly OpenAlert[], seen: readonly Observation[], checked: ReadonlySet<string>, newId: () => string): Change[] {
  const byKey = new Map(open.map((r) => [r.dedupe_key, r]));
  const out: Change[] = [];
  const keys = new Set<string>();
  for (const o of seen) {
    const key = dedupeKeyOf(o);
    if (keys.has(key)) continue;
    keys.add(key);
    const r = byKey.get(key);
    if (!r) out.push({ kind: o.confirm ? 'sight' : 'open', key, alertId: newId(), obs: o });
    else if (r.confirmed_at === null) out.push({ kind: 'confirm', key, alertId: r.id, obs: o, row: r });
    else out.push({ kind: OPS_SEVERITY_RANK[o.severity] > OPS_SEVERITY_RANK[r.severity] ? 'raise' : 'seen', key, alertId: r.id, obs: o, row: r });
  }
  for (const r of open) {
    if (keys.has(r.dedupe_key) || !checked.has(scopeOf(r.code, r.table_id))) continue;
    out.push({ kind: r.confirmed_at === null ? 'drop' : 'resolve', key: r.dedupe_key, alertId: r.id, row: r });
  }
  return out;
}

const EVENT_OF: Partial<Record<Change['kind'], OpsEventKind>> = { open: 'alert_opened', confirm: 'alert_opened', raise: 'alert_raised', resolve: 'alert_resolved' };

/**
 * The statements for the changes, in one batch. Each log line is written only if its alert's write changed a row
 * (`changes()`), so a check that overlaps another (a slow one) neither opens a problem twice (the unique index on open
 * keys) nor logs what the other already did.
 */
export function changeStatements(d1: D1Database, changes: readonly Change[], now: number, newId: () => string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const c of changes) {
    const o = c.obs;
    const sev = o ? (c.row && OPS_SEVERITY_RANK[c.row.severity] > OPS_SEVERITY_RANK[o.severity] ? c.row.severity : o.severity) : c.row!.severity;
    // An ended alert has no observation: a room's issue is the middle of its key (room_issue:<issue>:<table>).
    const ended = c.row && c.row.code === 'room_issue' ? { issue: c.row.dedupe_key.split(':')[1] } : {};
    const summary = o ? summaryOf(o) : `${summaryOf({ code: c.row!.code, detail: ended })}: no longer seen`;
    switch (c.kind) {
      case 'open':
      case 'sight':
        out.push(
          d1
            .prepare(
              `INSERT OR IGNORE INTO ops_alerts (id, dedupe_key, code, severity, table_id, summary, detail, first_seen_at, confirmed_at, last_seen_at, seen)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8, 1)`,
            )
            .bind(c.alertId, c.key, o!.code, sev, o!.tableId, summary, JSON.stringify(o!.detail), now, c.kind === 'open' ? now : null),
        );
        break;
      case 'confirm':
        out.push(
          d1
            .prepare(`UPDATE ops_alerts SET confirmed_at = ?2, last_seen_at = ?2, seen = seen + 1, severity = ?3, summary = ?4, detail = ?5 WHERE id = ?1 AND resolved_at IS NULL AND confirmed_at IS NULL`)
            .bind(c.alertId, now, sev, summary, JSON.stringify(o!.detail)),
        );
        break;
      case 'seen':
      case 'raise':
        out.push(
          d1
            .prepare(`UPDATE ops_alerts SET last_seen_at = ?2, seen = seen + 1, severity = ?3, summary = ?4, detail = ?5 WHERE id = ?1 AND resolved_at IS NULL`)
            .bind(c.alertId, now, sev, summary, JSON.stringify(o!.detail)),
        );
        break;
      case 'resolve':
        out.push(d1.prepare(`UPDATE ops_alerts SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL AND confirmed_at IS NOT NULL`).bind(c.alertId, now));
        break;
      case 'drop':
        out.push(d1.prepare(`DELETE FROM ops_alerts WHERE id = ?1 AND confirmed_at IS NULL`).bind(c.alertId));
        break;
    }
    const kind = EVENT_OF[c.kind];
    if (!kind) continue;
    const tableId = o ? o.tableId : c.row!.table_id;
    const code = o ? o.code : c.row!.code;
    out.push(
      d1
        .prepare(
          `INSERT INTO ops_events (id, at, kind, code, severity, table_id, summary, alert_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE changes() > 0`,
        )
        .bind(newId(), now, kind, code, sev, tableId, summary, c.alertId),
    );
  }
  return out;
}

/** The audit actions of an administrator's table controls, logged in ops_events too (with `.failed`: an attempt refused or broken off). */
export const OPS_CONTROL_ACTIONS: readonly string[] = ['table.control', 'table.close', 'table.timer_recover'];

/**
 * The ops_events line of an administrator's table control, from its audit row (null: not one). Which control and whether
 * the room confirmed it, or the failed attempt's status and error code: never who (the audit row has that), nor the
 * reason they typed.
 */
export function controlEvent(action: string, target: { type: string; id: string } | undefined, detail: unknown, outcome: 'ok' | 'failed') {
  const base = action.endsWith('.failed') ? action.slice(0, -'.failed'.length) : action;
  if (!OPS_CONTROL_ACTIONS.includes(base) || target?.type !== 'table') return null;
  const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
  const word = (v: unknown) => (typeof v === 'string' && /^[a-z_]{1,32}$/.test(v) ? v : null);
  const parts = [base];
  if (word(d.action)) parts.push(word(d.action)!);
  const unconfirmed = outcome === 'ok' && d.roomConfirmed === false;
  if (outcome === 'failed') parts.push(['failed', typeof d.status === 'number' ? d.status : null, word(d.code)].filter((x) => x !== null).join(' '));
  else if (unconfirmed) parts.push('saved, room did not confirm');
  return { code: base, severity: (outcome === 'failed' || unconfirmed ? 'warning' : 'info') as OpsSeverity, tableId: target.id, summary: parts.join(' ') };
}

/** A room's `monitor` summary, or null when it did not answer in OPS_PROBE_TIMEOUT_MS. */
async function probe(env: Env, id: string): Promise<MonitorRoom | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), OPS_PROBE_TIMEOUT_MS)));
  try {
    return (await Promise.race([roomCallEnv(env, id, 'monitor'), late])) as MonitorRoom | null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** A table is in play while it is open and a hand runs or a member sits there. */
const IN_PLAY = `status = 'open' AND (live_playing = 1 OR live_seated > live_bots)`;

export interface WatchResult {
  changes: number;
  opened: number;
  resolved: number;
  rooms: number;
  unanswered: number;
}

/** One check (the minute cron). Never throws past a failed D1 read: the cron's other work goes on. */
export async function watchOps(env: Env, now = Date.now(), ask: (id: string) => Promise<MonitorRoom | null> = (id) => probe(env, id)): Promise<WatchResult> {
  const started = Date.now();
  const d1 = env.DB;
  const open = (await d1.prepare(`SELECT id, dedupe_key, code, severity, table_id, confirmed_at FROM ops_alerts WHERE resolved_at IS NULL LIMIT 500`).all<OpenAlert>())
    .results;
  const alerted = [...new Set(open.filter((r) => scopeOf(r.code, r.table_id).startsWith('room:') && r.table_id).map((r) => r.table_id!))].slice(0, 90);
  const [stuck, closing, metrics, outbox, candidates, alertedRows, playing] = await d1.batch<Record<string, unknown>>([
    // CROSS JOIN starts from the seated rows (as the console's list does), not from every closed table.
    d1.prepare(`SELECT DISTINCT s.table_id AS id FROM table_sessions s CROSS JOIN tables t ON t.id = s.table_id WHERE s.status = 'seated' AND t.status = 'closed' LIMIT 50`),
    d1.prepare(`SELECT id, updated_at AS since FROM tables WHERE status = 'closing' LIMIT 50`),
    d1.prepare(`SELECT metric, SUM(n) AS n FROM ops_metrics WHERE bucket >= ?1 GROUP BY metric`).bind(opsBucket(now) - OPS_WINDOW_MS + OPS_BUCKET_MS),
    d1.prepare(`SELECT COUNT(*) AS n FROM realtime_outbox WHERE status = 'pending' AND created_at < ?1`).bind(now - OUTBOX_BACKLOG_MS),
    d1.prepare(`SELECT id FROM tables WHERE ${IN_PLAY} ORDER BY live_playing DESC, live_updated_at DESC LIMIT ${OPS_WATCH_ROOMS_MAX}`),
    alerted.length
      ? d1.prepare(`SELECT id FROM tables WHERE id IN (${alerted.map((_, i) => `?${i + 1}`).join(', ')}) AND ${IN_PLAY}`).bind(...alerted)
      : d1.prepare(`SELECT NULL AS id WHERE 0`),
    d1.prepare(`SELECT COUNT(*) AS n FROM tables WHERE ${IN_PLAY}`),
  ]);
  const ids = (r: D1Result<Record<string, unknown>> | undefined) => (r?.results ?? []).map((x) => String(x.id));
  const stillAlerted = new Set(ids(alertedRows));
  const inPlay = ids(candidates);
  // Alerted tables first, then the rest of the tables in play, up to the cap.
  const asked = [...new Set([...alerted.filter((id) => stillAlerted.has(id)), ...inPlay])].slice(0, OPS_WATCH_ROOMS_MAX);
  const skipped = Math.max(0, Number(playing?.results[0]?.n ?? 0) - asked.length);
  const rooms = new Map<string, MonitorRoom | null>();
  await Promise.all(asked.map(async (id) => rooms.set(id, await ask(id).catch(() => null))));
  const input: WatchInput = {
    now,
    seatedOnClosed: ids(stuck),
    closing: (closing?.results ?? []).map((r) => ({ id: String(r.id), since: Number(r.since) })),
    metrics: Object.fromEntries((metrics?.results ?? []).map((r) => [String(r.metric), Number(r.n)])),
    outboxBacklog: Number(outbox?.results[0]?.n ?? 0),
    rooms,
    idle: alerted.filter((id) => !stillAlerted.has(id)),
  };
  const staleSince = new Map(open.filter((r) => r.code === 'table_stale' && r.confirmed_at !== null).map((r) => [r.table_id!, r.confirmed_at!]));
  // A room that did not answer hides its problems: only the rooms that answered (and the tables no longer in play) end them.
  const answered = asked.filter((id) => rooms.get(id));
  const checked = new Set(['tables', 'metrics', ...answered.map((id) => `room:${id}`), ...input.idle.map((id) => `room:${id}`)]);
  const changes = reconcile(open, observe(input, staleSince), checked, () => crypto.randomUUID());
  const unanswered = [...rooms.values()].filter((r) => r === null).length;
  const stmts = [
    ...changeStatements(d1, changes, now, () => crypto.randomUUID()),
    d1
      .prepare(
        `INSERT INTO ops_watch (id, checked_at, took_ms, rooms, unanswered, skipped) VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at, took_ms = excluded.took_ms, rooms = excluded.rooms, unanswered = excluded.unanswered, skipped = excluded.skipped`,
      )
      .bind(now, Date.now() - started, asked.length, unanswered, skipped),
  ];
  await d1.batch(stmts);
  const opened = changes.filter((c) => c.kind === 'open' || c.kind === 'confirm').length;
  const resolved = changes.filter((c) => c.kind === 'resolve').length;
  // The console pages re-read the alerts when they change (opened, raised or resolved), not on every count.
  if (changes.some((c) => EVENT_OF[c.kind])) await sendToAdmins(env, { type: 'admin.monitor.changed', kind: 'ops', resourceId: 'alerts', revision: now }).catch(() => {});
  return { changes: changes.length, opened, resolved, rooms: asked.length, unanswered };
}
