import type { LobbyTableDto, TournamentSummaryDto } from '@jc/types';
import { Badge, Button, cx, Empty, formatChips, Input, Spinner } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { tutorialComplete, useProgress } from '../academy/progress';
import { JoinCodeModal } from '../components/JoinCode';
import { BOT_LEVEL_LABEL, HostedBy } from '../components/MemberName';
import { ANY, filtersOf, QuickPlayPanel, useLobbyFilters, type QuickFilters } from '../components/QuickPlay';
import { CreateRoomModal } from '../components/Rooms';
import { InstallOfferLazy } from '../components/InstallLazy';
import { MaintenanceNote } from '../components/MaintenanceNote';
import { ShareButton } from '../components/Share';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { entryOf, latest, lobbyPoller, POLL_MS, useTablePrefs, type Latest } from '../lib/lobby';
import { rememberLobby } from '../lib/lobbyReturn';
import { setFavourite, useFavourites } from '../lib/prefs';
import { useMaintenance } from '../lib/service';
import { siteUrl } from '../lib/share';

type Filter = 'all' | 'fav' | 'recent' | 'beginner' | 'playing' | 'open' | 'empty';
const FILTERS: Filter[] = ['all', 'fav', 'recent', 'beginner', 'playing', 'open', 'empty'];
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

function statusOf(t: LobbyTableDto): 'playing' | 'waiting' | 'empty' {
  if (t.playing) return 'playing';
  return t.seated > 0 ? 'waiting' : 'empty';
}

/**
 * The table list: refreshed every POLL_MS while the page is visible and in use (every IDLE_POLL_MS when nobody has
 * touched it for a minute), and at once when it becomes visible again, the window gets focus back, the connection
 * returns or someone uses an idle lobby. Requests never overlap and an outdated answer is never applied.
 */
function useLobbyTables() {
  const [tables, setTables] = useState<LobbyTableDto[] | null>(null);
  const [error, setError] = useState(false);
  const feed = useRef<Latest | null>(null);
  useEffect(() => {
    const f = latest(
      (signal) => api<LobbyTableDto[]>('/api/tables', { signal }),
      (list) => {
        setTables(list);
        setError(false);
      },
      () => setError(true),
    );
    feed.current = f;
    f.run();
    const p = lobbyPoller(f, () => document.visibilityState === 'visible');
    const h = setInterval(p.tick, POLL_MS);
    document.addEventListener('visibilitychange', p.wake);
    window.addEventListener('focus', p.wake);
    window.addEventListener('online', p.wake);
    for (const e of INPUT_EVENTS) window.addEventListener(e, p.input, { passive: true });
    return () => {
      f.stop();
      clearInterval(h);
      document.removeEventListener('visibilitychange', p.wake);
      window.removeEventListener('focus', p.wake);
      window.removeEventListener('online', p.wake);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, p.input);
    };
  }, []);
  // The refresh button replaces a request already out rather than waiting for it.
  const refresh = useCallback(() => void feed.current?.run(true), []);
  return { tables, error, refresh };
}

/**
 * The way into tournaments (the bottom navigation has no room for it on a phone). Asked once per visit, not polled:
 * the viewer's own tournament, if any, names itself; otherwise the card just describes them.
 */
function TournamentCard() {
  const { t } = useI18n();
  const [mine, setMine] = useState<TournamentSummaryDto | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    api<{ current: TournamentSummaryDto | null }>('/api/tournaments?limit=1', { signal: ac.signal }).then(
      (r) => setMine(r.current),
      () => {
        /* the card still links to the list */
      },
    );
    return () => ac.abort();
  }, []);
  const live = mine?.status === 'running' && mine.me?.status === 'playing' && mine.tableId;
  return (
    <Link
      to={live ? `/table/${mine.tableId}` : mine ? `/tournaments/${mine.id}` : '/tournaments'}
      className="jc-panel jc-tap flex items-center gap-3 p-4 transition hover:border-gold-400/60"
      data-testid="lobby-tournaments"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-500/15 text-xl text-gold-300">🏆</span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-ivory">{t('tn.lobbyTitle')}</span>
        <span className="block truncate text-xs text-ink-300">
          {mine ? t('tn.lobbyMine', { name: mine.name, status: t(`tn.status.${mine.status}` as MsgKey) }) : t('tn.lobbyBody')}
        </span>
      </span>
      <span className="shrink-0 text-sm font-semibold text-gold-300">{live ? t('tn.toTable') : t('tn.details')} →</span>
    </Link>
  );
}

