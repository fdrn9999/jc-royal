/**
 * The virtual chip economy: where the chips are (wallets, tables), what was issued, how they moved per day, failures
 * and transactions worth a look; and the reconciliation events with the evidence an administrator decides on. Nothing
 * here changes a wallet by itself: a correction is chosen by a super admin, shown before → after, and confirmed.
 */
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, Stat } from '@jc/ui';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import { ledgerTypeLabel, memoLabel, roleLabel, scopeLabel, tableIssueLabel, userStatusLabel, type Tr } from '../labels';
import { errText, useAdmin, useData } from '../lib';
import { Feedback, LoadError, Modal, type Note } from '../ui';
import { Table } from './Console';

type Flow = { n: number; sum: number; plus: number; minus: number };
type LedgerType = 'signup_grant' | 'buy_in' | 'top_up' | 'cash_out' | 'admin_adjust' | 'reconcile' | 'free_refill';
type Scope = 'user_ledger' | 'table';
interface AdminRow { id: string; userId: string; nickname: string | null; amount: number; memo: string | null; actorId: string | null; actorNickname: string | null; createdAt: number }
interface Economy {
  days: number;
  since: number;
  at: number;
  d1Ms: number;
  rowsRead: number;
  wallets: { members: number; accounts: number; balance: number; deleted: number; suspended: number; staff: number };
  tables: { chips: number; openSessions: number; seatedBuyIn: number };
  issued: { signup: number; admin: number; reconcile: number; refill: number; total: number };
  ledger: { total: number; byType: Record<LedgerType, Flow> };
  gap: number;
  period: { counts: Record<LedgerType | 'auto_rebuy', Flow>; moved: number; series: { date: string; n: number; moved: number; in: number; out: number }[] };
  reconciliation: { created: Record<Scope, number>; open: Record<Scope, number>; lastRun: { at: number; mismatches: number | null; created: number | null } | null };
  failures: { from: number; cashout: number; room: number; api: number; cashoutDays: { date: string; n: number }[]; tables: { id: string; name: string; status: string; issue: string; at: number }[] };
  anomalies: {
    rapidGrants: { userId: string; nickname: string | null; count: number; sum: number; from: number; to: number; actors: (string | null)[] }[];
    largeAdjustments: AdminRow[];
    refused: { id: string; action: string; userId: string; nickname: string | null; actorId: string; actorNickname: string | null; detail: { reason?: string; amount?: number; memo?: string } | null; createdAt: number }[];
    staleSessions: { id: string; tableId: string; tableName: string | null; tableStatus: string; userId: string; nickname: string | null; buyIn: number; createdAt: number; reason: 'closed_table' | 'closing_table' | 'long' }[];
    adminRowsCapped: boolean;
  };
  thresholds: { largeAdjustment: number; rapidGrants: number; rapidWindowMs: number; staleSessionMs: number; closingAfterMs: number };
}

const PERIODS = [7, 30, 90] as const;
const HOUR = 3_600_000;
const signed = (n: number) => `${n > 0 ? '+' : ''}${formatChips(n)}`;
/** Period rows: automatic rebuys are top-ups the server made, counted apart from the ones players asked for. */
const FLOWS: [LedgerType | 'auto_rebuy', Key][] = [
  ['signup_grant', 'ledgerSignupGrant'],
  ['free_refill', 'ledgerFreeRefill'],
  ['buy_in', 'ledgerBuyIn'],
  ['top_up', 'econTopUpManual'],
  ['auto_rebuy', 'memoAutoRebuy'],
  ['cash_out', 'ledgerCashOut'],
  ['admin_adjust', 'ledgerAdminAdjust'],
  ['reconcile', 'ledgerReconcile'],
];
const REFUSAL: Record<string, Key> = { forbidden: 'refusedForbidden', large_adjustment: 'refusedLarge', insufficient_balance: 'refusedBalance' };
const STALE: Record<string, Key> = { closed_table: 'staleClosedTable', closing_table: 'staleClosingTable', long: 'staleLong' };

