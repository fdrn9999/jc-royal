/**
 * Member detail panels added for member management: recent tables, reports by and about the member, play activity by
 * period, and the administrators' history of the account with internal notes.
 */
import { Badge, Button, Empty, formatChips, formatDate, Panel, Stat } from '@jc/ui';
import type { ReportReason, ReportStatus } from '@jc/types';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useT } from '../i18n';
import { auditActionLabel, roleLabel, userStatusLabel, type Tr } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { jumpTarget, LoadError, Modal } from '../ui';
import { Table } from './Console';
import { REASON, STATUS } from './Reports';

export interface RecentTable {
  id: string;
  tableId: string;
  tableName: string | null;
  roomType: 'official' | 'member' | null;
  seatIndex: number;
  buyIn: number;
  cashOut: number | null;
  status: 'seated' | 'closed';
  createdAt: number;
  closedAt: number | null;
}

export function RecentTablesPanel({ rows }: { rows: RecentTable[] }) {
  const { t, locale } = useT();
  return (
    <Panel title={t('recentTablesTitle')}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-400">{t('noRecentTables')}</p>
      ) : (
        <div data-testid="recent-tables">
          <Table head={[t('colTable'), t('buyin'), t('colCashOut'), t('colSatAt'), t('colLeftAt')]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-1.5">
                  <Link to={`/tables/${r.tableId}`} className="font-semibold text-gold-300 hover:underline">{r.tableName ?? r.tableId}</Link>
                  {r.roomType === 'member' && <Badge tone="blue" className="ml-1">{t('memberRoom')}</Badge>}
                </td>
                <td className="px-2 py-1.5 font-mono">{formatChips(r.buyIn)}</td>
                <td className="px-2 py-1.5 font-mono">{r.status === 'seated' ? <Badge tone="green" className="font-sans">{t('seatedNow')}</Badge> : r.cashOut === null ? '—' : formatChips(r.cashOut)}</td>
                <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(r.createdAt, locale)}</td>
                <td className="px-2 py-1.5 text-xs text-ink-400">{r.closedAt ? formatDate(r.closedAt, locale) : '—'}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Panel>
  );
}

type Counts = { open: number; resolved: number; dismissed: number; total: number };
type ReportBrief = { id: string; targetType: string; reason: ReportReason; status: ReportStatus; createdAt: number; otherNickname: string };
export interface MemberReports { filed: Counts; against: Counts; recentFiled: ReportBrief[]; recentAgainst: ReportBrief[] }

