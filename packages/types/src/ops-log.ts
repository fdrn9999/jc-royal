import { z } from 'zod';
import type { MonitorTable } from './admin-monitor';

// ------------------------------------------------------------------ persistent alerts and operations log (docs/CONTROL_CENTER.md)
//
// What the api's minute cron finds wrong (apps/api/src/lib/ops-watch.ts), kept in D1 so an administrator who closes the
// console and comes back still sees it, with the log of when each problem opened, rose, ended or was noted, and of the
// administrators' table controls. Codes, ids, counts and times only: never a card, a player's name or a reason's text.

/** INFO / WARNING / ERROR / CRITICAL: the console's 정보 / 주의 / 경고 / 긴급. */
export const OPS_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type OpsSeverity = (typeof OPS_SEVERITIES)[number];
export const OPS_SEVERITY_RANK: Record<OpsSeverity, 1 | 2 | 3 | 4> = { info: 1, warning: 2, error: 3, critical: 4 };

/**
 * What an alert is about.
 * - `seated_on_closed`: a closed table that still has seated rows (chips no room will cash out).
 * - `close_overdue`: a close unfinished past the sweep's limit.
 * - `table_stale`: a table in play whose room did not answer the check (what it is doing is unknown); critical once it
 *   has gone on for OPS_STALE_LONG_MS.
 * - `room_issue`: a problem the room reports in itself (`detail.issue`: TableRoom.issuesAt's code).
 * - `settlement_failed`: cash-outs that failed in the window (ops_metrics cashout_fail).
 * - `recovery_failed`: rooms that could not finish a restart's half-done seats (recover_fail).
 * - `server_errors`: api 5xx and room failures together past a threshold.
 * - `delivery_failed`: realtime events the hubs did not take, retried or given up.
 * - `reconnect_surge`: table connections reopened or dropped past a threshold.
 * - `outbox_backlog`: realtime outbox events still waiting long after they were written.
 */
export const OPS_ALERT_CODES = [
  'seated_on_closed',
  'close_overdue',
  'table_stale',
  'room_issue',
  'settlement_failed',
  'recovery_failed',
  'server_errors',
  'delivery_failed',
  'reconnect_surge',
  'outbox_backlog',
] as const;
export type OpsAlertCode = (typeof OPS_ALERT_CODES)[number];

/**
 * How serious each problem a room reports in itself is (the console's table cards use the same levels). A hand that
 * stopped, a turn past its deadline or no timer to end it: critical. A seat being bought into, usually gone within
 * seconds: warning. Anything else, and a code not listed: error.
 */
export const OPS_ROOM_ISSUE_SEVERITY: Record<string, OpsSeverity> = {
  stalled_hand: 'critical',
  turn_overdue: 'critical',
  timer_unarmed: 'critical',
  pending_seat: 'warning',
};
/** Room issues the room itself only reports once they are late (OVERDUE_MS): an alert from their first sighting. */
export const OPS_ROOM_ISSUES_LATE: readonly string[] = ['stalled_hand', 'turn_overdue', 'timer_unarmed', 'next_hand_overdue'];
export const roomIssueSeverity = (issue: string): OpsSeverity => OPS_ROOM_ISSUE_SEVERITY[issue] ?? 'error';

/** What an administrator noted on an alert (확인 / 조치 중 / 무시): the alert stays open until the check stops seeing it. */
export const OPS_HANDLINGS = ['new', 'ack', 'investigating', 'dismissed'] as const;
export type OpsHandling = (typeof OPS_HANDLINGS)[number];

export const OPS_EVENT_KINDS = ['alert_opened', 'alert_raised', 'alert_resolved', 'alert_handled', 'admin_control'] as const;
export type OpsEventKind = (typeof OPS_EVENT_KINDS)[number];

/** Numbers and codes an alert carries: a metric's count in the window, the room's issue, how long a close is late. */
export type OpsAlertDetail = Partial<Record<'issue' | 'metric', string>> & Partial<Record<'n' | 'threshold' | 'windowMs' | 'sinceMs', number>>;

