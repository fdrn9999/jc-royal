import { Badge, Button, Empty, formatChips, formatDate, Panel, Stat } from '@jc/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import { useData } from '../lib';
import { Table } from './Console';

type Metric = 'ws_retry' | 'ws_drop' | 'room_error' | 'api_error';
/** Absent from an API older than these counters. */
type Later = 'action_dup' | 'recover_fail' | 'web_error';
type Counts = Record<Metric, number> & Partial<Record<Later, number>>;
/** `seated` is members; table bots are `bots`. */
interface TypeStats { tables: number; closing: number; blocked: number; occupied: number; playing: number; seated: number; bots?: number; waitlist: number; spectators: number; connections: number }
interface BusyTable {
  id: string;
  name: string;
  type: 'official' | 'member' | 'tournament';
  status: 'open' | 'closing';
  entryBlocked: boolean;
  maxSeats: number;
  seated: number;
  bots?: number;
  playing: boolean;
  waitlist: number;
  spectators: number;
  connections: number;
  liveUpdatedAt: number | null;
  lastIssue: string | null;
}
interface Live {
  /** `tournament` is absent from an API older than the tournaments release. */
  tables: { official: TypeStats; member: TypeStats; tournament?: TypeStats };
  top: BusyTable[];
  onlineUsers: number;
  ops: { slotMs: number; trend: (Counts & { at: number })[]; last5m: Counts; lastHour: Counts };
  reports: { open: number; oldest: number | null; byReason: Record<string, number> };
  warnings: {
    reconciliation: { open: number; oldest: number | null };
    stuckClosing: { id: string; name: string; since: number }[];
    seatedOnClosed: { id: string; name: string; n: number }[];
  };
  rowsRead: number;
  server: { d1LatencyMs: number; at: number };
}
interface Totals {
  users: number;
  tables: { total: number; active: number; seatedBots?: number };
  handsCompleted: number;
  handsLast24h: number;
  openTableSessions: number;
  issues: { id: string; name: string; issue: string }[];
  server: { env: string; d1LatencyMs: number; at: number };
}

/** Live figures are polled this often, and only while the page is in view and the admin was active recently. */
export const LIVE_REFRESH_MS = 30_000;
const IDLE_AFTER_MS = 5 * 60_000;
const REASON_KEY: Record<string, Key> = { spam: 'reasonSpam', abuse: 'reasonAbuse', inappropriate: 'reasonInappropriate', cheating: 'reasonCheating', other: 'reasonOther' };

/** Calls `reload` every LIVE_REFRESH_MS while the tab is visible and the admin used it within IDLE_AFTER_MS. */
function useLiveRefresh(reload: () => Promise<unknown>) {
  const [paused, setPaused] = useState(false);
  const lastFetch = useRef(Date.now());
  const lastActive = useRef(Date.now());
  useEffect(() => {
    const touch = () => {
      lastActive.current = Date.now();
    };
    const tick = () => {
      const now = Date.now();
      const watching = document.visibilityState === 'visible' && now - lastActive.current < IDLE_AFTER_MS;
      setPaused(!watching);
      if (watching && now - lastFetch.current >= LIVE_REFRESH_MS) {
        lastFetch.current = now;
        void reload();
      }
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    document.addEventListener('visibilitychange', tick);
    const id = setInterval(tick, 5_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      document.removeEventListener('visibilitychange', tick);
      clearInterval(id);
    };
  }, [reload]);
  const now = useCallback(async () => {
    lastFetch.current = Date.now();
    await reload();
  }, [reload]);
  return { paused, refreshNow: now };
}

function useAge() {
  const { t } = useT();
  return (since: number, now: number) => {
    const min = Math.max(0, Math.floor((now - since) / 60_000));
    if (min < 60) return t('ageMin', { n: min });
    if (min < 48 * 60) return t('ageHour', { n: Math.floor(min / 60) });
    return t('ageDay', { n: Math.floor(min / 1440) });
  };
}

const timeOf = (ms: number, locale: string) => new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { timeStyle: 'medium' }).format(ms);
const avg = (sum: number, n: number) => (n > 0 ? (Math.round((sum / n) * 10) / 10).toString() : '—');

