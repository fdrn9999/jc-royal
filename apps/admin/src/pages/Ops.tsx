/**
 * The control center's persistent alerts and operations log (docs/CONTROL_CENTER.md '지속 경고와 운영 기록'): what the
 * api's minute check found wrong and every administrator's table control, kept in D1, so an administrator who opens the
 * console again finds them; and one alert on one screen with its table, its log, the alerts around it and the table's
 * controls (the same re-authenticated actions as the control center's panel).
 */
import {
  OPS_ALERT_CODES,
  OPS_ALERT_STATES,
  OPS_EVENT_KINDS,
  OPS_HANDLINGS,
  OPS_SEVERITIES,
  type AdminMonitorEvent,
  type MonitorRoomsResponse,
  type OpsAlertDto,
  type OpsAlertsResponse,
  type OpsEventDto,
  type OpsEventsResponse,
  type OpsHandling,
  type OpsIncidentResponse,
  type OpsWatchDto,
} from '@jc/types';
import { Badge, Button, cx, Empty, formatDate, Panel, XIcon } from '@jc/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAdminChanges } from '../adminChanges';
import { useT, type Key } from '../i18n';
import type { Tr } from '../labels';
import { errText, hasGrant, useAdmin, useData } from '../lib';
import { applyRooms, freshnessOf, levelOf, problemsOf, type RoomEntry } from '../monitor';
import { HANDLING_KEY, metricLabel, opsAlertText, opsEventText, sevLevel } from '../opsText';
import { dayStart, Feedback, LoadError, Pager, PageState, type Note } from '../ui';
import { Table } from './Console';
import { ControlSection, LEVEL_KEY, LevelChip, TableHealth, useNow } from './ControlCenter';

type Cursor = { at: number; id: string };
const PAGE = 50;
const selectCls = 'h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const chipCls = 'rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300';
const TABS = ['alerts', 'events'] as const;
type Tab = (typeof TABS)[number];
const ALERT_FILTERS = ['state', 'severity', 'code', 'table'] as const;
const EVENT_FILTERS = ['kind', 'severity', 'table', 'from', 'to'] as const;

const STATE_KEY: Record<(typeof OPS_ALERT_STATES)[number], Key> = { open: 'opsStateOpen', resolved: 'opsStateResolved', all: 'statusAll' };
const KIND_KEY: Record<OpsEventDto['kind'], Key> = {
  alert_opened: 'opsKindOpened',
  alert_raised: 'opsKindRaised',
  alert_resolved: 'opsKindResolved',
  alert_handled: 'opsKindHandled',
  admin_control: 'opsKindControl',
};
const codeText = (t: Tr, code: string) => t(`opsCode_${code}` as Key);

function SevChip({ s }: { s: OpsAlertDto['severity'] }) {
  const { t } = useT();
  const l = sevLevel(s);
  return <LevelChip level={l} word={t(LEVEL_KEY[l])} />;
}

/** The minute check's last run: how long ago, and how much it could see. */
function WatchLine({ watch, now }: { watch: OpsWatchDto | null; now: number }) {
  const { t, locale } = useT();
  const late = !watch || now - watch.checkedAt > 3 * 60_000;
  return (
    <p className={cx('text-xs', late ? 'font-semibold text-warning' : 'text-ink-400')} data-testid="ops-watch" data-late={late ? '1' : '0'}>
      {!watch
        ? t('opsWatchNever')
        : t(late ? 'opsWatchLate' : 'opsWatchLine', {
            time: formatDate(watch.checkedAt, locale),
            rooms: watch.rooms,
            unanswered: watch.unanswered,
            skipped: watch.skipped,
            m: Math.floor((now - watch.checkedAt) / 60_000),
          })}
    </p>
  );
}

