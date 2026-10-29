/**
 * The control center's model (docs/CONTROL_CENTER.md): what the page's address holds, which tables a filter keeps and
 * in what order, what counts as a problem and how bad, how current the data is, where a seat sits on the oval, and how
 * a snapshot and the socket's events combine, which alerts the readings raise and resolve, and the timeline's lines.
 * Pure, so it is tested without a browser (test/monitor.test.ts).
 *
 * Nothing here decides anything for the game: a problem is a reading of what D1 and the rooms reported, an alert noted
 * as seen is still the same problem, and acting on one goes through the console's existing controls.
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
  if (e.type === 'admin.monitor.room' || e.type === 'admin.monitor.changed') return { tables: prev, unknown: false };
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

/** The event delays the header shows: the latest DELAYS_MAX, none older than DELAYS_KEEP_MS. */
export const DELAYS_MAX = 20;
export const DELAYS_KEEP_MS = 5 * 60_000;

/** How long one event took from its server stamp to this page (`at`: when it came, by this page's clock). */
export interface Delay {
  at: number;
  ms: number;
}

/**
 * Adds an event's delay: when it came, on the server's clock (this page's plus `skew`, from a list read), less when it was
 * stamped. Only as exact as the skew (half that read's round trip), so a delay smaller than that error reads 0, never less.
 */
export function addDelay(list: readonly Delay[], occurredAt: number, gotAt: number, skew: number): Delay[] {
  const ms = Math.max(0, Math.round(gotAt + skew - occurredAt));
  return [...list.filter((d) => d.at > gotAt - DELAYS_KEEP_MS), { at: gotAt, ms }].slice(-DELAYS_MAX);
}

/** The median of the delays still recent at `now`, and of how many (null: none). */
export function delayOf(list: readonly Delay[], now: number): { ms: number; n: number } | null {
  const ms = list
    .filter((d) => d.at > now - DELAYS_KEEP_MS)
    .map((d) => d.ms)
    .sort((a, b) => a - b);
  if (!ms.length) return null;
  const mid = ms.length >> 1;
  return { ms: ms.length % 2 ? ms[mid]! : Math.round((ms[mid - 1]! + ms[mid]!) / 2), n: ms.length };
}

// ------------------------------------------------------------------ alerts

/**
 * What an administrator noted about an alert on this page: nothing yet, seen, being looked into, or set aside as a false
 * alarm. It is a note of this page only (not shared with other administrators, gone with the page) and it changes
 * nothing about the table: the problem behind an alert stays shown as it is read, and the alert resolves only when the
 * readings no longer show it, whatever was noted.
 */
export type AlertHandling = 'new' | 'ack' | 'investigating' | 'dismissed';

/** One problem of one table, from when the page first read it until the readings stopped showing it. */
export interface Alert {
  /** This run of the problem: its key and when it was first seen (a problem that comes back is a new alert). */
  id: string;
  /** The table and the problem: at most one active alert each. */
  key: string;
  tableId: string;
  name: string;
  code: string;
  level: Exclude<Level, 0>;
  source: Problem['source'];
  n?: number;
  firstSeen: number;
  /** When a reading last showed it (a room's problem: when that room's answer came). */
  lastSeen: number;
  /** Since when the readings no longer show it, while it waits out RESOLVE_AFTER_MS (null: it is shown). */
  clearSince: number | null;
  /** When it went (null: active). */
  resolvedAt: number | null;
  /** Why: the readings stopped showing it, or its table left the list. */
  resolvedBy: 'cleared' | 'gone' | null;
  handling: AlertHandling;
}

/** One table as the page reads it now: its problems and when its room last answered (null: no answer to read). */
export interface Reading {
  table: MonitorTable;
  problems: Problem[];
  roomAt: number | null;
}

/** A problem missing from the readings this long has resolved; one back sooner is the same alert (no flapping). */
export const RESOLVE_AFTER_MS = 10_000;
/** A resolved alert stays listed this long, at most RESOLVED_MAX of them. */
export const RESOLVED_KEEP_MS = 5 * 60_000;
export const RESOLVED_MAX = 50;

