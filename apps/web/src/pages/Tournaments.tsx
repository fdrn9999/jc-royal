/**
 * Members' Sit & Go tournaments (docs/TOURNAMENT.md): the list (open and running, or ended) and one tournament with its
 * structure, clock, players and register / withdraw. Free entry, no prize: nothing here shows or moves wallet chips.
 * The server decides everything (eligibility, seats, the start); these pages only show its answers and refresh while
 * the tournament can still change.
 */
import { blindsAt, type EntryStatus, type TournamentDetailDto, type TournamentStatus, type TournamentSummaryDto } from '@jc/types';
import { Badge, Button, cx, Empty, formatChips, Panel, Spinner } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { when } from '../lib/service';
import { useTn, type Tn, type TnKey } from '../game/tournament-text';

const PAGE = 20;
/** How often a page refreshes while it is visible and the tournament can still change. */
const LIST_POLL_MS = 15_000;
const DETAIL_POLL_MS = 5_000;

interface ListDto {
  tournaments: TournamentSummaryDto[];
  hasMore: boolean;
  current: TournamentSummaryDto | null;
  now: number;
}

const ACTIVE: readonly TournamentStatus[] = ['registering', 'closed', 'running'];
const STATUS_TONE: Record<TournamentStatus, 'neutral' | 'gold' | 'green' | 'red' | 'blue'> = {
  registering: 'gold',
  closed: 'blue',
  running: 'green',
  finished: 'neutral',
  cancelled: 'red',
  aborted: 'red',
};
const ENTRY_TONE: Partial<Record<EntryStatus, 'neutral' | 'gold' | 'green' | 'red' | 'blue'>> = {
  registered: 'gold',
  playing: 'green',
  won: 'gold',
  eliminated: 'neutral',
  stopped: 'red',
};

/** m:ss (or h:mm:ss) for a time left. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Runs `tick` every `ms` while the page is visible, and at once when it becomes visible again. */
function useVisiblePoll(tick: () => void, ms: number, on: boolean) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    const wake = () => {
      if (document.visibilityState === 'visible') ref.current();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [ms, on]);
}

/** Re-renders every second while `on` (countdowns). */
function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [on]);
}

function StatusBadge({ status }: { status: TournamentStatus }) {
  const { t } = useI18n();
  return (
    <span data-testid="tn-status" data-status={status}>
      <Badge tone={STATUS_TONE[status]}>
        {status === 'running' && <span className="size-1.5 rounded-full bg-success jc-pulse-gold" />}
        {t(`tn.status.${status}` as MsgKey)}
      </Badge>
    </span>
  );
}

function MyBadge({ me }: { me: TournamentSummaryDto['me'] }) {
  const { t } = useI18n();
  const tr = useTn();
  if (!me || me.status === 'unregistered' || me.status === 'dropped') return null;
  return (
    <span data-testid="tn-mine" data-status={me.status}>
      <Badge tone={ENTRY_TONE[me.status] ?? 'neutral'}>
        {tr('you')} · {me.place !== null ? tr('place', { n: me.place }) : tr(`entry.${me.status}` as TnKey)}
      </Badge>
    </span>
  );
}

