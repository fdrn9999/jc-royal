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
