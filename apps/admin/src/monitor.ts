/**
 * The control center's model (docs/CONTROL_CENTER.md): what the page's address holds, which tables a filter keeps and
 * in what order, what counts as a problem and how bad, how current the data is, where a seat sits on the oval, and how
 * a snapshot and the socket's events combine. Pure, so it is tested without a browser (test/monitor.test.ts).
 *
 * Nothing here decides anything for the game: a problem is a reading of what D1 and the rooms reported, and acting on
 * one goes through the console's existing controls.
 */
import type { AdminMonitorEvent, MonitorCounts, MonitorRoom, MonitorRoomsResponse, MonitorTable } from '@jc/types';

// ------------------------------------------------------------------ the page's address

export const CC_TYPES = ['all', 'official', 'member', 'tournament'] as const;
export type CcType = (typeof CC_TYPES)[number];
/** `closed` reads the most recently closed tables instead of the open ones (scope=closed). */
export const CC_STATES = ['all', 'playing', 'waiting', 'empty', 'full', 'blocked', 'paused', 'closing', 'warnings', 'bots', 'connection', 'stale', 'closed'] as const;
export type CcState = (typeof CC_STATES)[number];
export const CC_SORTS = ['severity', 'activity', 'players', 'spectators', 'waitlist', 'name', 'created', 'blinds'] as const;
export type CcSort = (typeof CC_SORTS)[number];
export const CC_TABS = ['all', 'pinned', 'problems'] as const;
export type CcTab = (typeof CC_TABS)[number];
export const CC_SIZES = ['s', 'm', 'l'] as const;
export type CcSize = (typeof CC_SIZES)[number];
/** Tables opened side by side at most (the hub follows this many rooms for one page: ADMIN_MONITOR_WATCH_MAX). */
export const FOCUS_MAX = 4;

export interface CcView {
  type: CcType;
  state: CcState;
  sort: CcSort;
  tab: CcTab;
  size: CcSize;
  /** A table's name or its exact id (the server narrows by it). */
  q: string;
  /** The nickname of a member seated now (exact, the server narrows by it). */
  member: string;
  /** The tables opened in the detail panel, in the order opened. */
  focus: string[];
}

export const DEFAULT_VIEW: CcView = { type: 'all', state: 'all', sort: 'severity', tab: 'all', size: 'm', q: '', member: '', focus: [] };

const oneOf = <T extends string>(list: readonly T[], v: string | null, fallback: T): T => (v !== null && (list as readonly string[]).includes(v) ? (v as T) : fallback);

export function viewOf(p: URLSearchParams): CcView {
  const focus = [...new Set((p.get('focus') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64))].slice(0, FOCUS_MAX);
  return {
    type: oneOf(CC_TYPES, p.get('type'), DEFAULT_VIEW.type),
    state: oneOf(CC_STATES, p.get('state'), DEFAULT_VIEW.state),
    sort: oneOf(CC_SORTS, p.get('sort'), DEFAULT_VIEW.sort),
    tab: oneOf(CC_TABS, p.get('tab'), DEFAULT_VIEW.tab),
    size: oneOf(CC_SIZES, p.get('size'), DEFAULT_VIEW.size),
    q: (p.get('q') ?? '').trim().slice(0, 64),
    member: (p.get('member') ?? '').trim().slice(0, 32),
    focus,
  };
}

/** The address for a view, leaving out what is the default (so a plain /control-center is the default view). */
export function paramsOf(v: CcView): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ['type', 'state', 'sort', 'tab', 'size', 'q', 'member'] as const) if (v[k] && v[k] !== DEFAULT_VIEW[k]) p.set(k, v[k]);
  if (v.focus.length) p.set('focus', v.focus.join(','));
  return p;
}

/** Opens a table in the panel (alone, or `add` beside those open, the oldest giving way past FOCUS_MAX); again closes it. */
export function toggleFocus(focus: string[], id: string, add: boolean): string[] {
  if (focus.includes(id)) return focus.filter((x) => x !== id);
  if (!add) return [id];
  return [...focus, id].slice(-FOCUS_MAX);
}

/** The table list's address for a view: only what the server narrows by. */
export function tablesPath(v: Pick<CcView, 'state' | 'q' | 'member'>): string {
  const p = new URLSearchParams();
  if (v.state === 'closed') p.set('scope', 'closed');
  if (v.q) p.set('q', v.q);
  if (v.member) p.set('member', v.member);
  const s = p.toString();
  return `/api/admin/monitor/tables${s ? `?${s}` : ''}`;
}

// ------------------------------------------------------------------ problems

