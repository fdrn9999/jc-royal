/**
 * The control center's persistent alerts and operations log (docs/CONTROL_CENTER.md '지속 경고와 운영 기록'): what the
 * minute check (lib/ops-watch.ts) found and when, and the administrators' table controls. Read only, but for the note
 * an administrator puts on an alert (확인 / 조치 중 / 무시), which never closes it: only the check does, when it stops
 * seeing the problem. Nothing here names a member, holds a card or repeats a reason typed: codes, ids, counts, times.
 * Who did a table control and why is in the audit log (its own permission), linked by the line's correlation id.
 */
import {
  OPS_ALERT_CODES,
  OPS_ALERT_STATES,
  OPS_EVENT_KINDS,
  OPS_OPEN_ALERTS_MAX,
  OPS_PAGE_MAX,
  OPS_SEVERITIES,
  OpsHandlingBodySchema,
  type OpsAlertDetail,
  type OpsAlertDto,
  type OpsAlertsResponse,
  type OpsEventDto,
  type OpsEventsResponse,
  type OpsIncidentResponse,
  type OpsWatchDto,
} from '@jc/types';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { MONITOR_COLUMNS, monitorTable, sendToAdmins, type MonitorRow } from '../lib/admin-monitor';
import { audit } from '../lib/audit';
import { fail, parseBody } from '../lib/http';

const HOUR = 60 * 60_000;

/** A query value from a fixed list, or undefined (an unknown value narrows to nothing rather than being ignored: 400). */
function oneOf<T extends string>(c: { req: { query(k: string): string | undefined } }, key: string, list: readonly T[]): T | undefined {
  const v = c.req.query(key);
  if (v === undefined || v === '') return undefined;
  if (!(list as readonly string[]).includes(v)) fail(400, 'bad_request', `unknown ${key}`);
  return v as T;
}
function num(c: { req: { query(k: string): string | undefined } }, key: string): number | undefined {
  const v = c.req.query(key);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) fail(400, 'bad_request', `bad ${key}`);
  return n;
}
const idParam = (v: string | undefined) => (v && /^[\w-]{1,64}$/.test(v) ? v : undefined);

const ALERT_COLUMNS = `a.id, a.code, a.severity, a.table_id, a.summary, a.detail, a.first_seen_at, a.confirmed_at, a.last_seen_at, a.seen,
  a.resolved_at, a.handling, a.handled_at, t.name AS table_name, t.status AS table_status`;
const RANK = `CASE a.severity WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END`;

interface AlertRow {
  id: string;
  code: OpsAlertDto['code'];
  severity: OpsAlertDto['severity'];
  table_id: string | null;
  summary: string;
  detail: string | null;
  first_seen_at: number;
  confirmed_at: number;
  last_seen_at: number;
  seen: number;
  resolved_at: number | null;
  handling: OpsAlertDto['handling'];
  handled_at: number | null;
  table_name: string | null;
  table_status: 'open' | 'closing' | 'closed' | null;
}
function toAlert(r: AlertRow): OpsAlertDto {
  let detail: OpsAlertDetail = {};
  try {
    detail = r.detail ? (JSON.parse(r.detail) as OpsAlertDetail) : {};
  } catch {
    detail = {};
  }
  return {
    id: r.id,
    code: r.code,
    severity: r.severity,
    tableId: r.table_id,
    table: r.table_name !== null && r.table_status ? { name: r.table_name, status: r.table_status } : null,
    summary: r.summary,
    detail,
    openedAt: r.confirmed_at,
    lastSeenAt: r.last_seen_at,
    seen: r.seen,
    resolvedAt: r.resolved_at,
    handling: r.handling,
    handledAt: r.handled_at,
  };
}

interface EventRow {
  id: string;
  at: number;
  kind: OpsEventDto['kind'];
  code: string;
  severity: OpsEventDto['severity'];
  table_id: string | null;
  table_name?: string | null;
  summary: string;
  alert_id: string | null;
  correlation_id: string | null;
}
const toEvent = (r: EventRow): OpsEventDto => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  code: r.code,
  severity: r.severity,
  tableId: r.table_id,
  ...(r.table_name !== undefined ? { tableName: r.table_name } : {}),
  summary: r.summary,
  alertId: r.alert_id,
  correlationId: r.correlation_id,
});

const WATCH_SQL = `SELECT checked_at AS checkedAt, took_ms AS tookMs, rooms, unanswered, skipped FROM ops_watch WHERE id = 1`;

