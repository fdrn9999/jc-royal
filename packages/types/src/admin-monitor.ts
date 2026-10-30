import { z } from 'zod';
import type { BotStyle } from './bots';
import type { Card } from './cards';
import type { ActionType, BotLevel, HandStage, MaxSeats, SeatState } from './table';

// ------------------------------------------------------------------ admin control center (docs/CONTROL_CENTER.md)
//
// What the admin console's control center reads, never a member page. Watching is not sitting or spectating: nothing
// here counts as a spectator, joins a waitlist or reaches the game socket. Nothing here carries a card a player holds,
// the deck, a join code (or its hash) or who is waiting (tables.live_waitlist_users): only what a spectator at the table
// sees, plus the room's own diagnosis. The member realtime protocol (realtime.ts) never carries any of it.

export type MonitorRoomType = 'official' | 'member' | 'tournament';

/**
 * What a table's D1 row alone says is wrong, with no room asked. `close_overdue`: closing for longer than the sweep's
 * limit (the dashboard's stuckClosing). `seated_on_closed`: closed while table_sessions still has seated rows (the
 * dashboard's seatedOnClosed). `blocked` / `paused`: an administrator's switch, a state rather than a fault.
 */
export const MONITOR_TABLE_FLAGS = ['close_overdue', 'seated_on_closed', 'blocked', 'paused'] as const;
export type MonitorTableFlag = (typeof MONITOR_TABLE_FLAGS)[number];
/** How long a close may stay unfinished before it is overdue (close_overdue; the api's sweep then nudges the room). */
export const CLOSE_OVERDUE_AFTER_MS = 15 * 60_000;

/** One table as the grid draws it from D1 (GET /api/admin/monitor/tables): the counts its room last wrote. */
export interface MonitorTable {
  id: string;
  name: string;
  roomType: MonitorRoomType;
  status: 'open' | 'closing' | 'closed';
  maxSeats: MaxSeats;
  smallBlind: number;
  bigBlind: number;
  isPrivate: boolean;
  allowSpectators: boolean;
  beginner: boolean;
  entryBlocked: boolean;
  handsPaused: boolean;
  botsEnabled: boolean;
  /** Seats taken, table bots included (`bots` of them). */
  seated: number;
  bots: number;
  playing: boolean;
  waitlist: number;
  spectators: number;
  connections: number;
  handsPlayed: number;
  /** The last problem the room recorded (it stays until another one replaces it): a hint, not a current fault. */
  lastIssue: string | null;
  /** When the room last changed these counts (null: never). Unchanged counts are not a stale room. */
  liveAt: number | null;
  createdAt: number;
  updatedAt: number;
  hostNickname: string | null;
  flags: MonitorTableFlag[];
}

/** The grid's totals over the tables listed (open and closing; closed only when asked for). Members exclude table bots. */
export interface MonitorTotals {
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
  /** Tables with a flag that is a fault (close_overdue, seated_on_closed). */
  flagged: number;
}

export interface MonitorTablesResponse {
  items: MonitorTable[];
  totals: MonitorTotals;
  /** More tables matched than one response lists (MONITOR_TABLES_MAX): narrow the filter. */
  truncated: boolean;
  /** With `member`: the tables where that member (by nickname, exact) is seated now, from table_sessions. */
  memberTables?: string[];
  /** Closed tables that table_sessions still has someone seated at (at most 50), whatever the scope. */
  seatedOnClosed: string[];
  at: number;
  d1Ms: number;
}

/** At most this many tables in one list response (newest first after the closing ones). */
export const MONITOR_TABLES_MAX = 500;
/** At most this many rooms asked at once (POST /api/admin/monitor/rooms): what the grid has on screen or pinned. */
export const MONITOR_ROOMS_MAX = 24;

/** A seat as a spectator at the table sees it, without any card. */
export interface MonitorSeat {
  seatIndex: number;
  state: SeatState;
  /** Empty, but the hand being played still counts it (its player folded and left during the hand). */
  held?: boolean;
  userId?: string;
  nickname?: string;
  bot?: BotLevel;
  botStyle?: BotStyle;
  stack: number;
  streetBet: number;
  /** Table bots are never away. */
  connected: boolean;
  lastAction: { type: ActionType; amount: number } | null;
  /** Holds cards in the hand being played (never which). */
  hasCards: boolean;
  /** Stands up once the hand ends. */
  leaving: boolean;
  /** Turns in a row that ran out. */
  timeouts: number;
  sitOutSince: number | null;
  /** The buy-in being committed (`pending`) or the cash-out being paid (`cashing`); null once seated. */
  phase: 'pending' | 'cashing' | null;
  topUp: 'queued' | 'debiting' | null;
}

