/**
 * 종합 관제, the control center (docs/CONTROL_CENTER.md): every open table on one screen as a small oval, worst first,
 * what changed arriving on the console's own socket (/ws/admin/monitor), and one to four tables opened beside the grid.
 *
 * Read only. Watching is not spectating: no table counts this page among its spectators or its waitlist, and nothing
 * here shows a card a player holds (a room's summary has none). Acting on a table goes through the console's controls.
 *
 * What it costs: the list is one D1 read when the page opens and whenever its socket (re)connects (every 30 s while the
 * socket is down); a card's seats come from its room's summary, read only for the cards on screen or pinned, at most once
 * a minute (sooner after its counts changed) and only while the page is in view and in use; the tables opened beside
 * the grid are followed by the hub, which sends their summaries as they change.
 */
import {
  MONITOR_TABLES_MAX,
  type AdminMonitorEvent,
  type MonitorRoom,
  type MonitorRoomsResponse,
  type MonitorSeat,
  type MonitorTable,
  type MonitorTablesResponse,
} from '@jc/types';
import {
  Badge,
  BanIcon,
  BotIcon,
  Button,
  CircleAlertIcon,
  cx,
  EyeIcon,
  formatChips,
  InfoIcon,
  Input,
  ListOrderedIcon,
  LockIcon,
  OctagonAlertIcon,
  PauseIcon,
  PinIcon,
  PlayingCard,
  RefreshCwIcon,
  Spinner,
  Stat,
  TriangleAlertIcon,
  UsersIcon,
  WifiOffIcon,
  XIcon,
  type LucideIcon,
} from '@jc/ui';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type Key } from '../i18n';
import { actionLabel, botLevelLabel, botStyleLabel, seatPhaseLabel, stageLabel, tableIssueLabel, tnStatusLabel, topUpStateLabel, type Tr } from '../labels';
import { errText, useAdmin } from '../lib';
import {
  applyEvent,
  applyRooms,
  applySnapshot,
  CC_SIZES,
  CC_SORTS,
  CC_STATES,
  CC_TABS,
  CC_TYPES,
  compare,
  FOCUS_MAX,
  freshnessOf,
  keeps,
  levelOf,
  lingers,
  linkOf,
  loadPins,
  newerRoom,
  paramsOf,
  POLL_MS,
  problemsOf,
  roomsToRead,
  savePins,
  seatPoint,
  skewOf,
  tablesPath,
  toggleFocus,
  togglePin,
  totalsOf,
  viewOf,
  type CcSize,
  type CcSort,
  type CcState,
  type CcTab,
  type CcType,
  type CcView,
  type Freshness,
  type Judged,
  type Level,
  type LinkState,
  type Problem,
  type RoomEntry,
} from '../monitor';
import { useMonitorSocket } from '../monitorSocket';
import { IDLE_AFTER_MS } from './Dashboard';

// ------------------------------------------------------------------ words and looks

const TYPE_KEY: Record<CcType, Key> = { all: 'ccTypeAll', official: 'typeOfficial', member: 'memberRoom', tournament: 'tournamentRoom' };
const STATE_KEY: Record<CcState, Key> = {
  all: 'ccStateAll',
  playing: 'ccStatePlaying',
  waiting: 'ccStateWaiting',
  empty: 'ccStateEmpty',
  full: 'ccStateFull',
  blocked: 'ccStateBlocked',
  paused: 'ccStatePaused',
  closing: 'ccStateClosing',
  warnings: 'ccStateWarnings',
  bots: 'ccStateBots',
  connection: 'ccStateConnection',
  stale: 'ccStateStale',
  closed: 'ccStateClosed',
};
const SORT_KEY: Record<CcSort, Key> = {
  severity: 'ccSortSeverity',
  activity: 'ccSortActivity',
  players: 'ccSortPlayers',
  spectators: 'ccSortSpectators',
  waitlist: 'ccSortWaitlist',
  name: 'ccSortName',
  created: 'ccSortCreated',
  blinds: 'ccSortBlinds',
};
const TAB_KEY: Record<CcTab, Key> = { all: 'ccTabAll', pinned: 'ccTabPinned', problems: 'ccTabProblems' };
const SIZE_KEY: Record<CcSize, Key> = { s: 'ccSizeS', m: 'ccSizeM', l: 'ccSizeL' };
const FRESH_KEY: Record<Freshness, Key> = { live: 'ccFreshLive', stale: 'ccFreshStale', unknown: 'ccFreshUnknown', closing: 'ccFreshClosing', closed: 'ccFreshClosed' };
const FRESH_DOT: Record<Freshness, string> = { live: 'bg-success', stale: 'bg-danger', unknown: 'bg-warning', closing: 'bg-gold-400', closed: 'bg-ink-500' };
const LINK_KEY: Record<LinkState, Key> = { live: 'ccLinkLive', polling: 'ccLinkPolling', stale: 'ccLinkStale', connecting: 'ccLinkConnecting' };
const LINK_DOT: Record<LinkState, string> = { live: 'bg-success', polling: 'bg-warning', stale: 'bg-danger', connecting: 'bg-ink-500' };

type Severity = Exclude<Level, 0>;
const LEVEL_KEY: Record<Severity, Key> = { 1: 'ccLevel1', 2: 'ccLevel2', 3: 'ccLevel3', 4: 'ccLevel4' };
const LEVEL_ICON: Record<Severity, LucideIcon> = { 1: InfoIcon, 2: CircleAlertIcon, 3: TriangleAlertIcon, 4: OctagonAlertIcon };
const LEVEL_CHIP: Record<Severity, string> = {
  1: 'border-info/40 bg-info/10 text-[#a9c8ee]',
  2: 'border-gold-500/40 bg-gold-500/10 text-gold-300',
  3: 'border-warning/50 bg-warning/12 text-warning',
  4: 'border-danger/50 bg-danger/15 text-[#f0a0a2]',
};
const LEVEL_TEXT: Record<Level, string> = { 0: 'text-ink-400', 1: 'text-[#a9c8ee]', 2: 'text-gold-300', 3: 'text-warning', 4: 'text-[#f0a0a2]' };

/** A card's narrowest width, its felt's height and its seats' size, by the size chosen. */
const CARD_MIN: Record<CcSize, number> = { s: 190, m: 250, l: 330 };
const FELT_H: Record<CcSize, string> = { s: 'h-[84px]', m: 'h-[118px]', l: 'h-[168px]' };
const FELT_PAD: Record<CcSize, string> = { s: 'p-2.5', m: 'p-3.5', l: 'px-4.5 pt-4.5 pb-6' };
const SEAT_CLS: Record<CcSize, string> = { s: 'size-5 text-[10px]', m: 'size-7 text-[11px]', l: 'size-9 text-xs' };
const CARD_H: Record<CcSize, number> = { s: 200, m: 240, l: 320 };
const FELT_STYLE = {
  background: 'var(--t-felt)',
  boxShadow: 'inset 0 0 0 1px var(--t-felt-line), 0 0 0 3px var(--t-rail-inner), 0 0 0 4px rgba(212,175,55,0.38)',
} as const;

