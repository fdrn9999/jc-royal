/**
 * The report queue: what the server recorded when each report was filed, how severe staff rated it and who works on
 * it, its history and internal notes, the reported member's sanctions, and the decision with the optional outcome
 * messages; and reference statistics. Nothing here acts on a member by a count: a suspension is given by an
 * administrator who read the evidence, from the report it answers.
 */
import {
  REPORT_REASONS,
  REPORT_SEVERITIES,
  REPORT_STATS_DAYS,
  REPORT_TARGETS,
  type ReportDto,
  type ReportEventDto,
  type ReportListDto,
  type ReportReason,
  type ReportSeverity,
  type ReportStatsDto,
  type ReportStatus,
  type ReportTarget,
} from '@jc/types';
import { Badge, Button, ChevronDownIcon, ChevronUpIcon, Empty, formatChips, formatDate, Input, Panel, Stat, XIcon } from '@jc/ui';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { REASONS } from '../adminTemplates';
import { useT, type Key } from '../i18n';
import { auditActionLabel, contentStatusLabel, userStatusLabel, type Tr } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { AdminReasonField } from '../templateFields';
import { contentTone, Feedback, LoadError, Modal, type Note } from '../ui';
import { Table } from './Console';
import { IntegritySignals, SignalEvidence } from './Integrity';

export const REASON: Record<ReportReason, Key> = { spam: 'reasonSpam', abuse: 'reasonAbuse', inappropriate: 'reasonInappropriate', cheating: 'reasonCheating', other: 'reasonOther' };
const TARGET: Record<ReportTarget, Key> = { post: 'targetPost', comment: 'targetComment', player: 'targetPlayer', dm: 'targetDm' };
export const STATUS: Record<ReportStatus, Key> = { open: 'statusOpen', resolved: 'statusResolved', dismissed: 'statusDismissed' };
const SEVERITY: Record<ReportSeverity, Key> = { low: 'sevLow', medium: 'sevMedium', high: 'sevHigh', critical: 'sevCritical' };
const SEV_TONE: Record<ReportSeverity, 'neutral' | 'blue' | 'gold' | 'red'> = { low: 'neutral', medium: 'blue', high: 'gold', critical: 'red' };
const SORTS: [string, Key][] = [
  ['newest', 'sortReportNewest'],
  ['oldest', 'sortReportOldest'],
  ['severity', 'sortReportSeverity'],
];
const PAGE = 50;
const MIN = 60_000;
const HOUR = 3_600_000;
const selectCls = 'h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const selectSm = 'h-9 rounded-lg border border-white/10 bg-ink-850 px-2 text-sm';
const checkbox = 'size-4 cursor-pointer accent-gold-500';
const td = 'px-2 py-1.5';
// Narrow screens scroll these tables sideways rather than breaking headers and badges letter by letter.
const NOWRAP = '[&_td]:whitespace-nowrap [&_th]:whitespace-nowrap';

interface Staff { id: string; nickname: string; role: string }

/** How long something took or has waited: minutes under an hour, hours under two days, then days. */
export function dur(t: Tr, ms: number): string {
  if (ms < MIN) return t('durUnderMin');
  if (ms < HOUR) return t('durMin', { n: Math.floor(ms / MIN) });
  if (ms < 48 * HOUR) return t('durHour', { n: Math.floor(ms / HOUR) });
  return t('durDay', { n: Math.floor(ms / (24 * HOUR)) });
}
const sevLabel = (t: Tr, v: string | null) => (v && Object.hasOwn(SEVERITY, v) ? t(SEVERITY[v as ReportSeverity]) : t('sevNone'));
const statusLabel = (t: Tr, v: string | null) => (v && Object.hasOwn(STATUS, v) ? t(STATUS[v as ReportStatus]) : (v ?? '—'));