/**
 * Problems the room sees in itself (TableRoom.adminStatus' `issues`): a turn past its deadline, a hand that should have
 * been dealt, a seat or cash-out not finished, hands not yet recorded, a timer or retry alarm missing, and so on.
 */
export type MonitorRoomIssue = string;

/** One room's live summary (the room's internal `monitor` action): read only, never woken for a closed table. */
export interface MonitorRoom {
  tableId: string;
  /** The room's state version: a newer one replaces an older one. */
  version: number;
  status: 'waiting' | 'playing' | 'closing' | 'closed';
  handNumber: number;
  hand: {
    stage: HandStage;
    buttonSeat: number;
    sbSeat: number | null;
    bbSeat: number | null;
    /** The community cards dealt so far, as everyone at the table sees them. */
    board: Card[];
    potTotal: number;
    actorSeat: number | null;
    /** The running turn: when it began, the table's turn time, time added from a time bank, and when it times out. */
    turn: { startedAt: number; baseMs: number; extraMs: number; deadline: number } | null;
  } | null;
  nextHandAt: number | null;
  paused: boolean;
  maintenance: boolean;
  entryBlocked: boolean;
  waitlist: number;
  spectators: number;
  connections: number;
  /** A free seat held for the first member on the waitlist, until `until`. */
  reservation: { seatIndex: number; until: number } | null;
  tournament: {
    id: string;
    status: string;
    level: number;
    levelCount: number;
    smallBlind: number;
    bigBlind: number;
    levelEndsAt: number | null;
    paused: boolean;
    playersLeft: number;
    entrants: number;
  } | null;
  seats: MonitorSeat[];
  issues: MonitorRoomIssue[];
  /** The room's clock when it answered. */
  at: number;
}

/** POST /api/admin/monitor/rooms: each table asked, its summary or why there is none. */
export interface MonitorRoomsResponse {
  rooms: Record<string, { room: MonitorRoom; ms: number } | { error: 'not_found' | 'closed' | 'room_unavailable'; ms?: number }>;
  at: number;
}

// ------------------------------------------------------------------ the control center's socket (GET /ws/admin/monitor)
//
// An administrator's console page, signed in to the console (jc_asid) with table duty, opened from the console's own
// origin: never a member's session or /ws/realtime. It gets what changed, never more than the REST reads above give;
// the page reads the grid again over REST when it connects, reconnects or meets a table it does not know.

export const ADMIN_MONITOR_PROTOCOL = 1;
/** The one hub every console socket is on (a few administrators, not every member). */
export const ADMIN_MONITOR_HUB = 'admin-0';
/** Rooms one page may follow live at once (the tables an operator has opened), and that one rooms read may start following. */
export const ADMIN_MONITOR_WATCH_MAX = 4;

/** Close codes of /ws/admin/monitor past the standard ones (as REALTIME_CLOSE). */
export const ADMIN_MONITOR_CLOSE = {
  /** Past its check, or the administrator's role or duties changed: reconnect now (the api checks again and may refuse). */
  reauth: 4000,
  /** The console sign-in ended (logout, suspension, a role taken away): do not reconnect. */
  signedOut: 4401,
  /** More console pages of this administrator than the hub keeps: the oldest closes. */
  tooMany: 4008,
} as const;

/** Field names nothing on this socket may carry, at any depth: a held or shown card, a result, a join code, who waits. */
export const MONITOR_PRIVATE_KEYS = ['holeCards', 'shown', 'showdown', 'result', 'deck', 'joinCode', 'joinCodeHash', 'join_code_hash', 'waitlistUsers', 'liveWaitlistUsers', 'live_waitlist_users'] as const;

const PRIVATE = new Set<string>(MONITOR_PRIVATE_KEYS);
/**
 * Whether `v` has one of MONITOR_PRIVATE_KEYS anywhere (checked by the hub before it sends anything). Nothing the hub
 * sends nests deeper than four; an object nested deeper than eight is refused as if it had one, unread.
 */