/** 0 none, 1 정보 info, 2 주의 caution, 3 경고 warning, 4 긴급 urgent. Shown with an icon and a word, never by colour alone. */
export type Level = 0 | 1 | 2 | 3 | 4;

export interface Problem {
  /** A room issue code (tableIssueLabel), or one of the console's own: see problemsOf. */
  code: string;
  level: Level;
  /** Where it was read: D1's row of the table, or the room's own answer. */
  source: 'd1' | 'room';
  /** How many (disconnected players). */
  n?: number;
}

/**
 * How bad a room's own issue is (TableRoom.issuesAt and its diagnosis). Urgent: a hand or a turn nothing moves on, or a
 * seat and its session disagreeing (chips may be in the wrong place). Caution: a seat being bought into, usually gone
 * within seconds. Anything else, and a code this console does not know yet, is a warning.
 */
const ROOM_ISSUE_LEVEL: Record<string, Level> = {
  stalled_hand: 4,
  turn_overdue: 4,
  timer_unarmed: 4,
  seat_without_session: 4,
  session_without_seat: 4,
  pending_seat: 2,
};

/** A room's last answer to this page: its summary or why there is none, when it came (this clock), and how long it took. */
export type RoomEntry = { room: MonitorRoom; at: number; ms?: number } | { error: 'not_found' | 'closed' | 'room_unavailable'; at: number; ms?: number };

/**
 * What is wrong with a table, worst first. From D1's row: closed with someone still seated (urgent), closing past its
 * limit (warning), seated members without a connection (caution; from the counts alone a lower bound: seated members
 * minus every socket the room has, spectators' included), and the last problem the room wrote (info: when it happened
 * is in its text, it may be over). From the room's answer, when there is one: its issues, the exact players without a
 * connection (bots are always connected), and an open table whose room did not answer (warning). An entry blocked or
 * a table paused is an administrator's switch, shown as a state, not a problem.
 */
export function problemsOf(t: MonitorTable, entry?: RoomEntry): Problem[] {
  const out: Problem[] = [];
  if (t.flags.includes('seated_on_closed')) out.push({ code: 'seated_on_closed', level: 4, source: 'd1' });
  if (t.flags.includes('close_overdue')) out.push({ code: 'close_overdue', level: 3, source: 'd1' });
  const room = entry && 'room' in entry ? entry.room : null;
  if (room && t.status !== 'closed') {
    for (const code of room.issues) out.push({ code, level: ROOM_ISSUE_LEVEL[code] ?? 3, source: 'room' });
    const off = room.seats.filter((s) => s.state !== 'empty' && !s.bot && !!s.userId && !s.connected).length;
    if (off > 0) out.push({ code: 'disconnected', level: 2, source: 'room', n: off });
  } else if (t.status !== 'closed') {
    if (entry && 'error' in entry && entry.error === 'room_unavailable') out.push({ code: 'room_unavailable', level: 3, source: 'room' });
    const off = Math.max(0, t.seated - t.bots - t.connections);
    if (off > 0) out.push({ code: 'disconnected', level: 2, source: 'd1', n: off });
  }
  if (t.lastIssue) out.push({ code: 'last_issue', level: 1, source: 'd1' });
  return out.sort((a, b) => b.level - a.level);
}

export const levelOf = (ps: Problem[]): Level => ps.reduce<Level>((m, p) => (p.level > m ? p.level : m), 0);

/** The problems tab: caution and worse (an old problem the room wrote, info, is not one). */
export const PROBLEM_LEVEL: Level = 2;
/** The 경고 filter: warning and urgent. */
export const WARNING_LEVEL: Level = 3;

// ------------------------------------------------------------------ how current

/**
 * The page's link: `live` while its socket is open (the hub pings and the page closes a socket that stops answering);
 * `polling` while the socket is down but the last read of the list is recent; `stale` once it is not; `connecting`
 * before the first read.
 */
export type LinkState = 'live' | 'polling' | 'stale' | 'connecting';
/** The list is read again this often while the socket is down (Dashboard's LIVE_REFRESH_MS). */
export const POLL_MS = 30_000;
/** Two missed reads: what the page shows is no longer current. */
export const STALE_AFTER_MS = 2 * POLL_MS + 5_000;

export function linkOf(socket: 'off' | 'connecting' | 'open' | 'down', lastReadAt: number | null, now: number): LinkState {
  if (lastReadAt === null) return 'connecting';
  if (socket === 'open') return 'live';
  return now - lastReadAt < STALE_AFTER_MS ? 'polling' : 'stale';
}