/** What the server captured when the report was filed. */
function Evidence({ r }: { r: ReportDto }) {
  const { t, locale } = useT();
  const ctx = r.context;
  if (!ctx) return <p className="text-xs text-ink-400">{t('none')}</p>;
  if (ctx.kind === 'signal') return <SignalEvidence ctx={ctx} target={r.target.nickname} />;
  if (ctx.kind === 'dm') {
    return (
      <div className="flex flex-col gap-2 text-sm" data-testid="report-dm">
        <div className="text-xs text-ink-400">
          {t('dmParties')}:{' '}
          <Link to={`/users/${ctx.senderId}`} className="text-gold-300 hover:underline">{r.target.nickname}</Link> →{' '}
          <Link to={`/users/${ctx.recipientId}`} className="text-ink-100 hover:underline">{ctx.recipientId === r.reporter.id ? r.reporter.nickname : ctx.recipientId}</Link>
        </div>
        <div>
          <div className="mb-1 text-xs text-ink-400">{t('dmMessage')} · {formatDate(ctx.at, locale)}</div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-ink-950/60 p-2 text-ink-100" data-testid="report-content">{ctx.body}</p>
        </div>
        {ctx.earlier.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-ink-400">{t('dmEarlier')}</div>
            <ul className="flex flex-col gap-0.5 rounded bg-ink-950/60 p-2 text-xs">
              {ctx.earlier.map((m) => (
                <li key={m.id} className="break-words">
                  <span className="mr-2 font-mono text-ink-400">{formatDate(m.at, locale)}</span>
                  {m.body}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (ctx.kind === 'player') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <Link to={`/tables/${ctx.tableId}`} className="text-gold-300 hover:underline">{ctx.tableName || ctx.tableId}</Link>
          {ctx.handId && ctx.handNumber !== null && (
            <Link to={`/hands/${ctx.handId}`} className="text-gold-300 hover:underline" data-testid="report-hand">{t('handN', { n: ctx.handNumber })}</Link>
          )}
          {ctx.basis && <Badge tone={ctx.basis === 'present' ? 'green' : 'blue'}>{t(ctx.basis === 'present' ? 'basisPresent' : 'basisHistory')}</Badge>}
        </div>
        {ctx.overlap && (
          <div className="text-xs text-ink-300" data-testid="report-overlap">
            {t('overlap')}: {formatDate(ctx.overlap.from, locale)} – {formatDate(ctx.overlap.to, locale)}
          </div>
        )}
        {ctx.sharedHands && ctx.sharedHands.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-ink-400">{t('sharedHands')}:</span>
            {ctx.sharedHands.map((h) => (
              <Link key={h.id} to={`/hands/${h.id}`} className="text-gold-300 hover:underline">#{h.number}</Link>
            ))}
          </div>
        )}
        <div>
          <div className="mb-1 text-xs text-ink-400">{t('recentChat')}</div>
          {ctx.chat.length === 0 ? (
            <p className="text-xs text-ink-400">{t('none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 rounded bg-ink-950/60 p-2 text-xs" data-testid="report-chat">
              {ctx.chat.map((l, i) => (
                <li key={i} className="break-words">
                  <span className="mr-2 font-mono text-ink-400">{formatDate(l.at, locale)}</span>
                  {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded bg-ink-950/60 p-2 text-sm">
      {ctx.kind === 'post' && <div className="font-semibold text-ivory">{ctx.title}</div>}
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ink-100" data-testid="report-content">{ctx.body}</p>
      {r.contentStatus && (
        <div className="text-xs text-ink-400">
          {t('contentNow')}: <Badge tone={contentTone(r.contentStatus)}>{contentStatusLabel(t, r.contentStatus)}</Badge>
        </div>
      )}
    </div>
  );
}

/** The reported member's last suspensions, lifts and forced disconnects, and which report each answered. */
function Sanctions({ r }: { r: ReportDto }) {
  const { t, locale } = useT();
  return (
    <div data-testid="report-sanctions">
      <div className="mb-1 text-xs font-semibold text-ink-300">{t('sanctionsTitle')}</div>
      {r.sanctions.length === 0 ? (
        <p className="text-xs text-ink-400">{t('noSanctions')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {r.sanctions.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Badge tone={s.action === 'user.unsuspend' ? 'green' : 'red'}>{auditActionLabel(t, s.action)}</Badge>
              <span className="font-mono text-ink-400">{formatDate(s.at, locale)}</span>
              <span className="text-ink-300">{s.actor.nickname ?? '—'}</span>
              {s.reason && <span className="min-w-0 break-all text-ink-100">{s.reason}</span>}
              {s.reportId && <Badge tone={s.reportId === r.id ? 'gold' : 'neutral'}>{t(s.reportId === r.id ? 'sanctionThis' : 'sanctionReport')}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function eventText(t: Tr, e: ReportEventDto): string {
  const who = (id: string | null, name: string | null) => (id ? (name ?? id) : t('unassigned'));
  switch (e.kind) {
    case 'note':
      return e.body ?? '';
    case 'severity':
      return t('histChange', { from: sevLabel(t, e.from), to: sevLabel(t, e.to) });
    case 'assign':
      return t('histChange', { from: who(e.from, e.fromName), to: who(e.to, e.toName) });
    case 'status':
      return t('histChange', { from: statusLabel(t, e.from), to: statusLabel(t, e.to) }) + (e.body ? ` · ${e.body}` : '');
    case 'sanction':
      return auditActionLabel(t, e.to) + (e.body ? ` · ${e.body}` : '');
  }
}
const EVENT: Record<ReportEventDto['kind'], Key> = { note: 'evNote', severity: 'severity', assign: 'assignee', status: 'status', sanction: 'catSanction' };

/** The report's history, oldest first, and the internal note form (staff only; never shown to members). */
function ReportLog({ r }: { r: ReportDto }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, error, reload } = useData<{ items: ReportEventDto[] }>(`/api/admin/reports/${r.id}/events`);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api(`/api/admin/reports/${r.id}/notes`, { body: { body } });
      setBody('');
      await reload();
    } catch (x) {
      setMsg(errText(x, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/5 bg-ink-950/40 p-3" data-testid="report-log">
      {error && <p className="text-xs text-danger">{error}</p>}
      {data && data.items.length === 0 && <p className="text-xs text-ink-400">{t('noEvents')}</p>}
      {data && data.items.length > 0 && (
        <ol className="flex flex-col gap-1 text-xs">
          {data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="report-event" data-kind={e.kind}>
              <span className="font-mono text-ink-400">{formatDate(e.createdAt, locale)}</span>
              <Badge tone={e.kind === 'note' ? 'neutral' : e.kind === 'sanction' ? 'red' : 'blue'}>{t(EVENT[e.kind])}</Badge>
              <span className="text-ink-300">{e.actor.nickname ?? '—'}</span>
              <span className={`min-w-0 break-words ${e.kind === 'note' ? 'whitespace-pre-wrap text-ink-100' : 'text-ink-200'}`}>{eventText(t, e)}</span>
            </li>
          ))}
        </ol>
      )}
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={add}>
        <Input
          value={body}
          maxLength={500}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('reportNotePlaceholder')}
          aria-label={t('evNote')}
          className="min-w-0 flex-1"
          data-testid="report-note-input"
        />
        <Button type="submit" size="sm" variant="outline" className="shrink-0" loading={saving} disabled={body.trim().length < 2} data-testid="report-note-add">
          {t('addNote')}
        </Button>
      </form>
      {msg && <p className="text-xs text-danger" role="alert">{msg}</p>}
    </div>
  );
}

/** The API's answer to a decision sent with `preview: true`: what it would do now; nothing is written. */
interface DecisionPreview { closes: number; hides: boolean; notify: { reporters: number; target: number } }
type Decision = 'resolved' | 'dismissed';

function ReportItem({ r, staff, onDone }: { r: ReportDto; staff: Staff[]; onDone: (note: Note) => void }) {
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const [note, setNote] = useState('');
  const [hide, setHide] = useState(false);
  const [notifyReporter, setNotifyReporter] = useState(false);
  const [notifyTarget, setNotifyTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // `lang`: the member's language as the server last said it, when they switched it after this list loaded.
  const [suspend, setSuspend] = useState<{ reason: string; error: string | null; lang?: 'ko' | 'en' } | null>(null);
  const targetLang = suspend?.lang ?? r.target.locale;
  // Bumped when the dialog opens or closes: an answer that comes back after it did is for a dialog no longer there.
  const suspendSeq = useRef(0);
  const openSuspend = () => {
    suspendSeq.current++;
    setSuspend({ reason: '', error: null });
  };
  const closeSuspend = () => {
    suspendSeq.current++;
    setSuspend(null);
  };
  // A decision waits in a confirmation that shows the server's preview of it (reports closed with it, content hidden, messages sent).
  const [decide, setDecide] = useState<{ status: Decision; pv: { data: DecisionPreview } | { error: unknown } | null } | null>(null);
  const pvSeq = useRef(0);
  const open = r.status === 'open';
  const canHide = r.targetType !== 'player' && r.contentStatus === 'visible';
  const now = Date.now();
  // A former administrator stays visible as the assignee until someone changes it.
  const options = r.assignee && !staff.some((s) => s.id === r.assignee!.id) ? [...staff, { ...r.assignee, role: '' }] : staff;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      onDone({ ok: true, text: await fn() });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) onDone({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) =>
    run(async () => {
      await api(`/api/admin/reports/${r.id}`, { method: 'PATCH', body });
      return t('saved');
    });
  const decision = (status: Decision) => ({
    status,
    note: note.trim() || undefined,
    hideContent: canHide && hide && status === 'resolved' ? true : undefined,
    notifyReporter: notifyReporter || undefined,
    notifyTarget: status === 'resolved' && notifyTarget ? true : undefined,
  });
  const ask = (status: Decision) => {
    const seq = ++pvSeq.current;
    setDecide({ status, pv: null });
    api<DecisionPreview>(`/api/admin/reports/${r.id}`, { body: { ...decision(status), preview: true } }).then(
      (data) => seq === pvSeq.current && setDecide({ status, pv: { data } }),
      (e: unknown) => seq === pvSeq.current && setDecide({ status, pv: { error: e } }),
    );
  };
  const cancelDecide = () => {
    pvSeq.current++;
    setDecide(null);
  };
  // Sends the decision that was previewed (the form is not editable while the confirmation is open).
  const close = (status: Decision) => {
    cancelDecide();
    void run(async () => {
      const res = await api<{ closed: number; notified: { reporters: number; target: number } }>(`/api/admin/reports/${r.id}`, { body: decision(status) });
      const sent = res.notified.reporters + res.notified.target;
      return t('reportsClosed', { n: res.closed }) + (sent ? ` ${t('reportsNotified', { n: sent })}` : '');
    });
  };
  const pv = decide?.pv && 'data' in decide.pv ? decide.pv.data : null;
  const pvError = decide?.pv && 'error' in decide.pv ? errText(decide.pv.error, t) : null;
  const confirmSuspend = async () => {
    if (!suspend) return;
    const seq = suspendSeq.current;
    const sentLang = targetLang;
    setBusy(true);
    try {
      await api(`/api/admin/users/${r.target.id}/suspend`, { body: { reason: suspend.reason.trim(), reportId: r.id, reasonLocale: sentLang } });
      if (seq === suspendSeq.current) closeSuspend();
      onDone({ ok: true, text: t('reportSuspended', { name: r.target.nickname }) });
    } catch (e) {
      // Only the dialog it was sent from takes the answer, and it keeps what was typed while it was on its way.
      if (seq !== suspendSeq.current) return;
      if (e instanceof ApiError && e.code === 'locale_changed') {
        // Written again in the member's language now (the field does it); the note stays until the dialog closes.
        const lang = (e.details as { locale?: 'ko' | 'en' } | undefined)?.locale ?? (sentLang === 'en' ? 'ko' : 'en');
        setSuspend((s) => s && { ...s, lang, error: null });
      } else if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) {
        const error = errText(e, t);
        setSuspend((s) => s && { ...s, error });
      }
    } finally {
      setBusy(false);
    }
  };
  const waited = (r.handledAt ?? now) - r.createdAt;
  return (
    <li className="flex flex-col gap-3 py-4" data-testid="report-item" data-report={r.id}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="blue">{t(TARGET[r.targetType])}</Badge>
        <Badge tone="gold">{t(REASON[r.reason])}</Badge>
        <Badge tone={open ? 'red' : r.status === 'resolved' ? 'green' : 'neutral'}>{t(STATUS[r.status])}</Badge>
        {r.severity && <Badge tone={SEV_TONE[r.severity]}>{t('severity')}: {t(SEVERITY[r.severity])}</Badge>}
        <span data-testid="report-dwell" data-late={open && waited > 24 * HOUR ? 'true' : undefined}>
          <Badge tone={open && waited > 24 * HOUR ? 'red' : 'neutral'}>{t(open ? 'waitingFor' : 'handledIn', { d: dur(t, waited) })}</Badge>
        </span>
        <span className="ml-auto text-xs text-ink-400">{t('receivedAt')} {formatDate(r.createdAt, locale)}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-ink-400">{t('reportedUser')}</dt>
          <dd className="flex items-center gap-1.5">
            <Link to={`/users/${r.target.id}`} className="font-semibold text-gold-300 hover:underline">{r.target.nickname}</Link>
            {r.target.status !== 'active' && <Badge tone="red">{userStatusLabel(t, r.target.status)}</Badge>}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-400">{t('reporter')}</dt>
          <dd><Link to={`/users/${r.reporter.id}`} className="text-ink-100 hover:underline">{r.reporter.nickname}</Link></dd>
        </div>
      </dl>
      {r.priorReports.total > 0 && (
        <Link to={`/reports?status=all&userId=${r.target.id}`} className="self-start text-xs text-[#f0a0a2] hover:underline" data-testid="report-prior">
          {t('priorReports', { total: r.priorReports.total, resolved: r.priorReports.resolved, reporters: r.priorReports.reporters })}
        </Link>
      )}
      {r.detail && <p className="whitespace-pre-wrap break-words border-l-2 border-gold-500/40 pl-3 text-sm text-ink-100">{r.detail}</p>}
      <div>
        <div className="mb-1 text-xs font-semibold text-ink-300">{t('evidence')}</div>
        <Evidence r={r} />
      </div>
      <Sanctions r={r} />
      {open ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="report-manage">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-ink-400">{t('severity')}</span>
            <select value={r.severity ?? ''} disabled={busy} onChange={(e) => void patch({ severity: e.target.value || null })} className={selectSm} data-testid="report-severity">
              <option value="">{t('sevNone')}</option>
              {REPORT_SEVERITIES.map((s) => <option key={s} value={s}>{t(SEVERITY[s])}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-ink-400">{t('assignee')}</span>
            <select value={r.assignee?.id ?? ''} disabled={busy} onChange={(e) => void patch({ assigneeId: e.target.value || null })} className={selectSm} data-testid="report-assignee">
              <option value="">{t('unassigned')}</option>
              {options.map((s) => <option key={s.id} value={s.id}>{s.nickname}</option>)}
            </select>
          </label>
          {!r.assignee && <Button size="sm" variant="outline" disabled={busy} onClick={() => void patch({ take: true })} data-testid="report-take">{t('reportTake')}</Button>}
          {r.assignee && r.assignee.id === me?.user.id && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void patch({ assigneeId: null })} data-testid="report-release">{t('reportRelease')}</Button>
          )}
          {r.assignee && r.assignedAt && <span className="text-xs text-ink-400">{t('assignedAt', { time: formatDate(r.assignedAt, locale) })}</span>}
        </div>
      ) : (
        <p className="text-xs text-ink-400" data-testid="report-handled">
          {t('handledBy', { name: r.handledBy?.nickname ?? '—', time: r.handledAt ? formatDate(r.handledAt, locale) : '—' })}
          {r.assignee && <span className="ml-2">· {t('assignee')} {r.assignee.nickname}</span>}
          {r.note && <span className="ml-2 text-ink-200">· {r.note}</span>}
          <span className="ml-2" data-testid="report-notice">
            · {r.notice && (r.notice.reporter || r.notice.target)
              ? t('noticeSentTo', { who: [r.notice.reporter ? t('reporter') : null, r.notice.target ? t('reportedUser') : null].filter(Boolean).join(', ') })
              : t('noticeNotSent')}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="subtle" aria-expanded={showLog} onClick={() => setShowLog(!showLog)} data-testid="report-timeline-toggle">
          {t('reportLog')}
          {showLog ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
        </Button>
        {r.target.status === 'active' && (
          <Button size="sm" variant="danger" disabled={busy} onClick={openSuspend} data-testid="report-suspend">{t('suspendFromReport')}</Button>
        )}
      </div>
      {showLog && <ReportLog key={`${r.status}|${r.severity}|${r.assignee?.id}|${r.target.status}|${r.sanctions.length}`} r={r} />}
      {open && (
        <div className="flex flex-col gap-2 border-t border-white/5 pt-3">
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('noteOptional')} aria-label={t('note')} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {canHide && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className={checkbox} checked={hide} onChange={(e) => setHide(e.target.checked)} data-testid="report-hide" />
                {t('hideContent')}
              </label>
            )}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className={checkbox} checked={notifyReporter} onChange={(e) => setNotifyReporter(e.target.checked)} data-testid="report-notify-reporter" />
              {t('notifyReporter')}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className={checkbox} checked={notifyTarget} onChange={(e) => setNotifyTarget(e.target.checked)} data-testid="report-notify-target" />
              {t('notifyTarget')}
            </label>
            <div className="ml-auto flex shrink-0 gap-2">
              <Button size="sm" onClick={() => ask('resolved')} loading={busy} data-testid="report-resolve">{t('resolve')}</Button>
              <Button size="sm" variant="outline" onClick={() => ask('dismissed')} disabled={busy} data-testid="report-dismiss">{t('dismiss')}</Button>
            </div>
          </div>
          <p className="text-xs text-ink-400">{t('notifyHint')}</p>
        </div>
      )}
      <Modal
        open={decide !== null}
        onClose={cancelDecide}
        title={decide?.status === 'dismissed' ? t('dismiss') : t('resolve')}
        footer={
          <>
            <Button variant="ghost" onClick={cancelDecide}>{t('cancel')}</Button>
            <Button variant={decide?.status === 'dismissed' ? 'outline' : 'gold'} disabled={!pv} onClick={() => decide && close(decide.status)} data-testid="report-confirm">
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm" data-testid="report-decision">
          <p>{t(decide?.status === 'dismissed' ? 'decideDismiss' : 'decideResolve', { name: r.target.nickname })}</p>
          {decide && !decide.pv && <p className="text-ink-400" aria-live="polite">{t('pvLoading')}</p>}
          {pvError && <p className="break-all text-danger" role="alert">{pvError}</p>}
          {pv && (
            <ul className="flex list-disc flex-col gap-1 rounded-lg border border-white/10 bg-ink-950/40 py-2 pl-7 pr-3" data-testid="report-preview">
              <li>{t('pvReportsClose', { n: pv.closes })}</li>
              {canHide && hide && decide?.status === 'resolved' && <li>{t(pv.hides ? 'pvHides' : 'pvHideNone')}</li>}
              <li>{pv.notify.reporters + pv.notify.target > 0 ? t('pvNotify', { reporters: pv.notify.reporters, target: pv.notify.target }) : t('pvNotifyNone')}</li>
              {note.trim() && <li className="break-all">{t('note')}: {note.trim()}</li>}
            </ul>
          )}
          {pv && <p className="text-xs text-ink-400">{t('pvBasis')}</p>}
        </div>
      </Modal>
      <Modal
        open={suspend !== null}
        onClose={closeSuspend}
        title={t('suspendFromReport')}
        footer={
          <>
            <Button variant="ghost" onClick={closeSuspend}>{t('cancel')}</Button>
            <Button variant="danger" loading={busy} disabled={!suspend || suspend.reason.trim().length < 2 || suspend.reason.trim().length > 200} onClick={() => void confirmSuspend()} data-testid="report-suspend-confirm">
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{t('suspendConfirm', { name: r.target.nickname })}</p>
          <p className="text-xs text-ink-300">{t('suspendFromReportHint')}</p>
          <AdminReasonField
            label={t('reason')}
            templates={REASONS.suspend}
            value={suspend?.reason ?? ''}
            onChange={(v) => setSuspend((s) => s && { ...s, reason: v, error: null })}
            maxLength={200}
            lang={targetLang}
            follow
            hint={t('suspendReasonHint', { lang: targetLang === 'en' ? t('langEn') : t('langKo') })}
            testid="report-suspend-reason"
          />
          {suspend?.lang && (
            <p className="text-xs text-gold-300" role="status" data-testid="report-suspend-relang">{t('errLocaleChanged')}</p>
          )}
          {suspend?.error && <p className="text-xs text-danger" role="alert">{suspend.error}</p>}
        </div>
      </Modal>
    </li>
  );
}

/** Reference figures: what was filed, the open backlog and how long it waits, decision times, repeat reports. */
function ReportStats() {
  const { t, locale } = useT();
  const [days, setDays] = useState<(typeof REPORT_STATS_DAYS)[number]>(30);
  const { data, error, loading, reload } = useData<ReportStatsDto>(`/api/admin/reports/stats?days=${days}`);
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
        {REPORT_STATS_DAYS.map((n) => (
          <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`report-stats-${n}`}>
            {t('daysN', { n })}
          </Button>
        ))}
      </div>
      <Button size="sm" variant="subtle" onClick={() => void reload()} loading={loading}>{t('refresh')}</Button>
    </div>
  );
  if (error) return <div className="flex flex-col gap-4">{header}<LoadError error={error} onRetry={reload} /></div>;
  if (!data) return <div className="flex flex-col gap-4">{header}<Empty>{t('loading')}</Empty></div>;
  const b = data.backlog;
  const filed = data.byReason.reduce((s, x) => s + x.total, 0);
  // Durations are words ("3 h", "1분 미만"), not figures: the text face, not the monospace one.
  const avg = (ms: number | null) => (ms === null ? '—' : <span className="font-sans">{dur(t, ms)}</span>);
  const outcomeRow = (key: string, label: string, o: { total: number; open: number; resolved: number; dismissed: number; avgHandleMs: number | null }) => (
    <tr key={key}>
      <td className={td}>{label}</td>
      <td className={`${td} font-mono`}>{formatChips(o.total)}</td>
      <td className={`${td} font-mono ${o.open ? 'text-danger' : ''}`}>{formatChips(o.open)}</td>
      <td className={`${td} font-mono`}>{formatChips(o.resolved)}</td>
      <td className={`${td} font-mono`}>{formatChips(o.dismissed)}</td>
      <td className={td}>{avg(o.avgHandleMs)}</td>
    </tr>
  );
  const outcomeHead = [t('colKind'), t('statsFiledCol'), t('statusOpen'), t('statusResolved'), t('statusDismissed'), t('statsAvgCol')];
  return (
    <div className={`flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="report-stats">
      {header}
      <p className="text-xs text-ink-400">{t('statsHint')}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="report-stats-totals">
        <Stat label={t('statsFiled', { n: data.days })} value={formatChips(filed)} />
        <Stat label={t('statsOpenNow')} value={<span className={b.open ? 'text-danger' : undefined}>{formatChips(b.open)}</span>} sub={t('statsUnassignedN', { n: b.unassigned })} />
        <Stat label={t('statsOver24h')} value={<span className={b.over24h ? 'text-danger' : undefined}>{formatChips(b.over24h)}</span>} sub={t('statsOver72hN', { n: b.over72h })} />
        <Stat label={t('statsOldest')} value={avg(b.oldestOpenAt === null ? null : Date.now() - b.oldestOpenAt)} />
        <Stat label={t('statsHandled', { n: data.days })} value={formatChips(data.handled.count)} />
        <Stat label={t('statsAvgHandle')} value={avg(data.handled.avgMs)} sub={data.handled.maxMs === null ? undefined : t('statsMaxHandle', { d: dur(t, data.handled.maxMs) })} />
      </div>
      <Panel title={t('statsBacklog')}>
        <div className="flex flex-wrap gap-2 text-sm" data-testid="report-stats-severity">
          {(['none', ...REPORT_SEVERITIES] as const).map((s) => (
            <Link key={s} to={`/reports?status=open&severity=${s}`} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 hover:border-gold-500/40">
              {s === 'none' ? <Badge>{t('sevNone')}</Badge> : <Badge tone={SEV_TONE[s]}>{t(SEVERITY[s])}</Badge>}
              <span className="font-mono">{formatChips(b.bySeverity[s])}</span>
            </Link>
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
        <Panel title={t('statsByReason', { n: data.days })}>
          <div className={NOWRAP} data-testid="report-stats-reason">
            {data.byReason.length === 0 ? (
              <p className="text-sm text-ink-400">{t('noneFound')}</p>
            ) : (
              <Table head={outcomeHead}>{data.byReason.map((x) => outcomeRow(x.reason, t(REASON[x.reason]), x))}</Table>
            )}
          </div>
        </Panel>
        <Panel title={t('statsByTarget', { n: data.days })}>
          <div className={NOWRAP} data-testid="report-stats-target">
            {data.byTarget.length === 0 ? (
              <p className="text-sm text-ink-400">{t('noneFound')}</p>
            ) : (
              <Table head={outcomeHead}>{data.byTarget.map((x) => outcomeRow(x.targetType, t(TARGET[x.targetType]), x))}</Table>
            )}
          </div>
        </Panel>
      </div>
      <Panel title={t('statsRepeated', { n: data.days })}>
        <div className={`flex flex-col gap-2 ${NOWRAP}`} data-testid="report-stats-repeated">
          <p className="text-xs text-gold-300">{t('statsRepeatedHint')}</p>
          {data.repeated.length === 0 ? (
            <p className="text-sm text-ink-400">{t('noneFound')}</p>
          ) : (
            <Table head={[t('colUser'), t('status'), t('statsReportsCol'), t('statsReportersCol'), t('statusOpen'), t('statusResolved'), t('statusDismissed'), t('statsSuspensionsCol'), t('statsLastCol'), '']}>
              {data.repeated.map((x) => (
                <tr key={x.user.id} data-testid="report-repeated-row">
                  <td className={td}><Link to={`/users/${x.user.id}`} className="font-semibold text-gold-300 hover:underline">{x.user.nickname}</Link></td>
                  <td className={td}><Badge tone={x.user.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, x.user.status)}</Badge></td>
                  <td className={`${td} font-mono`}>{formatChips(x.reports)}</td>
                  <td className={`${td} font-mono`}>{formatChips(x.reporters)}</td>
                  <td className={`${td} font-mono ${x.open ? 'text-danger' : ''}`}>{formatChips(x.open)}</td>
                  <td className={`${td} font-mono`}>{formatChips(x.resolved)}</td>
                  <td className={`${td} font-mono`}>{formatChips(x.dismissed)}</td>
                  <td className={`${td} font-mono`}>{formatChips(x.suspensions)}</td>
                  <td className={`${td} text-xs text-ink-300`}>{formatDate(x.lastAt, locale)}</td>
                  <td className={td}><Link to={`/reports?status=all&userId=${x.user.id}`} className="text-gold-300 hover:underline">{t('viewReports')}</Link></td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Panel>
    </div>
  );
}

const FILTER_KEYS = ['status', 'severity', 'reason', 'targetType', 'assignee', 'sort'] as const;

export function ReportsPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'stats' ? 'stats' : params.get('view') === 'signals' ? 'signals' : 'list';
  const status = params.get('status') ?? 'open';
  const userId = params.get('userId');
  const reporterId = params.get('reporterId');
  const page = Math.max(1, Math.floor(Number(params.get('page') ?? 1)) || 1);
  const q = new URLSearchParams({ status, page: String(page), limit: String(PAGE) });
  if (userId) q.set('userId', userId);
  if (reporterId) q.set('reporterId', reporterId);
  for (const k of FILTER_KEYS) if (k !== 'status' && params.get(k)) q.set(k, params.get(k)!);
  const { data, error, reload, loading } = useData<ReportListDto>(view === 'list' ? `/api/admin/reports?${q}` : null);
  const { data: staff } = useData<{ items: Staff[] }>(view === 'list' ? '/api/admin/reports/assignees' : null);
  const [msg, setMsg] = useState<Note>(null);
  /** Changing a filter starts again from the first page. */
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };
  const tab = (v: 'list' | 'stats' | 'signals') => {
    const next = new URLSearchParams(params);
    if (v !== 'list') next.set('view', v);
    else next.delete('view');
    setParams(next);
  };
  const shown = data?.items.length ?? 0;
  const from = data ? (data.page - 1) * data.limit : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-extrabold">{t('reports')}</h1>
        {view === 'list' && data && <Badge tone={data.openCount ? 'red' : 'neutral'}>{t('openReports', { n: data.openCount })}</Badge>}
        <div className="ml-auto flex gap-1" role="tablist" aria-label={t('reports')}>
          <Button size="sm" role="tab" aria-selected={view === 'list'} variant={view === 'list' ? 'gold' : 'outline'} onClick={() => tab('list')} data-testid="report-view-list">{t('reportViewList')}</Button>
          <Button size="sm" role="tab" aria-selected={view === 'stats'} variant={view === 'stats' ? 'gold' : 'outline'} onClick={() => tab('stats')} data-testid="report-view-stats">{t('reportViewStats')}</Button>
          <Button size="sm" role="tab" aria-selected={view === 'signals'} variant={view === 'signals' ? 'gold' : 'outline'} onClick={() => tab('signals')} data-testid="report-view-signals">{t('reportViewSignals')}</Button>
        </div>
      </div>
      {view === 'stats' ? (
        <ReportStats />
      ) : view === 'signals' ? (
        <IntegritySignals />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {userId && (
              <button className="rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300" onClick={() => set('userId', null)} data-testid="report-user-filter">
                {t('reportedUser')}: {data?.items[0]?.target.nickname ?? userId} <XIcon className="inline size-3 align-[-2px]" />
              </button>
            )}
            {reporterId && (
              <button className="rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300" onClick={() => set('reporterId', null)} data-testid="report-reporter-filter">
                {t('reporterFilter')}: {data?.items[0]?.reporter.nickname ?? reporterId} <XIcon className="inline size-3 align-[-2px]" />
              </button>
            )}
            <select value={status} onChange={(e) => set('status', e.target.value)} className={selectCls} aria-label={t('status')} data-testid="report-status">
              <option value="open">{t('statusOpen')}</option>
              <option value="resolved">{t('statusResolved')}</option>
              <option value="dismissed">{t('statusDismissed')}</option>
              <option value="all">{t('statusAll')}</option>
            </select>
            <select value={params.get('severity') ?? ''} onChange={(e) => set('severity', e.target.value)} className={selectCls} aria-label={t('severity')} data-testid="report-severity-filter">
              <option value="">{t('severity')}: {t('statusAll')}</option>
              <option value="none">{t('severity')}: {t('sevNone')}</option>
              {REPORT_SEVERITIES.map((s) => <option key={s} value={s}>{t('severity')}: {t(SEVERITY[s])}</option>)}
            </select>
            <select value={params.get('reason') ?? ''} onChange={(e) => set('reason', e.target.value)} className={selectCls} aria-label={t('reason')} data-testid="report-reason-filter">
              <option value="">{t('reason')}: {t('statusAll')}</option>
              {REPORT_REASONS.map((s) => <option key={s} value={s}>{t('reason')}: {t(REASON[s])}</option>)}
            </select>
            <select value={params.get('targetType') ?? ''} onChange={(e) => set('targetType', e.target.value)} className={selectCls} aria-label={t('reportTargetType')} data-testid="report-target-filter">
              <option value="">{t('reportTargetType')}: {t('statusAll')}</option>
              {REPORT_TARGETS.map((s) => <option key={s} value={s}>{t('reportTargetType')}: {t(TARGET[s])}</option>)}
            </select>
            <select value={params.get('assignee') ?? ''} onChange={(e) => set('assignee', e.target.value)} className={selectCls} aria-label={t('assignee')} data-testid="report-assignee-filter">
              <option value="">{t('assignee')}: {t('statusAll')}</option>
              <option value="me">{t('assigneeMe')}</option>
              <option value="none">{t('unassigned')}</option>
              {staff?.items.map((s) => <option key={s.id} value={s.id}>{t('assignee')}: {s.nickname}</option>)}
            </select>
            <select value={params.get('sort') ?? 'newest'} onChange={(e) => set('sort', e.target.value === 'newest' ? null : e.target.value)} className={selectCls} aria-label={t('sortLabel')} data-testid="report-sort">
              {SORTS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
            </select>
          </div>
          <Feedback note={msg} pin />
          {error && <LoadError error={error} onRetry={reload} />}
          <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
            {data && data.items.length === 0 ? (
              <Empty>{t('noReports')}</Empty>
            ) : (
              <ul className="divide-y divide-white/5">
                {data?.items.map((r) => (
                  <ReportItem
                    key={r.id}
                    r={r}
                    staff={staff?.items ?? []}
                    onDone={(m) => {
                      setMsg(m);
                      void reload();
                    }}
                  />
                ))}
              </ul>
            )}
            {data && data.total > 0 && (
              <nav className="mt-3 flex flex-wrap items-center justify-end gap-2" aria-label={t('reports')} data-testid="report-pager">
                <span className="mr-auto text-xs text-ink-400" aria-live="polite">{t('reportPageRange', { from: from + 1, to: from + shown, total: data.total })}</span>
                <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => set('page', String(page - 1))} data-testid="report-prev">{t('prevPage')}</Button>
                <Button size="sm" variant="outline" disabled={from + shown >= data.total || loading} onClick={() => set('page', String(page + 1))} data-testid="report-next">{t('nextPage')}</Button>
              </nav>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