export function DashboardPage() {
  const { t, locale } = useT();
  const live = useData<Live>('/api/admin/ops/live');
  const totals = useData<Totals>('/api/admin/dashboard');
  const { paused, refreshNow } = useLiveRefresh(live.reload);
  const [busy, setBusy] = useState(false);
  const d = live.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold">{t('dashboard')}</h1>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-400">
          <span data-testid="live-state" className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${paused ? 'bg-ink-500' : 'bg-success'}`} />
            {paused ? t('livePaused') : t('liveOn', { s: LIVE_REFRESH_MS / 1000 })}
          </span>
          {d && (
            <span data-testid="live-meta">
              {t('updatedAt', { time: timeOf(d.server.at, locale) })} · {t('liveCost', { ms: d.server.d1LatencyMs, n: formatChips(d.rowsRead) })}
            </span>
          )}
          <Button
            size="sm"
            variant="subtle"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void refreshNow().finally(() => setBusy(false));
            }}
          >
            {busy ? t('loading') : t('refresh')}
          </Button>
        </div>
      </div>

      {live.error && (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-[#f0a0a2]">
          {d ? t('refreshFailedStale', { msg: live.error }) : t('loadFailed', { msg: live.error })}
        </p>
      )}
      {!d ? (
        !live.error && <Empty>{t('loading')}</Empty>
      ) : (
        <>
          <LiveFigures d={d} />
          <div className="grid gap-6 lg:grid-cols-2">
            <OpsPanel d={d} />
            <div className="flex flex-col gap-6">
              <WarningsPanel d={d} />
              <ReportsPanel d={d} />
            </div>
          </div>
          <BusyTables d={d} />
        </>
      )}
      <TotalsPanel totals={totals} />
    </div>
  );
}

function LiveFigures({ d }: { d: Live }) {
  const { t } = useT();
  const { official: o, member: m } = d.tables;
  // Tournament tables count toward every total; they get their own figure only when there are any.
  const tn = d.tables.tournament;
  const all = [o, m, ...(tn ? [tn] : [])];
  const sum = (k: keyof TypeStats) => all.reduce((s, x) => s + (x[k] ?? 0), 0);
  const occupied = sum('occupied');
  const seated = sum('seated');
  const bots = sum('bots');
  return (
    <section aria-labelledby="live-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="live-title" className="text-sm font-bold tracking-[0.06em] text-gold-300">{t('liveTitle')}</h2>
        <span className="text-xs text-ink-400">{t('basisRoom')}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="dashboard">
        <Stat label={t('onlineUsers')} value={formatChips(d.onlineUsers)} sub={t('basisOnline')} />
        <Stat label={t('wsConnections')} value={formatChips(sum('connections'))} />
        <Stat label={t('handsInPlay')} value={formatChips(sum('playing'))} />
        <Stat label={t('waitingPlayers')} value={formatChips(sum('waitlist'))} />
        <Stat label={t('officialTables')} value={formatChips(o.tables)} sub={typeSub(t, o)} />
        <Stat label={t('memberRooms')} value={formatChips(m.tables)} sub={typeSub(t, m)} />
        <Stat label={t('avgSeated')} value={avg(seated, occupied)} sub={bots ? `${t('seatedOver', { n: seated, tables: occupied })} · ${t('botsN', { n: bots })}` : t('seatedOver', { n: seated, tables: occupied })} />
        <Stat label={t('watchers')} value={formatChips(sum('spectators'))} sub={t('perTable', { v: avg(sum('spectators'), occupied) })} />
        {tn && tn.tables > 0 && <Stat label={t('tournamentTables')} value={formatChips(tn.tables)} sub={typeSub(t, tn)} />}
      </div>
    </section>
  );
}

function typeSub(t: ReturnType<typeof useT>['t'], s: TypeStats) {
  const parts = [t('occupiedN', { n: s.occupied })];
  if (s.closing) parts.push(t('closingN', { n: s.closing }));
  if (s.blocked) parts.push(t('blockedN', { n: s.blocked }));
  return parts.join(' · ');
}

const SERIES: { key: Metric | 'errors'; label: Key; color: string }[] = [
  { key: 'ws_drop', label: 'legendDrop', color: 'bg-danger' },
  { key: 'ws_retry', label: 'legendRetry', color: 'bg-info' },
  { key: 'errors', label: 'legendErrors', color: 'bg-gold-500' },
];
const valueOf = (c: Counts, k: Metric | 'errors') => (k === 'errors' ? c.room_error + c.api_error : c[k]);

function OpsPanel({ d }: { d: Live }) {
  const { t, locale } = useT();
  const { last5m, lastHour, trend } = d.ops;
  const err5 = last5m.room_error + last5m.api_error;
  const err60 = lastHour.room_error + lastHour.api_error;
  const max = Math.max(1, ...trend.flatMap((s) => SERIES.map((x) => valueOf(s, x.key))));
  return (
    <Panel title={t('opsTitle')}>
      <p className="-mt-2 mb-3 text-xs text-ink-400">{t('opsBasis')}</p>
      <div className="grid grid-cols-2 gap-3" data-testid="ops-stats">
        <Stat label={t('errors5m')} value={<span className={err5 ? 'text-danger' : undefined}>{formatChips(err5)}</span>} sub={t('errorSplit', { room: last5m.room_error, api: last5m.api_error })} />
        <Stat label={t('errors1h')} value={formatChips(err60)} sub={t('errorSplit', { room: lastHour.room_error, api: lastHour.api_error })} />
        <Stat label={t('drops1h')} value={formatChips(lastHour.ws_drop)} />
        <Stat label={t('retries1h')} value={formatChips(lastHour.ws_retry)} />
        <Stat label={t('actionDup1h')} value={<span data-testid="ops-action-dup">{formatChips(lastHour.action_dup ?? 0)}</span>} sub={t('recoverFailN', { n: lastHour.recover_fail ?? 0 })} />
        <Stat label={t('webErrors1h')} value={<span data-testid="ops-web-error">{formatChips(lastHour.web_error ?? 0)}</span>} sub={t('webErrorsSub')} />
      </div>
      <figure className="mt-4" data-testid="ops-trend">
        <div
          role="img"
          aria-label={t('trendAria', { drop: lastHour.ws_drop, retry: lastHour.ws_retry, errors: err60 })}
          className="flex h-20 items-end gap-1 border-b border-white/10"
        >
          {trend.map((s) => (
            <div
              key={s.at}
              className="flex h-full flex-1 items-end justify-center gap-px"
              title={`${timeOf(s.at, locale)} · ${SERIES.map((x) => `${t(x.label)} ${valueOf(s, x.key)}`).join(' · ')}`}
            >
              {SERIES.map((x) => {
                const v = valueOf(s, x.key);
                return <span key={x.key} className={`w-full max-w-2 rounded-t-sm ${v ? x.color : 'bg-white/5'}`} style={{ height: v ? `${Math.max(6, (v / max) * 100)}%` : '2px' }} />;
              })}
            </div>
          ))}
        </div>
        <figcaption className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-400">
          <span>{t('trendSpan', { start: timeOf(trend[0]!.at, locale) })}</span>
          <span className="flex gap-3">
            {SERIES.map((x) => (
              <span key={x.key} className="inline-flex items-center gap-1">
                <span aria-hidden className={`size-2 rounded-sm ${x.color}`} />
                {t(x.label)}
              </span>
            ))}
          </span>
        </figcaption>
      </figure>
    </Panel>
  );
}

function WarningsPanel({ d }: { d: Live }) {
  const { t, locale } = useT();
  const age = useAge();
  const w = d.warnings;
  const err5 = d.ops.last5m.room_error + d.ops.last5m.api_error;
  const items: { key: string; node: ReactNode }[] = [];
  if (w.reconciliation.open > 0)
    items.push({
      key: 'recon',
      node: (
        <Link className="text-gold-300 underline-offset-2 hover:underline" to="/reconcile">
          {t('warnRecon', { n: w.reconciliation.open, age: age(w.reconciliation.oldest ?? d.server.at, d.server.at) })}
        </Link>
      ),
    });
  for (const s of w.stuckClosing)
    items.push({
      key: `stuck-${s.id}`,
      node: (
        <>
          {t('warnStuck', { age: age(s.since, d.server.at) })} — <Link className="text-gold-300" to={`/tables/${s.id}`}>{s.name}</Link>
        </>
      ),
    });
  for (const s of w.seatedOnClosed)
    items.push({
      key: `orphan-${s.id}`,
      node: (
        <>
          {t('warnOrphan', { n: s.n })} — <Link className="text-gold-300" to={`/tables/${s.id}`}>{s.name}</Link>
        </>
      ),
    });
  if (err5 > 0) items.push({ key: 'errors', node: t('warnErrors', { n: err5 }) });
  return (
    <Panel title={t('warningsTitle')}>
      {items.length === 0 ? (
        <p className="text-sm text-[#7fd3a3]" data-testid="warnings-none">{t('noWarnings')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm" data-testid="warnings">
          {items.map((i) => (
            <li key={i.key} className="flex gap-2">
              <span aria-hidden className="text-danger">●</span>
              <span>{i.node}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-ink-400">{t('warningsBasis', { time: formatDate(d.server.at, locale) })}</p>
    </Panel>
  );
}

function ReportsPanel({ d }: { d: Live }) {
  const { t } = useT();
  const age = useAge();
  const r = d.reports;
  return (
    <Panel
      title={t('reportsPending')}
      actions={
        <Link to="/reports" className="text-xs font-semibold text-gold-300 hover:underline">
          {t('goReports')}
        </Link>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2" data-testid="reports-pending">
        <span className="font-mono text-2xl font-semibold tabular-nums">{formatChips(r.open)}</span>
        {r.oldest !== null && <span className="text-xs text-ink-400">{t('oldestOpen', { age: age(r.oldest, d.server.at) })}</span>}
      </div>
      {r.open > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(r.byReason).map(([k, n]) => (
            <Badge key={k} tone={k === 'cheating' ? 'red' : 'neutral'}>
              {REASON_KEY[k] ? t(REASON_KEY[k]) : k} {n}
            </Badge>
          ))}
        </div>
      )}
    </Panel>
  );
}

function BusyTables({ d }: { d: Live }) {
  const { t, locale } = useT();
  const age = useAge();
  return (
    <Panel title={t('busyTables')}>
      {d.top.length === 0 ? (
        <Empty>{t('noBusyTables')}</Empty>
      ) : (
        <Table head={[t('name'), t('colType'), t('colSeated'), t('colHand'), t('colWaitlist'), t('colWatchers'), t('colConns'), t('colReported')]}>
          {d.top.map((tb) => (
            <tr key={tb.id} data-testid="busy-table">
              <td className="px-2 py-2">
                <Link className="font-semibold text-gold-300" to={`/tables/${tb.id}`}>{tb.name}</Link>
                {tb.lastIssue && <div className="mt-0.5 max-w-[22rem] truncate text-[11px] text-[#f0a0a2]" title={tb.lastIssue}>{t('lastIssue')}: <span className="font-mono">{tb.lastIssue}</span></div>}
              </td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={tb.type === 'member' ? 'blue' : 'gold'}>{t(tb.type === 'official' ? 'typeOfficial' : tb.type === 'tournament' ? 'tournamentRoom' : 'typeMember')}</Badge>
                  {tb.status === 'closing' && <Badge tone="red">{t('closing')}</Badge>}
                  {tb.entryBlocked && tb.status !== 'closing' && <Badge>{t('entryBlockedShort')}</Badge>}
                </div>
              </td>
              <td className="px-2 py-2 font-mono tabular-nums">{tb.seated}{tb.bots ? <span className="text-info" title={t('botsN', { n: tb.bots })}> +{tb.bots}</span> : null} / {tb.maxSeats}</td>
              <td className="px-2 py-2">{tb.playing ? <Badge tone="green">{t('inHand')}</Badge> : <span className="text-ink-400">{t('betweenHands')}</span>}</td>
              <td className="px-2 py-2 font-mono tabular-nums">{tb.waitlist}</td>
              <td className="px-2 py-2 font-mono tabular-nums">{tb.spectators}</td>
              <td className="px-2 py-2 font-mono tabular-nums">{tb.connections}</td>
              <td className="px-2 py-2 text-xs text-ink-400" title={tb.liveUpdatedAt ? formatDate(tb.liveUpdatedAt, locale) : undefined}>
                {tb.liveUpdatedAt ? t('agoShort', { age: age(tb.liveUpdatedAt, d.server.at) }) : t('neverReported')}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function TotalsPanel({ totals }: { totals: ReturnType<typeof useData<Totals>> }) {
  const { t, locale } = useT();
  const d = totals.data;
  return (
    <Panel
      title={t('totalsTitle')}
      actions={
        <Button size="sm" variant="ghost" onClick={() => void totals.reload()}>
          {t('refresh')}
        </Button>
      }
    >
      {totals.error ? (
        <p role="alert" className="text-sm text-danger">{t('loadFailed', { msg: totals.error })}</p>
      ) : !d ? (
        <Empty>{t('loading')}</Empty>
      ) : (
        <>
          <p className="-mt-2 mb-3 text-xs text-ink-400">{t('totalsAsOf', { time: formatDate(d.server.at, locale) })}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="totals">
            <Stat label={t('totalUsers')} value={formatChips(d.users)} />
            <Stat label={t('activeTables')} value={`${d.tables.active} / ${d.tables.total}`} />
            <Stat label={t('handsCompleted')} value={formatChips(d.handsCompleted)} sub={t('hands24hN', { n: formatChips(d.handsLast24h) })} />
            <Stat label={t('openSeats')} value={formatChips(d.openTableSessions)} sub={d.tables.seatedBots ? t('botsSeatedApart', { n: d.tables.seatedBots }) : undefined} />
            <Stat label={t('serverStatus')} value={<span className="text-success">{t('serverOk')}</span>} sub={`${d.server.env} · D1 ${d.server.d1LatencyMs}ms`} />
          </div>
          <h3 className="mb-2 mt-5 text-xs font-bold tracking-[0.06em] text-ink-300">{t('issues')}</h3>
          {d.issues.length === 0 ? (
            <p className="text-sm text-ink-400">{t('noIssues')}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {d.issues.map((i) => (
                <li key={i.id} className="break-words">
                  <Link className="text-gold-300" to={`/tables/${i.id}`}>{i.name}</Link> — {i.issue}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