const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm text-ivory';
const linkBtn = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-sm font-semibold text-gold-300 hover:bg-white/5';

/** A problem in words (the room's own codes as the table page names them). */
export function problemLabel(t: Tr, p: Problem): string {
  switch (p.code) {
    case 'seated_on_closed':
      return t('ccPSeatedOnClosed');
    case 'close_overdue':
      return t('ccPCloseOverdue');
    case 'disconnected':
      return p.source === 'd1' ? t('ccPDisconnectedMin', { n: p.n ?? 0 }) : t('ccPDisconnected', { n: p.n ?? 0 });
    case 'room_unavailable':
      return t('ccPRoomUnavailable');
    case 'last_issue':
      return t('lastIssue');
    default:
      return tableIssueLabel(t, p.code);
  }
}

const timeOf = (ms: number, locale: string) => new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { timeStyle: 'medium' }).format(ms);
const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
const roomOf = (e: RoomEntry | undefined): MonitorRoom | null => (e && 'room' in e ? e.room : null);

function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

/** In view and used within IDLE_AFTER_MS (as the dashboard): room reads and polling stop otherwise; the socket stays. */
function useWatching(): boolean {
  const [on, setOn] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    let last = Date.now();
    let cur = document.visibilityState === 'visible';
    const set = (v: boolean) => {
      if (v === cur) return;
      cur = v;
      setOn(v);
    };
    const used = () => {
      last = Date.now();
      set(document.visibilityState === 'visible');
    };
    const shown = () => {
      if (document.visibilityState === 'visible') last = Date.now();
      set(document.visibilityState === 'visible');
    };
    const id = setInterval(() => set(document.visibilityState === 'visible' && Date.now() - last < IDLE_AFTER_MS), 15_000);
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, used, { passive: true });
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(id);
      for (const e of events) window.removeEventListener(e, used);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);
  return on;
}

/** Korea's time, the platform's own (the console's administrators work by it), from the server's clock. */
function KstClock({ skew }: { skew: number }) {
  const { t, locale } = useT();
  const now = useNow(1000);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    [locale],
  );
  return (
    <span data-testid="cc-clock" className="font-mono tabular-nums text-ink-200">
      {t('ccKst')} {fmt.format(now + skew)}
    </span>
  );
}

type Meta = Pick<MonitorTablesResponse, 'truncated' | 'seatedOnClosed' | 'memberTables' | 'at' | 'd1Ms'>;
type Cached = Judged & { entry: RoomEntry | undefined; link: LinkState };

// ------------------------------------------------------------------ the page