function SummaryCard({ s, highlight }: { s: TournamentSummaryDto; highlight?: boolean }) {
  const { t, locale } = useI18n();
  const tr = useTn();
  const ended = !ACTIVE.includes(s.status);
  return (
    <Link
      to={`/tournaments/${s.id}`}
      className={cx('jc-panel jc-tap group flex flex-col gap-3 p-4 transition hover:border-gold-500/40', highlight && 'border-gold-500/40')}
      data-testid="tn-card"
      data-id={s.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-ivory">{s.name}</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusBadge status={s.status} />
            <MyBadge me={s.me} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-xl font-semibold tabular-nums text-gold-300">
            {s.status === 'running' && s.playersLeft !== null ? s.playersLeft : s.registered}
            <span className="text-sm text-ink-400">/{s.status === 'running' ? s.registered : s.capacity}</span>
          </div>
          <div className="text-[11px] text-ink-400">{s.status === 'running' ? tr('leftLabel') : tr('entries')}</div>
        </div>
      </header>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('startStack')}</dt>
          <dd className="font-mono font-semibold tabular-nums">{formatChips(s.startStack)}</dd>
        </div>
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('firstBlinds')}</dt>
          <dd className="font-mono font-semibold tabular-nums">
            {formatChips(s.firstLevel.sb)}/{formatChips(s.firstLevel.bb)}
          </dd>
        </div>
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('levelLength')}</dt>
          <dd className="font-mono font-semibold tabular-nums">{tr('minutes', { n: s.levelMinutes })}</dd>
        </div>
      </dl>
      <p className="flex flex-wrap justify-between gap-x-3 text-[11px] text-ink-400">
        <span>{tr('free')}</span>
        <span>
          {ended && s.endedAt
            ? tr('endedAt', { at: when(s.endedAt, locale) })
            : s.startedAt
              ? tr('startedAt', { at: when(s.startedAt, locale) })
              : tr('createdAt', { at: when(s.createdAt, locale) })}
        </span>
      </p>
      {s.status === 'finished' && s.winner && <p className="text-xs text-gold-300">🏆 {tr('wonBy', { name: s.winner })}</p>}
    </Link>
  );
}

export function TournamentsPage() {
  const { t } = useI18n();
  const tr = useTn();
  const [tab, setTab] = useState<'active' | 'ended'>('active');
  const [data, setData] = useState<ListDto | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) {
        setData(null);
        setError(false);
      }
      try {
        const r = await api<ListDto>(`/api/tournaments?status=${tab}&limit=${PAGE}`);
        // Only the latest request is applied (a tab change or a refresh replaces an older one).
        if (mine !== seq.current) return;
        setData((d) => (quiet && d && d.tournaments.length > PAGE ? { ...r, tournaments: [...r.tournaments, ...d.tournaments.slice(PAGE)], hasMore: d.hasMore } : r));
        setError(false);
      } catch {
        if (mine === seq.current) setError(true);
      }
    },
    [tab],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePoll(() => void load(true), LIST_POLL_MS, tab === 'active');

  async function more() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const r = await api<ListDto>(`/api/tournaments?status=${tab}&limit=${PAGE}&offset=${data.tournaments.length}`);
      setData((d) => (d ? { ...d, hasMore: r.hasMore, tournaments: [...d.tournaments, ...r.tournaments.filter((x) => !d.tournaments.some((y) => y.id === x.id))] } : d));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const list = data?.tournaments ?? [];
  const current = data?.current ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{tr('title')}</h1>
        <p className="mt-1 text-sm text-ink-300">{tr('subtitle')}</p>
      </div>

      {current && (
        <section className="flex flex-col gap-2" data-testid="tn-current">
          <h2 className="text-xs font-bold tracking-[0.08em] text-gold-300">{tr('current')}</h2>
          <SummaryCard s={current} highlight />
          {current.status === 'running' && current.tableId && current.me?.status === 'playing' && (
            <Link to={`/table/${current.tableId}`} className="jc-tap self-start rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-ink-950 hover:bg-gold-400" data-testid="tn-current-table">
              {t('tn.toTable')} →
            </Link>
          )}
        </section>
      )}

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4" role="tablist">
        {(['active', 'ended'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            data-testid={`tn-tab-${k}`}
            className={cx('shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition', tab === k ? 'border-gold-500 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory')}
          >
            {tr(`tab.${k}` as TnKey)}
          </button>
        ))}
      </div>

      {!data && !error && (
        <div className="flex justify-center py-16 text-gold-400">
          <Spinner />
        </div>
      )}
      {!data && error && (
        <Empty>
          <span className="flex flex-col items-center gap-3" role="alert" data-testid="tn-error">
            {tr('loadFailed')}
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </span>
        </Empty>
      )}
      {data && error && (
        <p className="rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status" data-testid="tn-stale">
          {tr('stale')}
        </p>
      )}
      {data && list.length === 0 && (
        <div data-testid="tn-empty">
          <Empty>{tab === 'active' ? tr('none') : tr('noneEnded')}</Empty>
        </div>
      )}
      {list.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="tn-list">
          {list.map((s) => (
            <SummaryCard key={s.id} s={s} />
          ))}
        </div>
      )}
      {data?.hasMore && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" loading={loadingMore} onClick={() => void more()} data-testid="tn-more">
            {tr('more')}
          </Button>
        </div>
      )}
    </div>
  );
}