/**
 * The alerts after a reading of the tables the page holds (on every change and every few seconds): one active alert per
 * table and problem, its last-seen time and count kept current, a worse level shown as new again. A problem the readings
 * stop showing resolves after RESOLVE_AFTER_MS; a room's problem only counts as gone when a newer answer of the room
 * lacks it (a room that stopped answering hides its issues, it does not fix them). A table no longer listed resolves its
 * alerts as gone. Returns `prev` itself when nothing changed.
 */
export function trackAlerts(prev: readonly Alert[], readings: Iterable<Reading>, now: number): Alert[] {
  const byTable = new Map<string, Reading>();
  for (const r of readings) byTable.set(r.table.id, r);
  const out: Alert[] = [];
  const active = new Set<string>();
  let changed = false;
  for (const a of prev) {
    if (a.resolvedAt !== null) {
      out.push(a);
      continue;
    }
    const r = byTable.get(a.tableId);
    if (!r) {
      out.push({ ...a, clearSince: null, resolvedAt: now, resolvedBy: 'gone' });
      changed = true;
      continue;
    }
    const p = r.problems.find((x) => x.code === a.code && x.level > 0);
    if (p) {
      const seen = p.source === 'room' && r.roomAt !== null ? r.roomAt : now;
      const level = p.level as Alert['level'];
      const next: Alert = {
        ...a,
        name: r.table.name,
        level,
        source: p.source,
        ...(p.n !== undefined ? { n: p.n } : {}),
        lastSeen: Math.max(a.lastSeen, seen),
        clearSince: null,
        handling: level > a.level ? 'new' : a.handling,
      };
      if (p.n === undefined) delete next.n;
      if (next.lastSeen !== a.lastSeen || next.clearSince !== a.clearSince || next.level !== a.level || next.n !== a.n || next.name !== a.name || next.source !== a.source || next.handling !== a.handling) changed = true;
      out.push(next);
      active.add(a.key);
      continue;
    }
    // Not shown now. A room's problem is gone only when the room answered since it was last seen.
    const roomRead = a.source === 'room' ? (r.roomAt !== null && r.roomAt > a.lastSeen ? r.roomAt : null) : now;
    if (roomRead === null) {
      out.push(a);
      active.add(a.key);
      continue;
    }
    const since = a.clearSince ?? roomRead;
    if (now - since >= RESOLVE_AFTER_MS) {
      out.push({ ...a, clearSince: null, resolvedAt: since, resolvedBy: 'cleared' });
      changed = true;
      continue;
    }
    if (a.clearSince === null) changed = true;
    out.push({ ...a, clearSince: since });
    active.add(a.key);
  }
  for (const r of byTable.values()) {
    for (const p of r.problems) {
      if (p.level === 0) continue;
      const key = `${r.table.id}:${p.code}`;
      if (active.has(key)) continue;
      active.add(key);
      const seen = p.source === 'room' && r.roomAt !== null ? r.roomAt : now;
      out.push({
        id: `${key}@${seen}`,
        key,
        tableId: r.table.id,
        name: r.table.name,
        code: p.code,
        level: p.level as Alert['level'],
        source: p.source,
        ...(p.n !== undefined ? { n: p.n } : {}),
        firstSeen: seen,
        lastSeen: seen,
        clearSince: null,
        resolvedAt: null,
        resolvedBy: null,
        handling: 'new',
      });
      changed = true;
    }
  }
  // Resolved ones are kept a while, the latest first, at most RESOLVED_MAX.
  const resolved = out.filter((a) => a.resolvedAt !== null).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
  const keep = new Set(resolved.filter((a) => now - a.resolvedAt! < RESOLVED_KEEP_MS).slice(0, RESOLVED_MAX));
  const kept = out.filter((a) => a.resolvedAt === null || keep.has(a));
  if (kept.length !== out.length) changed = true;
  return changed ? kept : (prev as Alert[]);
}

/** An administrator's note on an active alert (a resolved one keeps what it had). */
export function handleAlert(alerts: readonly Alert[], id: string, handling: AlertHandling): Alert[] {
  return alerts.map((a) => (a.id === id && a.resolvedAt === null ? { ...a, handling } : a));
}