/** `hidden`: the reports feature is off for this administrator, so the server sent the counts without the latest reports. */
export function MemberReportsPanel({ userId, reports, hidden = false }: { userId: string; reports: MemberReports; hidden?: boolean }) {
  const { t, locale } = useT();
  const side = (title: string, counts: Counts, recent: ReportBrief[], link: string, other: 'reportBy' | 'reportAbout', testid: string) => (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testid}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <span className="font-mono text-lg font-semibold">{counts.total}</span>
        {counts.total > 0 && !hidden && <Link to={link} className="ml-auto text-xs text-gold-300 hover:underline">{t('viewAll')} →</Link>}
      </div>
      <p className="text-xs text-ink-400">{t('reportCounts', counts)}</p>
      {recent.length > 0 && (
        <ul className="divide-y divide-white/5 text-sm">
          {recent.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
              <Badge tone="gold">{t(REASON[r.reason] ?? 'reasonOther')}</Badge>
              <Badge tone={r.status === 'open' ? 'red' : r.status === 'resolved' ? 'green' : 'neutral'}>{t(STATUS[r.status] ?? 'statusOpen')}</Badge>
              <span className="min-w-0 truncate text-xs text-ink-300">{t(other, { name: r.otherNickname })}</span>
              <span className="ml-auto text-xs text-ink-400">{formatDate(r.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <Panel title={t('memberReportsTitle')}>
      {hidden && <p className="mb-3 text-xs text-ink-400" data-testid="reports-hidden">{t('hiddenReports')}</p>}
      <div className="grid gap-6 sm:grid-cols-2">
        {side(t('reportsAgainst'), reports.against, reports.recentAgainst, `/reports?status=all&userId=${userId}`, 'reportBy', 'reports-against')}
        {side(t('reportsFiled'), reports.filed, reports.recentFiled, `/reports?status=all&reporterId=${userId}`, 'reportAbout', 'reports-filed')}
      </div>
    </Panel>
  );
}

interface Activity {
  days: number;
  series: { date: string; hands: number; net: number; wins: number; showdowns: number }[];
  totals: { hands: number; net: number; wins: number; showdowns: number; activeDays: number; seatings: number; tables: number; buyIn: number };
}

const PERIODS = [7, 30, 90] as const;

export function MemberActivityPanel({ userId }: { userId: string }) {
  const { t } = useT();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  // Minutes this browser's clock is ahead of UTC, so days end at the admin's own midnight.
  const tz = -new Date().getTimezoneOffset();
  const { data, error, loading, reload } = useData<Activity>(`/api/admin/users/${userId}/activity?days=${days}&tz=${tz}`);
  const max = Math.max(1, ...(data?.series.map((d) => d.hands) ?? []));
  const signed = (n: number) => `${n > 0 ? '+' : ''}${formatChips(n)}`;
  return (
    <Panel
      title={t('activityTitle')}
      actions={
        <div className="flex gap-1" role="group" aria-label={t('activityTitle')}>
          {PERIODS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`activity-${n}`}>
              {t('daysN', { n })}
            </Button>
          ))}
        </div>
      }
    >
      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : !data ? (
        <Empty>{t('loading')}</Empty>
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="activity">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('actHands')} value={formatChips(data.totals.hands)} />
            <Stat label={t('actNet')} value={<span className={data.totals.net < 0 ? 'text-danger' : data.totals.net > 0 ? 'text-success' : undefined}>{signed(data.totals.net)}</span>} />
            <Stat label={t('actWins')} value={formatChips(data.totals.wins)} sub={data.totals.hands ? `${Math.round((data.totals.wins / data.totals.hands) * 100)}%` : undefined} />
            <Stat label={t('actDays')} value={`${data.totals.activeDays}/${data.days}`} />
          </div>
          <p className="text-xs text-ink-300">{t('actSeatings', { n: data.totals.seatings, tables: data.totals.tables, buyIn: formatChips(data.totals.buyIn) })}</p>
          <figure>
            <div role="img" aria-label={`${t('activityChart')}: ${t('actHands')} ${data.totals.hands}, ${t('actDays')} ${data.totals.activeDays}/${data.days}`} className="flex h-24 items-end gap-px border-b border-white/10">
              {data.series.map((d) => (
                <span
                  key={d.date}
                  title={t('activityDay', { date: d.date, hands: d.hands, net: signed(d.net) })}
                  className={`min-w-0 flex-1 rounded-t-sm ${d.hands === 0 ? 'bg-white/5' : d.net < 0 ? 'bg-danger/70' : 'bg-gold-500/70'}`}
                  style={{ height: d.hands ? `${Math.max(6, (d.hands / max) * 100)}%` : '2px' }}
                />
              ))}
            </div>
            <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-ink-400">
              <span>{data.series[0]?.date} – {data.series[data.series.length - 1]?.date}</span>
              <span>{t('activityBasis')}</span>
            </figcaption>
          </figure>
        </div>
      )}
    </Panel>
  );
}

interface TimelineItem {
  id: string;
  action: string;
  createdAt: number;
  actor: { id: string; nickname: string | null };
  detail: Record<string, unknown> | null;
  body: string | null;
}
/** A page of history; the next one starts after the last item shown (its time and id). */
interface Page { items: TimelineItem[]; nextBefore: number | null; nextBeforeId: string | null }
type Cursor = { at: number; id: string } | null;
const cursorOf = (p: Page): Cursor => (p.nextBefore !== null && p.nextBeforeId ? { at: p.nextBefore, id: p.nextBeforeId } : null);
type Kind = 'all' | 'sanction' | 'chips' | 'note';
const KINDS: { kind: Kind; label: 'histAll' | 'histSanction' | 'histChips' | 'histNotes' }[] = [
  { kind: 'all', label: 'histAll' },
  { kind: 'sanction', label: 'histSanction' },
  { kind: 'chips', label: 'histChips' },
  { kind: 'note', label: 'histNotes' },
];

