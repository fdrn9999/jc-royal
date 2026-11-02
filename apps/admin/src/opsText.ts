/**
 * The control center's persistent alerts and operations log in words, and one table's health at a glance
 * (docs/CONTROL_CENTER.md '지속 경고와 운영 기록', '테이블 상태 요약'). The server keeps codes and numbers only; the words
 * are the console's, so they follow its language. A value the console has not observed is `unknown`, never assumed fine.
 */
import { OPS_SEVERITY_RANK, type MonitorTable, type OpsAlertDto, type OpsEventDto, type OpsSeverity } from '@jc/types';
import type { Key } from './i18n';
import { tableIssueLabel, type Tr } from './labels';
import type { Freshness, RoomEntry } from './monitor';

/** The console's levels (정보 / 주의 / 경고 / 긴급) for INFO / WARNING / ERROR / CRITICAL. */
export const sevLevel = (s: OpsSeverity): 1 | 2 | 3 | 4 => OPS_SEVERITY_RANK[s];

const METRIC_KEY: Record<string, Key> = {
  cashout_fail: 'opsMetricCashoutFail',
  recover_fail: 'opsMetricRecoverFail',
  api_error: 'opsMetricApiError',
  room_error: 'opsMetricRoomError',
  rt_undelivered: 'opsMetricRtUndelivered',
  rt_revoke_fail: 'opsMetricRtRevokeFail',
  rt_outbox_retry: 'opsMetricRtOutboxRetry',
  rt_outbox_failed: 'opsMetricRtOutboxFailed',
  ws_retry: 'opsMetricWsRetry',
  ws_drop: 'opsMetricWsDrop',
};
export const metricLabel = (t: Tr, m: string) => m.split('+').map((x) => (METRIC_KEY[x] ? t(METRIC_KEY[x]) : x)).join(' + ');

const mins = (ms: number | undefined) => Math.max(1, Math.round((ms ?? 0) / 60_000));

/** What an alert is about, from its code and numbers. */
export function opsAlertText(t: Tr, a: Pick<OpsAlertDto, 'code' | 'detail'>): string {
  const d = a.detail;
  switch (a.code) {
    case 'seated_on_closed':
      return t('ccPSeatedOnClosed');
    case 'close_overdue':
      return t('opsACloseOverdue', { m: mins(d.sinceMs) });
    case 'table_stale':
      return t('opsATableStale');
    case 'room_issue':
      return d.issue ? tableIssueLabel(t, d.issue) : t('opsARoomIssue');
    case 'outbox_backlog':
      return t('opsAOutboxBacklog', { n: d.n ?? 0 });
    case 'settlement_failed':
    case 'recovery_failed':
    case 'server_errors':
    case 'delivery_failed':
    case 'reconnect_surge':
      return t('opsAMetric', { what: t(`opsCode_${a.code}` as Key), metric: metricLabel(t, d.metric ?? ''), n: d.n ?? 0, m: mins(d.windowMs) });
    default:
      return a.code;
  }
}

const CONTROL_KEY: Record<string, Key> = { 'table.control': 'auditTableControl', 'table.close': 'auditTableClose', 'table.timer_recover': 'auditTimerRecover' };

/** One line of the operations log in words: an alert's change, or an administrator's table control. */
export function opsEventText(t: Tr, e: Pick<OpsEventDto, 'kind' | 'code' | 'summary'>): string {
  if (e.kind === 'admin_control') {
    // The summary is codes the api wrote: '<action> [pause|block…] [failed <status> <code> | saved, room did not confirm]'.
    const words = e.summary.split(' ').slice(1);
    const name = CONTROL_KEY[e.code] ? t(CONTROL_KEY[e.code]!) : e.code;
    const sub = words[0] && /^(pause|resume|block|unblock)$/.test(words[0]) ? t(`opsCtl_${words[0]}` as Key) : '';
    const failed = e.summary.includes(' failed');
    const unconfirmed = e.summary.includes('room did not confirm');
    return [name, sub, failed ? t('ccOutcomeFailed') : unconfirmed ? t('ccOutcomeUnconfirmed') : t('ccOutcomeOk')].filter(Boolean).join(' · ');
  }
  const what = OPS_CODE_KEYS.has(e.code) ? t(`opsCode_${e.code}` as Key) : e.code;
  const issue = e.code === 'room_issue' ? / reports (\w+)/.exec(e.summary)?.[1] : undefined;
  const subject = issue ? `${what}: ${tableIssueLabel(t, issue)}` : what;
  if (e.kind === 'alert_handled') {
    const to = /-> (\w+)$/.exec(e.summary)?.[1];
    return t('opsEvHandled', { what: subject, to: to ? t(HANDLING_KEY[to as keyof typeof HANDLING_KEY] ?? 'opsHandlingNew') : '' });
  }
  return t(e.kind === 'alert_opened' ? 'opsEvOpened' : e.kind === 'alert_raised' ? 'opsEvRaised' : 'opsEvResolved', { what: subject });
}
const OPS_CODE_KEYS = new Set(['seated_on_closed', 'close_overdue', 'table_stale', 'room_issue', 'settlement_failed', 'recovery_failed', 'server_errors', 'delivery_failed', 'reconnect_surge', 'outbox_backlog']);
export const HANDLING_KEY = { new: 'opsHandlingNew', ack: 'opsHandlingAck', investigating: 'opsHandlingInvestigating', dismissed: 'opsHandlingDismissed' } as const satisfies Record<OpsAlertDto['handling'], Key>;

// ------------------------------------------------------------------ one table's health