/** Mounted inside the admin router (requireAdmin and the permission rules already applied: the `tables` grant). */
export const adminOpsRoutes = new Hono<AppEnv>()
  .get('/monitor/alerts', async (c) => {
    const state = oneOf(c, 'state', OPS_ALERT_STATES) ?? 'open';
    const severity = oneOf(c, 'severity', OPS_SEVERITIES);
    const code = oneOf(c, 'code', OPS_ALERT_CODES);
    const table = idParam(c.req.query('table'));
    const before = num(c, 'before');
    const beforeId = idParam(c.req.query('beforeId')) ?? '';
    const limit = Math.min(num(c, 'limit') ?? 50, OPS_PAGE_MAX) || 50;
    const where = ['a.confirmed_at IS NOT NULL'];
    const binds: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      binds.push(v);
      where.push(sql.replace('?', `?${binds.length}`));
    };
    if (state === 'open') where.push('a.resolved_at IS NULL');
    if (state === 'resolved') where.push('a.resolved_at IS NOT NULL');
    if (severity) add('a.severity = ?', severity);
    if (code) add('a.code = ?', code);
    if (table) add('a.table_id = ?', table);
    const open = state === 'open';
    if (!open && before !== undefined) {
      binds.push(before, beforeId);
      where.push(`(a.first_seen_at < ?${binds.length - 1} OR (a.first_seen_at = ?${binds.length - 1} AND a.id < ?${binds.length}))`);
    }
    const take = open ? OPS_OPEN_ALERTS_MAX : limit + 1;
    const [list, watch] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(
        `SELECT ${ALERT_COLUMNS} FROM ops_alerts a LEFT JOIN tables t ON t.id = a.table_id WHERE ${where.join(' AND ')}
         ORDER BY ${open ? `${RANK} DESC, ` : ''}a.first_seen_at DESC, a.id DESC LIMIT ${take}`,
      ).bind(...binds),
      c.env.DB.prepare(WATCH_SQL),
    ]);
    const rows = (list!.results as unknown as AlertRow[]).map(toAlert);
    const items = open ? rows : rows.slice(0, limit);
    const lastRow = !open && rows.length > limit ? (list!.results[limit - 1] as unknown as AlertRow) : null;
    c.header('Cache-Control', 'no-store');
    return c.json({
      items,
      nextBefore: lastRow?.first_seen_at ?? null,
      nextBeforeId: lastRow?.id ?? null,
      watch: (watch!.results[0] as OpsWatchDto | undefined) ?? null,
      at: Date.now(),
    } satisfies OpsAlertsResponse);
  })
  .get('/monitor/events', async (c) => {
    const kind = oneOf(c, 'kind', OPS_EVENT_KINDS);
    const severity = oneOf(c, 'severity', OPS_SEVERITIES);
    const table = idParam(c.req.query('table'));
    const alert = idParam(c.req.query('alert'));
    const code = c.req.query('code');
    const from = num(c, 'from');
    const to = num(c, 'to');
    const before = num(c, 'before');
    const beforeId = idParam(c.req.query('beforeId')) ?? '';
    const limit = Math.min(num(c, 'limit') ?? 50, OPS_PAGE_MAX) || 50;
    const where: string[] = [];
    const binds: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      binds.push(v);
      where.push(sql.replace('?', `?${binds.length}`));
    };
    if (kind) add('e.kind = ?', kind);
    if (severity) add('e.severity = ?', severity);
    if (table) add('e.table_id = ?', table);
    if (alert) add('e.alert_id = ?', alert);
    if (code && /^[a-z_.]{1,40}$/.test(code)) add('e.code = ?', code);
    else if (code) fail(400, 'bad_request', 'bad code');
    if (from !== undefined) add('e.at >= ?', from);
    if (to !== undefined) add('e.at < ?', to);
    if (before !== undefined) {
      binds.push(before, beforeId);
      where.push(`(e.at < ?${binds.length - 1} OR (e.at = ?${binds.length - 1} AND e.id < ?${binds.length}))`);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT e.id, e.at, e.kind, e.code, e.severity, e.table_id, t.name AS table_name, e.summary, e.alert_id, e.correlation_id
       FROM ops_events e LEFT JOIN tables t ON t.id = e.table_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.at DESC, e.id DESC LIMIT ${limit + 1}`,
    )
      .bind(...binds)
      .all<EventRow>();
    const items = results.slice(0, limit).map(toEvent);
    const last = results.length > limit ? items[items.length - 1]! : null;
    c.header('Cache-Control', 'no-store');
    return c.json({ items, nextBefore: last?.at ?? null, nextBeforeId: last?.id ?? null, at: Date.now() } satisfies OpsEventsResponse);
  })
  /**
   * One alert and what acting on it needs, on one screen: the table as D1 has it now, the log around it (its own lines
   * and the table's from an hour before it opened to its end), the table's other alerts then, and for an alert on the
   * counters, the counters per minute. The room's live state is the console's rooms read (it asks the room itself).
   */
  .get('/monitor/alerts/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    if (!id) fail(404, 'not_found', 'alert not found');
    const row = await c.env.DB.prepare(`SELECT ${ALERT_COLUMNS} FROM ops_alerts a LEFT JOIN tables t ON t.id = a.table_id WHERE a.id = ?1 AND a.confirmed_at IS NOT NULL`)
      .bind(id)
      .first<AlertRow>();
    if (!row) fail(404, 'not_found', 'alert not found');
    const alert = toAlert(row);
    const now = Date.now();
    const from = alert.openedAt - HOUR;
    const to = Math.min(alert.resolvedAt ?? now, now);
    const metricNames = alert.detail.metric ? alert.detail.metric.split('+').filter((m) => /^[a-z_]{1,32}$/.test(m)) : [];
    const sameScope = alert.tableId ? 'a.table_id = ?2' : 'a.table_id IS NULL';
    const [events, related, table, metrics, watch] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(
        `SELECT id, at, kind, code, severity, table_id, summary, alert_id, correlation_id FROM ops_events
          WHERE alert_id = ?1 OR (?2 IS NOT NULL AND table_id = ?2 AND at >= ?3 AND at <= ?4) ORDER BY at DESC, id DESC LIMIT 200`,
      ).bind(id, alert.tableId, from, to),
      c.env.DB.prepare(
        `SELECT ${ALERT_COLUMNS} FROM ops_alerts a LEFT JOIN tables t ON t.id = a.table_id
          WHERE a.id <> ?1 AND ${sameScope} AND a.confirmed_at IS NOT NULL AND a.first_seen_at <= ?4 AND COALESCE(a.resolved_at, ?4) >= ?3
          ORDER BY a.first_seen_at DESC LIMIT 50`,
      ).bind(id, alert.tableId, from, to),
      alert.tableId
        ? c.env.DB.prepare(
            `SELECT ${MONITOR_COLUMNS},
               CASE WHEN t.status = 'closed' AND EXISTS (SELECT 1 FROM table_sessions s WHERE s.table_id = t.id AND s.status = 'seated') THEN 1 ELSE 0 END AS stuck
             FROM tables t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?1`,
          ).bind(alert.tableId)
        : c.env.DB.prepare(`SELECT NULL AS id WHERE 0`),
      metricNames.length
        ? c.env.DB.prepare(
            `SELECT bucket, metric, n FROM ops_metrics WHERE bucket >= ?1 AND bucket <= ?2 AND metric IN (${metricNames.map((_, i) => `?${i + 3}`).join(', ')})
             ORDER BY bucket, metric LIMIT 1000`,
          ).bind(from, Math.min(to, alert.openedAt + HOUR), ...metricNames)
        : c.env.DB.prepare(`SELECT NULL AS bucket WHERE 0`),
      c.env.DB.prepare(WATCH_SQL),
    ]);
    const t = table!.results[0] as (MonitorRow & { stuck: number }) | undefined;
    c.header('Cache-Control', 'no-store');
    return c.json({
      alert,
      table: t ? monitorTable(t, now, new Set(t.stuck ? [t.id] : [])) : null,
      events: (events!.results as unknown as EventRow[]).map(toEvent),
      related: (related!.results as unknown as AlertRow[]).map(toAlert),
      metrics: metrics!.results as OpsIncidentResponse['metrics'],
      watch: (watch!.results[0] as OpsWatchDto | undefined) ?? null,
      at: now,
    } satisfies OpsIncidentResponse);
  })
  /**
   * An administrator's note on an alert (확인 / 조치 중 / 무시, or back to new), kept with it so every console shows it:
   * audited, and a line in the log. It does not close the alert, nor stop the check from raising it.
   */
  .post('/monitor/alerts/:id/handling', async (c) => {
    const id = idParam(c.req.param('id'));
    const { handling } = await parseBody(c, OpsHandlingBodySchema);
    const row = id
      ? await c.env.DB.prepare(`SELECT code, severity, table_id, handling FROM ops_alerts WHERE id = ?1 AND confirmed_at IS NOT NULL`)
          .bind(id)
          .first<{ code: string; severity: string; table_id: string | null; handling: string }>()
      : null;
    if (!id || !row) fail(404, 'not_found', 'alert not found');
    if (row.handling === handling) return c.json({ ok: true, changed: false });
    const now = Date.now();
    const auditId = await audit(c, 'monitor.alert_handling', undefined, { alert: id, code: row.code, table: row.table_id, from: row.handling, to: handling });
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE ops_alerts SET handling = ?2, handled_at = ?3 WHERE id = ?1`).bind(id, handling, now),
      c.env.DB.prepare(
        `INSERT INTO ops_events (id, at, kind, code, severity, table_id, summary, alert_id, correlation_id) VALUES (?1, ?2, 'alert_handled', ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(crypto.randomUUID(), now, row.code, row.severity, row.table_id, `handling ${row.handling} -> ${handling}`, id, auditId),
    ]);
    c.executionCtx.waitUntil(sendToAdmins(c.env, { type: 'admin.monitor.changed', kind: 'ops', resourceId: 'alerts', revision: now }).catch(() => {}));
    return c.json({ ok: true, changed: true });
  });