const td = 'px-2 py-1.5';
function UserLink({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/users/${id}`} className="text-gold-300 hover:underline">{name ?? id}</Link>;
}

function Section({ title, hint, count, testid, children }: { title: string; hint: ReactNode; count: number; testid: string; children: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testid}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <Badge tone={count ? 'red' : 'neutral'}>{count}</Badge>
      </div>
      <p className="text-xs text-ink-400">{hint}</p>
      {count === 0 ? <p className="text-sm text-ink-400">{t('noneFound')}</p> : children}
    </div>
  );
}

export function EconomyPage() {
  const { t, locale } = useT();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  // Minutes this browser's clock is ahead of UTC, so days end at the admin's own midnight.
  const tz = -new Date().getTimezoneOffset();
  const { data, error, loading, reload } = useData<Economy>(`/api/admin/economy?days=${days}&tz=${tz}`);
  const time = (ms: number) => formatDate(ms, locale);
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('economy')}</h1>
      <Link to="/economy/refill" className="text-sm text-gold-300 hover:underline" data-testid="economy-refill-link">{t('refillManage')} →</Link>
      <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
        {PERIODS.map((n) => (
          <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`economy-${n}`}>
            {t('daysN', { n })}
          </Button>
        ))}
        <Button size="sm" variant="subtle" onClick={() => void reload()} loading={loading} data-testid="economy-reload">{t('refresh')}</Button>
      </div>
    </div>
  );
  if (error) return <div className="flex flex-col gap-4">{header}<LoadError error={error} onRetry={reload} /></div>;
  if (!data) return <div className="flex flex-col gap-4">{header}<Empty>{t('loading')}</Empty></div>;
  const d = data;
  const a = d.anomalies;
  const th = d.thresholds;
  const openEvents = d.reconciliation.open.user_ledger + d.reconciliation.open.table;
  const max = Math.max(1, ...d.period.series.map((s) => s.moved));
  return (
    <div className={`flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="economy-totals">
        <Stat label={t('econWallets')} value={formatChips(d.wallets.balance)} sub={t('econWalletsSub', { n: formatChips(d.wallets.members), suspended: formatChips(d.wallets.suspended), staff: formatChips(d.wallets.staff) })} />
        <Stat label={t('econOnTables')} value={formatChips(d.tables.chips)} sub={t('econOnTablesSub', { n: d.tables.openSessions, buyIn: formatChips(d.tables.seatedBuyIn) })} />
        <Stat label={t('econIssued')} value={formatChips(d.issued.total)} sub={t('econIssuedSub', { signup: formatChips(d.issued.signup), admin: signed(d.issued.admin), rec: signed(d.issued.reconcile), refill: formatChips(d.issued.refill) })} />
        <Stat
          label={t('econGap')}
          value={<span className={d.gap ? 'text-danger' : 'text-success'} data-testid="economy-gap">{signed(d.gap)}</span>}
          sub={<Link to="/reconcile" className="text-gold-300 hover:underline">{t('econOpenEvents', { n: openEvents })} →</Link>}
        />
        <Stat label={t('econMoved', { n: d.days })} value={formatChips(d.period.moved)} sub={t('econRows', { n: formatChips(d.period.series.reduce((s, x) => s + x.n, 0)) })} />
      </div>
      <p className="text-xs text-ink-400">
        {t('econIdentity', { wallets: formatChips(d.wallets.balance), tables: formatChips(d.tables.chips), issued: formatChips(d.issued.total), gap: signed(d.gap) })} {t('econIdentityHint')}
      </p>
      {/* minmax(0, …) columns: an implicit column would grow to the flows table's minimum width (640px) on a phone, and
          two equal columns are narrower than it below the widest layout. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title={t('econPeriodTitle', { n: d.days })}>
          <div data-testid="economy-flows">
            <Table head={[t('colKind'), t('econCount'), t('econIn'), t('econOut'), t('econNet')]}>
              {FLOWS.map(([k, label]) => {
                const f = d.period.counts[k];
                return (
                  <tr key={k} data-flow={k}>
                    <td className={td}>{t(label)}</td>
                    <td className={`${td} font-mono`}>{formatChips(f.n)}</td>
                    <td className={`${td} font-mono text-success`}>{f.plus ? `+${formatChips(f.plus)}` : '0'}</td>
                    <td className={`${td} font-mono`}>{f.minus ? `-${formatChips(f.minus)}` : '0'}</td>
                    <td className={`${td} font-mono`}>{signed(f.sum)}</td>
                  </tr>
                );
              })}
            </Table>
          </div>
          <p className="mt-2 text-xs text-ink-400">{t('econFlowsHint')}</p>
        </Panel>
        <Panel title={t('econDailyTitle')}>
          <figure>
            <div role="img" aria-label={`${t('econDailyTitle')}: ${formatChips(d.period.moved)}`} className="flex h-28 items-end gap-px border-b border-white/10" data-testid="economy-chart">
              {d.period.series.map((s) => (
                <span
                  key={s.date}
                  title={t('econDay', { date: s.date, n: s.n, in: formatChips(s.in), out: formatChips(s.out) })}
                  className={`min-w-0 flex-1 rounded-t-sm ${s.moved === 0 ? 'bg-white/5' : 'bg-gold-500/70'}`}
                  style={{ height: s.moved ? `${Math.max(6, (s.moved / max) * 100)}%` : '2px' }}
                />
              ))}
            </div>
            <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-ink-400">
              <span>{d.period.series[0]?.date} – {d.period.series[d.period.series.length - 1]?.date}</span>
              <span>{t('activityBasis')}</span>
            </figcaption>
          </figure>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="economy-reconcile">
            <div>
              <dt className="text-xs text-ink-400">{t('econRecCreated', { n: d.days })}</dt>
              <dd>{t('econRecScopes', { user: d.reconciliation.created.user_ledger, table: d.reconciliation.created.table })}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-400">{t('econRecOpen')}</dt>
              <dd className={openEvents ? 'text-danger' : undefined}>{t('econRecScopes', { user: d.reconciliation.open.user_ledger, table: d.reconciliation.open.table })}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-ink-400">{t('econLastRun')}</dt>
              <dd>
                {d.reconciliation.lastRun
                  ? `${time(d.reconciliation.lastRun.at)} · ${t('reconcileResult', { n: d.reconciliation.lastRun.mismatches ?? '—', created: d.reconciliation.lastRun.created ?? '—' })}`
                  : t('econNeverRun')}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Panel title={t('econFailuresTitle')}>
        <div className="flex flex-col gap-3 text-sm" data-testid="economy-failures">
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('econCashoutFail')} value={<span className={d.failures.cashout ? 'text-danger' : undefined}>{formatChips(d.failures.cashout)}</span>} />
            <Stat label={t('econRoomError')} value={formatChips(d.failures.room)} />
            <Stat label={t('econApiError')} value={formatChips(d.failures.api)} />
          </div>
          {d.failures.cashoutDays.length > 0 && (
            <p className="text-xs text-ink-300">{d.failures.cashoutDays.map((x) => t('econFailDay', { date: x.date, n: x.n })).join(' · ')}</p>
          )}
          {d.failures.tables.length > 0 && (
            <ul className="flex flex-col gap-1">
              {d.failures.tables.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2">
                  <Link to={`/tables/${x.id}`} className="font-semibold text-gold-300 hover:underline">{x.name}</Link>
                  <Badge>{t(x.status as 'open')}</Badge>
                  <span className="break-all font-mono text-xs text-ink-400">{x.issue}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-400">{t('econFailuresHint', { from: time(d.failures.from) })}</p>
        </div>
      </Panel>
      <Panel title={t('econAnomaliesTitle')}>
        <div className="flex flex-col gap-8">
          {a.adminRowsCapped && <p className="text-xs text-danger" role="status">{t('econCapped')}</p>}
          <Section title={t('econRapid')} hint={t('econRapidHint', { n: th.rapidGrants, h: th.rapidWindowMs / HOUR })} count={a.rapidGrants.length} testid="anomaly-rapid">
            <Table head={[t('colUser'), t('econTimes'), t('econSum'), t('econWindow'), t('actor')]}>
              {a.rapidGrants.map((r) => (
                <tr key={r.userId}>
                  <td className={td}><UserLink id={r.userId} name={r.nickname} /></td>
                  <td className={`${td} font-mono`}>{r.count}</td>
                  <td className={`${td} font-mono`}>{signed(r.sum)}</td>
                  <td className={`${td} text-xs text-ink-400`}>{time(r.from)} – {time(r.to)}</td>
                  <td className={`${td} text-xs`}>{r.actors.filter(Boolean).join(', ')}</td>
                </tr>
              ))}
            </Table>
          </Section>
          <Section title={t('econLarge')} hint={t('econLargeHint', { n: formatChips(th.largeAdjustment) })} count={a.largeAdjustments.length} testid="anomaly-large">
            <Table head={[t('time'), t('colUser'), t('amount'), t('memo'), t('actor')]}>
              {a.largeAdjustments.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} text-xs text-ink-400`}>{time(r.createdAt)}</td>
                  <td className={td}><UserLink id={r.userId} name={r.nickname} /></td>
                  <td className={`${td} font-mono ${r.amount > 0 ? 'text-success' : ''}`}>{signed(r.amount)}</td>
                  <td className={`${td} text-xs text-ink-300`}>{memoLabel(t, r.memo)}</td>
                  <td className={`${td} text-xs`}>{r.actorNickname ?? r.actorId ?? '—'}</td>
                </tr>
              ))}
            </Table>
          </Section>
          <Section title={t('econRefused')} hint={t('econRefusedHint')} count={a.refused.length} testid="anomaly-refused">
            <Table head={[t('time'), t('colKind'), t('colUser'), t('amount'), t('memo'), t('actor')]}>
              {a.refused.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} text-xs text-ink-400`}>{time(r.createdAt)}</td>
                  <td className={td}>
                    {r.action === 'user.chips_duplicate' ? (
                      <Badge tone="blue">{t('econDuplicate')}</Badge>
                    ) : (
                      <Badge tone="red">{t(REFUSAL[r.detail?.reason ?? ''] ?? 'econRefusedOther')}</Badge>
                    )}
                  </td>
                  <td className={td}><UserLink id={r.userId} name={r.nickname} /></td>
                  <td className={`${td} font-mono`}>{typeof r.detail?.amount === 'number' ? signed(r.detail.amount) : '—'}</td>
                  <td className={`${td} break-all text-xs text-ink-300`}>{r.detail?.memo ?? ''}</td>
                  <td className={`${td} text-xs`}>{r.actorNickname ?? r.actorId}</td>
                </tr>
              ))}
            </Table>
          </Section>
          <Section title={t('econStale')} hint={t('econStaleHint', { h: th.staleSessionMs / HOUR, m: th.closingAfterMs / 60_000 })} count={a.staleSessions.length} testid="anomaly-stale">
            <Table head={[t('colSatAt'), t('colTable'), t('colUser'), t('buyin'), t('reason')]}>
              {a.staleSessions.map((s) => (
                <tr key={s.id}>
                  <td className={`${td} text-xs text-ink-400`}>{time(s.createdAt)}</td>
                  <td className={td}>
                    <Link to={`/tables/${s.tableId}`} className="text-gold-300 hover:underline">{s.tableName ?? s.tableId}</Link> <Badge>{t(s.tableStatus as 'open')}</Badge>
                  </td>
                  <td className={td}><UserLink id={s.userId} name={s.nickname} /></td>
                  <td className={`${td} font-mono`}>{formatChips(s.buyIn)}</td>
                  <td className={`${td} text-xs`}>{t(STALE[s.reason] ?? 'staleLong', { h: th.staleSessionMs / HOUR, m: th.closingAfterMs / 60_000 })}</td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      </Panel>
      <p className="text-xs text-ink-400" data-testid="economy-meta">
        {t('econBasis', { at: time(d.at), ms: d.d1Ms, rows: formatChips(d.rowsRead) })}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ reconciliation
type Resolution = 'note' | 'record' | 'revert';
interface ReconcileEvent {
  id: string;
  scope: Scope;
  subjectId: string;
  expected: number;
  actual: number;
  detail: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: Resolution | null;
  createdAt: number;
}
interface LedgerRow { seq: number; id: string; type: string; amount: number; balanceAfter: number; tableId: string | null; idempotencyKey: string; actorId: string | null; memo: string | null; createdAt: number }
interface WalletEvidence {
  event: ReconcileEvent;
  member: { id: string; nickname: string; status: string; role: string; balance: number } | null;
  ledger: { count: number; sum: number; checked: number; truncated: boolean };
  difference: { event: number; current: number | null };
  breaks: (LedgerRow & { expected: number; difference: number; previousAt: number | null })[];
  breakCount: number;
  afterLast: { amount: number; since: number | null };
  recorded: number;
  recent: LedgerRow[];
  openSessions: { id: string; tableId: string; seatIndex: number; buyIn: number; createdAt: number }[];
  corrections: { id: string; idempotencyKey: string; amount: number; balanceAfter: number; actorId: string | null; createdAt: number }[];
}
interface TableEvidence {
  event: ReconcileEvent;
  table: { id: string; name: string; status: string; entryBlocked: boolean; handsPaused: boolean; lastIssue: string | null } | null;
  diagnosis: {
    issues: string[];
    sessionsOnlyInD1: { id: string; userId: string; seatIndex: number; buyIn: number; nickname: string | null }[];
    seatsOnlyInRoom: { userId: string; nickname: string; tableSessionId: string }[];
  } | null;
}
type Evidence = WalletEvidence | TableEvidence;

const RESOLUTION_LABEL: Record<Resolution, Key> = { note: 'resNote', record: 'resRecord', revert: 'resRevert' };
const RESOLUTION_TONE: Record<Resolution, 'neutral' | 'blue' | 'gold'> = { note: 'neutral', record: 'blue', revert: 'gold' };
const ACTION_LABEL: Record<Resolution, Key> = { note: 'recActNote', record: 'recActRecord', revert: 'recActRevert' };
const ACTION_HINT: Record<Resolution, Key> = { note: 'recActNoteHint', record: 'recActRecordHint', revert: 'recActRevertHint' };

/** The event's text: what the server found, in the console's language, then each administrator's note in turn. */
function eventNotes(t: Tr, e: ReconcileEvent): { what: string; notes: { kind: string; text: string }[] } {
  const what = e.scope === 'table' ? t('recWhatTable') : t('recWhatWallet');
  const notes: { kind: string; text: string }[] = [];
  const parts = (e.detail ?? '').split(/ \| (resolved|note|record|revert): /);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const kind = parts[i] === 'resolved' ? 'note' : parts[i]!;
    notes.push({ kind: t(RESOLUTION_LABEL[kind as Resolution] ?? 'resNote'), text: parts[i + 1]! });
  }
  return { what, notes };
}

function StatusBadge({ e }: { e: ReconcileEvent }) {
  const { t } = useT();
  if (!e.resolvedAt) return <Badge tone="red">{t('recOpen')}</Badge>;
  const r = e.resolution ?? 'note';
  return <Badge tone={RESOLUTION_TONE[r]}>{t(RESOLUTION_LABEL[r])}</Badge>;
}

export function ReconcilePage() {
  const { t } = useT();
  const { api } = useAdmin();
  const { data, error, reload } = useData<ReconcileEvent[]>('/api/admin/reconcile');
  const [result, setResult] = useState<Note>(null);
  const [running, setRunning] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  // A correction's outcome is shown here: once resolved, the event leaves the open list and its row goes with it.
  const [notice, setNotice] = useState<string | null>(null);
  const changed = async (text?: string) => {
    if (text) setNotice(text);
    await reload();
  };
  const run = async () => {
    setRunning(true);
    setResult(null);
    setNotice(null);
    try {
      const r = await api<{ mismatches: unknown[]; created: number; acknowledged: number }>('/api/admin/reconcile/run', { body: {} });
      setResult({ ok: true, text: `${t('reconcileResult', { n: r.mismatches.length, created: r.created })}${r.acknowledged ? ` · ${t('recAcknowledged', { n: r.acknowledged })}` : ''}` });
      await reload();
    } catch (e) {
      setResult({ ok: false, text: errText(e, t) });
    } finally {
      setRunning(false);
    }
  };
  const rows = (data ?? []).filter((e) => !openOnly || !e.resolvedAt);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{t('reconcile')}</h1>
        <Link to="/economy" className="text-sm text-gold-300 hover:underline">{t('economy')} →</Link>
        <Button className="ml-auto" onClick={run} loading={running} data-testid="run-reconcile">{t('runReconcile')}</Button>
      </div>
      <Feedback note={result} testid="rec-run-result" />
      {notice && <p className="text-sm text-gold-300" role="status" data-testid="rec-result">{notice}</p>}
      <p className="text-xs text-ink-400">{t('recPolicy')}</p>
      <Panel
        actions={
          <div className="flex gap-1" role="group" aria-label={t('reconcile')}>
            <Button size="sm" variant={openOnly ? 'gold' : 'outline'} aria-pressed={openOnly} onClick={() => setOpenOnly(true)} data-testid="rec-open-only">{t('recOpenOnly')}</Button>
            <Button size="sm" variant={!openOnly ? 'gold' : 'outline'} aria-pressed={!openOnly} onClick={() => setOpenOnly(false)} data-testid="rec-all">{t('recAll')}</Button>
          </div>
        }
        title={t('recEvents')}
      >
        {error ? (
          <LoadError error={error} onRetry={reload} />
        ) : !data ? (
          <Empty>{t('loading')}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{openOnly ? t('recNoneOpen') : t('noneFound')}</Empty>
        ) : (
          // The container lets an open evidence row size itself to the visible width, not the table's minimum width.
          <div className="@container">
            <Table head={[t('time'), t('colScope'), t('colSubject'), t('colExpected'), t('colActual'), t('recDifference'), t('status'), '']}>
              {rows.map((e) => <EventRow key={e.id} e={e} onChanged={changed} />)}
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function EventRow({ e, onChanged }: { e: ReconcileEvent; onChanged: (notice?: string) => Promise<void> }) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const { what, notes } = eventNotes(t, e);
  const diff = e.actual - e.expected;
  const num = (n: number) => (e.scope === 'table' ? t('recSeats', { n }) : formatChips(n));
  return (
    <>
      <tr data-testid="rec-row" data-event-id={e.id}>
        <td className={`${td} text-xs text-ink-400`}>{formatDate(e.createdAt, locale)}</td>
        <td className={td}>{scopeLabel(t, e.scope)}</td>
        <td className={td}>
          <Link to={e.scope === 'table' ? `/tables/${e.subjectId}` : `/users/${e.subjectId}`} className="break-all font-mono text-xs text-gold-300 hover:underline">{e.subjectId}</Link>
          <span className="block text-xs text-ink-400">{what}</span>
          {notes.map((n, i) => (
            <span key={i} className="block break-all text-xs text-ink-300">{n.kind}: {n.text}</span>
          ))}
        </td>
        <td className={`${td} font-mono`}>{num(e.expected)}</td>
        <td className={`${td} font-mono`}>{num(e.actual)}</td>
        <td className={`${td} font-mono ${diff ? 'text-danger' : ''}`}>{e.scope === 'table' ? t('recSeats', { n: (diff > 0 ? '+' : '') + diff }) : signed(diff)}</td>
        <td className={td}><StatusBadge e={e} /></td>
        <td className={td}>
          <Button size="sm" variant="subtle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="rec-evidence-toggle">{open ? t('recHide') : t('recEvidence')}</Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-ink-900/40 px-3 py-4">
            {/* On a phone the table scrolls sideways; the evidence and its form stay within the visible width. */}
            <div className="sticky left-3 w-[calc(100cqw-1.5rem)]">
              <EvidencePanel id={e.id} onChanged={onChanged} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Outcome = { ok: boolean; text: string };
/** Called with what became of a resolution; the event and the list are read again either way. */
type Done = (o: Outcome) => Promise<void>;

function EvidencePanel({ id, onChanged }: { id: string; onChanged: (notice?: string) => Promise<void> }) {
  const { t } = useT();
  const { data, error, reload } = useData<Evidence>(`/api/admin/reconcile/${id}`);
  // A refusal stays by the evidence (the event is unchanged); a success goes to the page, which may drop this row.
  const [failure, setFailure] = useState<string | null>(null);
  if (error) return <LoadError error={error} onRetry={reload} />;
  if (!data) return <p className="text-sm text-ink-400">{t('loading')}</p>;
  const done: Done = async (o) => {
    setFailure(o.ok ? null : o.text);
    await Promise.all([reload(), onChanged(o.ok ? o.text : undefined)]);
  };
  return (
    <div className="flex flex-col gap-3">
      {'table' in data ? <TableEvidenceView ev={data} done={done} /> : <WalletEvidenceView ev={data} done={done} />}
      {failure && <p className="text-sm text-danger" role="alert" data-testid="rec-error">{failure}</p>}
    </div>
  );
}

function TableEvidenceView({ ev, done }: { ev: TableEvidence; done: Done }) {
  const { t } = useT();
  const tb = ev.table;
  const dg = ev.diagnosis;
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="rec-evidence">
      {!tb ? (
        <p className="text-ink-400">{t('recNoTable')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/tables/${tb.id}`} className="font-semibold text-gold-300 hover:underline">{tb.name}</Link>
          <Badge tone={tb.status === 'open' ? 'green' : 'neutral'}>{t(tb.status as 'open')}</Badge>
          {tb.handsPaused && <Badge tone="red">{t('pausedBadge')}</Badge>}
          {tb.entryBlocked && <Badge tone="red">{t('entryBlockedShort')}</Badge>}
        </div>
      )}
      {dg ? (
        <>
          {dg.issues.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {dg.issues.map((x) => <li key={x} className="text-danger">● {tableIssueLabel(t, x)}</li>)}
            </ul>
          ) : (
            <p className="text-success">{t('recTableNow')}</p>
          )}
          {dg.sessionsOnlyInD1.map((s) => (
            <p key={s.id} className="text-xs">{t('onlyInD1')}: <Link to={`/users/${s.userId}`} className="text-gold-300 hover:underline">#{s.seatIndex + 1} {s.nickname ?? s.userId}</Link> · {t('seatBuyIn', { n: formatChips(s.buyIn) })}</p>
          ))}
          {dg.seatsOnlyInRoom.map((s) => (
            <p key={s.tableSessionId} className="text-xs">{t('onlyInRoom')}: <Link to={`/users/${s.userId}`} className="text-gold-300 hover:underline">{s.nickname}</Link></p>
          ))}
        </>
      ) : (
        tb && <p className="text-ink-400">{t('recNoLive')}</p>
      )}
      <p className="text-xs text-ink-400">{t('recTableHint')}</p>
      {!ev.event.resolvedAt && <ResolveForm ev={ev} choices={['note']} done={done} />}
    </div>
  );
}

function WalletEvidenceView({ ev, done }: { ev: WalletEvidence; done: Done }) {
  const { t, locale } = useT();
  const { me } = useAdmin();
  const time = (ms: number | null) => (ms ? formatDate(ms, locale) : t('none'));
  const m = ev.member;
  const e = ev.event;
  const corrected = e.resolution === 'record' || e.resolution === 'revert';
  // After a correction the difference is gone by design; before it, a different one means the wallet moved again.
  const stale = !corrected && ev.difference.current !== ev.difference.event;
  const superAdmin = me?.user.role === 'super_admin';
  // A correction holds only while the difference is still the event's (the server refuses it otherwise).
  const correctable = !corrected && !!m && !stale;
  const choices: Resolution[] = [...(!e.resolvedAt ? (['note'] as const) : []), ...(superAdmin && correctable ? (['record', 'revert'] as const) : [])];
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="rec-evidence">
      {!m ? (
        <p className="text-ink-400">{t('recNoMember')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/users/${m.id}`} className="font-semibold text-gold-300 hover:underline">{m.nickname}</Link>
          <Badge tone={m.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, m.status)}</Badge>
          {m.role !== 'user' && <Badge tone="gold">{roleLabel(t, m.role)}</Badge>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('balance')} value={m ? formatChips(m.balance) : '—'} />
        <Stat label={t('recLedgerSum')} value={formatChips(ev.ledger.sum)} sub={t('recLedgerRows', { n: formatChips(ev.ledger.count) })} />
        <Stat label={t('recDiffNow')} value={<span className={ev.difference.current ? 'text-danger' : 'text-success'} data-testid="rec-diff-now">{ev.difference.current === null ? '—' : signed(ev.difference.current)}</span>} />
        <Stat label={t('recDiffEvent')} value={signed(ev.difference.event)} />
      </div>
      {stale && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-[#f3b0b2]" role="status" data-testid="rec-stale">{t('recStale')}</p>}
      <div className="flex flex-col gap-1" data-testid="rec-breaks">
        <h4 className="text-xs font-semibold text-ink-300">{t('recWhere')}</h4>
        {ev.afterLast.amount !== 0 && <p className="text-danger">● {t('recAfterLast', { amount: signed(ev.afterLast.amount), since: time(ev.afterLast.since) })}</p>}
        {ev.breaks.map((b) => (
          <p key={b.id} className="text-danger">
            ● {t(b.previousAt ? 'recBreak' : 'recBreakFirst', { from: time(b.previousAt), to: time(b.createdAt), diff: signed(b.difference), kind: ledgerTypeLabel(t, b.type), expected: formatChips(b.expected), actual: formatChips(b.balanceAfter) })}
          </p>
        ))}
        {ev.breakCount > ev.breaks.length && <p className="text-xs text-ink-400">{t('recMoreBreaks', { n: ev.breakCount - ev.breaks.length })}</p>}
        {ev.afterLast.amount === 0 && ev.breakCount === 0 && <p className="text-ink-400">{t('recNoBreak')}</p>}
        <p className="text-xs text-ink-400">
          {t('recChecked', { n: formatChips(ev.ledger.checked) })}
          {ev.ledger.truncated ? ` ${t('recTruncated')}` : ''}
          {ev.recorded ? ` ${t('recRecordedSum', { n: signed(ev.recorded) })}` : ''}
        </p>
      </div>
      {ev.openSessions.length > 0 && (
        <p className="text-xs text-ink-300">
          {t('recSeated')}{' '}
          {ev.openSessions.map((s) => (
            <Link key={s.id} to={`/tables/${s.tableId}`} className="mr-2 text-gold-300 hover:underline">{s.tableId} #{s.seatIndex + 1} ({t('seatBuyIn', { n: formatChips(s.buyIn) })})</Link>
          ))}
        </p>
      )}
      {ev.corrections.length > 0 && (
        <div data-testid="rec-corrections">
          <h4 className="text-xs font-semibold text-ink-300">{t('recCorrections')}</h4>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
            {ev.corrections.map((c) => (
              <li key={c.id} className="font-mono">{time(c.createdAt)} · {c.idempotencyKey.endsWith(':revert') ? t('resRevert') : t('resRecord')} · {signed(c.amount)} → {formatChips(c.balanceAfter)}</li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-xs font-semibold text-ink-300">{t('recRecent', { n: ev.recent.length })}</summary>
        <div className="mt-2">
          <Table head={[t('time'), t('colKind'), t('amount'), t('balance'), t('colTable'), t('memo')]}>
            {ev.recent.map((l) => (
              <tr key={l.id}>
                <td className={`${td} text-xs text-ink-400`}>{formatDate(l.createdAt, locale)}</td>
                <td className={td}>{ledgerTypeLabel(t, l.type)}</td>
                <td className={`${td} font-mono ${l.amount >= 0 ? 'text-success' : ''}`}>{signed(l.amount)}</td>
                <td className={`${td} font-mono`}>{formatChips(l.balanceAfter)}</td>
                <td className={`${td} text-xs`}>{l.tableId}</td>
                <td className={`${td} text-xs text-ink-300`}>{memoLabel(t, l.memo)}</td>
              </tr>
            ))}
          </Table>
        </div>
      </details>
      {choices.length > 0 && <ResolveForm ev={ev} choices={choices} done={done} />}
      {!superAdmin && correctable && <p className="text-xs text-ink-400">{t('recSuperOnly')}</p>}
    </div>
  );
}

function ResolveForm({ ev, choices, done }: { ev: Evidence; choices: Resolution[]; done: Done }) {
  const { t } = useT();
  const { api } = useAdmin();
  const [action, setAction] = useState<Resolution>(choices[0]!);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = choices.includes(action) ? action : choices[0]!;
  const wallet = 'member' in ev ? ev : null;
  const d = ev.event.actual - ev.event.expected;
  const balance = wallet?.member?.balance ?? 0;
  const sum = wallet?.ledger.sum ?? 0;
  // What the choice changes, shown before it is confirmed.
  const change =
    chosen === 'record'
      ? [t('recChangeRecord', { diff: signed(d), from: formatChips(sum), to: formatChips(sum + d) }), t('recChangeBalanceSame', { n: formatChips(balance) })]
      : chosen === 'revert'
        ? [t('recChangeRevertRows', { plus: signed(d), minus: signed(-d), sum: formatChips(sum) }), t('recChangeBalance', { from: formatChips(balance), to: formatChips(balance - d) }), t('recChangeMessage')]
        : [t('recChangeNothing')];
  const submit = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const r = await api<{ ok: true; balanceAfter?: number | null }>(`/api/admin/reconcile/${ev.event.id}/resolve`, { body: { action: chosen, note: note.trim() } });
      setNote('');
      const who = wallet?.member ? `${wallet.member.nickname} · ${t(ACTION_LABEL[chosen])}: ` : '';
      await done({ ok: true, text: who + (chosen === 'revert' && typeof r.balanceAfter === 'number' ? `${t('saved')} ${t('recBalanceNow', { n: formatChips(r.balanceAfter) })}` : t('saved')) });
    } catch (e) {
      await done({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 p-3" data-testid="rec-resolve">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink-300">{t('recChoose')}</legend>
        {choices.map((c) => (
          <label key={c} className="flex items-start gap-2">
            <input type="radio" name={`rec-${ev.event.id}`} className="mt-1 size-4 shrink-0 cursor-pointer accent-gold-500" checked={chosen === c} onChange={() => setAction(c)} data-testid={`rec-action-${c}`} />
            <span>
              <span className="font-semibold">{t(ACTION_LABEL[c])}</span>
              <span className="block text-xs text-ink-400">{t(ACTION_HINT[c])}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={note} maxLength={300} onChange={(x) => setNote(x.target.value)} data-testid="rec-note" />}</Field>
      <Button variant={chosen === 'revert' ? 'danger' : 'gold'} disabled={note.trim().length < 2} loading={busy} onClick={() => setConfirm(true)} data-testid="rec-submit">{t(ACTION_LABEL[chosen])}</Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t(ACTION_LABEL[chosen])}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{t('cancel')}</Button>
            <Button variant={chosen === 'revert' ? 'danger' : 'gold'} onClick={submit} data-testid="rec-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{t(ACTION_HINT[chosen])}</p>
          {wallet?.member && <p className="text-ink-300">{t('recConfirmFor', { name: wallet.member.nickname, diff: signed(d) })}</p>}
          <ul className="flex flex-col gap-1" data-testid="rec-change">
            {change.map((c) => (
              <li key={c} className="font-semibold"><span className="font-normal text-ink-400">{t('changeLine')}:</span> {c}</li>
            ))}
          </ul>
          <p className="break-all text-ink-300">{t('reason')}: {note.trim()}</p>
        </div>
      </Modal>
    </div>
  );
}