/**
 * One table's data: `closed` / `closing` as D1 has it; `unknown` when its room did not answer; `stale` when the page's
 * link is. A room writes its counts only when they change, so counts that have not changed for an hour are current:
 * an idle table is not a stale one.
 */
export type Freshness = 'live' | 'stale' | 'unknown' | 'closing' | 'closed';

export function freshnessOf(t: MonitorTable, link: LinkState, entry?: RoomEntry): Freshness {
  if (t.status === 'closed') return 'closed';
  if (link === 'stale') return 'stale';
  if (entry && 'error' in entry && entry.error === 'room_unavailable') return 'unknown';
  return t.status === 'closing' ? 'closing' : 'live';
}

/** A table that closes while the page lists open tables stays this long, shown closed, and then leaves the list. */
export const CLOSED_LINGER_MS = 2 * 60_000;

/** Whether a table stays on a page listing `scope` (`now`: the server's clock). */
export function lingers(t: MonitorTable, scope: 'active' | 'closed', now: number): boolean {
  if (scope === 'closed' || t.status !== 'closed') return true;
  return now - Math.max(t.liveAt ?? 0, t.updatedAt) < CLOSED_LINGER_MS;
}

// ------------------------------------------------------------------ filtering and order

export interface Judged {
  table: MonitorTable;
  problems: Problem[];
  level: Level;
  fresh: Freshness;
}

export function keeps(j: Judged, v: CcView, pinned: ReadonlySet<string>): boolean {
  const t = j.table;
  if (v.type !== 'all' && t.roomType !== v.type) return false;
  if (v.tab === 'pinned' && !pinned.has(t.id)) return false;
  if (v.tab === 'problems' && j.level < PROBLEM_LEVEL) return false;
  switch (v.state) {
    case 'all':
      return true;
    case 'playing':
      return t.playing;
    case 'waiting':
      return t.status !== 'closed' && !t.playing && t.seated > 0;
    case 'empty':
      return t.seated === 0;
    case 'full':
      return t.seated >= t.maxSeats;
    case 'blocked':
      return t.entryBlocked;
    case 'paused':
      return t.handsPaused;
    case 'closing':
      return t.status === 'closing';
    case 'warnings':
      return j.level >= WARNING_LEVEL;
    case 'bots':
      return t.bots > 0;
    case 'connection':
      return j.problems.some((p) => p.code === 'disconnected' || p.code === 'room_unavailable');
    case 'stale':
      return j.fresh === 'stale' || j.fresh === 'unknown';
    case 'closed':
      return t.status === 'closed';
  }
}

const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);

/**
 * Worst first by default; ties fall back to the newest table and then its id, so a card moves only when what it is
 * sorted by changes (a count changing does not reshuffle a severity-sorted grid).
 */
export function compare(sort: CcSort, locale: string): (a: Judged, b: Judged) => number {
  const tie = (a: Judged, b: Judged) => desc(a.table.createdAt, b.table.createdAt) || (a.table.id < b.table.id ? -1 : a.table.id > b.table.id ? 1 : 0);
  const by: Record<CcSort, (a: Judged, b: Judged) => number> = {
    severity: (a, b) => b.level - a.level,
    activity: (a, b) => desc(a.table.liveAt, b.table.liveAt),
    players: (a, b) => b.table.seated - a.table.seated,
    spectators: (a, b) => b.table.spectators - a.table.spectators,
    waitlist: (a, b) => b.table.waitlist - a.table.waitlist,
    name: (a, b) => a.table.name.localeCompare(b.table.name, locale),
    created: () => 0,
    blinds: (a, b) => b.table.bigBlind - a.table.bigBlind,
  };
  return (a, b) => by[sort](a, b) || tie(a, b);
}

/** The summary row, from the tables the page holds now (as the api's monitorTotals, with problems in place of flags). */
export interface CcTotals {
  tables: number;
  playing: number;
  members: number;
  bots: number;
  spectators: number;
  waitlist: number;
  connections: number;
  blocked: number;
  paused: number;
  closing: number;
  problems: number;
  urgent: number;
}

export function totalsOf(js: Judged[]): CcTotals {
  const t: CcTotals = { tables: 0, playing: 0, members: 0, bots: 0, spectators: 0, waitlist: 0, connections: 0, blocked: 0, paused: 0, closing: 0, problems: 0, urgent: 0 };
  for (const j of js) {
    const x = j.table;
    if (x.status === 'closed') continue;
    t.tables += 1;
    if (x.playing) t.playing += 1;
    t.members += Math.max(0, x.seated - x.bots);
    t.bots += x.bots;
    t.spectators += x.spectators;
    t.waitlist += x.waitlist;
    t.connections += x.connections;
    if (x.entryBlocked) t.blocked += 1;
    if (x.handsPaused) t.paused += 1;
    if (x.status === 'closing') t.closing += 1;
    if (j.level >= PROBLEM_LEVEL) t.problems += 1;
    if (j.level >= 4) t.urgent += 1;
  }
  return t;
}