export function LobbyPage() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const { me } = useAuth();
  const academy = useProgress(me?.id);
  const { tables, error, refresh } = useLobbyTables();
  // The tab, the search and the size/blind filters live in the address: back from a table, a reload or a shared link
  // finds the list as it was. One write for all of them (two in one go would each start from the same address).
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') as Filter | null;
  const filter: Filter = tab && FILTERS.includes(tab) ? tab : 'all';
  const q = params.get('q') ?? '';
  const view = (next: { filter?: Filter; q?: string; filters?: QuickFilters }) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        const put = (k: string, v: string, none: string) => (v === none ? p.delete(k) : p.set(k, v));
        if (next.filter !== undefined) put('tab', next.filter, 'all');
        if (next.q !== undefined) put('q', next.q, '');
        if (next.filters) {
          put('seats', String(next.filters.maxSeats), '0');
          put('bb', String(next.filters.bigBlind), '0');
        }
        return p;
      },
      { replace: true },
    );
  const { search } = useLocation();
  useEffect(() => rememberLobby(search), [search]);
  const { filters, blinds, any } = useLobbyFilters(tables, filtersOf(params));
  const setFilters = (f: QuickFilters) => view({ filters: f });
  const prefs = useTablePrefs(me?.id);
  const [codeFor, setCodeFor] = useState<{ table: LobbyTableDto; then: 'sit' | 'wait' } | null>(null);
  const [creating, setCreating] = useState(false);
  // Maintenance under way: the server refuses new rooms, quick play and seats, so those buttons wait for its end.
  const paused = useMaintenance().games;

  // Favourite tables are the account's (every device); recently opened ones stay on this device.
  const favList = useFavourites();
  const favs = useMemo(() => new Set(favList), [favList]);
  const visited = useMemo(() => new Map(prefs.recent.map((r) => [r.id, r.at])), [prefs.recent]);
  const counts = useMemo(() => ({ fav: (tables ?? []).filter((tb) => favs.has(tb.id)).length, recent: (tables ?? []).filter((tb) => visited.has(tb.id)).length }), [tables, favs, visited]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (tables ?? []).filter((tb) => {
      if (needle && !tb.name.toLowerCase().includes(needle) && !`${tb.smallBlind}/${tb.bigBlind}`.includes(needle)) return false;
      if (filters.maxSeats && tb.maxSeats !== filters.maxSeats) return false;
      if (filters.bigBlind && tb.bigBlind !== filters.bigBlind) return false;
      switch (filter) {
        case 'fav':
          return favs.has(tb.id);
        case 'recent':
          return visited.has(tb.id);
        case 'beginner':
          return tb.beginner;
        case 'playing':
          return tb.playing;
        case 'open':
          return tb.seated < tb.maxSeats;
        case 'empty':
          return tb.seated === 0;
        default:
          return true;
      }
    });
    if (filter === 'recent') return list.sort((a, b) => visited.get(b.id)! - visited.get(a.id)!);
    // Favourites first, otherwise in the server's order.
    return [...list.filter((tb) => favs.has(tb.id)), ...list.filter((tb) => !favs.has(tb.id))];
  }, [tables, q, filter, filters.maxSeats, filters.bigBlind, favs, visited]);

  const narrowed = filter !== 'all' || q.trim() !== '' || !any;
  const resetAll = () => view({ filter: 'all', q: '', filters: ANY });

  function open(tb: LobbyTableDto, how: 'sit' | 'wait' | 'watch') {
    if (tb.isPrivate && how !== 'watch') {
      setCodeFor({ table: tb, then: how });
      return;
    }
    nav(`/table/${tb.id}${how === 'watch' ? '' : `?${how}=1`}`);
  }

  const filteredBy = [filters.maxSeats ? t('room.seatsN', { n: filters.maxSeats }) : null, filters.bigBlind ? blinds.find(([bb]) => bb === filters.bigBlind)?.map((x) => formatChips(x)).reverse().join('/') : null].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-6">
      {!tutorialComplete(academy) && (
        <Link to="/academy" className="jc-panel jc-tap flex items-center gap-3 border-gold-500/30 p-4 transition hover:border-gold-400/60" data-testid="lobby-academy">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-500/15 text-xl text-gold-300">♠</span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ivory">{t('lobby.academyTitle')}</span>
            <span className="block text-xs text-ink-300">{t('lobby.academyBody')}</span>
          </span>
          <span className="hidden shrink-0 text-sm font-semibold text-gold-300 sm:inline">{t('lobby.academyCta')} →</span>
        </Link>
      )}
      <TournamentCard />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('lobby.title')}</h1>
            <p className="mt-1 text-sm text-ink-300">{t('app.virtual')}</p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 sm:hidden" disabled={!!paused} onClick={() => setCreating(true)} data-testid="room-create-open">
            ＋ {t('room.create')}
          </Button>
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('lobby.search')} value={q} onChange={(e) => view({ q: e.target.value })} className="sm:w-64" aria-label={t('lobby.search')} />
          <Button variant="subtle" onClick={refresh} aria-label={t('lobby.refresh')} data-testid="lobby-refresh">
            ↻
          </Button>
          <ShareButton size="md" data={{ title: 'JC ROYAL', text: t('share.siteText'), url: siteUrl(locale === 'en' ? '/?lang=en' : '/') }} label={t('share.site')} testId="site-share">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
            </svg>
          </ShareButton>
          {/* max-sm (not `hidden sm:inline-flex`): the button's own inline-flex would otherwise win and show it twice on phones. */}
          <Button variant="outline" className="max-sm:hidden" disabled={!!paused} onClick={() => setCreating(true)} data-testid="room-create-open-wide">
            ＋ {t('room.create')}
          </Button>
        </div>
      </div>

      <InstallOfferLazy />
      {paused && <MaintenanceNote m={paused} what="games" />}
      <QuickPlayPanel filters={filters} blinds={blinds} onFilters={setFilters} onCreateRoom={() => setCreating(true)} paused={!!paused} />

      <div className="flex flex-col gap-2">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist">
          {FILTERS.map((f) => {
            const n = f === 'fav' || f === 'recent' ? counts[f] : 0;
            return (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => view({ filter: f })}
                data-testid={`lobby-filter-${f}`}
                className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${filter === f ? 'border-gold-500 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory'}`}
              >
                {t(`lobby.filter.${f}` as MsgKey)}
                {n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
        {!any && (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-300" data-testid="lobby-filtered">
            {t('lobby.filteredBy', { what: filteredBy })}
            <button type="button" className="jc-tap font-semibold text-gold-300 underline underline-offset-2" onClick={() => setFilters(ANY)}>
              {t('quick.reset')}
            </button>
          </p>
        )}
      </div>

      {tables === null && !error && (
        <div className="flex justify-center py-16 text-gold-400">
          <Spinner />
        </div>
      )}
      {error && tables === null && (
        <Empty>
          <span className="flex flex-col items-center gap-3">
            {t('common.error')}
            <Button size="sm" variant="outline" onClick={refresh}>
              {t('lobby.refresh')}
            </Button>
          </span>
        </Empty>
      )}
      {error && tables !== null && (
        <p className="rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status" data-testid="lobby-stale">
          {t('lobby.stale')}
        </p>
      )}
      {tables && shown.length === 0 && (
        <Empty>
          <span className="flex flex-col items-center gap-3">
            {filter === 'fav' && counts.fav === 0 ? t('lobby.noFav') : filter === 'recent' && counts.recent === 0 ? t('lobby.noRecent') : t('lobby.none')}
            {narrowed && (
              <Button size="sm" variant="outline" onClick={resetAll} data-testid="lobby-reset">
                {t('quick.reset')}
              </Button>
            )}
          </span>
        </Empty>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((tb) => {
          const st = statusOf(tb);
          const full = tb.seated >= tb.maxSeats;
          const entry = entryOf(tb);
          const fav = favs.has(tb.id);
          return (
            <article key={tb.id} className="jc-panel group flex flex-col gap-4 p-5 transition hover:border-gold-500/40" data-testid="lobby-table" data-table={tb.id}>
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-bold text-ivory">{tb.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={st === 'playing' ? 'green' : st === 'waiting' ? 'gold' : 'neutral'}>
                      {st === 'playing' && <span className="size-1.5 rounded-full bg-success jc-pulse-gold" />}
                      {t(`lobby.status.${st}` as MsgKey)}
                    </Badge>
                    {full && <span data-testid="full-badge"><Badge tone="red">{t('lobby.full')}</Badge></span>}
                    {tb.host && (
                      <span data-testid="member-badge" className="min-w-0 max-w-full">
                        <Badge className="max-w-full">
                          <HostedBy host={tb.host} />
                        </Badge>
                      </span>
                    )}
                    {tb.beginner && <span data-testid="beginner-badge"><Badge tone="blue">🔰 {t('lobby.beginner')}</Badge></span>}
                    {tb.botLevel && (
                      <span data-testid="bot-table-badge" data-level={tb.botLevel} title={t('lobby.botTableHint')}>
                        <Badge>{t('lobby.botTable', { level: t(BOT_LEVEL_LABEL[tb.botLevel]) })}</Badge>
                      </span>
                    )}
                    {tb.isPrivate && <Badge tone="red">🔒 {t('lobby.private')}</Badge>}
                    {!tb.allowSpectators && <Badge>{t('lobby.noSpectate')}</Badge>}
                    {tb.entryBlocked && <Badge tone="red">{t('lobby.blocked')}</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 items-start gap-1">
                  <div className="text-right">
                    <div className="font-mono text-2xl font-semibold text-gold-300 tabular-nums">
                      {tb.seated}
                      <span className="text-base text-ink-400">/{tb.maxSeats}</span>
                    </div>
                    <div className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.players')}</div>
                    {tb.bots > 0 && (
                      <div className="whitespace-nowrap text-[11px] text-ink-300" data-testid="lobby-humans-bots">
                        {t('lobby.humansBots', { humans: tb.seated - tb.bots, bots: tb.bots })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-pressed={fav}
                    aria-label={t(fav ? 'lobby.unfav' : 'lobby.fav', { name: tb.name })}
                    onClick={() => setFavourite(tb.id, !fav)}
                    className={cx('jc-tap -mr-2 -mt-1.5 grid size-10 place-items-center rounded-lg text-xl transition hover:bg-white/5', fav ? 'text-gold-300' : 'text-ink-400 hover:text-ink-200')}
                    data-testid="fav-toggle"
                  >
                    {fav ? '★' : '☆'}
                  </button>
                </div>
              </header>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-black/25 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.blinds')}</dt>
                  <dd className="font-mono font-semibold tabular-nums">
                    {formatChips(tb.smallBlind)} / {formatChips(tb.bigBlind)}
                  </dd>
                </div>
                <div className="rounded-lg bg-black/25 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.buyin')}</dt>
                  <dd className="font-mono font-semibold tabular-nums">
                    {formatChips(tb.minBuyIn, true)} – {formatChips(tb.maxBuyIn, true)}
                  </dd>
                </div>
              </dl>
              <div className="flex items-center justify-between text-xs text-ink-400">
                <span>{t('lobby.spectators', { n: tb.spectators })}</span>
                {tb.waitlist > 0 && <span>{t('lobby.waitlist', { n: tb.waitlist })}</span>}
              </div>
              <div className="mt-auto flex flex-col gap-2">
                {entry === 'wait' && (
                  <p className="text-xs text-ink-300" data-testid="lobby-wait-hint">
                    {tb.allowSpectators ? t('lobby.waitHint') : t('lobby.waitHintHidden')}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" disabled={!tb.allowSpectators} onClick={() => open(tb, 'watch')} data-testid="lobby-watch">
                    {tb.allowSpectators ? t('lobby.spectate') : t('lobby.noSpectate')}
                  </Button>
                  <Button
                    variant={entry === 'wait' ? 'outline' : 'gold'}
                    disabled={entry === 'blocked' || entry === 'closing' || !!paused}
                    onClick={() => open(tb, entry === 'wait' ? 'wait' : 'sit')}
                    data-testid="lobby-enter"
                    data-entry={entry}
                  >
                    {paused ? t('lobby.entry.maintenance') : t(`lobby.entry.${entry}` as MsgKey)}
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <JoinCodeModal table={codeFor?.table ?? null} then={codeFor?.then} onClose={() => setCodeFor(null)} />
      <CreateRoomModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