export interface OpsAlertDto {
  id: string;
  code: OpsAlertCode;
  severity: OpsSeverity;
  tableId: string | null;
  /** The table's name and status as D1 has them now (null: no table, or the table is gone). */
  table: { name: string; status: MonitorTable['status'] } | null;
  summary: string;
  detail: OpsAlertDetail;
  /** When it was first confirmed (a transient state counts from its second sighting). */
  openedAt: number;
  lastSeenAt: number;
  /** Checks that saw it while it was open. */
  seen: number;
  resolvedAt: number | null;
  handling: OpsHandling;
  handledAt: number | null;
}

export interface OpsEventDto {
  id: string;
  at: number;
  kind: OpsEventKind;
  /** An alert's code, or the audit action of an administrator's control (`table.control`, `table.close`, ...). */
  code: string;
  severity: OpsSeverity;
  tableId: string | null;
  /** The table's name now, on the log's list (null: a service-wide line, or the table is gone; an alert's screen names
   * its table once, so its lines leave this out). */
  tableName?: string | null;
  summary: string;
  alertId: string | null;
  /** The admin_audit_log row of an administrator's control (who did it and why are there, not here). */
  correlationId: string | null;
}

/** The minute check's last run: no alert means nothing wrong only if it ran lately and could see. */
export interface OpsWatchDto {
  checkedAt: number;
  tookMs: number;
  /** Rooms asked, and of those, how many did not answer. */
  rooms: number;
  unanswered: number;
  /** Tables in play not asked that time (past the check's cap). */
  skipped: number;
}

export const OPS_ALERT_STATES = ['open', 'resolved', 'all'] as const;
export type OpsAlertState = (typeof OPS_ALERT_STATES)[number];
/** Open alerts listed at most (the open ones come in one page, most serious first). */
export const OPS_OPEN_ALERTS_MAX = 200;
/** A page of resolved alerts or log lines. */
export const OPS_PAGE_MAX = 100;

/**
 * GET /api/admin/monitor/alerts?state=open|resolved|all&severity=&code=&table=&before=&beforeId=&limit=. Open: every
 * open alert (up to OPS_OPEN_ALERTS_MAX), most serious first, then newest. Resolved or all: newest first by when each
 * was first seen, a page at a time (pass nextBefore and nextBeforeId back as before and beforeId).
 */
export interface OpsAlertsResponse {
  items: OpsAlertDto[];
  nextBefore: number | null;
  nextBeforeId: string | null;
  /** null: the check has never run (or not since the log was cleared). */
  watch: OpsWatchDto | null;
  at: number;
}

/** GET /api/admin/monitor/events?table=&kind=&severity=&code=&from=&to=&before=&beforeId=&limit=: newest first. */
export interface OpsEventsResponse {
  items: OpsEventDto[];
  nextBefore: number | null;
  nextBeforeId: string | null;
  at: number;
}

export const OpsHandlingBodySchema = z.object({ handling: z.enum(OPS_HANDLINGS) });

/** GET /api/admin/monitor/alerts/:id: one alert with what an administrator needs to act on it, on one screen. */
export interface OpsIncidentResponse {
  alert: OpsAlertDto;
  /** The table as the control center's grid draws it from D1 now (null: a service-wide alert, or the table is gone). */
  table: MonitorTable | null;
  /** The log around it: this alert's lines and, for a table, the table's other lines from an hour before it opened. */
  events: OpsEventDto[];
  /** Other alerts of the same table (of the service, for a service-wide one) from an hour before it opened to its end. */
  related: OpsAlertDto[];
  /** For an alert on the counters: its counters per minute, from an hour before it opened to its end (an hour at most after). */
  metrics: { bucket: number; metric: string; n: number }[];
  watch: OpsWatchDto | null;
  at: number;
}

/** How long resolved alerts and log lines are kept (the daily housekeeping deletes older ones). */
export const OPS_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** A table in play whose room has not answered for this long is critical (장시간 STALE). */
export const OPS_STALE_LONG_MS = 10 * 60_000;