/** One line per thing the record says: reason, before → after, amounts, what reached the tables. */
function describe(t: Tr, it: TimelineItem): string[] {
  const d = it.detail ?? {};
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const out: string[] = [];
  if (it.action === 'note') return it.body ? [it.body] : [];
  if (it.action === 'user.role' && str('from') && str('to')) out.push(t('histChange', { from: roleLabel(t, str('from')), to: roleLabel(t, str('to')) }));
  if ((it.action === 'user.suspend' || it.action === 'user.unsuspend') && str('from') && str('to') && str('from') !== str('to')) {
    out.push(t('histChange', { from: userStatusLabel(t, str('from')), to: userStatusLabel(t, str('to')) }));
  }
  if (it.action === 'user.chips' && num('amount') !== null) out.push(`${num('amount')! > 0 ? '+' : ''}${formatChips(num('amount')!)}${str('memo') ? ` · ${str('memo')}` : ''}`);
  if (it.action === 'user.reconcile') {
    out.push(`${t(str('action') === 'revert' ? 'resRevert' : 'resRecord')} · ${t('recDifference')} ${num('difference')! > 0 ? '+' : ''}${formatChips(num('difference') ?? 0)}`);
    if (num('balanceBefore') !== null && num('balanceAfter') !== null && num('balanceBefore') !== num('balanceAfter')) {
      out.push(t('histChange', { from: formatChips(num('balanceBefore')!), to: formatChips(num('balanceAfter')!) }));
    }
    if (str('note')) out.push(t('histNote', { r: str('note')! }));
  }
  if (str('reason')) out.push(t('histReason', { r: str('reason')! }));
  if (it.action === 'user.unsuspend' && str('suspendedReason')) out.push(t('histPrevReason', { r: str('suspendedReason')! }));
  if (it.action === 'user.suspend' && str('reportId')) out.push(t('histFromReport'));
  if (num('sessions')) out.push(t('histSessions', { n: num('sessions')! }));
  const kick = d.kick as { sockets?: number } | undefined;
  if (kick && typeof kick.sockets === 'number') out.push(t('histKick', { sockets: kick.sockets }));
  if (it.action === 'user.reset_link' && d.mailed === true) out.push(t('histMailed'));
  if (it.action.startsWith('report.') && num('closed') !== null) out.push(t('histReportClosed', { n: num('closed')! }) + (d.hidden === true ? ` · ${t('histHidden')}` : ''));
  if (it.action.startsWith('report.') && str('note')) out.push(t('histNote', { r: str('note')! }));
  return out;
}

const SANCTION_TONE: Record<string, 'red' | 'green' | 'gold' | 'blue' | 'neutral'> = {
  'user.suspend': 'red',
  'user.unsuspend': 'green',
  'user.disconnect': 'red',
  'user.role': 'gold',
  'user.chips': 'blue',
  'user.reconcile': 'gold',
  note: 'neutral',
};

