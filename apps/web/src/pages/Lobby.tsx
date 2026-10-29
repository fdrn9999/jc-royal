import type { LobbyTableDto, TournamentSummaryDto } from '@jc/types';
import { Badge, Button, cx, Empty, formatChips, HourglassIcon, Input, LockIcon, PlayIcon, PlusIcon, RefreshCwIcon, Spinner, SproutIcon, StarIcon, TrophyIcon, UserIcon } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { tutorialComplete, useProgress } from '../academy/progress';
import { JoinCodeModal } from '../components/JoinCode';
import { BOT_LEVEL_LABEL, HostedBy } from '../components/MemberName';
import { ANY, filtersOf, QuickPlayPanel, useLobbyFilters, type QuickFilters } from '../components/QuickPlay';
import { CreateRoomModal } from '../components/Rooms';
import { InstallOffer } from '../components/InstallOffer';
import { MaintenanceNote } from '../components/MaintenanceNote';
import { ShareButton } from '../components/Share';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { entryOf, keepCard, latest, lobbyPoller, mergeList, newLobbyLive, POLL_MS, RESUME, RESUME_WAIT, useTablePrefs, type Latest } from '../lib/lobby';
import { rememberLobby } from '../lib/lobbyReturn';
import { setFavourite, useFavourites } from '../lib/prefs';
import { coalesced, onRealtime, realtimeUp, useRealtimeStatus, wantTopic } from '../lib/realtime';
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
 * returns or someone uses an idle lobby. Requests never overlap and an outdated answer is never applied. While the
 * realtime socket is up, each table's public changes arrive on it and are laid over the last read (mergeList); a
 * change to the player's own place makes one read of that table (it holds myParticipation), and the list itself is
 * read only every LIVE_POLL_MS, and once more whenever the socket comes (back) up.
 */
function useLobbyTables() {
  const [tables, setTables] = useState<LobbyTableDto[] | null>(null);
  const [error, setError] = useState(false);
  const feed = useRef<Latest | null>(null);
  const poller = useRef<ReturnType<typeof lobbyPoller> | null>(null);
  const up = useRealtimeStatus() === 'open';
  useEffect(() => {
    const live = newLobbyLive();
    let base: { list: LobbyTableDto[]; at: number } | null = null;
    let stopped = false;
    const show = (fresh = false) => {
      if (base && !stopped) setTables(mergeList(base.list, base.at, live, fresh));
    };
    const f = latest(
      (signal) => {
        const at = Date.now();
        return api<LobbyTableDto[]>('/api/tables', { signal }).then((list) => ({ list, at }));
      },
      (read) => {
        base = read;
        show(true);
        setError(false);
      },
      () => setError(true),
    );
    feed.current = f;
    // Asked for before the first read, so a change committed after that read began is not missed.
    const release = wantTopic('lobby');
    f.run();
    const reads = new Map<string, () => Promise<void>>();
    const readMine = (id: string) => {
      let read = reads.get(id);
      if (!read) {
        read = coalesced(async () => {
          const at = Date.now();
          const t = await api<LobbyTableDto>(`/api/tables/${encodeURIComponent(id)}`).catch(() => null);
          if (!t || t.roomType === 'tournament') return;
          const { myParticipation, ...card } = t;
          keepCard(live, id, card, at);
          live.mine.set(id, { p: myParticipation ?? { status: 'none' }, at });
          show();
        });
        reads.set(id, read);
      }
      void read();
    };
    const off = [
      onRealtime('lobby.table.changed', ({ payload: p }) => {
        if ((live.patches.get(p.id)?.rev ?? -1) < p.rev) live.patches.set(p.id, p);
        show();
      }),
      onRealtime('lobby.table.updated', ({ resourceId: id, payload: card }) => {
        keepCard(live, id, card, Date.now());
        show();
      }),
      onRealtime('lobby.table.removed', ({ resourceId: id }) => {
        live.gone.add(id);
        show();
      }),
      onRealtime('lobby.mine.changed', ({ resourceId: id }) => readMine(id)),
    ];
    const p = lobbyPoller(f, () => document.visibilityState === 'visible', Date.now, realtimeUp);
    poller.current = p;
    const h = setInterval(p.tick, POLL_MS);
    document.addEventListener('visibilitychange', p.wake);
    window.addEventListener('focus', p.wake);
    window.addEventListener('online', p.wake);
    for (const e of INPUT_EVENTS) window.addEventListener(e, p.input, { passive: true });
    return () => {
      stopped = true;
      f.stop();
      release();
      for (const o of off) o();
      clearInterval(h);
      document.removeEventListener('visibilitychange', p.wake);
      window.removeEventListener('focus', p.wake);
      window.removeEventListener('online', p.wake);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, p.input);
    };
  }, []);
  // The socket (back) up: changes arrive from now on, and the list is read once more for any made before.
  const wasUp = useRef(up);
  useEffect(() => {
    if (up && !wasUp.current) poller.current?.up();
    wasUp.current = up;
  }, [up]);
  // The refresh button replaces a request already out rather than waiting for it.
  const refresh = useCallback(() => void feed.current?.run(true), []);
  return { tables, error, refresh };
}