// ------------------------------------------------------------------ the oval

/**
 * Where a seat sits on a mini table, in percent of its felt: seat 0 at the bottom, the others clockwise, spaced evenly
 * (the game's own seatLayout with no seat of the viewer's to turn to the bottom).
 */
export function seatPoint(seat: number, maxSeats: number): { x: number; y: number } {
  const angle = Math.PI / 2 + (seat / maxSeats) * 2 * Math.PI;
  return { x: Math.round((50 + 44 * Math.cos(angle)) * 10) / 10, y: Math.round((50 + 40 * Math.sin(angle)) * 10) / 10 };
}

// ------------------------------------------------------------------ snapshot and events

const countsNewer = (a: MonitorTable, b: MonitorTable) => (a.liveAt ?? -Infinity) > (b.liveAt ?? -Infinity);

/**
 * One table from two readings (a snapshot and an event, in either order): its settings from the one written later
 * (updatedAt), its counts from the one counted later (liveAt), so a slow answer never takes a table back. Closed is
 * final: nothing reopens a table.
 */
export function mergeTable(old: MonitorTable, next: MonitorTable): MonitorTable {
  const base = next.updatedAt >= old.updatedAt ? next : old;
  const counts = countsNewer(old, next) ? old : next;
  const merged: MonitorTable = {
    ...base,
    seated: counts.seated,
    bots: counts.bots,
    playing: counts.playing,
    waitlist: counts.waitlist,
    spectators: counts.spectators,
    connections: counts.connections,
    liveAt: counts.liveAt,
    lastIssue: counts.lastIssue ?? base.lastIssue,
  };
  if (old.status === 'closed' || next.status === 'closed') merged.status = 'closed';
  return merged;
}

/**
 * The list read just now, against what the page holds: the read says which tables there are (one it no longer lists
 * is dropped, unless `keep` holds it: a table that just closed lingers on the open list), and each table it lists keeps
 * whatever the page already has that is newer than the read.
 */
export function applySnapshot(prev: ReadonlyMap<string, MonitorTable>, items: MonitorTable[], keep?: (t: MonitorTable) => boolean): Map<string, MonitorTable> {
  const out = new Map<string, MonitorTable>();
  for (const t of items) {
    const old = prev.get(t.id);
    out.set(t.id, old ? mergeTable(old, t) : t);
  }
  if (keep) for (const [id, old] of prev) if (!out.has(id) && keep(old)) out.set(id, old);
  return out;
}

/**
 * An event to the tables the page holds. `unknown`: it was about an open table the page does not have (the page may
 * read the list again; a table row is added at once when it fits the list's scope). `scope` null: the list is narrowed
 * by a search the server ran, so nothing is added to it and nothing unknown is worth a read.
 */
export function applyEvent(prev: ReadonlyMap<string, MonitorTable>, e: AdminMonitorEvent, scope: 'active' | 'closed' | null): { tables: ReadonlyMap<string, MonitorTable>; unknown: boolean } {
  if (e.type === 'admin.monitor.room') return { tables: prev, unknown: false };
  const old = prev.get(e.resourceId);
  if (e.type === 'admin.monitor.table') {
    const t = e.table as MonitorTable;
    if (!old) {
      const fits = scope !== null && (scope === 'closed' ? t.status === 'closed' : t.status !== 'closed');
      if (!fits) return { tables: prev, unknown: false };
      const out = new Map(prev);
      out.set(t.id, t);
      return { tables: out, unknown: false };
    }
    const merged = mergeTable(old, t);
    if (sameTable(old, merged)) return { tables: prev, unknown: false };
    const out = new Map(prev);
    out.set(t.id, merged);
    return { tables: out, unknown: false };
  }
  if (!old) return { tables: prev, unknown: scope === 'active' && e.counts.status !== 'closed' };
  const next = withCounts(old, e.counts, e.revision);
  if (next === old) return { tables: prev, unknown: false };
  const out = new Map(prev);
  out.set(old.id, next);
  return { tables: out, unknown: false };
}