export function MemberHistoryPanel({ userId }: { userId: string }) {
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const [kind, setKind] = useState<Kind>('all');
  const { data, error, reload, loading } = useData<Page>(`/api/admin/users/${userId}/timeline?kind=${kind}`);
  const [more, setMore] = useState<{ kind: Kind; items: TimelineItem[]; next: Cursor } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [del, setDel] = useState<TimelineItem | null>(null);
  const extra = more?.kind === kind ? more : null;
  const items = [...(data?.items ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : data ? cursorOf(data) : null;
  const refresh = async () => {
    setMore(null);
    await reload();
  };
  const loadMore = async () => {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const r = await api<Page>(`/api/admin/users/${userId}/timeline?kind=${kind}&before=${next.at}&beforeId=${encodeURIComponent(next.id)}`);
      setMore({ kind, items: [...(extra?.items ?? []), ...r.items], next: cursorOf(r) });
    } catch (e) {
      setMsg(errText(e, t));
    } finally {
      setLoadingMore(false);
    }
  };
  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api(`/api/admin/users/${userId}/notes`, { body: { body: note } });
      setNote('');
      await refresh();
    } catch (x) {
      setMsg(errText(x, t));
    } finally {
      setSaving(false);
    }
  };
  const removeNote = async () => {
    const n = del;
    setDel(null);
    if (!n) return;
    setMsg(null);
    try {
      await api(`/api/admin/users/${userId}/notes/${n.id}`, { method: 'DELETE' });
      await refresh();
    } catch (x) {
      if (!(x instanceof ApiError && x.code === 'reauth_cancelled')) setMsg(errText(x, t));
    }
  };
  const canDelete = (it: TimelineItem) => it.action === 'note' && (it.actor.id === me?.user.id || me?.user.role === 'super_admin');
  return (
    <Panel title={t('historyTitle')} id="member-history" className={jumpTarget}>
      <form className="flex flex-col gap-2" onSubmit={addNote} data-testid="note-form">
        <textarea
          className="min-h-20 w-full rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-sm text-ivory placeholder:text-ink-400 focus:border-gold-500/70 focus:outline-none focus:ring-2 focus:ring-gold-500/20"
          placeholder={t('notePlaceholder')}
          aria-label={t('notePlaceholder')}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="note-input"
        />
        <div className="flex flex-wrap items-start gap-3">
          <p className="min-w-0 flex-1 basis-60 break-keep text-xs text-ink-400">{t('notePurpose')}</p>
          <span className="font-mono text-xs text-ink-400">{note.length}/500</span>
          <Button type="submit" size="sm" loading={saving} disabled={note.trim().length < 2} data-testid="note-add">{t('addNote')}</Button>
        </div>
      </form>
      {msg && <p className="mt-2 text-sm text-danger" role="alert">{msg}</p>}
      <div className="mt-4 flex flex-wrap gap-1" role="group" aria-label={t('historyTitle')}>
        {KINDS.map((k) => (
          <Button key={k.kind} size="sm" variant={kind === k.kind ? 'gold' : 'outline'} aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)} data-testid={`history-${k.kind}`}>
            {t(k.label)}
          </Button>
        ))}
      </div>
      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : !data ? (
        <Empty>{t('loading')}</Empty>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-ink-400">{t('noHistory')}</p>
      ) : (
        <ol className={`mt-3 flex flex-col divide-y divide-white/5 ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="history">
          {items.map((it) => (
            <li key={`${it.action}:${it.id}`} className="flex flex-col gap-1 py-2" data-testid="history-item">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SANCTION_TONE[it.action] ?? 'neutral'}>{auditActionLabel(t, it.action)}</Badge>
                <span className="text-xs text-ink-300">{it.actor.nickname ?? it.actor.id}</span>
                <span className="text-xs text-ink-400">{formatDate(it.createdAt, locale)}</span>
                {canDelete(it) && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDel(it)} data-testid="note-delete">{t('delete')}</Button>
                )}
              </div>
              {describe(t, it).map((line, i) => (
                <p key={i} className={`break-words text-sm ${it.action === 'note' ? 'whitespace-pre-wrap text-ink-100' : 'text-ink-200'}`}>{line}</p>
              ))}
            </li>
          ))}
        </ol>
      )}
      {next !== null && items.length > 0 && (
        <div className="mt-2">
          <Button size="sm" variant="subtle" onClick={loadMore} loading={loadingMore} data-testid="history-more">{t('loadMore')}</Button>
        </div>
      )}
      <Modal
        open={del !== null}
        onClose={() => setDel(null)}
        title={t('delete')}
        footer={<><Button variant="ghost" onClick={() => setDel(null)}>{t('cancel')}</Button><Button variant="danger" onClick={removeNote} data-testid="note-delete-confirm">{t('delete')}</Button></>}
      >
        <p className="text-sm">{t('noteDeleteConfirm')}</p>
      </Modal>
    </Panel>
  );
}