/**
 * Tournaments from the lobby (the navigation also has them, on a phone as the second tab). Asked once per visit, not
 * polled: the viewer's own tournament, if any, names itself; otherwise the card just describes them.
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
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-500/15 text-gold-300"><TrophyIcon className="size-6" /></span>
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

/**
 * The tables where the player holds a seat or a place on the waitlist, above everything else so no tab, search or
 * filter hides them: going to the lobby keeps both, and the game and its turn clock go on meanwhile.
 */
function MyGames({ tables }: { tables: LobbyTableDto[] }) {
  const { t } = useI18n();
  if (tables.length === 0) return null;
  const waits = (tb: LobbyTableDto) => tb.myParticipation?.status === 'waiting';
  return (
    <section id="lobby-my-games" className="flex scroll-mt-20 flex-col gap-2" aria-labelledby="lobby-my-games-title" data-testid="lobby-my-games">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="lobby-my-games-title" className="text-sm font-bold tracking-wide text-gold-300">{t('lobby.myGames')}</h2>
        {tables.some((tb) => !waits(tb)) && <p className="text-xs text-ink-300">{t('lobby.myGamesHint')}</p>}
        {tables.some(waits) && <p className="text-xs text-ink-300">{t('lobby.myWaitHint')}</p>}
      </div>
      {tables.map((tb) => {
        const p = tb.myParticipation;
        const blinds = `${formatChips(tb.smallBlind)}/${formatChips(tb.bigBlind)}`;
        return (
          <Link
            key={tb.id}
            to={`/table/${tb.id}`}
            state={p?.status === 'waiting' ? RESUME_WAIT : RESUME}
            className="jc-panel jc-tap flex min-w-0 items-center gap-3 border-gold-500/40 p-4 transition hover:border-gold-400/70"
            data-testid="lobby-my-game"
            data-table={tb.id}
            data-kind={p?.status === 'waiting' ? 'wait' : 'seat'}
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-500/15 text-gold-300">
              {p?.status === 'waiting' ? <HourglassIcon className="size-6" /> : <UserIcon className="size-6" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-ivory">{tb.name}</span>
              <span className="block truncate text-xs text-ink-300">
                {p?.status === 'waiting' ? t('lobby.myWaitLine', { blinds, n: p.position }) : t('lobby.myGameLine', { blinds, seated: tb.seated, max: tb.maxSeats })}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-gold-300">{t(p?.status === 'waiting' ? 'lobby.viewWaitlist' : 'lobby.continue')} →</span>
          </Link>
        );
      })}
    </section>
  );
}

/**
 * The lobby is the signed-in member's (their seats, places on a waitlist, tournament): another account signing in, from
 * another tab, starts it afresh, so nothing of the previous one shows and no answer asked for it is applied.
 */
export function LobbyPage() {
  const { me } = useAuth();
  return <Lobby key={me?.id} />;
}

function Lobby() {
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
      // Not in a transition (as in Hands): the next tap or key starts from this address, not from the one before it.
      { replace: true, flushSync: true },
    );
  // The box holds what is typed, so a key in the middle of the text stays there; a change the address makes elsewhere
  // (a reset, the logo) comes back into it.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
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

  // My seats (quick play asks before finding another) and, with them at the top, my places on waitlists.
  const mine = useMemo(() => (tables ?? []).filter((tb) => entryOf(tb) === 'continue'), [tables]);
  const myGames = useMemo(() => (tables ?? []).filter((tb) => entryOf(tb) === 'continue' || entryOf(tb) === 'waiting'), [tables]);

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
      <MyGames tables={myGames} />
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
            <PlusIcon />
            {t('room.create')}
          </Button>
        </div>
        {/* The search gives way where the row is tight (640px in English: the icon buttons, a little wider than the
            characters they replaced, pushed the page past the window on CI's fonts). */}
        <div className="flex min-w-0 gap-2">
          <Input placeholder={t('lobby.search')} value={text} onChange={(e) => { setText(e.target.value); view({ q: e.target.value }); }} className="min-w-0 sm:w-64" aria-label={t('lobby.search')} />
          <Button variant="subtle" onClick={refresh} aria-label={t('lobby.refresh')} data-testid="lobby-refresh">
            <RefreshCwIcon />
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
            <PlusIcon />
            {t('room.create')}
          </Button>
        </div>
      </div>

      <InstallOffer />
      {paused && <MaintenanceNote m={paused} what="games" />}
      <QuickPlayPanel filters={filters} blinds={blinds} onFilters={setFilters} onCreateRoom={() => setCreating(true)} paused={!!paused} mine={mine} />

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
                {f === 'fav' && <StarIcon className="mr-1 inline size-3.5 align-[-2px]" />}
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
          const seatedHere = entry === 'continue';
          const place = entry === 'waiting' && tb.myParticipation?.status === 'waiting' ? tb.myParticipation.position : null;
          const fav = favs.has(tb.id);
          // min-w-0: in the one-column list of a phone a long name (up to 40 characters) ends in an ellipsis, instead of
          // widening every card, and with them the page, past the screen.
          return (
            <article
              key={tb.id}
              className={cx('jc-panel group flex min-w-0 flex-col gap-4 p-5 transition hover:border-gold-500/40', (seatedHere || entry === 'waiting') && 'border-gold-500/40')}
              data-testid="lobby-table"
              data-table={tb.id}
            >
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-bold text-ivory">{tb.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={st === 'playing' ? 'green' : st === 'waiting' ? 'gold' : 'neutral'}>
                      {st === 'playing' && <span className="size-1.5 rounded-full bg-success jc-pulse-gold" />}
                      {t(`lobby.status.${st}` as MsgKey)}
                    </Badge>
                    {seatedHere && <span data-testid="lobby-mine-badge"><Badge tone="gold"><UserIcon className="size-3" />{t('lobby.mine')}</Badge></span>}
                    {entry === 'waiting' && <span data-testid="lobby-waiting-badge"><Badge tone="blue"><HourglassIcon className="size-3" />{t('lobby.waiting')}</Badge></span>}
                    {full && <span data-testid="full-badge"><Badge tone="red">{t('lobby.full')}</Badge></span>}
                    {tb.host && (
                      <span data-testid="member-badge" className="min-w-0 max-w-full">
                        <Badge className="max-w-full">
                          <HostedBy host={tb.host} />
                        </Badge>
                      </span>
                    )}
                    {tb.beginner && <span data-testid="beginner-badge"><Badge tone="blue"><SproutIcon className="size-3" />{t('lobby.beginner')}</Badge></span>}
                    {tb.botLevel && (
                      <span data-testid="bot-table-badge" data-level={tb.botLevel} title={t('lobby.botTableHint')}>
                        <Badge>{t('lobby.botTable', { level: t(BOT_LEVEL_LABEL[tb.botLevel]) })}</Badge>
                      </span>
                    )}
                    {tb.isPrivate && <Badge tone="red"><LockIcon className="size-3" />{t('lobby.private')}</Badge>}
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
                    className={cx('jc-tap -mr-2 -mt-1.5 grid size-10 place-items-center rounded-lg transition hover:bg-white/5', fav ? 'text-gold-300' : 'text-ink-400 hover:text-ink-200')}
                    data-testid="fav-toggle"
                  >
                    <StarIcon className={cx('size-5', fav && 'fill-current')} />
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
              {/* Nobody watches a table without spectators (the ones connected there are waiting for a seat): the line
                  keeps its height for the waitlist alone. */}
              <div className="flex min-h-4 items-center justify-between text-xs text-ink-400">
                <span>{tb.allowSpectators && t('lobby.spectators', { n: tb.spectators })}</span>
                {tb.waitlist > 0 && <span>{t('lobby.waitlist', { n: tb.waitlist })}</span>}
              </div>
              <div className="mt-auto flex flex-col gap-2">
                {/* Their own seat: one way back to it, no code, buy-in or waitlist, even during maintenance. */}
                {seatedHere ? (
                  <Button variant="gold" onClick={() => nav(`/table/${tb.id}`, { state: RESUME })} data-testid="lobby-continue">
                    <PlayIcon />
                    {t('lobby.continue')}
                  </Button>
                ) : place !== null ? (
                  // My place on its waitlist: a look at the table (the place lets me in, code or no spectators), never
                  // a second sign-up, which would put me at the back.
                  <>
                    <p className="text-xs text-ink-300" data-testid="lobby-wait-place">{t('lobby.waitPlace', { n: place })}</p>
                    <Button variant="gold" onClick={() => nav(`/table/${tb.id}`, { state: RESUME_WAIT })} data-testid="lobby-view-waitlist">
                      <HourglassIcon />
                      {t('lobby.viewWaitlist')}
                    </Button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
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