/** A room's counts (revision: tables.live_updated_at) unless the page already has these or later ones. */
export function withCounts(old: MonitorTable, c: MonitorCounts, revision: number): MonitorTable {
  if (old.liveAt !== null && revision <= old.liveAt) return old;
  const status = old.status === 'closed' || c.status === 'closed' ? 'closed' : c.status;
  return {
    ...old,
    seated: c.seated,
    bots: c.bots,
    playing: c.playing,
    waitlist: c.waitlist,
    spectators: c.spectators,
    connections: c.connections,
    liveAt: revision,
    lastIssue: c.issue ?? old.lastIssue,
    status,
    // Closing past its limit is a closing table's; seated_on_closed comes with the next read of the list.
    flags: status === 'closing' ? old.flags : old.flags.filter((f) => f !== 'close_overdue'),
  };
}

const sameTable = (a: MonitorTable, b: MonitorTable) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A room's summary unless the page has a later one: its version counts its changes, and two answers of the same
 * version (nothing changed between them) are told apart by when the room answered.
 */
export function newerRoom(old: RoomEntry | undefined, room: MonitorRoom): boolean {
  if (!old || !('room' in old)) return true;
  return room.version > old.room.version || (room.version === old.room.version && room.at >= old.room.at);
}

/** A rooms read's answers to what the page holds (each kept only when it is not older than what the page has). */
export function applyRooms(prev: ReadonlyMap<string, RoomEntry>, res: MonitorRoomsResponse, now: number): Map<string, RoomEntry> {
  const out = new Map(prev);
  for (const [id, r] of Object.entries(res.rooms)) {
    if ('room' in r) {
      if (newerRoom(out.get(id), r.room)) out.set(id, { room: r.room, at: now, ms: r.ms });
    } else out.set(id, { error: r.error, at: now, ...(r.ms !== undefined ? { ms: r.ms } : {}) });
  }
  return out;
}

/** Event ids already applied: the hub may send one twice (a reconnect), and it must change nothing the second time. */
export class SeenEvents {
  private ids = new Set<string>();
  constructor(private cap = 300) {}
  /** false when this id was seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.cap) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }
}

// ------------------------------------------------------------------ which rooms to read

/** Rooms read at once for the cards on screen (the api's MONITOR_ROOMS_MAX). */
export const ROOMS_MAX = 24;
/** A card's room summary is read again after this long, while the page is in use. */
export const ROOMS_EVERY_MS = 60_000;
/** Sooner when the room's counts changed since (someone sat, left or a hand began), but not more often than this. */
export const ROOMS_CHANGED_EVERY_MS = 15_000;

/**
 * The rooms worth reading now: pinned ones first, then the cards on screen, only open or closing tables (a closed one is
 * never woken), none read within ROOMS_EVERY_MS (ROOMS_CHANGED_EVERY_MS for one in `changed`), none opened in the panel
 * (those are read with `follow`), at most ROOMS_MAX.
 */
export function roomsToRead(o: {
  pinned: readonly string[];
  visible: readonly string[];
  focus: readonly string[];
  tables: ReadonlyMap<string, MonitorTable>;
  rooms: ReadonlyMap<string, RoomEntry>;
  changed?: ReadonlySet<string>;
  now: number;
}): string[] {
  const out: string[] = [];
  for (const id of [...o.pinned, ...o.visible]) {
    if (out.length >= ROOMS_MAX) break;
    if (out.includes(id) || o.focus.includes(id)) continue;
    const t = o.tables.get(id);
    if (!t || t.status === 'closed') continue;
    const e = o.rooms.get(id);
    if (e && o.now - e.at < (o.changed?.has(id) ? ROOMS_CHANGED_EVERY_MS : ROOMS_EVERY_MS)) continue;
    out.push(id);
  }
  return out;
}

// ------------------------------------------------------------------ pins

const PINS_KEY = 'jc.admin.cc.pins';
export const PINS_MAX = 24;

/** This browser's pinned tables (a convenience of this browser, not shared with other administrators). */
export function loadPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, PINS_MAX) : [];
  } catch {
    return [];
  }
}

export function savePins(ids: string[]) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(ids.slice(0, PINS_MAX)));
  } catch {
    // Private windows and blocked storage: pins last as long as the page.
  }
}

export function togglePin(pins: string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((x) => x !== id) : [id, ...pins].slice(0, PINS_MAX);
}

/** The server's clock minus this one's, from an answer stamped `serverAt` that took from `sentAt` to `gotAt`. */
export function skewOf(serverAt: number, sentAt: number, gotAt: number): number {
  return Math.round(serverAt - (sentAt + gotAt) / 2);
}