export function hasPrivateKey(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (depth > 8) return true;
  if (Array.isArray(v)) return v.some((x) => hasPrivateKey(x, depth + 1));
  for (const [k, x] of Object.entries(v)) if (PRIVATE.has(k) || hasPrivateKey(x, depth + 1)) return true;
  return false;
}

const mId = z.string().min(1).max(64);
const mCount = z.number().int().min(0);
const mBase = { eventId: mId, occurredAt: z.number(), resourceId: mId, revision: z.number() };
const objectWith = <T>(id: string, version: string) =>
  z.custom<T>(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Record<string, unknown>)[id] === 'string' &&
      typeof (v as Record<string, unknown>)[version] === 'number' &&
      !hasPrivateKey(v),
  );

/** The counts a room wrote to tables.live_* (as the grid reads them), and the table's status then. Never who. */
export const MonitorCountsSchema = z.object({
  seated: mCount,
  bots: mCount,
  playing: z.boolean(),
  waitlist: mCount,
  spectators: mCount,
  connections: mCount,
  status: z.enum(['open', 'closing', 'closed']),
  /** The problem written with these counts (tables.last_issue), if one was; null leaves the last one. */
  issue: z.string().max(300).nullable(),
});
export type MonitorCounts = z.infer<typeof MonitorCountsSchema>;

/**
 * What another administrator changed (admin.monitor.changed), for a console page showing it: a member's VIP state
 * (resourceId: the member, revision: the VIP version) or a tournament (resourceId: the tournament, revision: its
 * version). A table's own changes are admin.monitor.table.
 */
export const ADMIN_CHANGE_KINDS = ['vip', 'tournament'] as const;
export type AdminChangeKind = (typeof ADMIN_CHANGE_KINDS)[number];
/** The console permission (apps/api/src/lib/permissions.ts GRANTS) whose pages show each: only those hear of it. */
export const ADMIN_CHANGE_GRANT: Record<AdminChangeKind, string> = { vip: 'vip', tournament: 'tournaments' };

export const AdminMonitorEventSchema = z.discriminatedUnion('type', [
  /** A table's row as the grid lists it, after its settings, its switches or its status changed (revision: updatedAt). */
  z.object({ ...mBase, type: z.literal('admin.monitor.table'), table: objectWith<MonitorTable>('id', 'updatedAt') }),
  /** A room's counts after it wrote them (revision: tables.live_updated_at of that write). */
  z.object({ ...mBase, type: z.literal('admin.monitor.counts'), counts: MonitorCountsSchema }),
  /** A followed room's summary after it changed (revision: the room's version); only to the pages following it. */
  z.object({ ...mBase, type: z.literal('admin.monitor.room'), room: objectWith<MonitorRoom>('tableId', 'version') }),
  /**
   * Another administrator's change to a member's VIP state or a tournament, saved: what it was and its new version,
   * nothing else (never the reason or the change itself; the page reads it when the administrator asks). Only to the
   * pages of administrators with that permission (ADMIN_CHANGE_GRANT).
   */
  z.strictObject({ ...mBase, type: z.literal('admin.monitor.changed'), kind: z.enum(ADMIN_CHANGE_KINDS) }),
]);
export type AdminMonitorEvent = z.infer<typeof AdminMonitorEventSchema>;
export type AdminMonitorEventType = AdminMonitorEvent['type'];
/** What a publisher hands over: the hub's helpers stamp eventId and occurredAt. */
export type AdminMonitorEventInput = AdminMonitorEvent extends infer E ? (E extends unknown ? Omit<E, 'eventId' | 'occurredAt'> : never) : never;

/** What the page may send: which rooms it follows (the room keeps pushing only while a rooms read asked it to). */
export const AdminMonitorClientFrameSchema = z.object({ t: z.literal('watch'), tables: z.array(mId).max(ADMIN_MONITOR_WATCH_MAX) });
export type AdminMonitorClientFrame = z.infer<typeof AdminMonitorClientFrameSchema>;

export type AdminMonitorServerFrame = { t: 'hello'; v: number; at: number } | { t: 'event'; e: AdminMonitorEvent };