export function ControlCenterPage() {
  const { t, locale } = useT();
  const { me, api, refresh } = useAdmin();
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => viewOf(params), [params]);
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  /** Changes the view in the address (replacing it: filters are not history), from the address as it is now. */
  const setView = useCallback((patch: Partial<CcView> | ((v: CcView) => Partial<CcView>)) => {
    setParamsRef.current(
      (p) => {
        const v = viewOf(p);
        return paramsOf({ ...v, ...(typeof patch === 'function' ? patch(v) : patch) });
      },
      { replace: true },
    );
  }, []);

  // What is typed in the two search boxes reaches the address (and the server) once typing pauses, or on Enter.
  const [qDraft, setQDraft] = useState(view.q);
  const [memberDraft, setMemberDraft] = useState(view.member);
  const applied = useRef({ q: view.q, member: view.member });
  useEffect(() => {
    if (view.q !== applied.current.q) {
      applied.current.q = view.q;
      setQDraft(view.q);
    }
    if (view.member !== applied.current.member) {
      applied.current.member = view.member;
      setMemberDraft(view.member);
    }
  }, [view.q, view.member]);
  const applySearch = useCallback(
    (q: string, member: string) => {
      const next = { q: q.trim().slice(0, 64), member: member.trim().slice(0, 32) };
      if (next.q === applied.current.q && next.member === applied.current.member) return;
      applied.current = next;
      setView(next);
    },
    [setView],
  );
  useEffect(() => {
    const id = setTimeout(() => applySearch(qDraft, memberDraft), 400);
    return () => clearTimeout(id);
  }, [qDraft, memberDraft, applySearch]);

  const [tables, setTables] = useState<ReadonlyMap<string, MonitorTable>>(() => new Map());
  const tablesRef = useRef(tables);
  const putTables = useCallback((m: ReadonlyMap<string, MonitorTable>) => {
    tablesRef.current = m;
    setTables(m);
  }, []);
  const [rooms, setRooms] = useState<ReadonlyMap<string, RoomEntry>>(() => new Map());
  const roomsRef = useRef(rooms);
  const putRooms = useCallback((m: ReadonlyMap<string, RoomEntry>) => {
    roomsRef.current = m;
    setRooms(m);
  }, []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pins, setPins] = useState<string[]>(loadPins);
  const [activeId, setActiveId] = useState<string | null>(null);
  const skew = useRef(0);
  /** Tables whose room counts changed since their summary was read: read again sooner. */
  const changed = useRef(new Set<string>());
  const visible = useRef(new Set<string>());
  const watching = useWatching();
  const now = useNow(5000);

  const listPath = tablesPath(view);
  const scope: 'active' | 'closed' = view.state === 'closed' ? 'closed' : 'active';
  // A list the server narrowed (a search) gains no table from an event: it would not know whether one matches.
  const eventScope: typeof scope | null = view.q || view.member ? null : scope;
  const latest = useRef({ listPath, scope, eventScope, focus: view.focus, pins, watching, t, api, sortedIds: [] as string[], truncated: false });
  Object.assign(latest.current, { listPath, scope, eventScope, focus: view.focus, pins, watching, t, api, truncated: meta?.truncated ?? false });

  /** Reads the list (one at a time; a read asked for meanwhile runs once after it). A late answer for an old filter is dropped. */
  const readList = useMemo(() => {
    let running = false;
    let queued = false;
    const run = async (): Promise<void> => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      setReading(true);
      const { listPath: path, scope: sc } = latest.current;
      const sent = Date.now();
      try {
        const r = await latest.current.api<MonitorTablesResponse>(path);
        if (path === latest.current.listPath) {
          const got = Date.now();
          skew.current = skewOf(r.at, sent, got);
          // A table that just closed stays a while on the open list, shown closed, though the read no longer lists it.
          putTables(applySnapshot(tablesRef.current, r.items, sc === 'active' ? (x) => x.status === 'closed' && lingers(x, 'active', r.at) : undefined));
          setMeta({ truncated: r.truncated, seatedOnClosed: r.seatedOnClosed, memberTables: r.memberTables, at: r.at, d1Ms: r.d1Ms });
          setLastReadAt(got);
          setListError(null);
        } else queued = true;
      } catch (e) {
        if (path === latest.current.listPath) setListError(errText(e, latest.current.t));
      } finally {
        running = false;
        setReading(false);
        if (queued) {
          queued = false;
          void run();
        }
      }
    };
    return run;
  }, [putTables]);

  /** The summaries of the rooms on screen or pinned that are due (closed tables never; see roomsToRead). */
  const readRooms = useMemo(() => {
    let busy = false;
    let pauseUntil = 0;
    return async (force = false): Promise<void> => {
      const l = latest.current;
      if (busy || (!force && (!l.watching || Date.now() < pauseUntil))) return;
      const ids = roomsToRead({
        pinned: l.pins,
        visible: l.sortedIds.filter((id) => visible.current.has(id)),
        focus: l.focus,
        tables: tablesRef.current,
        rooms: force ? new Map() : roomsRef.current,
        changed: changed.current,
        now: Date.now(),
      });
      if (!ids.length) return;
      busy = true;
      try {
        const r = await l.api<MonitorRoomsResponse>('/api/admin/monitor/rooms', { body: { ids } });
        putRooms(applyRooms(roomsRef.current, r, Date.now()));
        for (const id of ids) changed.current.delete(id);
      } catch {
        // Each card says how old its seats are; the next try waits a little.
        pauseUntil = Date.now() + 30_000;
      } finally {
        busy = false;
      }
    };
  }, [putRooms]);

  /** The tables open in the panel, read with `follow`: the hub then sends their summaries as they change, for a while. */
  const readFocus = useMemo(
    () => async (): Promise<void> => {
      const l = latest.current;
      const ids = l.focus.filter((id) => {
        const x = tablesRef.current.get(id);
        return !!x && x.status !== 'closed';
      });
      if (!ids.length) return;
      try {
        const r = await l.api<MonitorRoomsResponse>('/api/admin/monitor/rooms', { body: { ids, follow: true } });
        putRooms(applyRooms(roomsRef.current, r, Date.now()));
      } catch {
        // The panel says when its room last answered.
      }
    },
    [putRooms],
  );

  const helloSeen = useRef(false);
  const unknownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(unknownTimer.current), []);

  const socket = useMonitorSocket({
    watch: view.focus,
    onHello: () => {
      helloSeen.current = true;
      void readList();
      void readFocus();
    },
    onEvent: (e: AdminMonitorEvent) => {
      if (e.type === 'admin.monitor.room') {
        const room = e.room as MonitorRoom;
        if (!newerRoom(roomsRef.current.get(room.tableId), room)) return;
        const m = new Map(roomsRef.current);
        m.set(room.tableId, { room, at: Date.now() });
        putRooms(m);
        return;
      }
      const r = applyEvent(tablesRef.current, e, latest.current.eventScope);
      if (r.tables !== tablesRef.current) putTables(r.tables);
      if (e.type === 'admin.monitor.counts' && roomsRef.current.has(e.resourceId)) changed.current.add(e.resourceId);
      if (r.unknown && !latest.current.truncated) {
        clearTimeout(unknownTimer.current);
        unknownTimer.current = setTimeout(() => void readList(), 1500);
      }
    },
    onCheck: () => void refresh(),
  });

  // The first read waits a moment for the socket's hello (which reads), so opening the page costs one read.
  useEffect(() => {
    const id = setTimeout(() => {
      if (!helloSeen.current) void readList();
    }, 1500);
    return () => clearTimeout(id);
  }, [readList]);
  // Another filter the server narrows by: a new list.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    putTables(new Map());
    setMeta(null);
    void readList();
  }, [listPath, putTables, readList]);
  // The socket down: read the list every POLL_MS while the page is watched.
  useEffect(() => {
    if (socket.status === 'open' || !watching) return;
    const id = setInterval(() => void readList(), POLL_MS);
    return () => clearInterval(id);
  }, [socket.status, watching, readList]);
  useEffect(() => {
    if (!watching) return;
    void readRooms();
    const id = setInterval(() => void readRooms(), 5000);
    return () => clearInterval(id);
  }, [watching, readRooms]);
  const focusKey = view.focus.join(',');
  const hasList = meta !== null;
  useEffect(() => {
    if (!hasList || !watching) return;
    void readFocus();
    const id = setInterval(() => void readFocus(), 60_000);
    return () => clearInterval(id);
  }, [focusKey, hasList, watching, readFocus]);

  // Which cards are on screen (a little beyond): only theirs are read.
  const els = useRef(new Map<Element, string>());
  const io = useRef<IntersectionObserver | null>(null);
  const visTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const o = new IntersectionObserver(
      (entries) => {
        let moved = false;
        for (const en of entries) {
          const id = els.current.get(en.target);
          if (!id) continue;
          if (en.isIntersecting) {
            if (!visible.current.has(id)) {
              visible.current.add(id);
              moved = true;
            }
          } else if (visible.current.delete(id)) moved = true;
        }
        if (moved) {
          clearTimeout(visTimer.current);
          visTimer.current = setTimeout(() => void readRooms(), 600);
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.current = o;
    for (const el of els.current.keys()) o.observe(el);
    return () => {
      o.disconnect();
      io.current = null;
      clearTimeout(visTimer.current);
    };
  }, [readRooms]);
  const observe = useCallback((id: string, el: Element) => {
    els.current.set(el, id);
    io.current?.observe(el);
    return () => {
      els.current.delete(el);
      io.current?.unobserve(el);
      visible.current.delete(id);
    };
  }, []);

  const link = linkOf(socket.status === 'parked' ? 'down' : socket.status, lastReadAt, now);
  const cache = useRef(new Map<string, Cached>());
  const all = useMemo(() => {
    const next = new Map<string, Cached>();
    const out: Cached[] = [];
    const serverNow = now + skew.current;
    for (const x of tables.values()) {
      if (!lingers(x, scope, serverNow)) continue;
      const entry = rooms.get(x.id);
      const old = cache.current.get(x.id);
      let j: Cached;
      if (old && old.table === x && old.entry === entry && old.link === link) j = old;
      else {
        const problems = problemsOf(x, entry);
        j = { table: x, problems, level: levelOf(problems), fresh: freshnessOf(x, link, entry), entry, link };
      }
      next.set(x.id, j);
      out.push(j);
    }
    cache.current = next;
    return out;
  }, [tables, rooms, link, scope, now]);
  const pinSet = useMemo(() => new Set(pins), [pins]);
  const grid = useMemo(() => all.filter((j) => keeps(j, view, pinSet)).sort(compare(view.sort, locale)), [all, view, pinSet, locale]);
  const tabCounts = useMemo(() => Object.fromEntries(CC_TABS.map((tab) => [tab, all.filter((j) => keeps(j, { ...view, tab }, pinSet)).length])) as Record<CcTab, number>, [all, view, pinSet]);
  const totals = useMemo(() => totalsOf(all), [all]);
  useEffect(() => {
    latest.current.sortedIds = grid.map((j) => j.table.id);
  }, [grid]);

  const onSelect = useCallback(
    (id: string, add: boolean) => {
      const f = latest.current.focus;
      // A card already open beside others comes to the front; clicked again alone, it closes.
      if (!add && f.length > 1 && f.includes(id)) {
        setActiveId((a) => (a === id ? a : id));
        if (activeRef.current !== id) return;
      }
      setView((v) => ({ focus: toggleFocus(v.focus, id, add) }));
      setActiveId(id);
    },
    [setView],
  );
  const onPin = useCallback((id: string) => {
    setPins((p) => {
      const n = togglePin(p, id);
      savePins(n);
      return n;
    });
  }, []);
  const closePanel = useCallback(() => setView({ focus: [] }), [setView]);
  const closeOne = useCallback((id: string) => setView((v) => ({ focus: v.focus.filter((x) => x !== id) })), [setView]);

  const active = activeId && view.focus.includes(activeId) ? activeId : (view.focus[view.focus.length - 1] ?? null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusSet = useMemo(() => new Set(view.focus), [view.focus]);

  useEffect(() => {
    if (!view.focus.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.focus.length, closePanel]);

  const doRefresh = () => {
    void readList();
    void readRooms(true);
    void readFocus();
  };

  const activeTable = active ? tables.get(active) : undefined;
  const activeJudged = active ? all.find((j) => j.table.id === active) : undefined;
  const emptyWord =
    view.member && meta?.memberTables?.length === 0
      ? t('ccNoMemberTables', { name: view.member })
      : view.tab === 'pinned' && !pins.length
        ? t('ccNoPinned')
        : t('ccNoTables');

  return (
    <div data-testid="control-center" className={cx('flex flex-col gap-4', view.focus.length > 0 && 'pb-[64dvh] xl:pb-0')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold">{t('controlCenter')}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-400">
          <span data-testid="cc-link" data-state={socket.status === 'parked' ? 'parked' : link} aria-live="polite" className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx('size-2 rounded-full', socket.status === 'parked' ? 'bg-ink-500' : LINK_DOT[link])} />
            <span className={cx(link === 'live' && socket.status !== 'parked' && 'font-semibold text-[#7fd3a3]')}>
              {socket.status === 'parked' ? t('ccLinkParked') : t(LINK_KEY[link], { s: POLL_MS / 1000 })}
            </span>
            {!watching && <span className="text-ink-500">· {t('ccIdle')}</span>}
          </span>
          {(socket.status === 'parked' || socket.status === 'down') && (
            <Button size="sm" variant="subtle" onClick={socket.reconnect}>
              {t('ccReconnect')}
            </Button>
          )}
          <KstClock skew={skew.current} />
          {me && (
            <span data-testid="cc-admin" className="max-w-[10rem] truncate">
              {me.user.nickname}
            </span>
          )}
          {meta && (
            <span data-testid="cc-meta" className="tabular-nums">
              {t('updatedAt', { time: timeOf(meta.at, locale) })} · {t('ccD1Ms', { ms: meta.d1Ms })}
            </span>
          )}
          <Button size="sm" variant="subtle" disabled={reading} onClick={doRefresh} aria-label={t('refresh')}>
            <RefreshCwIcon className={cx('size-3.5', reading && 'animate-spin')} />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {listError && (
        <p role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-[#f0a0a2]">
          <span className="min-w-0 flex-1">{meta ? t('refreshFailedStale', { msg: listError }) : t('loadFailed', { msg: listError })}</span>
          <Button size="sm" variant="subtle" onClick={() => void readList()}>
            {t('refresh')}
          </Button>
        </p>
      )}

      <section aria-label={t('ccKpis')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label={t('ccKpiTables')} value={String(totals.tables)} sub={t('ccKpiTablesSub', { closing: totals.closing, blocked: totals.blocked })} />
        <Stat label={t('ccKpiPlaying')} value={String(totals.playing)} sub={t('ccKpiPlayingSub', { paused: totals.paused })} />
        <Stat label={t('ccKpiMembers')} value={String(totals.members)} sub={t('ccKpiMembersSub', { n: totals.connections })} />
        <Stat label={t('ccKpiBots')} value={String(totals.bots)} />
        <Stat label={t('ccKpiSpectators')} value={String(totals.spectators)} sub={t('ccKpiSpectatorsSub', { n: totals.waitlist })} />
        <Stat
          label={t('ccKpiProblems')}
          value={String(totals.problems)}
          sub={<span className={cx(totals.urgent > 0 && 'font-semibold text-[#f0a0a2]')}>{t('ccKpiProblemsSub', { n: totals.urgent })}</span>}
        />
      </section>

      {meta && meta.seatedOnClosed.length > 0 && (
        <p role="alert" data-testid="cc-seated-on-closed" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-[#f0a0a2]">
          <OctagonAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{t('ccSeatedOnClosed', { n: meta.seatedOnClosed.length })}</span>
          {view.state !== 'closed' && (
            <Button size="sm" variant="subtle" onClick={() => setView({ state: 'closed', tab: 'all' })}>
              {t('ccShowClosed')}
            </Button>
          )}
        </p>
      )}
      {meta?.truncated && (
        <p className="rounded-xl border border-gold-500/35 bg-gold-500/10 px-4 py-3 text-sm text-gold-300">{t('ccTruncated', { n: MONITOR_TABLES_MAX })}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-0 flex-1 basis-56"
          value={qDraft}
          maxLength={64}
          onChange={(e) => setQDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applySearch(qDraft, memberDraft)}
          placeholder={t('ccSearch')}
          aria-label={t('ccSearch')}
          data-testid="cc-search"
        />
        <Input
          className="min-w-0 flex-1 basis-44"
          value={memberDraft}
          maxLength={32}
          onChange={(e) => setMemberDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applySearch(qDraft, memberDraft)}
          placeholder={t('ccMemberSearch')}
          aria-label={t('ccMemberSearch')}
          data-testid="cc-member"
        />
        <select className={selectCls} value={view.type} onChange={(e) => setView({ type: e.target.value as CcType })} aria-label={t('ccType')} data-testid="cc-type">
          {CC_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(TYPE_KEY[x])}
            </option>
          ))}
        </select>
        <select className={selectCls} value={view.state} onChange={(e) => setView({ state: e.target.value as CcState })} aria-label={t('ccState')} data-testid="cc-state">
          {CC_STATES.map((x) => (
            <option key={x} value={x}>
              {t(STATE_KEY[x])}
            </option>
          ))}
        </select>
        <select className={selectCls} value={view.sort} onChange={(e) => setView({ sort: e.target.value as CcSort })} aria-label={t('ccSort')} data-testid="cc-sort">
          {CC_SORTS.map((x) => (
            <option key={x} value={x}>
              {t(SORT_KEY[x])}
            </option>
          ))}
        </select>
        <div role="group" aria-label={t('ccSize')} className="inline-flex h-11 items-center rounded-lg border border-white/10 bg-ink-850 p-1">
          {CC_SIZES.map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={view.size === x}
              onClick={() => setView({ size: x })}
              className={cx('h-full min-w-9 rounded-md px-2 text-xs font-semibold', view.size === x ? 'bg-gold-500/15 text-gold-300' : 'text-ink-300 hover:text-ivory')}
            >
              {t(SIZE_KEY[x])}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,440px)] xl:items-start">
        <section aria-label={t('ccGrid')} className="flex min-w-0 flex-col gap-3">
          <div role="group" aria-label={t('ccTabs')} className="flex flex-wrap gap-1.5">
            {CC_TABS.map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={view.tab === x}
                data-testid={`cc-tab-${x}`}
                onClick={() => setView({ tab: x })}
                className={cx(
                  'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold',
                  view.tab === x ? 'border-gold-500/50 bg-gold-500/12 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory',
                )}
              >
                {x === 'pinned' && <PinIcon className="size-3.5" />}
                {x === 'problems' && <TriangleAlertIcon className="size-3.5" />}
                {t(TAB_KEY[x])}
                <span className="font-mono text-xs tabular-nums text-ink-400">{tabCounts[x]}</span>
              </button>
            ))}
          </div>
          {!meta && !tables.size ? (
            <div className="flex min-h-40 items-center justify-center rounded-xl border border-white/5 text-ink-400">
              <Spinner label={t('loading')} />
            </div>
          ) : grid.length === 0 ? (
            <p data-testid="cc-empty" className="rounded-xl border border-white/5 px-4 py-10 text-center text-sm text-ink-400">
              {emptyWord}
            </p>
          ) : (
            <div data-testid="cc-grid" className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${CARD_MIN[view.size]}px), 1fr))` }}>
              {grid.map((j) => (
                <MiniTable
                  key={j.table.id}
                  j={j}
                  entry={(j as Cached).entry}
                  size={view.size}
                  selected={focusSet.has(j.table.id)}
                  active={active === j.table.id}
                  pinned={pinSet.has(j.table.id)}
                  onSelect={onSelect}
                  onPin={onPin}
                  observe={observe}
                />
              ))}
            </div>
          )}
        </section>

        <aside
          aria-label={t('ccPanel')}
          data-testid="cc-panel"
          className={cx(
            'fixed inset-x-0 bottom-0 z-40 max-h-[62dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-white/10 bg-ink-900 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.55)]',
            'xl:sticky xl:inset-auto xl:top-[calc(var(--shell-h,7rem)+1rem)] xl:z-auto xl:max-h-[calc(100dvh-var(--shell-h,7rem)-2rem)] xl:rounded-xl xl:border xl:shadow-none',
            !view.focus.length && 'hidden xl:block',
          )}
        >
          {!view.focus.length ? (
            <p className="py-8 text-center text-sm text-ink-400">{t('ccPanelHint', { max: FOCUS_MAX })}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {view.focus.length > 1 && (
                <div role="tablist" aria-label={t('ccFocused', { n: view.focus.length, max: FOCUS_MAX })} className="flex gap-1 overflow-x-auto pb-1">
                  {view.focus.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={id === active}
                      onClick={() => setActiveId(id)}
                      className={cx(
                        'h-8 max-w-[11rem] shrink-0 truncate rounded-full border px-3 text-xs font-semibold',
                        id === active ? 'border-gold-500/50 bg-gold-500/12 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory',
                      )}
                    >
                      {tables.get(id)?.name ?? id}
                    </button>
                  ))}
                </div>
              )}
              {active && activeTable && activeJudged ? (
                <FocusPanel
                  key={active}
                  j={activeJudged}
                  entry={rooms.get(active)}
                  skew={skew.current}
                  onClose={() => (view.focus.length > 1 ? closeOne(active) : closePanel())}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <p className="min-w-0 flex-1 text-sm text-ink-400">{meta ? t('ccNotListed') : t('loading')}</p>
                  <Button size="sm" variant="ghost" aria-label={t('ccClose')} onClick={() => (active && view.focus.length > 1 ? closeOne(active) : closePanel())}>
                    <XIcon className="size-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ one table's card

interface CardProps {
  j: Judged;
  entry: RoomEntry | undefined;
  size: CcSize;
  selected: boolean;
  active: boolean;
  pinned: boolean;
  onSelect: (id: string, add: boolean) => void;
  onPin: (id: string) => void;
  observe: (id: string, el: Element) => () => void;
}

/**
 * A table as a small oval: its seats where the room says they are (only once its summary was read: before that, faint
 * outlines and the count D1 has, never a guessed seat), the hand's street, pot and number, and what is wrong with it.
 * Every line has a fixed height, so a card does not change size as its table changes.
 */
const MiniTable = memo(function MiniTable({ j, entry, size, selected, active, pinned, onSelect, onPin, observe }: CardProps) {
  const { t } = useT();
  const tb = j.table;
  const ref = useCallback((el: HTMLElement | null) => (el ? observe(tb.id, el) : undefined), [observe, tb.id]);
  const room = tb.status !== 'closed' ? roomOf(entry) : null;
  const hand = room?.hand ?? null;
  const top = j.problems[0];
  const lvl = j.level;
  const summary = [
    tb.name,
    t(TYPE_KEY[tb.roomType]),
    t('ccSeatedOf', { n: tb.seated, max: tb.maxSeats }),
    hand ? `${stageLabel(t, hand.stage)} ${t('ccPotShort')} ${formatChips(hand.potTotal)}` : room ? t('idleState') : '',
    t(FRESH_KEY[j.fresh]),
    lvl !== 0 ? t(LEVEL_KEY[lvl]) : '',
    top ? problemLabel(t, top) : '',
  ]
    .filter(Boolean)
    .join(', ');

  let center: ReactNode;
  if (hand) {
    center = (
      <>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-gold-300/90">{stageLabel(t, hand.stage)}</span>
        {size === 'l' && hand.board.length > 0 && (
          <span className="flex gap-0.5">
            {hand.board.map((c, i) => (
              <PlayingCard key={i} card={c} size="1.05rem" />
            ))}
          </span>
        )}
        <span className="font-mono text-xs font-semibold text-ivory tabular-nums">
          {t('ccPotShort')} {formatChips(hand.potTotal, true)}
        </span>
        {size !== 's' && <span className="font-mono text-[10px] text-ink-300">#{room!.handNumber}</span>}
      </>
    );
  } else if (room) {
    center = (
      <>
        <span className="text-[11px] text-ink-300">{room.status === 'closing' ? t('ccFreshClosing') : t('idleState')}</span>
        {room.handNumber > 0 && size !== 's' && <span className="font-mono text-[10px] text-ink-400">#{room.handNumber}</span>}
      </>
    );
  } else {
    center = (
      <>
        <span className="font-mono text-sm font-semibold text-ivory tabular-nums">
          {tb.seated}/{tb.maxSeats}
        </span>
        <span className="text-[10px] text-ink-400">{tb.status === 'closed' ? t('ccFreshClosed') : tb.playing ? t('ccStatePlaying') : t('ccStateWaiting')}</span>
      </>
    );
  }

  return (
    <article
      ref={ref}
      data-testid="cc-card"
      data-table={tb.id}
      data-level={lvl}
      data-fresh={j.fresh}
      data-room={room ? 'yes' : 'no'}
      className={cx(
        'group relative flex min-w-0 flex-col gap-1.5 rounded-xl border bg-ink-900/80 p-3 transition-colors',
        active ? 'border-gold-400/80 ring-2 ring-gold-500/45' : selected ? 'border-gold-500/60 ring-1 ring-gold-500/30' : 'border-white/8 hover:border-white/20',
        tb.status === 'closed' && 'opacity-70',
      )}
      style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${CARD_H[size]}px` }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={summary}
        onClick={(e) => onSelect(tb.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-400"
      />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ivory">{tb.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-300 tabular-nums">
          {formatChips(tb.smallBlind, true)}/{formatChips(tb.bigBlind, true)}
        </span>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={`${pinned ? t('ccUnpin') : t('ccPin')}: ${tb.name}`}
          title={pinned ? t('ccUnpin') : t('ccPin')}
          onClick={() => onPin(tb.id)}
          className={cx('relative z-10 -m-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/5', pinned ? 'text-gold-300' : 'text-ink-500')}
        >
          <PinIcon className={cx('size-3.5', pinned && 'fill-current')} />
        </button>
      </div>
      <div className="flex h-4 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-ink-400">
        <span className="shrink-0">{t(TYPE_KEY[tb.roomType])}</span>
        {tb.hostNickname && <span className="min-w-0 truncate">· {tb.hostNickname}</span>}
      </div>

      {/* The felt is drawn above the card's button (it is positioned): it lets a click through to it. */}
      <div className={cx(FELT_PAD[size], 'pointer-events-none')} aria-hidden>
        <div className={cx('relative', FELT_H[size])}>
          <div className="absolute inset-[9%_4%] rounded-[999px]" style={FELT_STYLE} />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-[20%] text-center leading-tight">{center}</div>
          {Array.from({ length: tb.maxSeats }, (_, i) => {
            const p = seatPoint(i, tb.maxSeats);
            return <SeatDot key={i} s={room?.seats[i]} known={!!room} size={size} actor={hand?.actorSeat === i} reserved={room?.reservation?.seatIndex === i} x={p.x} y={p.y} />;
          })}
        </div>
      </div>

      <p className={cx('h-4 truncate text-[11px] leading-4', top ? LEVEL_TEXT[top.level] : '')}>
        {top ? `${problemLabel(t, top)}${j.problems.length > 1 ? ` +${j.problems.length - 1}` : ''}` : ' '}
      </p>
      <div className="flex h-4 items-center gap-3 overflow-hidden whitespace-nowrap text-[11px] text-ink-300 tabular-nums">
        <Count icon={UsersIcon} value={`${tb.seated}/${tb.maxSeats}`} label={t('ccSeatedLabel')} />
        <Count icon={BotIcon} value={tb.bots} label={t('ccKpiBots')} dim={!tb.bots} />
        <Count icon={EyeIcon} value={tb.spectators} label={t('watchers')} dim={!tb.spectators} />
        <Count icon={ListOrderedIcon} value={tb.waitlist} label={t('ccWaitlistLabel')} dim={!tb.waitlist} />
      </div>
      <div className="flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px]">
        <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', FRESH_DOT[j.fresh])} />
        <span className="shrink-0 text-ink-400">{t(FRESH_KEY[j.fresh])}</span>
        {lvl !== 0 && <LevelChip level={lvl} word={t(LEVEL_KEY[lvl])} />}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-ink-400">
          {tb.entryBlocked && <Mark icon={BanIcon} label={t('entryBlockedShort')} />}
          {tb.handsPaused && <Mark icon={PauseIcon} label={t('pausedBadge')} />}
          {tb.isPrivate && <Mark icon={LockIcon} label={t('private')} />}
        </span>
      </div>
    </article>
  );
});