/** The alerts as listed: active ones first, worst first, then the newest; then the resolved ones, latest first. */
export function alertOrder(a: Alert, b: Alert): number {
  if ((a.resolvedAt === null) !== (b.resolvedAt === null)) return a.resolvedAt === null ? -1 : 1;
  if (a.resolvedAt !== null && b.resolvedAt !== null) return b.resolvedAt - a.resolvedAt;
  return b.level - a.level || b.firstSeen - a.firstSeen;
}

/** Alerts raised and resolved between two trackings, worth a line on the timeline (caution and worse). */
export function alertChanges(prev: readonly Alert[], next: readonly Alert[]): { raised: Alert[]; resolved: Alert[] } {
  const before = new Map(prev.map((a) => [a.id, a]));
  const raised: Alert[] = [];
  const resolved: Alert[] = [];
  for (const a of next) {
    if (a.level < PROBLEM_LEVEL) continue;
    const old = before.get(a.id);
    if (!old) {
      if (a.resolvedAt === null) raised.push(a);
    } else if (old.resolvedAt === null && a.resolvedAt !== null) resolved.push(a);
  }
  return { raised, resolved };
}

// ------------------------------------------------------------------ the timeline

/**
 * A line of the page's timeline: what the server told this page as it happened (a table's events and its open rooms'
 * summaries), the alerts the page raised and resolved, and the controls this administrator used here. Kept in this
 * page's memory only, at most TIMELINE_MAX lines; what lasts is in the audit log and the tables' own history.
 */
export interface TimelineEntry {
  id: string;
  at: number;
  kind: 'table' | 'seat' | 'game' | 'alert' | 'admin';
  code: string;
  tableId: string;
  name: string;
  params?: Record<string, string | number>;
}

export const TIMELINE_MAX = 200;

let lineSeq = 0;
const line = (at: number, kind: TimelineEntry['kind'], code: string, t: { id: string; name: string }, params?: TimelineEntry['params']): TimelineEntry => ({
  id: `tl${++lineSeq}`,
  at,
  kind,
  code,
  tableId: t.id,
  name: t.name,
  ...(params ? { params } : {}),
});

/**
 * What an event changed about a table, in lines: opened, closing, closed, seats taken and the waitlist (from and to),
 * entry blocked and allowed, new hands paused and resumed. Whether a hand is being played is not one: it changes
 * between every two hands (the open rooms' hand numbers are, handStarted).
 */
export function tableChanges(old: MonitorTable | undefined, next: MonitorTable | undefined, at: number): TimelineEntry[] {
  if (!next) return [];
  if (!old) return next.status === 'open' ? [line(at, 'table', 'opened', next)] : [];
  const out: TimelineEntry[] = [];
  if (old.status !== next.status && next.status !== 'open') out.push(line(at, 'table', next.status, next));
  if (old.seated !== next.seated) out.push(line(at, 'seat', 'seated', next, { from: old.seated, to: next.seated, max: next.maxSeats }));
  if (old.waitlist !== next.waitlist) out.push(line(at, 'seat', 'waitlist', next, { from: old.waitlist, to: next.waitlist }));
  if (old.entryBlocked !== next.entryBlocked) out.push(line(at, 'table', next.entryBlocked ? 'blocked' : 'unblocked', next));
  if (old.handsPaused !== next.handsPaused) out.push(line(at, 'table', next.handsPaused ? 'paused' : 'resumed', next));
  return out;
}

/** A newer summary of an open room that dealt a new hand: its number. */
export function handStarted(old: RoomEntry | undefined, room: MonitorRoom, name: string, at: number): TimelineEntry | null {
  const before = old && 'room' in old ? old.room.handNumber : null;
  if (before === null || room.handNumber <= before || !room.hand) return null;
  return line(at, 'game', 'hand', { id: room.tableId, name }, { n: room.handNumber });
}

/** A line for an alert raised or resolved, or for a control this administrator used here. */
export function timelineLine(at: number, kind: 'alert' | 'admin', code: string, t: { id: string; name: string }, params?: TimelineEntry['params']): TimelineEntry {
  return line(at, kind, code, t, params);
}

/** New lines first, at most `cap`. */
export function pushCapped<T>(list: readonly T[], add: readonly T[], cap = TIMELINE_MAX): T[] {
  if (add.length === 0) return list as T[];
  return [...[...add].reverse(), ...list].slice(0, cap);
}