const INELIGIBLE = ['suspended', 'bot', 'unverified', 'min_hands', 'active_elsewhere', 'full'] as const;

/** Why the viewer may not register, in their words (a reason this build doesn't know reads as the generic refusal). */
function ineligibleText(tr: Tn, t: ReturnType<typeof useI18n>['t'], reason: string, handsLeft?: number) {
  if (reason === 'min_hands') return tr('inel.min_hands', { n: handsLeft ?? 0 });
  if (!(INELIGIBLE as readonly string[]).includes(reason)) return t('err.tournament_ineligible');
  return tr(`inel.${reason}` as TnKey);
}

export function TournamentPage() {
  const { id = '' } = useParams();
  const { t, err, locale } = useI18n();
  const tr = useTn();
  const nav = useNavigate();
  const [d, setD] = useState<TournamentDetailDto | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) setError(null);
      try {
        const r = await api<TournamentDetailDto>(`/api/tournaments/${encodeURIComponent(id)}`);
        if (mine !== seq.current) return;
        setD(r);
        setSkew(r.now - Date.now());
        setError(null);
      } catch (x) {
        if (mine !== seq.current) return;
        setError(x instanceof ApiError && x.code === 'tournament_not_found' ? err(x.code) : tr('loadFailed'));
      }
    },
    [id, err, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const live = !d || ACTIVE.includes(d.status);
  useVisiblePoll(() => void load(true), DETAIL_POLL_MS, live);
  useTicker(d?.status === 'running' && d.levelEndsAt !== null);

  async function register(on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: true; started?: boolean; tableId?: string | null }>(`/api/tournaments/${encodeURIComponent(id)}/${on ? 'register' : 'unregister'}`, { method: 'POST' });
      if (on && r.started && r.tableId) {
        nav(`/table/${r.tableId}`);
        return;
      }
      if (!on) setMsg({ tone: 'ok', text: tr('unregisteredDone') });
    } catch (x) {
      const e = x instanceof ApiError ? x : null;
      const det = (e?.details ?? {}) as { reason?: string; handsLeft?: number };
      setMsg({ tone: 'err', text: e?.code === 'tournament_ineligible' && det.reason ? ineligibleText(tr, t, det.reason, det.handsLeft) : err(e?.code) });
    } finally {
      setBusy(false);
      void load(true);
    }
  }

  if (!d) {
    return (
      <div className="flex flex-col gap-5">
        <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">
          ← {tr('back')}
        </Link>
        {error ? (
          <Empty>
            <span className="flex flex-col items-center gap-3" role="alert" data-testid="tn-error">
              {error}
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            </span>
          </Empty>
        ) : (
          <div className="flex justify-center py-16 text-gold-400">
            <Spinner />
          </div>
        )}
      </div>
    );
  }

  const now = Date.now() + skew;
  const level = blindsAt(d.levels, d.level);
  const next = d.level < d.levels.length - 1 ? d.levels[d.level + 1]! : null;
  const mine = d.me?.status;
  const holding = mine === 'registered' || mine === 'playing';
  const tb = d.timeBank;
  const conds = [d.requireVerified ? tr('cond.verified') : null, d.minHands > 0 ? tr('cond.hands', { n: d.minHands }) : null].filter(Boolean).join(' · ') || tr('cond.none');
  const sec = (ms: number) => Math.round(ms / 1000);

  return (
    <div className="flex flex-col gap-5" data-testid="tn-detail" data-status={d.status}>
      <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">
        ← {tr('back')}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{d.name}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={d.status} />
          <MyBadge me={d.me} />
          <Badge>{tr('free')}</Badge>
        </div>
      </header>

      {error && (
        <p className="rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status" data-testid="tn-stale">
          {tr('stale')}
        </p>
      )}

      {/* What the viewer can do now */}
      <Panel className="flex flex-col gap-3">
        {d.status === 'registering' && !holding && (
          <>
            {d.eligibility && !d.eligibility.ok && (
              <p className="text-sm text-ink-200" data-testid="tn-ineligible" data-reason={d.eligibility.reason}>
                {ineligibleText(tr, t, d.eligibility.reason, d.eligibility.handsLeft)}
              </p>
            )}
            <Button className="self-start" loading={busy} disabled={!d.eligibility?.ok} onClick={() => void register(true)} data-testid="tn-register">
              {tr('register')}
            </Button>
          </>
        )}
        {(d.status === 'registering' || d.status === 'closed') && mine === 'registered' && (
          <>
            <p className="text-sm text-ink-100" data-testid="tn-registered">
              {d.autoStart ? tr('registeredAuto') : tr('registeredOp')}
            </p>
            <Button className="self-start" variant="outline" loading={busy} onClick={() => void register(false)} data-testid="tn-unregister">
              {tr('unregister')}
            </Button>
          </>
        )}
        {d.status === 'closed' && <p className="text-sm text-ink-300">{tr('closedNote')}</p>}
        {(d.status === 'registering' || d.status === 'closed') && <p className="text-xs text-ink-400">{tr('leaveNote')}</p>}
        {d.status === 'running' && d.tableId && (
          <Link
            to={`/table/${d.tableId}`}
            className={cx(
              'jc-tap self-start rounded-lg px-4 py-2 text-sm font-bold',
              mine === 'playing' ? 'bg-gold-500 text-ink-950 hover:bg-gold-400' : 'border border-gold-500/50 text-gold-300 hover:bg-gold-500/10',
            )}
            data-testid="tn-table"
          >
            {mine === 'playing' ? t('tn.toTable') : tr('watch')} →
          </Link>
        )}
        {d.status === 'running' && (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="tn-clock">
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('level', { n: d.level + 1, total: d.levels.length })}</div>
              <div className="font-mono font-semibold tabular-nums">
                {formatChips(level.sb)}/{formatChips(level.bb)}
              </div>
            </div>
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('clock')}</div>
              <div className="font-mono font-semibold tabular-nums" data-testid="tn-next">
                {d.paused
                  ? tr('pausedShort')
                  : !next
                    ? tr('lastLevel')
                    : d.levelEndsAt !== null
                      ? clockText(d.levelEndsAt - now)
                      : d.levelLeftMs !== null
                        ? tr('stoppedLeft', { time: clockText(d.levelLeftMs) })
                        : '—'}
              </div>
            </div>
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('entries')}</div>
              <div className="font-mono font-semibold tabular-nums">{tr('left', { n: d.playersLeft ?? d.registered, total: d.registered })}</div>
            </div>
            {next && (
              <div className="rounded-lg bg-black/25 px-3 py-2">
                <div className="text-[11px] text-ink-400">{tr('levelN', { n: d.level + 2 })}</div>
                <div className="font-mono font-semibold tabular-nums">
                  {formatChips(next.sb)}/{formatChips(next.bb)}
                </div>
              </div>
            )}
          </div>
        )}
        {d.status === 'running' && d.paused && <p className="text-sm text-gold-300" data-testid="tn-paused">{t('tn.paused')}</p>}
        {d.status === 'finished' && d.winner && <p className="text-base font-bold text-gold-300">🏆 {tr('wonBy', { name: d.winner })}</p>}
        {d.status === 'cancelled' && <p className="text-sm text-ink-200">{tr('cancelledNote')}</p>}
        {d.status === 'aborted' && <p className="text-sm text-ink-200" data-testid="tn-aborted">{tr('abortedNote')}</p>}
        {msg && (
          <p className={cx('text-sm', msg.tone === 'err' ? 'text-danger' : 'text-gold-300')} role={msg.tone === 'err' ? 'alert' : 'status'} data-testid="tn-msg">
            {msg.text}
          </p>
        )}
        <p className="text-[11px] text-ink-400">
          {d.endedAt ? tr('endedAt', { at: when(d.endedAt, locale) }) : d.startedAt ? tr('startedAt', { at: when(d.startedAt, locale) }) : tr('createdAt', { at: when(d.createdAt, locale) })}
        </p>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={`${tr('entries')} · ${d.status === 'running' || d.status === 'finished' || d.status === 'aborted' ? d.registered : tr('players', { n: d.registered, cap: d.capacity })}`}>
          {d.entries.length === 0 ? (
            <Empty>{tr('noEntries')}</Empty>
          ) : (
            <ol className="divide-y divide-white/5" data-testid="tn-entries">
              {d.entries.map((e, i) => (
                <li key={`${e.nickname}-${i}`} className={cx('flex items-center gap-3 py-2 text-sm', e.me && 'text-gold-300')} data-testid="tn-entry" data-status={e.status}>
                  <span className="w-10 shrink-0 font-mono text-xs tabular-nums text-ink-400">{e.place !== null ? tr('place', { n: e.place }) : ''}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {e.nickname}
                    {e.me && <span className="ml-1 text-xs font-normal">({tr('you')})</span>}
                  </span>
                  {e.stack !== null && e.status === 'playing' && <span className="shrink-0 font-mono text-xs tabular-nums text-ink-200">{formatChips(e.stack)}</span>}
                  <Badge tone={ENTRY_TONE[e.status] ?? 'neutral'}>{tr(`entry.${e.status}` as TnKey)}</Badge>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title={tr('structure')}>
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-400">{tr('startStack')}</dt>
            <dd className="text-right font-mono tabular-nums">{formatChips(d.startStack)}</dd>
            <dt className="text-ink-400">{tr('levelLength')}</dt>
            <dd className="text-right">{tr('minutes', { n: d.levelMinutes })}</dd>
            <dt className="text-ink-400">{tr('turn')}</dt>
            <dd className="text-right">{tr('seconds', { n: d.turnSeconds })}</dd>
            <dt className="text-ink-400">{tr('timeBank')}</dt>
            <dd className="text-right text-xs">
              {tb.enabled ? tr('timeBankOn', { initial: sec(tb.initialMs), max: sec(tb.maxMs), unit: sec(tb.unitMs), hands: tb.refillHands, refill: sec(tb.refillMs) }) : tr('timeBankOff')}
            </dd>
            <dt className="text-ink-400">{tr('conditions')}</dt>
            <dd className="text-right">{conds}</dd>
            <dt className="text-ink-400">{tr('start')}</dt>
            <dd className="text-right">{d.autoStart ? tr('start.auto') : tr('start.operator', { n: d.minPlayers })}</dd>
          </dl>
          <ol className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3" data-testid="tn-levels">
            {d.levels.map((l, i) => {
              const cur = d.status === 'running' && i === d.level;
              return (
                <li key={i} className={cx('flex items-center justify-between rounded-md px-2.5 py-1.5', cur ? 'bg-gold-500/15 text-gold-300' : 'bg-black/25 text-ink-200')}>
                  <span className="text-ink-400">{cur ? tr('nowLevel') : tr('levelN', { n: i + 1 })}</span>
                  <span className="font-mono tabular-nums">
                    {formatChips(l.sb)}/{formatChips(l.bb)}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