function SeatDot({ s, known, size, actor, reserved, x, y }: { s: MonitorSeat | undefined; known: boolean; size: CcSize; actor: boolean; reserved: boolean; x: number; y: number }) {
  const pos = { left: `${x}%`, top: `${y}%` };
  const base = cx('absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border font-semibold', SEAT_CLS[size]);
  if (!known || !s) return <span className={cx(base, 'border-white/12 bg-black/20')} style={pos} />;
  if (s.state === 'empty')
    return <span className={cx(base, 'border-dashed', reserved ? 'border-gold-500/70 bg-gold-500/10' : s.held ? 'border-white/30 bg-black/30' : 'border-white/15 bg-black/25')} style={pos} />;
  const out = s.state === 'folded' || s.state === 'sittingOut';
  return (
    <span
      className={cx(
        base,
        'border-[var(--t-seat-border)] bg-[var(--t-seat)]',
        s.bot ? 'text-[#a9c8ee]' : 'text-ivory',
        s.state === 'allin' && 'border-danger/70',
        out && 'opacity-45',
        actor && 'ring-2 ring-gold-400 shadow-[0_0_10px_rgba(212,175,55,0.55)]',
      )}
      style={pos}
    >
      {s.bot ? <BotIcon className="size-[60%]" /> : (Array.from(s.nickname ?? '?')[0] ?? '?')}
      {!s.connected && (
        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-danger text-ink-950">
          <WifiOffIcon className="size-2.5" />
        </span>
      )}
      {size === 'l' && (
        <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap rounded bg-black/65 px-1 font-mono text-[10px] font-normal leading-tight text-ink-100 tabular-nums">
          {formatChips(s.stack, true)}
        </span>
      )}
    </span>
  );
}