/** The table an alert or a line is about, or the service as a whole. */
function TableCell({ id, name, onPick }: { id: string | null; name?: string | null; onPick?: (id: string) => void }) {
  const { t } = useT();
  if (!id) return <span className="text-ink-300">{t('opsServiceWide')}</span>;
  return onPick ? (
    <button className="break-all text-left hover:underline" onClick={() => onPick(id)} title={t('auditOnlyThis')}>
      {name ?? <span className="font-mono text-xs">{id}</span>}
    </button>
  ) : (
    <span className="break-all">{name ?? <span className="font-mono text-xs">{id}</span>}</span>
  );
}

export function OpsPage() {
  const { t, locale } = useT();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'events' ? 'events' : 'alerts';
  const keys = tab === 'alerts' ? ALERT_FILTERS : EVENT_FILTERS;
  const filterKey = `${tab}:` + keys.map((k) => `${k}=${params.get(k) ?? ''}`).join('&');
  const [pages, setPages] = useState<{ key: string; stack: Cursor[] }>({ key: filterKey, stack: [] });
  const stack = pages.key === filterKey ? pages.stack : [];
  const cur = stack[stack.length - 1];

  const state = (OPS_ALERT_STATES as readonly string[]).includes(params.get('state') ?? '') ? params.get('state')! : 'open';
  const q = new URLSearchParams();
  if (tab === 'alerts') q.set('state', state);
  for (const k of ['severity', 'code', 'table', 'kind'] as const) if (keys.includes(k as never) && params.get(k)) q.set(k, params.get(k)!);
  if (tab === 'events') {
    const from = dayStart(params.get('from'));
    const to = dayStart(params.get('to'), true);
    if (from) q.set('from', String(from));
    if (to) q.set('to', String(to));
  }
  const paged = tab === 'events' || state !== 'open';
  if (paged) q.set('limit', String(PAGE));
  if (paged && cur) {
    q.set('before', String(cur.at));
    q.set('beforeId', cur.id);
  }
  const alerts = useData<OpsAlertsResponse>(tab === 'alerts' ? `/api/admin/monitor/alerts?${q}` : null);
  const events = useData<OpsEventsResponse>(tab === 'events' ? `/api/admin/monitor/events?${q}` : null);
  const shown = tab === 'alerts' ? alerts : events;
  // The watch line is the alerts list's; the log tab reads it too, from the open list (small).
  const watchData = useData<OpsAlertsResponse>(tab === 'events' ? '/api/admin/monitor/alerts?state=open' : null);
  const watch = (tab === 'alerts' ? alerts.data?.watch : watchData.data?.watch) ?? null;

  // A change the check or another administrator made is heard on the control center's socket; the page reads again.
  const reloadAlerts = alerts.reload;
  const reloadEvents = events.reload;
  const reloadWatch = watchData.reload;
  useAdminChanges(true, (e: AdminMonitorEvent) => {
    if (e.type !== 'admin.monitor.changed' || e.kind !== 'ops') return;
    if (tab === 'alerts') void reloadAlerts();
    else {
      void reloadEvents();
      void reloadWatch();
    }
  });

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  const reset = () => {
    const next = new URLSearchParams(params);
    for (const k of keys) next.delete(k);
    setParams(next);
  };
  const filtered = keys.some((k) => params.get(k));
  const table = params.get('table');
  const items = (tab === 'alerts' ? alerts.data?.items : events.data?.items) ?? [];
  const tableName = table
    ? ((tab === 'alerts' ? alerts.data?.items.find((a) => a.tableId === table)?.table?.name : events.data?.items.find((e) => e.tableId === table)?.tableName) ?? table)
    : null;
  const next = tab === 'alerts' ? alerts.data : events.data;
  // Drawn again every 30 s, so a check that stopped shows as late on a page left open.
  useNow(30_000);
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4" data-testid="ops-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-extrabold">{t('opsLog')}</h1>
        <Link to="/control-center" className="ms-auto text-sm font-semibold text-gold-300 hover:underline">
          {t('opsToControlCenter')}
        </Link>
      </div>
      <p className="text-xs text-ink-400">{t('opsIntro')}</p>
      <WatchLine watch={watch} now={now} />
      <div role="tablist" className="flex gap-1 border-b border-white/10">
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setParams(k === 'alerts' ? {} : { tab: k })}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', tab === k ? 'border-gold-400 text-ivory' : 'border-transparent text-ink-400 hover:text-ivory')}
            data-testid={`ops-tab-${k}`}
          >
            {t(k === 'alerts' ? 'opsTabAlerts' : 'opsTabEvents')}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tab === 'alerts' ? (
          <>
            <select value={state} onChange={(e) => set({ state: e.target.value === 'open' ? null : e.target.value })} className={selectCls} aria-label={t('opsState')} data-testid="ops-state">
              {OPS_ALERT_STATES.map((s) => (
                <option key={s} value={s}>
                  {t('opsState')}: {t(STATE_KEY[s])}
                </option>
              ))}
            </select>
            <select value={params.get('code') ?? ''} onChange={(e) => set({ code: e.target.value })} className={selectCls} aria-label={t('opsCode')} data-testid="ops-code">
              <option value="">
                {t('opsCode')}: {t('statusAll')}
              </option>
              {OPS_ALERT_CODES.map((c) => (
                <option key={c} value={c}>
                  {t('opsCode')}: {codeText(t, c)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <select value={params.get('kind') ?? ''} onChange={(e) => set({ kind: e.target.value })} className={selectCls} aria-label={t('opsKind')} data-testid="ops-kind">
              <option value="">
                {t('opsKind')}: {t('statusAll')}
              </option>
              {OPS_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t('opsKind')}: {t(KIND_KEY[k])}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-ink-300">
              {t('auditFrom')}
              <input type="date" className={selectCls} value={params.get('from') ?? ''} max={params.get('to') ?? undefined} onChange={(e) => set({ from: e.target.value })} data-testid="ops-from" />
            </label>
            <label className="flex items-center gap-1 text-xs text-ink-300">
              {t('auditTo')}
              <input type="date" className={selectCls} value={params.get('to') ?? ''} min={params.get('from') ?? undefined} onChange={(e) => set({ to: e.target.value })} data-testid="ops-to" />
            </label>
          </>
        )}
        <select value={params.get('severity') ?? ''} onChange={(e) => set({ severity: e.target.value })} className={selectCls} aria-label={t('severity')} data-testid="ops-severity">
          <option value="">
            {t('severity')}: {t('statusAll')}
          </option>
          {OPS_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t('severity')}: {t(LEVEL_KEY[sevLevel(s)])}
            </option>
          ))}
        </select>
        {table && (
          <button className={chipCls} onClick={() => set({ table: null })} data-testid="ops-table-chip">
            {t('colTable')}: {tableName} <XIcon className="inline size-3 align-[-2px]" />
          </button>
        )}
        {filtered && (
          <Button size="sm" variant="ghost" onClick={reset} data-testid="ops-reset">
            {t('auditReset')}
          </Button>
        )}
      </div>

      {shown.error && <LoadError error={shown.error} onRetry={shown.reload} />}
      <Panel className={shown.loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        {shown.data && items.length === 0 ? (
          <Empty>{tab === 'alerts' && state === 'open' && !filtered ? t('opsNoOpen') : t('opsEmpty')}</Empty>
        ) : tab === 'alerts' ? (
          <Table stack head={[t('severity'), t('colTable'), t('opsWhat'), t('opsSince'), t('opsHandling'), '']}>
            {(alerts.data?.items ?? []).map((a) => (
              <tr key={a.id} className={cx('max-sm:grid max-sm:grid-cols-2 max-sm:py-1.5', a.handling === 'dismissed' && 'opacity-60')} data-testid="ops-alert-row" data-code={a.code} data-open={a.resolvedAt ? '0' : '1'}>
                <td className="px-2 py-1.5 max-sm:py-0.5">
                  <SevChip s={a.severity} />
                </td>
                <td className="px-2 py-1.5 text-sm max-sm:py-0.5 max-sm:text-right">
                  <TableCell id={a.tableId} name={a.table?.name} onPick={(id) => set({ table: id })} />
                </td>
                <td className="px-2 py-1.5 text-sm max-sm:col-span-2 max-sm:py-0.5">
                  {opsAlertText(t, a)}
                  <span className="block font-mono text-[10px] text-ink-400">{a.code}</span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-400 tabular-nums max-sm:py-0.5">
                  {formatDate(a.openedAt, locale)}
                  <span className="block">{a.resolvedAt ? t('opsResolvedAt', { time: formatDate(a.resolvedAt, locale) }) : t('opsSeenN', { n: a.seen })}</span>
                </td>
                <td className="px-2 py-1.5 max-sm:py-0.5 max-sm:text-right">{a.handling === 'new' ? <span className="text-xs text-ink-400">{t('opsHandlingNew')}</span> : <Badge>{t(HANDLING_KEY[a.handling])}</Badge>}</td>
                <td className="px-2 py-1.5 text-right max-sm:col-span-2 max-sm:py-0.5">
                  <Link to={`/ops/alerts/${a.id}`} className="text-xs font-semibold text-gold-300 hover:underline" data-testid="ops-alert-open">
                    {t('opsIncidentLink')}
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Table stack head={[t('time'), t('severity'), t('opsKind'), t('colTable'), t('opsWhat')]}>
            {(events.data?.items ?? []).map((e) => (
              <tr key={e.id} className="max-sm:grid max-sm:grid-cols-2 max-sm:py-1.5" data-testid="ops-event-row" data-kind={e.kind}>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-400 tabular-nums max-sm:py-0.5">{formatDate(e.at, locale)}</td>
                <td className="px-2 py-1.5 max-sm:py-0.5 max-sm:text-right">
                  <SevChip s={e.severity} />
                </td>
                <td className="px-2 py-1.5 text-xs max-sm:py-0.5">{t(KIND_KEY[e.kind])}</td>
                <td className="px-2 py-1.5 text-sm max-sm:py-0.5 max-sm:text-right">
                  <TableCell id={e.tableId} name={e.tableName} onPick={(id) => set({ table: id })} />
                </td>
                <td className="px-2 py-1.5 text-sm max-sm:col-span-2 max-sm:py-0.5">
                  {opsEventText(t, e)}
                  {e.alertId && (
                    <Link to={`/ops/alerts/${e.alertId}`} className="ms-2 text-xs font-semibold text-gold-300 hover:underline">
                      {t('opsIncidentLink')}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {paged && (
          <Pager
            label={t(tab === 'alerts' ? 'opsTabAlerts' : 'opsTabEvents')}
            range={shown.data ? t('opsPageRange', { from: stack.length * PAGE + 1, to: stack.length * PAGE + items.length }) : ''}
            prev={stack.length ? () => setPages({ key: filterKey, stack: stack.slice(0, -1) }) : null}
            next={next?.nextBefore != null && next.nextBeforeId ? () => setPages({ key: filterKey, stack: [...stack, { at: next.nextBefore!, id: next.nextBeforeId! }] }) : null}
            busy={shown.loading}
            testid="ops-pager"
          />
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ one alert

const dlCls = 'grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm';

export function OpsIncidentPage() {
  const { t, locale } = useT();
  const { id = '' } = useParams();
  const { me, api } = useAdmin();
  const { data, error, reload } = useData<OpsIncidentResponse>(`/api/admin/monitor/alerts/${encodeURIComponent(id)}`);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  // Kept by table: an answer about the table of the alert before (this page moved on to another) is not this one's.
  const [rooms, setRooms] = useState<ReadonlyMap<string, RoomEntry>>(() => new Map());
  const [, tick] = useState(0);
  const tableId = data?.table?.id ?? null;
  const live = !!data?.table && data.table.status !== 'closed';
  const entry = tableId ? rooms.get(tableId) : undefined;

  /** The room as it is now, asked once (and again on Refresh): the alert's table may have moved on since. */
  const readRoom = useCallback(async () => {
    if (!tableId) return;
    try {
      const r = await api<MonitorRoomsResponse>('/api/admin/monitor/rooms', { body: { ids: [tableId] } });
      setRooms((prev) => applyRooms(prev, r, Date.now()));
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
    }
  }, [api, tableId, t]);
  useEffect(() => {
    if (live) void readRoom();
  }, [live, readRoom]);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(iv);
  }, []);
  useAdminChanges(true, (e: AdminMonitorEvent) => {
    if (e.type === 'admin.monitor.changed' && e.kind === 'ops') void reload();
  });

  if (!data) return <PageState error={error} onRetry={reload} />;
  const a = data.alert;
  const now = Date.now();
  const canNote = hasGrant(me, 'tables');
  const setHandling = async (h: OpsHandling) => {
    setBusy(true);
    setNote(null);
    try {
      await api(`/api/admin/monitor/alerts/${a.id}/handling`, { method: 'POST', body: { handling: h } });
      setNote({ ok: true, text: t('opsHandlingSaved', { to: t(HANDLING_KEY[h]) }) });
      await reload();
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const tb = data.table;
  const room = entry && 'room' in entry ? entry.room : null;
  const problems = tb ? problemsOf(tb, entry, now) : [];
  const j = tb ? { table: tb, problems, level: levelOf(problems), fresh: freshnessOf(tb, 'polling', entry) } : null;

  return (
    <div className="flex flex-col gap-4" data-testid="ops-incident">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/ops" className="text-sm font-semibold text-gold-300 hover:underline">
          {t('opsBack')}
        </Link>
        <Link to="/control-center" className="ms-auto text-sm font-semibold text-gold-300 hover:underline">
          {t('opsToControlCenter')}
        </Link>
      </div>

      <Panel>
        <div className="flex flex-wrap items-center gap-2">
          <SevChip s={a.severity} />
          <h1 className="min-w-0 text-lg font-extrabold break-words" data-testid="ops-incident-title">
            {opsAlertText(t, a)}
          </h1>
          <Badge tone={a.resolvedAt ? 'neutral' : 'red'}>{t(a.resolvedAt ? 'opsStateResolved' : 'opsStateOpen')}</Badge>
          {a.handling !== 'new' && <Badge tone="gold">{t(HANDLING_KEY[a.handling])}</Badge>}
        </div>
        <dl className={cx(dlCls, 'mt-3')}>
          <dt className="text-ink-400">{t('opsCode')}</dt>
          <dd>
            {codeText(t, a.code)} <span className="font-mono text-[11px] text-ink-400">{a.code}</span>
          </dd>
          <dt className="text-ink-400">{t('colTable')}</dt>
          <dd data-testid="ops-incident-table">
            <TableCell id={a.tableId} name={a.table?.name} />
          </dd>
          <dt className="text-ink-400">{t('opsOpenedAt')}</dt>
          <dd className="tabular-nums">{formatDate(a.openedAt, locale)}</dd>
          <dt className="text-ink-400">{t('opsLastSeen')}</dt>
          <dd className="tabular-nums">
            {formatDate(a.lastSeenAt, locale)} · {t('opsSeenN', { n: a.seen })}
          </dd>
          {a.resolvedAt && (
            <>
              <dt className="text-ink-400">{t('opsResolved')}</dt>
              <dd className="tabular-nums">{formatDate(a.resolvedAt, locale)}</dd>
            </>
          )}
          {a.handledAt && (
            <>
              <dt className="text-ink-400">{t('opsHandling')}</dt>
              <dd>
                {t(HANDLING_KEY[a.handling])} · <span className="tabular-nums">{formatDate(a.handledAt, locale)}</span>
              </dd>
            </>
          )}
        </dl>
        {canNote && (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="ops-handling">
            <span className="text-xs text-ink-400">{t('opsHandlingAsk')}</span>
            {OPS_HANDLINGS.map((h) => (
              <Button key={h} size="sm" variant={a.handling === h ? 'gold' : 'outline'} disabled={busy || a.handling === h} onClick={() => void setHandling(h)} data-testid={`ops-handling-${h}`}>
                {t(HANDLING_KEY[h])}
              </Button>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-ink-400">{t('opsHandlingNote')}</p>
        <Feedback note={note} />
        <div className="mt-2">
          <WatchLine watch={data.watch} now={now} />
        </div>
      </Panel>

      {tb && j && (
        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">{t('opsTableNow')}</h2>
            <span className="text-sm text-ink-300">{tb.name}</span>
            <span className="ms-auto flex flex-wrap gap-2 text-xs font-semibold">
              {live && (
                <Link to={`/control-center?focus=${tb.id}`} className="text-gold-300 hover:underline" data-testid="ops-to-focus">
                  {t('opsOpenInCc')}
                </Link>
              )}
              <Link to={`/tables/${tb.id}`} className="text-gold-300 hover:underline">
                {t('detail')}
              </Link>
              <Link to={`/audit?targetType=table&targetId=${tb.id}`} className="text-gold-300 hover:underline">
                {t('ccAuditLink')}
              </Link>
              {live && (
                <button className="text-gold-300 hover:underline" onClick={() => void readRoom()} data-testid="ops-room-refresh">
                  {t('opsRoomRefresh')}
                </button>
              )}
            </span>
          </div>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <TableHealth table={tb} entry={entry} fresh={null} alerts={data.related.filter((r) => !r.resolvedAt).concat(a.resolvedAt ? [] : [a])} now={now} />
            <ControlSection
              j={j}
              room={room}
              onActed={() => {
                void reload();
                void readRoom();
              }}
            />
          </div>
        </Panel>
      )}

      {data.metrics.length > 0 && (
        <Panel>
          <h2 className="text-base font-bold">{t('opsMetrics')}</h2>
          <p className="text-xs text-ink-400">{t('opsMetricsNote')}</p>
          <Table head={[t('time'), t('opsMetric'), t('opsCount')]}>
            {data.metrics.map((m) => (
              <tr key={`${m.bucket}:${m.metric}`} data-testid="ops-metric-row">
                <td className="whitespace-nowrap px-2 py-1 text-xs text-ink-400 tabular-nums">{formatDate(m.bucket, locale)}</td>
                <td className="px-2 py-1 text-sm">{metricLabel(t, m.metric)}</td>
                <td className="px-2 py-1 text-sm tabular-nums">{m.n}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      <Panel>
        <h2 className="text-base font-bold">{t('opsIncidentLog')}</h2>
        {data.events.length === 0 ? (
          <Empty>{t('opsEmpty')}</Empty>
        ) : (
          <ol className="mt-2 flex flex-col gap-1.5" data-testid="ops-incident-events">
            {data.events.map((e) => (
              <li key={e.id} className={cx('flex flex-wrap items-baseline gap-x-2 rounded-lg px-2 py-1 text-sm', e.alertId === a.id && 'bg-white/5')} data-testid="ops-incident-event" data-kind={e.kind}>
                <span className="text-xs text-ink-400 tabular-nums">{formatDate(e.at, locale)}</span>
                <SevChip s={e.severity} />
                <span className="min-w-0 break-words">{opsEventText(t, e)}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-bold">{t('opsRelated')}</h2>
        {data.related.length === 0 ? (
          <Empty>{t('opsNoRelated')}</Empty>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5" data-testid="ops-related">
            {data.related.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                <SevChip s={r.severity} />
                <Link to={`/ops/alerts/${r.id}`} className="min-w-0 break-words hover:underline">
                  {opsAlertText(t, r)}
                </Link>
                <span className="text-xs text-ink-400 tabular-nums">
                  {formatDate(r.openedAt, locale)}
                  {r.resolvedAt ? ` → ${formatDate(r.resolvedAt, locale)}` : ` · ${t('opsStateOpen')}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