export const HEALTH_KEYS = ['members', 'spectators', 'street', 'lastAction', 'socket', 'sync', 'errors', 'timer', 'settlement', 'lastGood'] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];
/** `none`: nothing to show for it now (no hand running, no turn, a closed table); `unknown`: not observed. */
export type HealthState = 'ok' | 'warn' | 'bad' | 'unknown' | 'none';
export interface HealthItem {
  key: HealthKey;
  state: HealthState;
  /** What the value is, for the words: a count, a time, a code. */
  n?: number;
  of?: number;
  at?: number;
  code?: string;
}

const SETTLE_ISSUES = ['unrecorded_hands', 'cashing_seat', 'topup_debiting', 'close_unfinished'];
const TIMER_ISSUES = ['turn_overdue', 'timer_unarmed', 'next_hand_overdue', 'stalled_hand'];

/**
 * The table's ten readings (연결 회원, 관전자, 스트리트, 마지막 액션, 소켓, 동기화, 최근 오류, 타이머, 정산, 마지막 정상 갱신).
 * From the room's own summary when it answered, D1's row, the open persistent alerts of the table and, on the control
 * center, how current the page's link is (`fresh`; null: a page that read the room once, without a live link).
 * `now`: the server's clock.
 */
export function healthOf(o: { table: MonitorTable; entry: RoomEntry | undefined; fresh: Freshness | null; alerts: readonly Pick<OpsAlertDto, 'code' | 'severity' | 'detail'>[]; now: number }): HealthItem[] {
  const { table, entry, fresh, alerts, now } = o;
  const closed = table.status === 'closed';
  const room = !closed && entry && 'room' in entry ? entry.room : null;
  const failed = !closed && entry && 'error' in entry && entry.error === 'room_unavailable';
  const unknown = (key: HealthKey): HealthItem => ({ key, state: closed ? 'none' : 'unknown' });
  const issues = room?.issues ?? [];
  const members = room ? room.seats.filter((s) => s.state !== 'empty' && !s.bot && !!s.userId) : [];
  const off = members.filter((s) => !s.connected).length;
  const hand = room?.hand ?? null;
  const turn = hand?.turn ?? null;
  const out: HealthItem[] = [];

  out.push(room ? { key: 'members', state: off ? 'warn' : 'ok', n: members.length - off, of: members.length } : unknown('members'));
  out.push(room ? { key: 'spectators', state: 'ok', n: room.spectators } : unknown('spectators'));
  out.push(room ? { key: 'street', state: 'ok', code: hand ? hand.stage : 'idle' } : unknown('street'));
  // The running turn began when the action before it was taken (or the street was dealt).
  out.push(room ? (hand ? (turn ? { key: 'lastAction', state: 'ok', at: turn.startedAt } : { key: 'lastAction', state: 'unknown' }) : { key: 'lastAction', state: 'none' }) : unknown('lastAction'));
  out.push(room ? { key: 'socket', state: off ? 'warn' : 'ok', n: room.connections, of: off } : unknown('socket'));

  let sync: HealthItem;
  if (closed) sync = { key: 'sync', state: 'none', code: 'closed' };
  else if (failed) sync = { key: 'sync', state: 'bad', code: 'unknown' };
  else if (fresh === 'stale') sync = { key: 'sync', state: 'bad', code: 'stale' };
  else if (!room) sync = { key: 'sync', state: 'unknown' };
  else sync = { key: 'sync', state: 'ok', code: fresh === null ? 'read' : fresh, at: entry!.at };
  out.push(sync);

  const worst = alerts.reduce((m, a) => Math.max(m, OPS_SEVERITY_RANK[a.severity]), 0);
  const errCount = issues.length + alerts.length;
  if (errCount) out.push({ key: 'errors', state: worst >= 3 || issues.length ? 'bad' : 'warn', n: errCount, code: issues[0] ?? alerts[0]!.detail.issue ?? alerts[0]!.code });
  else out.push(room ? { key: 'errors', state: 'ok', n: 0, ...(table.lastIssue ? { code: 'last_issue' } : {}) } : unknown('errors'));

  const timerIssue = issues.find((i) => TIMER_ISSUES.includes(i));
  if (!room) out.push(unknown('timer'));
  else if (timerIssue) out.push({ key: 'timer', state: 'bad', code: timerIssue, ...(turn && now > turn.deadline ? { n: now - turn.deadline } : {}) });
  else if (turn) out.push(now > turn.deadline ? { key: 'timer', state: 'warn', code: 'late', n: now - turn.deadline } : { key: 'timer', state: 'ok', n: turn.deadline - now });
  else out.push({ key: 'timer', state: 'none' });

  const settleIssue = issues.find((i) => SETTLE_ISSUES.includes(i));
  if (table.flags.includes('seated_on_closed')) out.push({ key: 'settlement', state: 'bad', code: 'seated_on_closed' });
  else if (settleIssue) out.push({ key: 'settlement', state: settleIssue === 'cashing_seat' || settleIssue === 'topup_debiting' ? 'warn' : 'bad', code: settleIssue });
  else out.push(room ? { key: 'settlement', state: 'ok' } : unknown('settlement'));

  if (room) out.push({ key: 'lastGood', state: 'ok', at: entry!.at });
  // Without an answer from the room, only D1's last change of its counts is known: a time, not a sign it is well.
  else out.push(table.liveAt ? { key: 'lastGood', state: closed ? 'none' : 'unknown', at: table.liveAt, code: 'd1' } : unknown('lastGood'));
  return out;
}