function Count({ icon: Icon, value, label, dim }: { icon: LucideIcon; value: ReactNode; label: string; dim?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1', dim && 'text-ink-500')} title={label}>
      <Icon className="size-3.5 text-ink-400" />
      {value}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Mark({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex" title={label}>
      <Icon className="size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function LevelChip({ level, word }: { level: Severity; word: string }) {
  const Icon = LEVEL_ICON[level];
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold', LEVEL_CHIP[level])}>
      <Icon className="size-3" />
      {word}
    </span>
  );
}

// ------------------------------------------------------------------ one table in detail

function Sec({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-white/8 pt-3">
      <h3 id={id} className="mb-2 text-xs font-bold tracking-[0.06em] text-gold-300">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-400">{k}</dt>
      <dd className="min-w-0 text-right font-mono text-ivory tabular-nums">{children}</dd>
    </>
  );
}

const dlCls = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm';

/**
 * The table opened beside the grid: its hand, its seats, its money in play, how its room and D1 agree, its bots and its
 * tournament. Only what the room's summary and D1's row say; a check of the ledger is the table page's.
 */
function FocusPanel({ j, entry, skew, onClose }: { j: Judged; entry: RoomEntry | undefined; skew: number; onClose: () => void }) {
  const { t, locale } = useT();
  // The tick redraws the countdowns each second; the time is read at each drawing, so a room push that lands between
  // two ticks counts from now (a 30-second turn that just began reads 30, not 31).
  useNow(1000);
  const now = Date.now() + skew;
  const tb = j.table;
  const room = tb.status !== 'closed' ? roomOf(entry) : null;
  const hand = room?.hand ?? null;
  const turn = hand?.turn ?? null;
  const tn = room?.tournament ?? null;
  const roomSeated = room ? room.seats.filter((s) => s.state !== 'empty').length : null;
  const roomBots = room ? room.seats.filter((s) => s.state !== 'empty' && s.bot).length : null;
  const seatState = (s: MonitorSeat) =>
    s.state === 'folded'
      ? t('ccFolded')
      : s.state === 'allin'
        ? t('ccAllIn')
        : s.state === 'active'
          ? t('ccInHand')
          : s.state === 'sittingOut'
            ? t('sittingOut')
            : t('ccWaitingSeat');

  let roomWord: string;
  if (tb.status === 'closed') roomWord = t('ccFreshClosed');
  else if (!entry) roomWord = t('ccRoomNotRead');
  else if ('error' in entry) roomWord = entry.error === 'room_unavailable' ? t('ccRoomFailed', { time: timeOf(entry.at, locale) }) : t('ccFreshClosed');
  else roomWord = t('ccRoomAnswered', { time: timeOf(entry.at, locale), ms: entry.ms ?? '–' });

  return (
    <div data-testid="cc-detail" data-table={tb.id} className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-ivory">{tb.name}</h2>
          <p className="truncate select-all font-mono text-[11px] text-ink-400">{tb.id}</p>
        </div>
        <Button size="sm" variant="ghost" aria-label={t('ccClose')} onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{t(TYPE_KEY[tb.roomType])}</Badge>
        <Badge>
          {t('blinds')} {formatChips(tb.smallBlind)}/{formatChips(tb.bigBlind)}
        </Badge>
        <Badge tone={tb.status === 'open' ? 'green' : tb.status === 'closing' ? 'gold' : 'neutral'}>{t(FRESH_KEY[j.fresh])}</Badge>
        {tb.entryBlocked && (
          <Badge tone="red">
            <BanIcon className="size-3" />
            {t('entryBlockedShort')}
          </Badge>
        )}
        {tb.handsPaused && (
          <Badge tone="gold">
            <PauseIcon className="size-3" />
            {t('pausedBadge')}
          </Badge>
        )}
        {tb.isPrivate && (
          <Badge>
            <LockIcon className="size-3" />
            {t('private')}
          </Badge>
        )}
        {room?.maintenance && <Badge tone="gold">{t('ccMaintenance')}</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to={`/tables/${tb.id}`} className={linkBtn} data-testid="cc-open-detail">
          {t('ccOpenDetail')}
        </Link>
      </div>
      <p className="text-xs text-ink-400" data-testid="cc-room-word">
        {roomWord} · {tb.liveAt ? t('ccD1Live', { time: timeOf(tb.liveAt, locale) }) : t('ccD1Never')}
      </p>

      <Sec id="cc-sec-progress" title={t('ccSecProgress')}>
        {room ? (
          <dl className={dlCls}>
            <Row k={t('ccHandNumber')}>#{room.handNumber}</Row>
            <Row k={t('ccStreet')}>{hand ? stageLabel(t, hand.stage) : t('idleState')}</Row>
            {hand && (
              <>
                <Row k={t('ccActor')}>{hand.actorSeat !== null ? t('ccSeatN', { n: hand.actorSeat + 1 }) : '–'}</Row>
                <Row k={t('ccPot')}>{formatChips(hand.potTotal)}</Row>
                {hand.board.length > 0 && (
                  <Row k={t('ccBoard')}>
                    <span className="inline-flex gap-1">
                      {hand.board.map((c, i) => (
                        <PlayingCard key={i} card={c} size="1.5rem" />
                      ))}
                    </span>
                  </Row>
                )}
              </>
            )}
            {turn && (
              <>
                <Row k={t('ccTurnStarted')}>{timeOf(turn.startedAt, locale)}</Row>
                <Row k={t('ccTurnBase')}>{t('ccSeconds', { s: Math.round(turn.baseMs / 1000) })}</Row>
                <Row k={t('ccTurnExtra')}>{t('ccSeconds', { s: Math.round(turn.extraMs / 1000) })}</Row>
                <Row k={t('ccDeadline')}>
                  <span data-testid="cc-turn-left" className={cx(now > turn.deadline && 'font-semibold text-[#f0a0a2]')}>
                    {/* (Never more than the turn's whole time: the clock offset is only known to within half a round trip.) */}
                    {now > turn.deadline ? t('ccOverdue', { s: secs(now - turn.deadline) }) : t('ccLeft', { s: secs(Math.min(turn.deadline - now, turn.baseMs + turn.extraMs)) })}
                  </span>
                </Row>
              </>
            )}
            <Row k={t('ccNextHand')}>
              {room.nextHandAt ? (now > room.nextHandAt ? t('ccOverdue', { s: secs(now - room.nextHandAt) }) : t('ccLeft', { s: secs(room.nextHandAt - now) })) : '–'}
            </Row>
            {room.paused && <Row k={t('pausedBadge')}>{t('ccYes')}</Row>}
          </dl>
        ) : (
          <p className="text-sm text-ink-400">{roomWord}</p>
        )}
      </Sec>

      <Sec id="cc-sec-players" title={t('ccSecPlayers')}>
        {room ? (
          <ul className="flex flex-col gap-1.5" data-testid="cc-seats">
            {room.seats.map((s) => (
              <li key={s.seatIndex} className="rounded-lg border border-white/5 bg-ink-850/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-ink-400">{t('ccSeatN', { n: s.seatIndex + 1 })}</span>
                  {s.state === 'empty' ? (
                    <span className="text-ink-400">{t('ccEmptySeat')}</span>
                  ) : (
                    <>
                      {s.userId && !s.bot ? (
                        <Link to={`/users/${s.userId}`} className="max-w-[12rem] truncate font-semibold text-ivory hover:underline">
                          {s.nickname}
                        </Link>
                      ) : (
                        <span className="max-w-[12rem] truncate font-semibold text-ivory">{s.nickname}</span>
                      )}
                      {s.bot && (
                        <Badge tone="blue">
                          <BotIcon className="size-3" />
                          {t('botBadge')} · {botLevelLabel(t, s.bot)}
                          {s.botStyle ? ` · ${botStyleLabel(t, s.botStyle)}` : ''}
                        </Badge>
                      )}
                      {hand?.actorSeat === s.seatIndex && <Badge tone="gold">{t('ccActor')}</Badge>}
                      {hand?.buttonSeat === s.seatIndex && <Badge>{t('ccButton')}</Badge>}
                      <Badge>{seatState(s)}</Badge>
                      {!s.connected && (
                        <Badge tone="red">
                          <WifiOffIcon className="size-3" />
                          {t('offline')}
                        </Badge>
                      )}
                      {s.leaving && <Badge>{t('leaveAfterHand')}</Badge>}
                      {s.timeouts > 0 && <Badge tone="gold">{t('timeoutsN', { n: s.timeouts })}</Badge>}
                      {s.phase && <Badge tone="gold">{seatPhaseLabel(t, s.phase)}</Badge>}
                      {s.topUp && <Badge tone="gold">{topUpStateLabel(t, s.topUp)}</Badge>}
                    </>
                  )}
                  {s.held && <Badge>{t('seatHeldByHand')}</Badge>}
                  {room.reservation?.seatIndex === s.seatIndex && <Badge tone="gold">{t('ccReserved', { s: secs(room.reservation.until - now) })}</Badge>}
                  {s.state !== 'empty' && <span className="ml-auto font-mono text-ivory tabular-nums">{formatChips(s.stack)}</span>}
                </div>
                {s.state !== 'empty' && (s.streetBet > 0 || s.lastAction) && (
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-xs text-ink-400">
                    {s.streetBet > 0 && <span>{t('ccBet', { n: formatChips(s.streetBet) })}</span>}
                    {s.lastAction && (
                      <span>
                        {actionLabel(t, s.lastAction.type)}
                        {s.lastAction.amount ? ` ${formatChips(s.lastAction.amount)}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-400">{t('ccSeatedOf', { n: tb.seated, max: tb.maxSeats })}</p>
        )}
        <p className="mt-2 text-xs text-ink-400">{t('holeCardsHidden')}</p>
      </Sec>

      <Sec id="cc-sec-economy" title={t('ccSecEconomy')}>
        <dl className={dlCls}>
          <Row k={t('ccPot')}>{hand ? formatChips(hand.potTotal) : '–'}</Row>
          <Row k={t('ccTopUpsPending')}>{room ? room.seats.filter((s) => s.topUp).length : '–'}</Row>
          <Row k={t('ccCashing')}>{room ? room.seats.filter((s) => s.phase === 'cashing').length : '–'}</Row>
          <Row k={t('ccBuying')}>{room ? room.seats.filter((s) => s.phase === 'pending').length : '–'}</Row>
        </dl>
        <p className="mt-2 text-xs text-ink-400">{t('ccLedgerCheck')}</p>
      </Sec>

      <Sec id="cc-sec-diag" title={t('ccSecDiag')}>
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-xs text-ink-400">
              <th className="text-left font-normal" />
              <th className="text-right font-normal">D1</th>
              <th className="text-right font-normal">{t('ccRoom')}</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {(
              [
                [t('ccSeatedLabel'), tb.seated, roomSeated],
                [t('ccKpiBots'), tb.bots, roomBots],
                [t('watchers'), tb.spectators, room?.spectators ?? null],
                [t('ccWaitlistLabel'), tb.waitlist, room?.waitlist ?? null],
                [t('ccConnections'), tb.connections, room?.connections ?? null],
              ] as const
            ).map(([k, d, r]) => (
              <tr key={k}>
                <td className="py-0.5 font-sans text-ink-300">{k}</td>
                <td className="py-0.5 text-right text-ivory">{d}</td>
                <td className={cx('py-0.5 text-right', r !== null && r !== d ? 'text-warning' : 'text-ivory')}>
                  {r ?? '–'}
                  {r !== null && r !== d && <span className="sr-only"> {t('ccDiffers')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {room && (roomSeated !== tb.seated || room.spectators !== tb.spectators || room.waitlist !== tb.waitlist) && (
          <p className="mt-1 text-xs text-ink-400">{t('ccDiffersNote')}</p>
        )}
        <ul className="mt-2 flex flex-col gap-1" data-testid="cc-problems">
          {j.problems.length === 0 && <li className="text-sm text-ink-400">{t('ccNoIssues')}</li>}
          {j.problems.map((p, i) => (
            <li key={`${p.code}-${i}`} className="flex flex-wrap items-center gap-1.5 text-sm">
              {p.level !== 0 && <LevelChip level={p.level} word={t(LEVEL_KEY[p.level])} />}
              <span className="text-ivory">{problemLabel(t, p)}</span>
              <span className="font-mono text-[11px] text-ink-500">{p.source === 'd1' ? 'D1' : t('ccRoom')}</span>
            </li>
          ))}
        </ul>
        {tb.lastIssue && <p className="mt-1 break-all font-mono text-[11px] text-ink-400">{tb.lastIssue}</p>}
      </Sec>

      <Sec id="cc-sec-bots" title={t('ccSecBots')}>
        <dl className={dlCls}>
          <Row k={t('ccBotsAllowed')}>{tb.botsEnabled ? t('ccYes') : t('ccNo')}</Row>
          <Row k={t('ccKpiBots')}>{tb.bots}</Row>
        </dl>
        <Link to="/bots" className="mt-2 inline-block text-xs font-semibold text-gold-300 hover:underline">
          {t('ccBotsLink')}
        </Link>
      </Sec>

      {(tn || tb.roomType === 'tournament') && (
        <Sec id="cc-sec-tournament" title={t('ccSecTournament')}>
          {tn ? (
            <>
              <dl className={dlCls}>
                <Row k={t('ccTnStatus')}>{tnStatusLabel(t, tn.status)}</Row>
                <Row k={t('ccTnLevel')}>{t('tnLevelN', { n: tn.level + 1, total: tn.levelCount })}</Row>
                <Row k={t('blinds')}>
                  {formatChips(tn.smallBlind)}/{formatChips(tn.bigBlind)}
                </Row>
                <Row k={t('ccLevelEnds')}>
                  {tn.paused ? t('ccClockPaused') : tn.levelEndsAt ? (now > tn.levelEndsAt ? t('ccOverdue', { s: secs(now - tn.levelEndsAt) }) : t('ccLeft', { s: secs(tn.levelEndsAt - now) })) : '–'}
                </Row>
                <Row k={t('ccPlayersLeft')}>{t('ccPlayersLeftN', { n: tn.playersLeft, total: tn.entrants })}</Row>
              </dl>
              <Link to={`/tournaments/${tn.id}`} className="mt-2 inline-block text-xs font-semibold text-gold-300 hover:underline">
                {t('ccTournamentLink')}
              </Link>
            </>
          ) : (
            <p className="text-sm text-ink-400">{roomWord}</p>
          )}
        </Sec>
      )}
    </div>
  );
}
