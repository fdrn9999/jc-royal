/**
 * TableRoom — one Durable Object per poker table.
 *
 * All table mutations are serialised through `run()` (a promise chain), so the
 * awaits on D1 inside a command cannot interleave with another command. State
 * that must survive eviction/restarts lives in Durable Object storage:
 *   room  — seats, button, hand counter, waitlist, timers
 *   hand  — the current hand's engine log (HandEngine.persist())
 *   chat  — recent chat lines
 *   oppStats — at tables with bots, what the bots learned of the members (opp-stats.ts)
 * Sockets use the WebSocket Hibernation API; each socket carries the verified
 * identity forwarded by the API worker in its attachment.
 */
import { DurableObject } from 'cloudflare:workers';
import { OpsCounter, type TimeBankMetric } from '@jc/db';
import { botView, decideBot, HandEngine, nextButtonSeat, STRATEGY_VERSION, styleFor, type ActResult, type HandRecord, type PersistedHand } from '@jc/poker-engine';
import {
  AUTO_REBUY_MAX_TIMES,
  type AutoBuyPolicy,
  type AutoBuyRequest,
  blindsAt,
  botBuyInOf,
  botPlayOf,
  type BotLevel,
  type BotProfile,
  type BotStyle,
  ClientMessageSchema,
  isVipColor,
  MEMBER_IDLE_CLOSE_MS,
  PLAYER_REPORT_WINDOW_MS,
  publicRole,
  REACTION_SLACK_MS,
  reactionRulesOf,
  reactionWait,
  shownRole,
  TIME_BANK_MIN_USE_MS,
  timeBankRulesFor,
  tournamentTimeBankRules,
  type ChatMessage,
  type ClientMessage,
  type ErrorCode,
  type HandStage,
  type LegalOption,
  type MaxSeats,
  type NoticeCode,
  type PreActionKind,
  type PublicRole,
  type SeatView,
  type ServerMessage,
  type SocialPolicy,
  type TableCue,
  type TableView,
  type TimeBankRules,
  type TournamentTableView,
  type VipColor,
} from '@jc/types';
import {
  buyIn,
  buyInCommitted,
  cashOut,
  committedTopUp,
  loadMaintenance,
  loadTable,
  markTableClosed,
  oneAtATime,
  publishLiveStats,
  recordHand,
  topUp,
  walletBalance,
  type Maintenance,
  type TableRow,
} from './settlement';
import { botBuyIn, botEvent, pickBot, readBotProfiles, within, type BotEventKind } from './bots';
import { botManners, emptyManners } from './bot-manners';
import { addShown, afterHandMs } from './muck';
import { addHand, OPP_STATS_KEY, readOppStats, statsBySeat, type OppStats } from './opp-stats';
import { countHand, countMove, type BotStatsAcc, type BotStatsFlush } from './bot-stats';
import { bustOut, markAborted, playersLeft, runClock, seedTourney, stopClock, syncTournament, type TournamentRow, type TourneyState } from './tournament';

export interface Env {
  DB: D1Database;
  INTERNAL_SECRET: string;
  ENVIRONMENT: string;
}

interface Identity {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  /**
   * The VIP name color the api read from D1 for this connection (shownVip), absent when the member has none. Only a
   * look: no rule of the table reads it.
   */
  vip?: string;
  /** Join code hash of the ticket this connection brought (verified by the api), or null. */
  codeHash: string | null;
  /** When the api verified the session this connection opened with (absent from older api builds). */
  authAt?: number;
}

interface Attachment extends Identity {
  connId: string;
  connectedAt: number;
  /** An admin ended this connection: it is closing, and anything it still sends is ignored. */
  kicked?: boolean;
}

interface SeatState {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  /** Staff only: set at sit, then brought up to date by `refreshRole`. */
  role?: PublicRole;
  /** VIP members only: set at sit, then brought up to date at each handshake and by `refreshVip`. Shown, never played on. */
  vip?: VipColor;
  stack: number;
  tableSessionId: string;
  /** 'pending' while the buy-in is being committed to D1; 'cashing' while cashing out. */
  phase: 'pending' | 'seated' | 'cashing';
  buyIn: number;
  sittingOut: boolean;
  sitOutSince: number | null;
  leaveAfterHand: boolean;
  timeouts: number;
  joinedAt: number;
  /**
   * A top-up in flight. 'queued' waits for the hand the player is in to end (nothing taken yet); 'debiting' is being
   * written to D1, and after a restart or a failed call the ledger key decides whether the chips arrived. 'debiting'
   * is only ever set for a key the ledger did not have yet, so a committed key found here has not been counted.
   * `auto` marks an automatic rebuy or top-up (`autoBuy`).
   */
  topUp?: { key: string; amount: number; state: 'queued' | 'debiting'; auto?: boolean } | null;
  /**
   * The automatic chip policy the player turned on for this seat only: a rebuy after busting, or a top-up back to a
   * target after a hand that left the stack below its trigger — never both. It lasts while they keep the seat.
   */
  autoBuy?: AutoBuyPolicy | null;
  /** Rooms before `autoBuy` kept an automatic rebuy here; taken over when the room loads, never written. */
  autoRebuy?: { amount: number; cap: number; spent: number } | null;
  /** The last hand after which `autoBuy` took chips at this seat: at most once per hand, whichever policy it has. */
  autoHand?: string | null;
  /**
   * What the player chose for their next turn of this street, with the amount they faced when choosing. `progress`
   * carries it out when the turn comes, only as a check or a fold the engine still allows.
   */
  preAction?: { handId: string; stage: HandStage; kind: PreActionKind; toCall: number } | null;
  /** Ids of the player's recent pre-action requests: one sent again is answered, not applied again. */
  preReqs?: string[];
  /**
   * A table bot of this level (bots.ts), not a member. It acts on its turn from what its seat sees (`playBotTurn`), never
   * times out or sits out, and leaves through `leaveAfterHand` like a member — but plays the hand out first.
   */
  bot?: BotLevel;
  /** The style the bot plays the current hand in, fixed with its level at the deal (`startHand`); absent: `styleFor`. */
  botStyle?: BotStyle;
  /**
   * The bot account's own settings (bot_profiles) as D1 last showed them: read when it sits down and by
   * `syncBotProfiles`, applied over the table's at the next deal. Null: none, it follows the table.
   */
  botProfile?: BotProfile | null;
  /**
   * The member's time bank at this table: ms left, and hands dealt in since the last refill. Given at their first hand
   * (`dealTimeBanks`), kept when they leave the seat (`keepBank`). Never on a bot.
   */
  bank?: { ms: number; hands: number } | null;
}

/** A word for one player about a top-up or rebuy the room carried out on its own. */
type Notice = { userId: string; code: NoticeCode; amount?: number };

interface RoomState {
  v: 1;
  seats: (SeatState | null)[];
  buttonSeat: number | null;
  handNumber: number;
  /** `codeHash`: the join code the player held when joining a private table (absent on entries from older builds). */
  waitlist: { userId: string; nickname: string; codeHash?: string | null }[];
  reservation: { userId: string; nickname: string; seatIndex: number; until: number } | null;
  nextHandAt: number | null;
  closing: boolean;
  closed: boolean;
  /** Recent sit/leave request ids (idempotency for client retries). */
  recentReqs: string[];
  /** Last hand whose result was applied to seats and recorded (idempotent finalisation). */
  settledHandId: string | null;
  /**
   * Players of the settled hand whose losing showdown hand stays face down where the rules allow it (HandEngine.handView):
   * everyone dealt in, since auto-muck always applies (a hand settled before then keeps those who had the old setting
   * on). Fixed when it settled, with the record, so the result shown and the hand history agree.
   */
  muck?: { handId: string; ids: string[] } | null;
  /**
   * Cards players chose to show after the settled hand (`show`), by user id and card position. Kept until the next deal
   * and never part of the hand's record or replay.
   */
  shown?: { handId: string; cards: Record<string, number[]> } | null;
  version: number;
  /** Member rooms: since when nobody has been seated (the room closes itself after MEMBER_IDLE_CLOSE_MS). */
  emptySince?: number | null;
  /** When the room closed; its chat is dropped once players can no longer report from it. */
  closedAt?: number | null;
  /** Shorter empty-room timeout for local test runs (never in production). */
  idleCloseMs?: number;
  /**
   * The join code hash (null: public) the waitlist was last checked against. When the table's code or privacy changes,
   * waitlist entries made with another code are dropped. Undefined until a room first loads under this build.
   */
  accessHash?: string | null;
  /**
   * Members an admin disconnected here, with when (pruned after KICK_WINDOW_MS). A connection whose session the api
   * checked before that moment is refused: a handshake already on its way when the admin acted does not get back in.
   */
  kicks?: Record<string, number>;
  /** No bot joins before this (a join failed: the fund or the service's bot count used up, D1 unreachable). */
  botRetryAt?: number | null;
  /** Bot joins that failed in a row, for the back-off. */
  botFails?: number;
  /** The bots' statistics of the members (`oppStats`) were written here: the table's closing deletes them. */
  oppStats?: boolean;
  /**
   * The time bank rules the current (or last) hand was dealt with; null or absent: none. Fixed at the deal, so a policy
   * changed during a hand applies from the next one and never moves a deadline already running.
   */
  bankRules?: TimeBankRules | null;
  /** Time banks of members who gave up their seat here, with when (kept BANK_KEEP_MS): sitting down again brings them back. */
  banks?: Record<string, { ms: number; hands: number; at: number }>;
  /** The current hand's time bank counters, moved into its record when it settles (statistics only). */
  tbCount?: { handId: string; n: Partial<Record<TimeBankMetric, number>> } | null;
  /** The table bots' play since it was last moved into a hand's record (bot-stats.ts; statistics only). */
  botStats?: BotStatsAcc | null;
  /**
   * The Sit & Go this table plays (tournament tables only: tournament.ts, docs/TOURNAMENT.md). Seeded from D1 once; from
   * then on the room's own state leads, and D1 only brings an operator's pause request and an abort.
   */
  tourney?: TourneyState | null;
}

const FIRST_HAND_DELAY_MS = 2_500;
const RESERVATION_MS = 30_000;
const SIT_OUT_STAND_UP_MS = 10 * 60_000;
const TIMEOUTS_BEFORE_SIT_OUT = 2;
const CHAT_HISTORY = 50;
const MSG_RATE = { capacity: 20, refillPerSec: 10 };
/** How soon the room retries work a failed D1 call left unfinished (a cash-out, a close, a hand record). */
const RETRY_MS = 15_000;
const UNRECORDED_PREFIX = 'unrecorded:';
/**
 * Operations counters and the latest problem ride along with the next occupancy write; with nothing else to write they
 * go out at most this often, so a failing D1 is not called on every error.
 */
const OPS_FLUSH_MS = 10_000;
/** How long a disconnect turns away handshakes the api authorised before it (far longer than any handshake takes). */
const KICK_WINDOW_MS = 60_000;
/** Clock difference allowed between the api and the room when comparing a handshake's `authAt` with a disconnect. */
const KICK_SKEW_MS = 2_000;
/** A turn this far past its deadline, or a next hand this late, means the room's timer did not run. */
const OVERDUE_MS = 5_000;
/** How long a bot takes over its turn (at most half the turn): long enough to read the table, never the whole clock. */
const BOT_THINK_MS = { min: 700, max: 2_200 };
/** Back-off after a failed bot join, doubling with each failure in a row up to the maximum. */
const BOT_RETRY_MS = { first: 60_000, max: 30 * 60_000 };
/** A bot sits down with this many big blinds, within the table's buy-in range. */
/** The seated bots' settings are read again at a deal this long after the last read, should a change not have reached the room. */
const BOT_SYNC_MS = 5 * 60_000;
/**
 * The longest that read may hold the room (players' moves and the clock wait behind it): slower, the deal goes on with
 * the settings the seats have and the next deal reads again.
 */
const BOT_SYNC_WAIT_MS = 2_000;
/** A member's time bank is kept this long after they leave their seat (and for at most this many members per room). */
const BANK_KEEP_MS = 6 * 60 * 60_000;
const BANK_KEEP_MAX = 100;

/** A finished hand kept in room storage until its D1 record is written. */
interface UnrecordedHand {
  handNumber: number;
  record: HandRecord;
  log: PersistedHand;
  /** Table bots dealt in (absent from hands kept by older builds: none). */
  bots?: number;
  /** The hand's time bank counters, for the day's statistics (absent: none). */
  timeBank?: Partial<Record<TimeBankMetric, number>>;
  /** The bots' play summed up to this hand, per day, for the statistics (absent: none). */
  botStats?: BotStatsFlush[];
}

/** A chat line's id from its sender and request id: a line sent again is recognised without storing anything more. */
async function chatLineId(userId: string, reqId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${reqId}`)));
  return Array.from(d.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

class CommandError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class TableRoom extends DurableObject<Env> {
  private tableId: string | null = null;
  private table: TableRow | null = null;
  private room!: RoomState;
  private hand: HandEngine | null = null;
  private chat: ChatMessage[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private buckets = new Map<string, { tokens: number; at: number }>();
  /** When each player last sent quick reactions (by player, so a second tab does not double the rate). Memory only. */
  private reactedAt = new Map<string, number[]>();
  /** When each player last posted a chat line (by player, as quick reactions: a new connection does not start the wait again). Memory only. */
  private chattedAt = new Map<string, number>();
  /** The bots' last quick reactions after a hand (bot-manners.ts). Memory only. */
  private botReacts = emptyManners();
  private lastStats = '';
  /** Occupancy to D1 (writeStats), one write at a time so an older one never lands after a newer one. */
  private publishStats = oneAtATime(() => this.writeStats());
  /** Operations counters (packages/db/src/ops.ts) and the latest problem, not written yet (see `publishStats`). */
  private ops = new OpsCounter();
  private pendingIssue: string | null = null;
  private lastOpsFlush = 0;
  private opsTimer: ReturnType<typeof setTimeout> | null = null;
  /** Connections already counted as dropped (an error may be followed by its close). */
  private dropped = new Set<string>();
  /** Storage keys of finished hands D1 does not have yet (see `retryUnrecorded`). */
  private unrecorded = new Set<string>();
  /**
   * The service maintenance window D1 last showed (see `inMaintenance`). Read with the table, with each occupancy
   * write, when an admin changes it (`reload`) and once more when it seems to end. Not stored: a woken room reads it.
   */
  private maint: Maintenance | null = null;
  /** Order of maintenance reads, so a slow one cannot undo a newer one. */
  private maintReads = 0;
  private maintApplied = 0;
  /** Whether the views last sent showed maintenance under way (its start is announced by the alarm). */
  private maintShown = false;
  /** The bots' statistics of the members (`oppStats`), read from storage the first time a table with bots needs them. */
  private opp: OppStats | null = null;
  private oppRead = false;
  /** When the seated bots' settings were last read from D1 (`syncBotProfiles`); 0 after a wake-up or a failed read. */
  private botSyncAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered by the runtime: they neither wake a hibernating room nor wait behind its work.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      const [room, hand, chat, tableId, unrecorded] = await Promise.all([
        ctx.storage.get<RoomState>('room'),
        ctx.storage.get<PersistedHand>('hand'),
        ctx.storage.get<ChatMessage[]>('chat'),
        ctx.storage.get<string>('tableId'),
        ctx.storage.list({ prefix: UNRECORDED_PREFIX }),
      ]);
      this.tableId = tableId ?? null;
      this.room = room ?? emptyRoom(9);
      // A room saved before automatic top-up kept an automatic rebuy on its own (an older build writes only that).
      for (const s of this.room.seats) {
        if (!s || !('autoRebuy' in s)) continue;
        s.autoBuy = s.autoRebuy ? { mode: 'rebuy', ...s.autoRebuy } : null;
        delete s.autoRebuy;
      }
      this.chat = chat ?? [];
      this.unrecorded = new Set(unrecorded.keys());
      if (hand) this.hand = HandEngine.restore(hand, Date.now());
    });
  }

  // ------------------------------------------------------------------ plumbing

  /** Serialise every mutation. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensureLoaded(tableId?: string) {
    if (tableId && !this.tableId) {
      this.tableId = tableId;
      await this.ctx.storage.put('tableId', tableId);
    }
    if (!this.tableId) throw new CommandError('not_found', 'table not initialised');
    if (!this.loaded || !this.table) {
      const read = ++this.maintReads;
      const { table: t, maintenance } = await loadTable(this.env.DB, this.tableId);
      if (!t) throw new CommandError('not_found', 'table not found');
      this.table = t;
      this.takeMaint(maintenance, read);
      if (this.room.seats.length !== t.maxSeats) {
        // Room created before config load: size the seat array once.
        const seats: (SeatState | null)[] = Array.from({ length: t.maxSeats }, (_, i) => this.room.seats[i] ?? null);
        this.room.seats = seats;
      }
      // A close that D1 holds but this room never took on (the call did not reach it) is resumed below.
      if (t.status === 'closing' && !this.room.closing) {
        this.room.closing = true;
        this.room.waitlist = [];
        this.room.reservation = null;
        await this.save();
      }
      // A tournament table meets its tournament (players sit down with their tournament chips), or takes on what an
      // operator changed meanwhile.
      const tourneyChanged = await this.takeTourney(t.tournament);
      this.loaded = true;
      // A code change this room was not told about (or slept through) still takes effect.
      await this.enforceAccess();
      // Seats a restart left half way (and a close not yet finished) are settled here; if D1 fails, play goes on and
      // the retry alarm `schedule` arms finishes them.
      try {
        await this.recoverPendingSeats();
      } catch (e) {
        this.ops.add('recover_fail');
        this.fault('recovery failed; will retry', e);
      }
      if (this.hand?.isSettled && this.room.settledHandId !== this.hand.handId) await this.settle([]);
      if (this.unfinishedWork()) {
        await this.finishWorkSafely();
        await this.schedule();
      }
      // A tournament woken by its first visitor (the api's `reload` did not reach it) deals without waiting for one.
      if (tourneyChanged) {
        if (!this.dealsNow()) await this.stopTourneyClock();
        await this.afterChange();
      }
    }
  }

  private async save(extra: Record<string, unknown> = {}) {
    this.room.version += 1;
    await this.ctx.storage.put({ ...extra, room: this.room, hand: this.hand ? this.hand.persist() : null });
  }

  /** The bots' statistics of the members (only tables with bots read or write them). */
  private async oppStats(): Promise<OppStats | null> {
    if (!this.oppRead) {
      this.opp = readOppStats(await this.ctx.storage.get(OPP_STATS_KEY));
      this.oppRead = true;
    }
    return this.opp;
  }

  /** Open sockets, optionally excluding one that is in the middle of closing. */
  private sockets(exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  private att(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  /** A fresh view for one player's connections only: for a change nobody else is shown. */
  private sendView(userId: string) {
    const connected = this.connectedUsers();
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a.userId === userId) this.send(ws, { t: 'state', state: this.view(a, connected), cues: [] });
    }
  }

  private connectedUsers(exclude?: WebSocket): Set<string> {
    return new Set(this.sockets(exclude).map((ws) => this.att(ws).userId));
  }

  /**
   * Who is watching: members connected here, neither seated nor on the waitlist (counted apart), at a table that shows
   * its hands to them. At a table without spectators the ones connected are there for a seat, not to watch.
   */
  private spectatorsOf(connected: Iterable<string>): number {
    if (!this.table?.allowSpectators) return 0;
    const waiting = new Set(this.room.waitlist.map((w) => w.userId));
    let n = 0;
    for (const u of new Set(connected)) if (this.seatIndexOf(u) === null && !waiting.has(u)) n++;
    return n;
  }

  private seatIndexOf(userId: string): number | null {
    const i = this.room.seats.findIndex((s) => s?.userId === userId);
    return i === -1 ? null : i;
  }

  // ------------------------------------------------------------------ private tables

  /** Whether a join code hash lets `userId` in: public table, the member room's own host, or the current code. */
  private mayEnter(userId: string, codeHash: string | null | undefined): boolean {
    const t = this.table!;
    if (!t.isPrivate) return true;
    if (t.roomType === 'member' && t.createdBy === userId) return true;
    return !!codeHash && codeHash === t.joinCodeHash;
  }

  /**
   * May this connection sit or join the waitlist? A waitlist place counts as well: it was taken with the code, and a
   * code change drops places taken with the old one (enforceAccess).
   */
  private hasAccess(a: Identity): boolean {
    return this.mayEnter(a.userId, a.codeHash ?? null) || this.room.waitlist.some((w) => w.userId === a.userId);
  }

  /** Private tables without spectators admit only people with the code, besides those already seated. */
  private mustRefuse(a: Identity): boolean {
    const t = this.table!;
    return t.isPrivate && !t.allowSpectators && this.seatIndexOf(a.userId) === null && !this.hasAccess(a);
  }

  private refuse(ws: WebSocket) {
    this.send(ws, { t: 'error', code: 'join_code_required', message: 'join code required' });
    try {
      ws.close(4003, 'join code required');
    } catch {
      /* already closing */
    }
  }

  /**
   * Applies the table's current code, privacy and spectator settings to people already here. Seated players keep their
   * seats whatever changed. When the code or privacy changed, waitlist places taken without the current code are
   * dropped (with a reservation they held); connections without the code are closed where spectators are not allowed,
   * and otherwise stay as spectators who can no longer sit.
   */
  private async enforceAccess() {
    const t = this.table!;
    const current = t.isPrivate ? t.joinCodeHash : null;
    if (this.room.accessHash === undefined) {
      // First load under this build: nothing to compare with yet.
      this.room.accessHash = current;
      await this.ctx.storage.put('room', this.room);
    } else if (this.room.accessHash !== current) {
      this.room.accessHash = current;
      this.room.waitlist = this.room.waitlist.filter((w) => this.mayEnter(w.userId, w.codeHash));
      if (this.room.reservation && !this.room.waitlist.some((w) => w.userId === this.room.reservation!.userId)) this.room.reservation = null;
      await this.save();
    }
    for (const ws of this.sockets()) if (this.mustRefuse(this.att(ws))) this.refuse(ws);
  }

  private broadcast(cues: TableCue[] = [], exclude?: WebSocket) {
    this.maintShown = this.inMaintenance();
    const connected = this.connectedUsers(exclude);
    for (const ws of this.sockets(exclude)) {
      const a = this.att(ws);
      this.send(ws, { t: 'state', state: this.view(a, connected), cues });
    }
    void this.publishStats();
  }

  /**
   * Mirrors occupancy to D1 when it changed, in the same batch as the pending operations counters and latest problem;
   * those (with the occupancy) are otherwise written at most every OPS_FLUSH_MS. A failed write keeps the counters and
   * the problem, and counts itself, so the next of those writes also brings the occupancy up to date. Pending counters
   * in a room where nothing else happens are written by a timer, so they reach the dashboard within OPS_FLUSH_MS.
   * Run through publishStats only.
   */
  private async writeStats() {
    if (!this.tableId) return;
    const taken = this.room.seats.filter((s): s is SeatState => !!s && s.phase !== 'pending');
    const conns = this.sockets().map((ws) => this.att(ws).userId);
    const stats = {
      seated: taken.length,
      bots: taken.filter((s) => s.bot).length,
      playing: !!this.hand,
      waitlist: this.room.waitlist.length,
      waitlistUsers: this.room.waitlist.map((w) => w.userId),
      spectators: this.spectatorsOf(conns),
      connections: conns.length,
    };
    const key = JSON.stringify(stats);
    const changed = key !== this.lastStats;
    const now = Date.now();
    const extra = this.ops.size > 0 || this.pendingIssue !== null;
    if (!changed && !(extra && now - this.lastOpsFlush >= OPS_FLUSH_MS)) {
      if (extra) this.flushOpsIn(OPS_FLUSH_MS - (now - this.lastOpsFlush));
      return;
    }
    this.lastStats = key;
    const ops = this.ops.take();
    const issue = this.pendingIssue;
    this.pendingIssue = null;
    if (extra) this.lastOpsFlush = now;
    const read = ++this.maintReads;
    try {
      const m = await publishLiveStats(this.env.DB, this.tableId, stats, issue, ops, now);
      if (this.takeMaint(m, read)) void this.run(() => this.maintenanceChanged());
    } catch (e) {
      this.ops.restore(ops);
      this.pendingIssue ??= issue;
      this.ops.add('room_error');
      // The occupancy was not written either: the retry writes it whatever changes meanwhile.
      this.lastStats = '';
      console.error('live stats', (e as Error).message);
      this.flushOpsIn(OPS_FLUSH_MS);
    }
  }

  private flushOpsIn(ms: number) {
    if (this.opsTimer) return;
    this.opsTimer = setTimeout(() => {
      this.opsTimer = null;
      void this.publishStats();
    }, Math.max(ms, 0));
  }

  /**
   * An operation that failed unexpectedly (anything but a refused command): logged, counted for the admin dashboard
   * and kept as the table's latest problem.
   */
  private fault(what: string, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(what, message);
    this.ops.add('room_error');
    this.pendingIssue = `${new Date().toISOString()} ${what}: ${message}`.slice(0, 300);
    void this.publishStats();
  }

  /** A connection that ended without the client closing it (the link died) or with a socket error, counted once. */
  private countDrop(ws: WebSocket) {
    let connId: string | undefined;
    try {
      connId = this.att(ws)?.connId;
    } catch {
      /* no attachment */
    }
    if (connId) {
      if (this.dropped.has(connId)) return;
      if (this.dropped.size >= 500) this.dropped.clear();
      this.dropped.add(connId);
    }
    this.ops.add('ws_drop');
  }

  // ------------------------------------------------------------------ HTTP / sockets

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('x-jc-internal') !== this.env.INTERNAL_SECRET || !this.env.INTERNAL_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const [, kind, tableId, action] = url.pathname.split('/');
    if (!tableId) return new Response('bad request', { status: 400 });

    if (kind === 'ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
      let identity: Identity;
      try {
        identity = JSON.parse(decodeURIComponent(request.headers.get('x-jc-identity') ?? '')) as Identity;
      } catch {
        return new Response('bad identity', { status: 400 });
      }
      if (!identity.userId) return new Response('bad identity', { status: 400 });
      // The web client marks a connection it opens again after losing one (useTableSocket).
      const retry = url.searchParams.get('r') === '1';
      return this.run(async () => {
        await this.ensureLoaded(tableId);
        if (this.room.closed) return new Response('table closed', { status: 410 });
        // The api read the role and VIP color from D1 for this handshake: a seat taken under older ones shows the current.
        const roleChanged = this.setSeatRole(identity.userId, identity.role);
        if (this.setSeatVip(identity.userId, identity.vip) || roleChanged) await this.save();
        return this.openSocket(identity, retry);
      });
    }

    if (kind === 'internal') {
      return this.run(async () => {
        await this.ensureLoaded(tableId);
        switch (action) {
          case 'status':
            return Response.json(await this.adminStatus());
          case 'timer-recover':
            return Response.json(await this.recoverTimer());
          case 'reload': {
            // `wrangler dev --var` reaches only the api worker, so local tests pass their timeout along here.
            const idleMs = Number(request.headers.get('x-jc-idle-close-ms'));
            if (this.env.ENVIRONMENT !== 'production' && idleMs > 0 && this.room.idleCloseMs !== idleMs) {
              this.room.idleCloseMs = idleMs;
              await this.ctx.storage.put('room', this.room);
            }
            const read = ++this.maintReads;
            const { table: t, maintenance } = await loadTable(this.env.DB, tableId);
            if (t) {
              const social = this.table?.social;
              this.table = t;
              // Quick reactions or staff badges changed: the views broadcast below show them, the chat is sent again.
              this.takeSocial(social, t.social);
              // Maintenance an admin planned, moved or ended (this broadcast and afterChange show it and deal again).
              this.takeMaint(maintenance, read);
              // A tournament's pause or resume (from the next hand), or its abort (which comes with the close below).
              await this.takeTourney(t.tournament);
              if (!this.dealsNow()) await this.stopTourneyClock();
              if (t.status === 'closing' && !this.room.closed) await this.beginClose();
              // A room an older build closed before telling D1.
              else if (this.room.closed && t.status !== 'closed') await markTableClosed(this.env.DB, tableId);
              // A new join code, privacy or spectator setting applies to people already here.
              await this.enforceAccess();
              // New bot settings or a new bot policy (a larger fund, say): a bot may try to join again now, not after the backoff.
              if (this.room.botRetryAt !== undefined) {
                this.room.botRetryAt = undefined;
                this.room.botFails = 0;
                await this.save();
              }
            }
            if (this.maintShown && !this.inMaintenance()) await this.offerFreedSeat();
            this.broadcast();
            // (A table resumed after a pause or a maintenance deals again from here.)
            await this.afterChange();
            return Response.json({
              ok: true,
              appliesFrom: this.hand ? 'next hand' : 'now',
              paused: !!this.table?.handsPaused,
              maintenance: this.inMaintenance(),
              handInProgress: !!this.hand && !this.hand.isSettled,
            });
          }
          case 'bot-profiles': {
            // An administrator changed a bot's own settings: read again now, applied from the next deal.
            if (!(await this.syncBotProfiles(true))) return Response.json({ ok: false }, { status: 503 });
            await this.save();
            return Response.json({ ok: true, appliesFrom: 'next hand', handInProgress: !!this.hand && !this.hand.isSettled });
          }
          case 'close':
            await this.beginClose();
            return Response.json({ ok: true, closed: this.room.closed, handInProgress: !!this.hand });
          case 'kick':
            return Response.json(
              await this.kick(url.searchParams.get('user') ?? '', url.searchParams.get('reason') === 'suspended' ? 'suspended' : 'disconnected', url.searchParams.get('leave') === '1'),
            );
          case 'report-context':
            return Response.json(this.reportContext(url.searchParams.get('target') ?? '', url.searchParams.get('reporter') ?? ''));
          case 'seat-check':
            return Response.json(this.seatCheck(url.searchParams.get('user') ?? ''));
          case 'holdings':
            return Response.json(this.holdings(url.searchParams.get('user') ?? ''));
          case 'role':
            // An admin changed this member's role (the api passes the stored value).
            return Response.json({ ok: true, seated: await this.refreshRole(url.searchParams.get('user') ?? '', url.searchParams.get('role') ?? 'user') });
          case 'vip':
            // An admin made this member VIP, changed their color or ended it (the api passes what others see; empty: none).
            return Response.json({ ok: true, seated: await this.refreshVip(url.searchParams.get('user') ?? '', url.searchParams.get('vip') ?? '') });
          case 'muck':
            // An api from before auto-muck always applied pushing a member's setting: there is none to change now.
            return Response.json({ ok: true, seated: this.seatIndexOf(url.searchParams.get('user') ?? '') !== null });
          default:
            return new Response('not found', { status: 404 });
        }
      });
    }
    return new Response('not found', { status: 404 });
  }

  private openSocket(identity: Identity, retry = false): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (this.mustRefuse(identity)) {
      // Accepted only to tell the client why (close 4003), so it asks for the code instead of reconnecting. Not
      // hibernatable and never counted as a connection; another tab of the same user is left alone.
      server.accept();
      this.refuse(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const kickedAt = this.room.kicks?.[identity.userId];
    if (kickedAt && kickedAt + KICK_WINDOW_MS > Date.now() && (identity.authAt ?? 0) < kickedAt + KICK_SKEW_MS) {
      // Authorised before an admin ended this member's connections here: turned away the same way (close 4004).
      server.accept();
      this.endConnection(server, 'disconnected');
      return new Response(null, { status: 101, webSocket: client });
    }
    // One live connection per user: a new tab replaces the old one.
    for (const ws of this.sockets()) {
      if (this.att(ws).userId === identity.userId) {
        this.send(ws, { t: 'replaced' });
        try {
          ws.close(4001, 'replaced by a newer connection');
        } catch {
          /* ignore */
        }
      }
    }
    const attachment: Attachment = { ...identity, connId: crypto.randomUUID(), connectedAt: Date.now() };
    this.ctx.acceptWebSocket(server, [identity.userId]);
    server.serializeAttachment(attachment);
    // Written with the occupancy the broadcast below publishes.
    if (retry) this.ops.add('ws_retry');
    const connected = this.connectedUsers();
    connected.add(identity.userId);
    this.send(server, { t: 'state', state: this.view(attachment, connected), cues: [] });
    this.send(server, { t: 'chatHistory', messages: this.chat.map((l) => this.shownLine(l)) });
    // Others see the (re)connection.
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = this.att(ws);
    // Ended by an admin: whatever it sent before closing is not carried out.
    if (a.kicked) return;
    if (!this.allow(a.connId)) {
      this.send(ws, { t: 'error', code: 'rate_limited', message: 'too many messages' });
      return;
    }
    if (typeof raw !== 'string' || raw.length > 2_000) {
      this.send(ws, { t: 'error', code: 'bad_request', message: 'invalid message' });
      return;
    }
    let msg: ClientMessage;
    try {
      const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error('schema');
      msg = parsed.data;
    } catch {
      this.send(ws, { t: 'error', code: 'bad_request', message: 'invalid message' });
      return;
    }
    if (msg.t === 'ping') {
      this.send(ws, { t: 'pong', at: Date.now() });
      return;
    }
    await this.run(async () => {
      // (Also a command that was waiting here when the admin's disconnect ran.)
      if (this.att(ws).kicked) return;
      try {
        await this.ensureLoaded();
        await this.handle(ws, a, msg);
      } catch (e) {
        const reqId = 'reqId' in msg ? msg.reqId : 'intentId' in msg ? msg.intentId : undefined;
        if (e instanceof CommandError) this.send(ws, { t: 'error', code: e.code, message: e.message, ...(reqId ? { reqId } : {}) });
        else {
          this.fault('command failed', e);
          this.send(ws, { t: 'error', code: 'internal', message: 'internal error', ...(reqId ? { reqId } : {}) });
          // A D1 call that failed half way (a cash-out, a buy-in) is retried by the alarm.
          await this.schedule().catch(() => undefined);
        }
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    if (code === 1006 || code === 1011) this.countDrop(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
    await this.run(async () => {
      if (!this.tableId) return;
      await this.ensureLoaded();
      this.broadcast([], ws);
      await this.schedule();
    });
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011);
  }

  private allow(connId: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(connId) ?? { tokens: MSG_RATE.capacity, at: now };
    b.tokens = Math.min(MSG_RATE.capacity, b.tokens + ((now - b.at) / 1000) * MSG_RATE.refillPerSec);
    b.at = now;
    this.buckets.set(connId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // ------------------------------------------------------------------ commands

  private async handle(ws: WebSocket, a: Attachment, msg: Exclude<ClientMessage, { t: 'ping' }>) {
    const t = this.table!;
    // A tournament seat is neither taken nor given up by hand, and its chips come from the tournament only.
    if (
      t.roomType === 'tournament' &&
      (msg.t === 'sit' || msg.t === 'leave' || msg.t === 'topUp' || msg.t === 'cancelTopUp' || msg.t === 'autoRebuy' || msg.t === 'autoBuy' || (msg.t === 'waitlist' && msg.join))
    ) {
      throw new CommandError('tournament_table', 'not at a tournament table');
    }
    switch (msg.t) {
      case 'sync':
        this.send(ws, { t: 'state', state: this.view(a, this.connectedUsers()), cues: [] });
        return;
      case 'chat': {
        const id = msg.reqId ? await chatLineId(a.userId, msg.reqId) : crypto.randomUUID();
        // Sent again after its answer was lost: the line is already posted.
        if (msg.reqId && this.chat.some((l) => l.id === id)) return this.ack(ws, msg.reqId);
        const now = Date.now();
        if (now - (this.chattedAt.get(a.userId) ?? 0) < 1_000) throw new CommandError('rate_limited', 'slow down');
        this.chattedAt.set(a.userId, now);
        if (this.chattedAt.size > 100) for (const [u, at] of this.chattedAt) if (now - at >= 1_000) this.chattedAt.delete(u);
        const isSeated = this.seatIndexOf(a.userId) !== null;
        if (!isSeated && !t.allowSpectators) throw new CommandError('forbidden', 'spectator chat is disabled');
        const role = publicRole(a.role);
        // The line keeps the VIP color it was posted with (like its role).
        const vip = !role && isVipColor(a.vip) ? a.vip : undefined;
        const line: ChatMessage = { id, userId: a.userId, nickname: a.nickname, ...(role ? { role } : {}), ...(vip ? { vip } : {}), text: msg.text, at: now };
        this.chat = [...this.chat, line].slice(-CHAT_HISTORY);
        await this.ctx.storage.put('chat', this.chat);
        const shown = this.shownLine(line);
        for (const s of this.sockets()) this.send(s, { t: 'chat', message: shown });
        return this.ack(ws, msg.reqId);
      }
      case 'react': {
        // Shown for a moment and gone: nothing is stored, and nothing about the hand or the seat changes.
        const rules = reactionRulesOf(t.social);
        if (!rules) throw new CommandError('reactions_off', 'quick reactions are off');
        const i = this.seatIndexOf(a.userId);
        if (i === null || this.room.seats[i]!.phase !== 'seated') throw new CommandError('forbidden', 'not seated');
        const now = Date.now();
        const times = this.reactedAt.get(a.userId) ?? [];
        if (reactionWait(times, now, rules) > REACTION_SLACK_MS) throw new CommandError('rate_limited', 'slow down');
        this.reactedAt.set(a.userId, [...times.filter((at) => now - at < rules.burstWindowMs), now]);
        if (this.reactedAt.size > 100) {
          for (const [u, ts] of this.reactedAt) if (now - ts[ts.length - 1]! >= rules.burstWindowMs) this.reactedAt.delete(u);
        }
        for (const s of this.sockets()) this.send(s, { t: 'react', seatIndex: i, userId: a.userId, reaction: msg.reaction, at: now });
        return this.ack(ws, msg.reqId);
      }
      case 'sit':
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        await this.sit(a, msg.seatIndex, msg.buyIn, msg.reqId, msg.autoBuy);
        this.send(ws, { t: 'ack', reqId: msg.reqId });
        return;
      case 'leave':
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        await this.leave(a.userId, msg.reqId);
        this.send(ws, { t: 'ack', reqId: msg.reqId });
        return;
      case 'topUp':
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        await this.topUp(a.userId, msg.amount, msg.reqId);
        this.send(ws, { t: 'ack', reqId: msg.reqId });
        return;
      case 'cancelTopUp': {
        const seat = this.seatedSeat(a.userId);
        // Nothing queued (any more): already cancelled, perhaps by this same request sent before.
        if (seat.topUp?.state !== 'queued') return this.ack(ws, msg.reqId);
        seat.topUp = null;
        await this.save();
        this.broadcast();
        return this.ack(ws, msg.reqId);
      }
      case 'autoRebuy':
      case 'autoBuy':
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        if (msg.t === 'autoRebuy') this.setAutoRebuy(a.userId, msg);
        else this.seatedSeat(a.userId).autoBuy = this.autoBuyPolicy(msg.policy);
        this.remember(msg.reqId);
        await this.save();
        this.broadcast();
        this.send(ws, { t: 'ack', reqId: msg.reqId });
        return;
      case 'sitOut':
      case 'sitIn': {
        if (msg.reqId && this.room.recentReqs.includes(msg.reqId)) return this.ack(ws, msg.reqId);
        const i = this.seatIndexOf(a.userId);
        const seat = i === null ? null : this.room.seats[i];
        if (!seat || seat.phase !== 'seated') throw new CommandError('forbidden', 'not seated');
        seat.sittingOut = msg.t === 'sitOut';
        seat.sitOutSince = seat.sittingOut ? Date.now() : null;
        seat.timeouts = 0;
        if (msg.reqId) this.remember(msg.reqId);
        await this.save();
        this.broadcast();
        this.ack(ws, msg.reqId);
        await this.afterChange();
        return;
      }
      case 'waitlist': {
        if (msg.reqId && this.room.recentReqs.includes(msg.reqId)) return this.ack(ws, msg.reqId);
        const w = this.room.waitlist.filter((x) => x.userId !== a.userId);
        if (msg.join) {
          if (this.seatIndexOf(a.userId) !== null) throw new CommandError('already_seated', 'already seated');
          // (Leaving the waitlist stays possible.)
          if (this.inMaintenance()) throw new CommandError('maintenance', 'service maintenance: no new entries');
          if (!this.hasAccess(a)) throw new CommandError('join_code_required', 'join code required');
          // A place kept from before (re-joining) keeps the code it was taken with.
          const kept = this.room.waitlist.find((x) => x.userId === a.userId)?.codeHash;
          w.push({ userId: a.userId, nickname: a.nickname, codeHash: this.mayEnter(a.userId, a.codeHash) ? a.codeHash : kept });
        }
        this.room.waitlist = w;
        if (msg.reqId) this.remember(msg.reqId);
        await this.save();
        this.broadcast();
        // A table bot may give its seat up to a member now waiting (or another may sit once nobody waits).
        if (this.table?.bots.enabled) await this.schedule();
        return this.ack(ws, msg.reqId);
      }
      case 'action':
        await this.action(ws, a.userId, msg);
        return;
      case 'preAction':
        await this.preAction(ws, a.userId, msg);
        return;
      case 'timeBank':
        await this.useTimeBank(ws, a.userId, msg);
        return;
      case 'muck': {
        // A page from before auto-muck always applied sending its setting: acknowledged, and nothing changes.
        if (this.seatIndexOf(a.userId) === null) throw new CommandError('forbidden', 'not seated');
        return this.ack(ws, msg.reqId);
      }
      case 'show': {
        // The first card, the second or both of the hand that just ended (settled, the next not dealt), turned over for
        // the table until the next deal: by a player dealt in at the seat they hold, whether they folded, won uncontested
        // or lost and kept their hand face down. A card already shown, or a hand the showdown showed, changes nothing.
        // Only what is shown changes: the result, the stacks, the record and the ledger were settled before.
        const i = this.seatIndexOf(a.userId);
        if (i === null) throw new CommandError('forbidden', 'not seated');
        const h = this.hand;
        if (!h || !h.isSettled || this.room.settledHandId !== h.handId) throw new CommandError('conflict', 'no finished hand to show');
        if (!h.holeCardsOf(a.userId) || h.startingSeats.find((p) => p.playerId === a.userId)?.seatIndex !== i) {
          throw new CommandError('forbidden', 'not dealt in');
        }
        const prev = this.room.shown?.handId === h.handId ? this.room.shown.cards : {};
        const mine = prev[a.userId] ?? [];
        const next = addShown(mine, msg.card);
        if (!this.revealedSeats(h).has(i) && next !== mine) {
          this.room.shown = { handId: h.handId, cards: { ...prev, [a.userId]: [...next] } };
          await this.save();
          this.broadcast();
        }
        return this.ack(ws, msg.reqId);
      }
    }
  }

  private remember(reqId: string) {
    this.room.recentReqs = [...this.room.recentReqs, reqId].slice(-200);
  }

  /** Answers a command that carried an id (older clients send some without one). */
  private ack(ws: WebSocket, reqId: string | undefined) {
    if (reqId) this.send(ws, { t: 'ack', reqId });
  }

  /** Seat checks shared by `sit` and quick play's `seatCheck`: the table takes entries and this seat is free. */
  private assertSeatFree(userId: string, codeOk: boolean, seatIndex: number) {
    const t = this.table!;
    if (t.roomType === 'tournament') throw new CommandError('tournament_table', 'not at a tournament table');
    if (this.room.closing || this.room.closed || t.status !== 'open') throw new CommandError('table_closed', 'table is closed');
    if (t.entryBlocked) throw new CommandError('entry_blocked', 'new entries are blocked');
    if (this.inMaintenance()) throw new CommandError('maintenance', 'service maintenance: no new entries');
    if (!codeOk) throw new CommandError('join_code_required', 'join code required');
    if (seatIndex < 0 || seatIndex >= t.maxSeats) throw new CommandError('bad_request', 'invalid seat');
    if (this.seatIndexOf(userId) !== null) throw new CommandError('already_seated', 'already seated');
    // Someone who folded and left is still in the hand's record and its final stacks (`settle` copies them by player):
    // a new seat of theirs would be overwritten.
    if (this.handHasPlayer(userId)) throw new CommandError('hand_in_progress', 'the hand you left is still being played');
    if (this.room.seats[seatIndex] || this.handHolds(seatIndex)) throw new CommandError('seat_taken', 'seat taken');
  }

  /** A held reservation or a waitlist that covers every open seat keeps others out. */
  private assertNoWaitlistPriority(userId: string) {
    const res = this.room.reservation;
    if (res && res.until > Date.now() && res.userId !== userId) throw new CommandError('seat_taken', 'a seat is reserved for the waitlist');
    if (!res && this.room.waitlist.length > 0 && this.room.waitlist[0]!.userId !== userId && this.openSeats() <= this.room.waitlist.length) {
      throw new CommandError('seat_taken', 'waitlist has priority');
    }
  }

  /**
   * Quick play asks before sending a player here: the first free seat `userId` could take right now, or why not.
   * The wallet is not checked (the api compares it with the table's minimum) and nothing is held: `sit` re-checks.
   */
  private seatCheck(userId: string): { ok: true; seatIndex: number } | { ok: false; code: ErrorCode } {
    const free = this.room.seats.findIndex((s, i) => !s && i < this.table!.maxSeats && !this.handHolds(i));
    try {
      if (free < 0) throw new CommandError('seat_taken', 'no free seat');
      this.assertSeatFree(userId, !this.table!.isPrivate, free);
      this.assertNoWaitlistPriority(userId);
      return { ok: true, seatIndex: free };
    } catch (e) {
      if (e instanceof CommandError) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * The free chip refill (api lib/refill.ts) asks what a member has on this table. During a hand that is the stack the
   * hand started with, bets included (it changes only when the hand settles). `stable` is false while chips are on
   * their way between the wallet and the seat (a buy-in, a top-up being taken, a cash-out): the api then holds the claim.
   * `settled` (the last hand settled here) lets it tell that two answers came from the same stretch between hands.
   */
  private holdings(
    userId: string,
  ): { seated: false } | { seated: true; tableSessionId: string; stack: number; stable: boolean; inHand: boolean; settled: string | null } {
    const i = this.seatIndexOf(userId);
    const s = i === null ? null : this.room.seats[i]!;
    // Tournament chips are not the member's chips.
    if (!s || this.table?.roomType === 'tournament') return { seated: false };
    return {
      seated: true,
      tableSessionId: s.tableSessionId,
      stack: s.stack,
      stable: s.phase === 'seated' && s.topUp?.state !== 'debiting',
      inHand: this.handHasPlayer(userId),
      settled: this.room.settledHandId,
    };
  }

  private async sit(a: Attachment, seatIndex: number, amount: number, reqId: string, auto?: AutoBuyRequest) {
    const t = this.table!;
    this.assertSeatFree(a.userId, this.hasAccess(a), seatIndex);
    if (!Number.isSafeInteger(amount) || amount < t.minBuyIn || amount > t.maxBuyIn) throw new CommandError('buyin_out_of_range', 'buy-in out of range');
    this.assertNoWaitlistPriority(a.userId);
    // Checked before anything is taken: a policy the table refuses refuses the buy-in with it.
    const autoBuy = auto ? this.autoBuyPolicy(auto) : null;

    const tableSessionId = crypto.randomUUID();
    const role = publicRole(a.role);
    const vip = !role && isVipColor(a.vip) ? a.vip : undefined;
    const seat: SeatState = {
      userId: a.userId,
      nickname: a.nickname,
      avatarUrl: a.avatarUrl,
      ...(role ? { role } : {}),
      ...(vip ? { vip } : {}),
      stack: amount,
      tableSessionId,
      phase: 'pending',
      buyIn: amount,
      sittingOut: false,
      sitOutSince: null,
      leaveAfterHand: false,
      timeouts: 0,
      joinedAt: Date.now(),
      ...(autoBuy ? { autoBuy } : {}),
    };
    // Reserve the seat durably before touching the wallet (crash safety).
    this.room.seats[seatIndex] = seat;
    await this.save();
    // If this throws, the outcome is unknown: the seat stays pending and the retry alarm asks the ledger
    // (recoverPendingSeats).
    const r = await buyIn(this.env.DB, { userId: a.userId, tableId: t.id, tableSessionId, seatIndex, amount });
    if (!r.ok) {
      this.room.seats[seatIndex] = null;
      await this.save();
      throw new CommandError(r.code, r.code === 'insufficient_balance' ? 'not enough chips in wallet' : r.code === 'suspended' ? 'account suspended' : 'already seated at this table');
    }
    seat.phase = 'seated';
    this.room.waitlist = this.room.waitlist.filter((w) => w.userId !== a.userId);
    if (this.room.reservation?.userId === a.userId) this.room.reservation = null;
    this.remember(reqId);
    await this.save();
    this.broadcast([{ kind: 'seat', seatIndex, nickname: a.nickname }]);
    await this.afterChange();
  }

  private openSeats() {
    return this.room.seats.filter((s, i) => !s && !this.handHolds(i)).length;
  }

  /**
   * On restart and on the retry alarm: confirm or roll back seats whose buy-in or top-up outcome is unknown, and finish
   * the leaves and cash-outs a failed D1 call cut short. Returns the seats it freed, and a notice for each member who
   * asked to leave and was told it had not gone through (for the callers that can send them).
   */
  private async recoverPendingSeats() {
    // On load this runs before a settled hand's stacks reach the seats (`settle`): a leaver waits for that.
    const unsettled = !!this.hand?.isSettled && this.room.settledHandId !== this.hand.handId;
    let changed = false;
    const cues: TableCue[] = [];
    const notices: Notice[] = [];
    const freed = (i: number, s: SeatState) => {
      cues.push({ kind: 'leave', seatIndex: i });
      if (s.leaveAfterHand && !s.bot && this.table?.roomType !== 'tournament') notices.push({ userId: s.userId, code: 'left_seat', amount: s.stack });
    };
    for (let i = 0; i < this.room.seats.length; i++) {
      const s = this.room.seats[i];
      if (!s) continue;
      if (s.phase === 'pending') {
        changed = true;
        if (!(await buyInCommitted(this.env.DB, s.tableSessionId))) {
          this.room.seats[i] = null;
          continue;
        }
        s.phase = 'seated';
      }
      // A player in the hand being played waits for it to end, except one who folded and left: their cash-out cut
      // short is finished here (the seat kept the stack to pay, top-up included). One not begun is `standFolded`'s,
      // which takes the stack from the hand.
      if (this.handHasPlayer(s.userId) && !(s.phase === 'cashing' && this.foldedOut(s))) continue;
      if (await this.resolveTopUp(s)) changed = true;
      if (s.phase === 'cashing') {
        await this.cashOutSeat(s);
        this.keepBank(s);
        this.room.seats[i] = null;
        freed(i, s);
        changed = true;
      } else if (s.leaveAfterHand && !unsettled) {
        // A player who left while D1 could not answer, or whose stand-up after a hand stopped before its cash-out began.
        await this.standUp(i);
        freed(i, s);
        changed = true;
      }
    }
    if (changed) await this.save();
    return { cues, notices };
  }

  /** Pays the seat's stack back to the wallet. A failure is counted for the chip economy page and passed on to the caller's retry. */
  private async cashOutSeat(seat: SeatState) {
    // Tournament chips never reach a wallet (standUp frees a tournament seat without coming here).
    if (this.table?.roomType === 'tournament') return;
    try {
      await cashOut(this.env.DB, { userId: seat.userId, tableId: this.tableId!, tableSessionId: seat.tableSessionId, amount: seat.stack });
    } catch (e) {
      this.ops.add('cashout_fail');
      throw e;
    }
  }

  private handHasPlayer(userId: string) {
    return !!this.hand && !this.hand.isSettled && this.hand.startingSeats.some((s) => s.playerId === userId);
  }

  /**
   * A seat the hand being played was dealt to, now empty (its player folded and left): nobody sits there until the hand
   * ends, so the hand's seats and the room's stay the same players.
   */
  private handHolds(i: number) {
    const h = this.hand;
    return !!h && !h.isSettled && h.startingSeats.some((p) => p.seatIndex === i);
  }

  /**
   * A member at a cash table who folded in the hand being played: their stack is final (the pot pays only players
   * still in), so their stand-up need not wait for the hand to end. Table bots play their hand out, and tournament
   * chips stay in the tournament, so neither gets up early.
   */
  private foldedOut(s: SeatState) {
    const h = this.hand;
    return !!h && !h.isSettled && !s.bot && this.table?.roomType !== 'tournament' && h.hasFolded(s.userId);
  }

  /** A seat whose stand-up or cash-out waits for the hand being played to end. */
  private waitsForHand(s: SeatState) {
    return this.handHasPlayer(s.userId) && !this.foldedOut(s);
  }

  /**
   * Stands up, mid-hand, the members who asked to leave and have folded: their final stack goes back to the wallet
   * (the chips they put in stay in the pot for the others) and the hand plays on without them. Their seat stays out of
   * reach until the hand ends (`handHolds`), and the hand's record keeps them. A failed cash-out leaves the seat
   * 'cashing' for the retry alarm, which pays the stack saved with it (`recoverPendingSeats`); one whose stand-up did
   * not begin is tried again here (`finishWorkSafely`) or stands up when the hand settles.
   */
  private async standFolded() {
    const h = this.hand;
    if (!h || h.isSettled) return;
    const left: TableCue[] = [];
    const notices: Notice[] = [];
    for (let i = 0; i < this.room.seats.length; i++) {
      const s = this.room.seats[i];
      if (!s || s.phase !== 'seated' || !s.leaveAfterHand || !this.foldedOut(s)) continue;
      const stack = h.finalStacks().get(s.userId);
      if (stack === undefined) continue;
      s.stack = stack;
      try {
        await this.standUp(i);
        left.push({ kind: 'leave', seatIndex: i });
        notices.push({ userId: s.userId, code: 'left_seat', amount: s.stack });
      } catch (e) {
        this.fault('cash-out failed; will retry', e);
      }
    }
    if (left.length) this.broadcast(left);
    this.notify(notices);
  }

  private async leave(userId: string, reqId?: string) {
    const i = this.seatIndexOf(userId);
    if (i === null) {
      this.room.waitlist = this.room.waitlist.filter((w) => w.userId !== userId);
      await this.save();
      this.broadcast();
      return;
    }
    const seat = this.room.seats[i]!;
    if (reqId) this.remember(reqId);
    if (this.handHasPlayer(userId)) {
      // Leaving mid-hand folds the hand: at once when it is the player's turn, else when their turn comes (`progress`).
      // Once folded they stand up without waiting for the hand (`standFolded`); a player all in stays in it and stands
      // up after settlement.
      seat.leaveAfterHand = true;
      seat.sittingOut = true;
      await this.save();
      if (this.hand!.actorId() === userId && !this.hand!.isStalled()) {
        await this.applyAction(userId, { type: 'fold' }, `leave-${reqId ?? crypto.randomUUID()}`);
      } else {
        // Leaving again after a cash-out that failed mid-hand tries it again now, as it does between hands (with any
        // other seat waiting on the same retry).
        const retry = seat.phase === 'cashing' && this.foldedOut(seat) ? await this.recoverPendingSeats() : null;
        this.broadcast(retry?.cues ?? []);
        if (retry) this.notify(retry.notices);
        await this.standFolded();
        await this.schedule();
      }
      // Their fold stood them up but the cash-out failed: the seat waits, 'cashing', for the retry alarm (or a leave
      // sent again), and they are told it did not go through.
      if (this.room.seats[i] === seat && seat.phase === 'cashing') throw new CommandError('internal', 'cash-out failed; will retry');
      return;
    }
    seat.leaveAfterHand = true;
    seat.sittingOut = true;
    // standUp asks D1 before it saves anything for a seat whose buy-in or top-up outcome is unknown. If that read fails,
    // the saved seat still says the player left, so recovery pays them back (when the ledger shows the chips landed)
    // instead of seating them. Other seats are saved as 'cashing' before any D1 call.
    if (seat.phase === 'pending' || seat.topUp?.state === 'debiting') await this.save();
    await this.standUp(i);
    // The last player leaving a closing room closes it.
    if (this.room.closing) await this.continueCloseSafely();
    this.broadcast([{ kind: 'leave', seatIndex: i }]);
    await this.afterChange();
  }

  /** Cash out the seat's stack to the wallet and free the seat. */
  private async standUp(i: number) {
    const seat = this.room.seats[i];
    if (!seat) return;
    if (this.table?.roomType === 'tournament') {
      // Tournament chips stay in the tournament: the seat is freed and nothing moves (docs/TOURNAMENT.md).
      this.room.seats[i] = null;
      await this.save();
      return;
    }
    // A seat whose buy-in D1 never confirmed (the call failed) may have brought nothing: only the ledger says whether
    // it did, and paying out a buy-in never taken would create chips. If that read fails too the seat stays pending
    // for `recoverPendingSeats`.
    if (seat.phase !== 'pending' || (await buyInCommitted(this.env.DB, seat.tableSessionId))) {
      // Chips from a top-up whose outcome is unknown are counted first; one still waiting for a hand is simply
      // dropped, since nothing was taken for it.
      await this.resolveTopUp(seat);
      seat.topUp = null;
      seat.phase = 'cashing';
      await this.save();
      await this.cashOutSeat(seat);
    }
    this.keepBank(seat);
    this.room.seats[i] = null;
    // During maintenance nobody could take it in time: the waitlist is offered the seat when it ends. A seat the hand
    // still holds (its player folded and left) is offered when the hand ends (`settle`).
    if (this.room.waitlist.length > 0 && !this.room.closing && !this.inMaintenance() && !this.handHolds(i)) {
      const head = this.room.waitlist[0]!;
      this.room.reservation = { userId: head.userId, nickname: head.nickname, seatIndex: i, until: Date.now() + RESERVATION_MS };
    }
    await this.save();
  }

  // ------------------------------------------------------------------ top-ups & automatic chip policy (rebuy, top-up)

  private seatedSeat(userId: string): SeatState {
    const i = this.seatIndexOf(userId);
    const seat = i === null ? null : this.room.seats[i]!;
    if (!seat || seat.phase !== 'seated') throw new CommandError('forbidden', 'not seated');
    return seat;
  }

  /**
   * Adds chips from the wallet to a seated player's stack. As when sitting down, the stack afterwards must be within
   * the table's buy-in range. While the player is in a hand it waits, taking nothing, and is applied when the hand
   * ends, so a stack never grows mid-hand; otherwise it applies at once.
   */
  private async topUp(userId: string, amount: number, reqId: string) {
    const t = this.table!;
    const seat = this.seatedSeat(userId);
    if (this.room.closing || this.room.closed || t.status !== 'open') throw new CommandError('table_closed', 'table is closed');
    if (seat.leaveAfterHand) throw new CommandError('forbidden', 'leaving after this hand');
    const inHand = this.handHasPlayer(userId);
    // Commands run one at a time, so a top-up still marked as debiting here is one whose D1 call failed: settle it
    // first (between hands only — chips never join a stack mid-hand).
    if (seat.topUp?.state === 'debiting') {
      if (inHand) throw new CommandError('conflict', 'a top-up is being applied');
      await this.resolveTopUp(seat);
      await this.save();
    }
    const key = `topup:${seat.tableSessionId}:${reqId}`;
    // A request the room no longer remembers (only the last 200 ids are kept) but the ledger has: already counted.
    if ((await committedTopUp(this.env.DB, key)) !== null) {
      this.remember(reqId);
      await this.save();
      return;
    }
    const stack = inHand ? (this.hand!.finalStacks().get(userId) ?? seat.stack) : seat.stack;
    if (stack + amount < t.minBuyIn || stack + amount > t.maxBuyIn) throw new CommandError('buyin_out_of_range', 'the stack would leave the buy-in range');
    if (inHand) {
      if ((await walletBalance(this.env.DB, userId)) < amount) throw new CommandError('insufficient_balance', 'not enough chips in wallet');
      // A newer request replaces the one waiting.
      seat.topUp = { key, amount, state: 'queued' };
    } else {
      const r = await this.debitTopUp(seat, { key, amount });
      if (r === 'insufficient') throw new CommandError('insufficient_balance', 'not enough chips in wallet');
      if (r === 'suspended') throw new CommandError('suspended', 'account suspended');
    }
    this.remember(reqId);
    await this.save();
    this.broadcast();
  }

  /**
   * Takes a top-up's chips from the wallet and adds them to the stack. The seat notes the attempt durably first, so
   * if the room restarts or the D1 call fails half way, `resolveTopUp` asks the ledger whether the chips moved.
   * A key the ledger already has was counted when it was committed (here or by `resolveTopUp`), so it is neither
   * noted nor written again: it is 'duplicate' and adds nothing. Noting it would let `resolveTopUp` count it twice.
   * `hand`: an automatic charge's hand, noted with the attempt so that hand is never charged again however it ends.
   */
  private async debitTopUp(
    seat: SeatState,
    p: { key: string; amount: number; auto?: boolean },
    memo = p.auto ? 'auto rebuy' : 'top-up',
    hand?: string,
  ): Promise<'applied' | 'duplicate' | 'insufficient' | 'suspended'> {
    if ((await committedTopUp(this.env.DB, p.key)) !== null) {
      seat.topUp = null;
      await this.save();
      return 'duplicate';
    }
    seat.topUp = { ...p, state: 'debiting' };
    if (hand) seat.autoHand = hand;
    await this.save();
    const r = await topUp(this.env.DB, { userId: seat.userId, tableId: this.tableId!, tableSessionId: seat.tableSessionId, amount: p.amount, key: p.key, memo });
    seat.topUp = null;
    if (r === 'applied') this.addChips(seat, p.amount, p.auto);
    await this.save();
    return r;
  }

  private addChips(seat: SeatState, amount: number, auto?: boolean) {
    seat.stack += amount;
    seat.buyIn += amount;
    // (One settled after a policy change counts against the new limit: never less than was taken.)
    if (auto && seat.autoBuy) seat.autoBuy.spent += amount;
  }

  /**
   * Settles a top-up whose D1 write may or may not have happened: the ledger decides, so its chips arrive once or not
   * at all, and as many as the ledger took.
   */
  private async resolveTopUp(seat: SeatState): Promise<boolean> {
    const p = seat.topUp;
    if (p?.state !== 'debiting') return false;
    const taken = await committedTopUp(this.env.DB, p.key);
    if (taken !== null) this.addChips(seat, taken, p.auto);
    seat.topUp = null;
    return true;
  }

  /**
   * Turns automatic rebuy on (only with the player's explicit consent, an amount and a total limit), replacing an
   * automatic top-up, or off. Pages before `autoBuy` send this; turning it off leaves an automatic top-up alone.
   */
  private setAutoRebuy(userId: string, msg: Extract<ClientMessage, { t: 'autoRebuy' }>) {
    const seat = this.seatedSeat(userId);
    if (!msg.on) {
      if (seat.autoBuy?.mode === 'rebuy') seat.autoBuy = null;
      return;
    }
    const { amount, cap } = msg;
    if (msg.consent !== true || !amount || !cap) throw this.badPolicy('bad_request', 'consent, an amount and a limit are required');
    seat.autoBuy = this.autoBuyPolicy({ mode: 'rebuy', amount, cap, consent: true });
  }

  /**
   * The automatic chip policy a player asked for, checked against this table's buy-in range: the rebuy amount or the
   * top-up target within it, a top-up's trigger at most its target (the target when not given), and a total limit
   * covering at least one rebuy (or one top-up from nothing) and at most AUTO_REBUY_MAX_TIMES of them. Nothing used yet.
   */
  private autoBuyPolicy(req: AutoBuyRequest): AutoBuyPolicy | null {
    const t = this.table!;
    if (req.mode === 'off') return null;
    const per = req.mode === 'rebuy' ? req.amount : req.target;
    if (per < t.minBuyIn || per > t.maxBuyIn) throw this.badPolicy('buyin_out_of_range', `${req.mode} amount out of range`);
    if (req.cap < per || req.cap > per * AUTO_REBUY_MAX_TIMES) throw this.badPolicy('bad_request', 'limit out of range');
    if (req.mode === 'rebuy') return { mode: 'rebuy', amount: req.amount, cap: req.cap, spent: 0 };
    const trigger = req.trigger ?? req.target;
    if (trigger > req.target) throw this.badPolicy('bad_request', 'trigger above the target');
    return { mode: 'topup', target: req.target, trigger, partial: req.partial ?? false, cap: req.cap, spent: 0 };
  }

  /** A policy request the room refuses (counted for the admin economy page: a page should never send one). */
  private badPolicy(code: ErrorCode, message: string) {
    this.ops.add('autobuy_invalid');
    return new CommandError(code, message);
  }

  /**
   * Between hands: apply the top-ups that waited for the hand to end, then the seat's automatic policy — a rebuy for a
   * busted player, or a top-up back to the target for a stack the hand left below the trigger. None takes more than the
   * player chose, and the stack stays within the buy-in range. `handId` is the hand just finished: one automatic charge
   * per hand, its ledger key made from it. A seat whose D1 call fails keeps its state for the next attempt: a charge
   * not yet noted is tried again, one noted is settled by the ledger and not tried again for that hand.
   */
  private async applyTopUps(handId: string | null): Promise<Notice[]> {
    const t = this.table!;
    const notices: Notice[] = [];
    if (this.room.closing || t.status !== 'open' || t.roomType === 'tournament') return notices;
    for (const s of this.room.seats) {
      if (!s || s.phase !== 'seated' || this.handHasPlayer(s.userId)) continue;
      try {
        if (await this.resolveTopUp(s)) await this.save();
        const q = s.topUp;
        if (q?.state === 'queued') {
          // The hand may have changed the stack: never more than asked, never past the maximum.
          const amount = Math.min(q.amount, t.maxBuyIn - s.stack);
          if (s.leaveAfterHand || amount <= 0 || s.stack + amount < t.minBuyIn) {
            s.topUp = null;
            await this.save();
            if (!s.leaveAfterHand) notices.push({ userId: s.userId, code: 'topup_dropped' });
          } else {
            // A suspended account's top-up is dropped without a word: its connections were ended.
            const r = await this.debitTopUp(s, { key: q.key, amount });
            if (r === 'applied') notices.push({ userId: s.userId, code: 'topup_applied', amount });
            else if (r === 'insufficient') notices.push({ userId: s.userId, code: 'topup_insufficient' });
          }
        }
        const pol = s.autoBuy;
        if (pol && handId && s.autoHand !== handId && !s.leaveAfterHand) {
          const n = pol.mode === 'rebuy' ? await this.autoRebuy(s, pol, handId) : await this.autoTopUp(s, pol, handId);
          if (n) notices.push(n);
        }
      } catch (e) {
        this.fault('top-up failed', e);
      }
    }
    return notices;
  }

  /** A busted player's automatic rebuy of the chosen amount. */
  private async autoRebuy(s: SeatState, pol: Extract<AutoBuyPolicy, { mode: 'rebuy' }>, handId: string): Promise<Notice | null> {
    if (s.stack > 0) return null;
    const t = this.table!;
    const amount = Math.min(pol.amount, t.maxBuyIn);
    // (Also when the table's range has since moved past the chosen amount.) The busted player stands up as usual.
    if (amount < t.minBuyIn || pol.spent + amount > pol.cap) return this.stopAuto(s, 'rebuy_cap');
    return this.autoDebit(s, handId, { key: `rebuy:${s.tableSessionId}:${handId}`, amount, memo: 'auto rebuy', done: 'rebuy_applied', short: 'rebuy_insufficient' });
  }

  /**
   * An automatic top-up: a stack the hand left below the trigger (0 included) is brought back to the target, the
   * shortfall taken from the wallet — all of it, or with `partial` as much as the wallet holds when that still brings
   * the stack to the table's minimum. Never past the table's maximum or the policy's limit.
   */
  private async autoTopUp(s: SeatState, pol: Extract<AutoBuyPolicy, { mode: 'topup' }>, handId: string): Promise<Notice | null> {
    if (s.stack >= pol.trigger) return null;
    const t = this.table!;
    const target = Math.min(pol.target, t.maxBuyIn);
    // (The table's range has since moved past the target.)
    if (target < t.minBuyIn) return this.stopAuto(s, 'autotopup_cap');
    let amount = target - s.stack;
    if (amount <= 0) return null;
    if (pol.partial) {
      // Read once here; the ledger checks the balance again as it takes the chips.
      amount = Math.min(amount, await walletBalance(this.env.DB, s.userId));
      if (amount <= 0 || s.stack + amount < t.minBuyIn) return this.stopAuto(s, 'autotopup_insufficient');
    }
    if (pol.spent + amount > pol.cap) return this.stopAuto(s, 'autotopup_cap');
    return this.autoDebit(s, handId, { key: `autotop:${s.tableSessionId}:${handId}`, amount, memo: 'auto top-up', done: 'autotopup_applied', short: 'autotopup_insufficient' });
  }

  /**
   * Takes an automatic rebuy's or top-up's chips (`debitTopUp`: noted first, so a restart or a failed call settles it
   * by the ledger key, which a repeat cannot pass). The hand is noted with the attempt: once its chips may have moved,
   * that hand is not charged again, not even under the other policy (another key) after a change. A wallet too short
   * turns the policy off with one notice, so it is neither retried nor announced again; a suspended account's, quietly.
   */
  private async autoDebit(
    s: SeatState,
    handId: string,
    p: { key: string; amount: number; memo: string; done: NoticeCode; short: NoticeCode },
  ): Promise<Notice | null> {
    const r = await this.debitTopUp(s, { key: p.key, amount: p.amount, auto: true }, p.memo, handId);
    if (r === 'insufficient') return this.stopAuto(s, p.short);
    if (r === 'suspended') {
      s.autoBuy = null;
      await this.save();
      return null;
    }
    s.autoHand = handId;
    await this.save();
    // The ledger had the key already: counted when it was committed, so neither taken nor announced again.
    if (r === 'duplicate') {
      this.ops.add('autobuy_dup');
      return null;
    }
    return { userId: s.userId, code: p.done, amount: p.amount };
  }

  /** The policy turns itself off, nothing taken, with one notice (counted for the admin economy page). */
  private async stopAuto(s: SeatState, code: NoticeCode): Promise<Notice> {
    s.autoBuy = null;
    await this.save();
    this.ops.add('autobuy_stop');
    return { userId: s.userId, code };
  }

  private notify(notices: Notice[]) {
    for (const n of notices) {
      for (const ws of this.sockets()) if (this.att(ws).userId === n.userId) this.send(ws, { t: 'notice', code: n.code, ...(n.amount ? { amount: n.amount } : {}) });
    }
  }

  private async action(ws: WebSocket, userId: string, msg: Extract<ClientMessage, { t: 'action' }>) {
    const h = this.hand;
    // Sent again because its answer was lost: it already counted, so only the answer is repeated.
    if (h && h.handId === msg.handId && h.hasApplied(msg.intentId)) {
      this.ops.add('action_dup');
      void this.publishStats();
      return this.ack(ws, msg.intentId);
    }
    if (!h || h.isSettled || h.handId !== msg.handId) throw new CommandError('conflict', 'no such hand in progress');
    if (msg.seq !== h.version) throw new CommandError('stale_version', 'table state changed; refresh and retry');
    await this.applyAction(userId, { type: msg.type, amount: msg.amount }, msg.intentId);
    this.ack(ws, msg.intentId);
  }

  private async applyAction(userId: string, req: { type: Extract<ClientMessage, { t: 'action' }>['type']; amount?: number }, intentId: string) {
    const h = this.hand!;
    const r = await h.act(userId, req, intentId, Date.now());
    if (!r.ok) {
      const code: ErrorCode = r.code === 'duplicate' ? 'duplicate' : r.code === 'not_your_turn' ? 'not_your_turn' : r.code === 'hand_over' ? 'conflict' : 'illegal_action';
      throw new CommandError(code, r.reason);
    }
    const seat = this.room.seats[this.seatIndexOf(userId)!];
    if (seat) seat.timeouts = 0;
    await this.progress(r.cues);
  }

  /**
   * Keeps (or clears) a player's pre-action for this street. It is kept only while someone else is to act and the hand,
   * street and amount to call are still what the player saw; otherwise nothing is kept and the player is told. Only
   * the player's own view changes, so only their connections get it.
   */
  private async preAction(ws: WebSocket, userId: string, msg: Extract<ClientMessage, { t: 'preAction' }>) {
    const seat = this.seatedSeat(userId);
    if (seat.preReqs?.includes(msg.reqId)) return this.ack(ws, msg.reqId);
    if (msg.kind === 'check' && msg.toCall > 0) throw new CommandError('bad_request', 'a check cannot be kept against a bet');
    if (msg.kind === 'fold' && msg.toCall === 0) throw new CommandError('bad_request', 'a fold is kept only against a bet');
    seat.preReqs = [...(seat.preReqs ?? []), msg.reqId].slice(-16);
    const h = this.hand;
    let kept: SeatState['preAction'] = null;
    if (msg.kind && h && !h.isSettled && h.handId === msg.handId && h.stage === msg.stage && !h.isStalled() && h.actorId() !== userId) {
      const me = this.facing(h, userId);
      if (me && me.toCall === msg.toCall) kept = { handId: h.handId, stage: h.stage, kind: msg.kind, toCall: me.toCall };
    }
    seat.preAction = kept;
    await this.save();
    this.ack(ws, msg.reqId);
    this.sendView(userId);
    if (msg.kind && !kept) this.notify([{ userId, code: 'preaction_cancelled' }]);
  }

  /** What `userId` must add to stay in on this street, or null when they are not in the hand with chips to act. */
  private facing(h: HandEngine, userId: string): { toCall: number } | null {
    const info = h.seatInfo(null);
    const i = h.seatOf(userId);
    const me = i === null ? undefined : info.get(i);
    if (!me?.inHand || me.folded || me.allIn) return null;
    return { toCall: Math.max(0, ...[...info.values()].map((x) => x.streetBet)) - me.streetBet };
  }

  /**
   * Drops pre-actions that no longer apply: from an earlier hand or street, of a player out of the hand or all in, or
   * a check a bet has since overtaken (that player is told, to decide on the turn). A fold or a check/fold still fits a
   * bigger bet, so those stay.
   */
  private dropStalePreActions(h: HandEngine, notices: Notice[]) {
    for (const s of this.room.seats) {
      const pre = s?.preAction;
      if (!s || !pre) continue;
      const me = !h.isSettled && pre.handId === h.handId && pre.stage === h.stage ? this.facing(h, s.userId) : null;
      if (me && !(pre.kind === 'check' && me.toCall > pre.toCall)) continue;
      s.preAction = null;
      if (me) notices.push({ userId: s.userId, code: 'preaction_cancelled' });
    }
  }

  /** After any engine event: resolve stalls/auto-actions, persist, broadcast, settle. */
  private async progress(cues: TableCue[]) {
    const h = this.hand!;
    const now = Date.now();
    const notices: Notice[] = [];
    // (Room for a pre-action and a leave-fold of every seat on top of the street changes.)
    for (let guard = 0; guard < 40 && !h.isSettled; guard++) {
      if (h.isStalled()) {
        cues.push(...(await h.resolveStall(now)));
        continue;
      }
      // Players who left / sit out act instantly instead of burning the clock. (A table bot on its way out plays the
      // hand out: it leaves for the table's sake, not because it stopped playing.)
      const actor = h.actorId();
      const seat = actor ? this.room.seats[this.seatIndexOf(actor) ?? -1] : null;
      if (actor && seat && seat.leaveAfterHand && !seat.bot) {
        const r = await h.act(actor, { type: 'fold' }, `leave-fold-${h.version}`, now);
        if (r.ok) cues.push(...r.cues);
        else break;
        continue;
      }
      // At a tournament table a player who is away stays dealt in (blinds and all) and checks or folds at once.
      if (actor && seat && seat.sittingOut && this.table?.roomType === 'tournament') {
        const type = h.legalOptions(actor).some((o) => o.type === 'check') ? 'check' : 'fold';
        const r = await h.act(actor, { type }, `away-${h.version}`, now);
        if (r.ok) cues.push(...r.cues);
        else break;
        continue;
      }
      // A pre-action chosen while waiting: carried out if the engine still allows it, else the player decides.
      const pre = seat?.preAction;
      if (actor && seat && pre && pre.handId === h.handId && pre.stage === h.stage) {
        seat.preAction = null;
        const type = preActionMove(h.legalOptions(actor), pre.kind);
        const r = type ? await h.act(actor, { type }, `pre-${h.version}`, now) : null;
        if (!r?.ok) {
          notices.push({ userId: actor, code: 'preaction_cancelled' });
          break;
        }
        seat.timeouts = 0;
        cues.push(...r.cues);
        continue;
      }
      break;
    }
    this.dropStalePreActions(h, notices);
    if (h.isSettled) {
      await this.settle(cues);
      this.notify(notices);
      return;
    }
    await this.save();
    this.broadcast(cues);
    this.notify(notices);
    // A leaver whose fold just went in gets up now (the others saw the fold first).
    await this.standFolded();
    await this.schedule();
  }

  /**
   * Applies a settled hand exactly once: copy final stacks to seats, record the
   * hand in D1, schedule the next hand and stand up leavers / busted players.
   * Safe to call again after a restart (settledHandId + idempotent D1 writes).
   */
  private async settle(cues: TableCue[]) {
    const h = this.hand!;
    const now = Date.now();
    const firstTime = this.room.settledHandId !== h.handId;
    const tn = this.table?.roomType === 'tournament' ? (this.room.tourney ?? null) : null;
    let reacts: Extract<ServerMessage, { t: 'react' }>[] = [];
    if (firstTime && tn) {
      const stacks = h.finalStacks();
      for (const s of this.room.seats) if (s && stacks.has(s.userId)) s.stack = stacks.get(s.userId)!;
      this.room.settledHandId = h.handId;
      this.room.nextHandAt = now + afterHandMs(h.startingSeats.some((p) => !this.botSeat(p.playerId)));
      this.room.muck = { handId: h.handId, ids: h.startingSeats.map((p) => p.playerId) };
      // A tournament hand is not recorded (no hand history, statistics or replay): its result is the tournament's —
      // places for those who lost their last chip, the winner once one player is left — written to D1 below.
      this.refillTimeBanks(h);
      this.room.tbCount = null;
      bustOut(tn, h.startingSeats, stacks, now, (id) => this.room.seats.find((s) => s?.userId === id)?.vip);
      if (tn.status !== 'aborted') tn.dirty = true;
      await this.save();
    } else if (firstTime) {
      const stacks = h.finalStacks();
      // A seat already 'cashing' is a player who folded and left mid-hand whose cash-out is still to go through: it pays
      // the stack saved with it (a top-up taken for them included), not the hand's.
      for (const s of this.room.seats) if (s && s.phase !== 'cashing' && stacks.has(s.userId)) s.stack = stacks.get(s.userId)!;
      this.room.settledHandId = h.handId;
      this.room.nextHandAt = now + afterHandMs(h.startingSeats.some((p) => !this.botSeat(p.playerId)));
      this.room.muck = { handId: h.handId, ids: h.startingSeats.map((p) => p.playerId) };
      // The record is kept with the result until D1 has it, so a failed write (or a crash) is retried, never lost.
      const key = `${UNRECORDED_PREFIX}${String(this.room.handNumber).padStart(10, '0')}`;
      const botIds = new Set(h.startingSeats.filter((p) => this.botSeat(p.playerId)).map((p) => p.playerId));
      const bots = botIds.size;
      this.refillTimeBanks(h);
      const tb = this.room.tbCount?.handId === h.handId ? this.room.tbCount.n : null;
      this.room.tbCount = null;
      const entry: UnrecordedHand = {
        handNumber: this.room.handNumber,
        record: h.record(now, this.muckOf(h)),
        log: h.persist(),
        ...(bots ? { bots } : {}),
        ...(tb ? { timeBank: tb } : {}),
      };
      // The bots' play for the admin console, counted and saved with the result like the time bank's (statistics only).
      try {
        const levelOf = (id: string) => (botIds.has(id) ? (this.botSeat(id)?.bot ?? undefined) : undefined);
        const counted = countHand(this.room.botStats, entry.record, h.rules.bigBlind, levelOf, now, this.room.closing);
        this.room.botStats = counted.acc;
        if (counted.flush.length) entry.botStats = counted.flush;
      } catch (e) {
        console.error('bot play statistics', e instanceof Error ? e.message : e);
      }
      // The bots' cards shown and reactions sent after the hand, saved with the result (manners only: never the play).
      try {
        reacts = this.botManners(h, entry.record, now);
      } catch (e) {
        console.error('bot manners', e instanceof Error ? e.message : e);
      }
      // At a table with bots, what the members did goes into the bots' statistics in the same write as the result. They
      // are only a help to the bots: should counting fail, the hand settles all the same, uncounted.
      let opp: OppStats | null = null;
      if (bots || this.table?.bots.enabled) {
        try {
          opp = addHand(await this.oppStats(), entry.record, h.rules.bigBlind, (id) => !botIds.has(id), now);
        } catch (e) {
          console.error('bot statistics', STRATEGY_VERSION, e instanceof Error ? e.message : e);
        }
      }
      if (opp) this.room.oppStats = true;
      await this.save({ [key]: entry, ...(opp ? { [OPP_STATS_KEY]: opp } : {}) });
      if (opp) this.opp = opp;
      this.unrecorded.add(key);
    }
    // Results stay visible until the next hand starts. They go out before the D1 write: the result is already saved
    // here, nothing shown depends on D1 having it, and commands sent on seeing it wait in `run` until settle is done.
    this.broadcast(cues);
    for (const r of reacts) for (const s of this.sockets()) this.send(s, r);
    if (tn) await this.syncTourney();
    else await this.retryUnrecorded();
    // Top-ups that waited for this hand and the automatic policy (rebuy, top-up) happen before busted players stand up.
    const notices = await this.applyTopUps(h.handId);
    // Seats players folded and left during the hand were not offered to the waitlist then (`standUp`): they are below.
    const heldFree = h.startingSeats.some((p) => !this.room.seats[p.seatIndex]);
    const left: TableCue[] = [];
    for (let i = 0; i < this.room.seats.length; i++) {
      const s = this.room.seats[i];
      if (!s || s.phase !== 'seated') continue;
      if (s.leaveAfterHand || s.stack === 0 || this.room.closing) {
        try {
          await this.standUp(i);
          left.push({ kind: 'leave', seatIndex: i });
          // The member who asked is told what went back to the wallet (an all-in leaver waited for this).
          if (s.leaveAfterHand && !s.bot && this.table?.roomType !== 'tournament') notices.push({ userId: s.userId, code: 'left_seat', amount: s.stack });
          // (A bot that was asked to leave was logged then; one that lost its chips is logged here.)
          if (s.bot && !s.leaveAfterHand && s.stack === 0) await this.logBot('leave', s.userId, 'busted');
        } catch (e) {
          // The seat stays 'cashing' and the alarm finishes the cash-out (its ledger key makes a repeat a no-op).
          this.fault('cash-out failed; will retry', e);
        }
      }
    }
    const reserved = this.room.reservation;
    if (heldFree && !this.inMaintenance()) await this.offerFreedSeat();
    if (left.length || notices.length || this.room.reservation !== reserved) this.broadcast(left);
    this.notify(notices);
    if (this.room.closing) await this.continueCloseSafely();
    await this.schedule();
  }

  // ------------------------------------------------------------------ hands & timers

  private eligibleSeats(): number[] {
    const out: number[] = [];
    // A tournament player who is away is dealt in all the same (see `progress`).
    const tourney = this.table?.roomType === 'tournament';
    this.room.seats.forEach((s, i) => {
      if (s && s.phase === 'seated' && s.stack > 0 && (tourney || (!s.sittingOut && !s.leaveAfterHand))) out.push(i);
    });
    return out;
  }

  /**
   * Service maintenance under way: no one new sits down or joins the waitlist and no new hand is dealt. A hand already
   * running plays out, and seated players keep their seats, top up and leave as usual. The table's own pause, entry
   * block and close are separate and stay as they are.
   */
  private inMaintenance(now = Date.now()): boolean {
    const m = this.maint;
    return !!m && m.startsAt <= now && now < m.endsAt;
  }

  /** Takes on what a maintenance read found, unless a later read was already taken. Returns whether it changed. */
  private takeMaint(m: Maintenance | null, read: number): boolean {
    if (read < this.maintApplied) return false;
    this.maintApplied = read;
    const same = m?.startsAt === this.maint?.startsAt && m?.endsAt === this.maint?.endsAt;
    this.maint = m;
    return !same;
  }

  /** A maintenance window an occupancy write found planned, moved or ended: shown, and the alarm set for it. */
  private async maintenanceChanged() {
    if (!this.table || this.room.closed) return;
    if (this.maintShown && !this.inMaintenance()) await this.offerFreedSeat();
    this.broadcast();
    await this.afterChange();
  }

  /** A seat freed during maintenance, when the waitlist was not offered it (see `standUp`), is offered once it ends. */
  private async offerFreedSeat() {
    if (this.room.reservation || this.room.waitlist.length === 0 || this.room.closing) return;
    const free = this.room.seats.findIndex((s, i) => !s && !this.handHolds(i));
    if (free < 0) return;
    const head = this.room.waitlist[0]!;
    this.room.reservation = { userId: head.userId, nickname: head.nickname, seatIndex: free, until: Date.now() + RESERVATION_MS };
    await this.save();
  }

  private async afterChange() {
    if (!this.hand && this.eligibleSeats().length >= 2 && !this.room.nextHandAt && !this.room.closing && this.dealsNow()) {
      this.room.nextHandAt = Date.now() + FIRST_HAND_DELAY_MS;
      await this.save();
    }
    await this.schedule();
  }

  private async startHand() {
    const t = this.table!;
    // Normally done when the last hand settled; this catches anything a restart or a failed D1 call left behind.
    this.notify(await this.applyTopUps(this.room.settledHandId));
    // Cards shown after the last hand go with its result.
    this.room.shown = null;
    const dealt = this.eligibleSeats();
    // A paused table deals nothing until an admin resumes it (`reload` then schedules the next hand), nor does any table
    // during maintenance (the alarm at its end does). Table bots never play a hand among themselves.
    const members = dealt.filter((i) => !this.room.seats[i]!.bot).length;
    if (dealt.length < 2 || members === 0 || this.room.closing || t.status !== 'open' || !this.dealsNow()) {
      this.room.nextHandAt = null;
      this.hand = null;
      // A tournament's level clock waits for the next deal (stopped before the view goes out, which shows the time kept).
      await this.stopTourneyClock();
      await this.save();
      this.broadcast();
      return;
    }
    // A level or style an operator changed (the table's, or a bot's own) applies to the bots already seated from this
    // deal on, never during a hand. A failed read of the bots' settings deals with the ones the seats already have.
    if (dealt.some((i) => this.room.seats[i]!.bot)) await this.syncBotProfiles(false);
    for (const i of dealt) {
      const s = this.room.seats[i]!;
      if (!s.bot) continue;
      const play = botPlayOf(s.userId, s.botProfile, t.bots);
      s.bot = play.level;
      s.botStyle = play.style;
    }
    // (A tournament's button moves to the next player still in: busted seats are free, so there is no dead button.)
    const button = nextButtonSeat(this.room.buttonSeat, dealt, t.maxSeats);
    this.room.buttonSeat = button;
    this.room.handNumber += 1;
    this.room.nextHandAt = null;
    const now = Date.now();
    const tn = t.roomType === 'tournament' ? (this.room.tourney ?? null) : null;
    let blinds = { sb: t.smallBlind, bb: t.bigBlind };
    if (tn) {
      // The level is fixed here for the whole hand: one whose time runs out during it applies from the next deal.
      runClock(tn, now);
      tn.hands += 1;
      tn.dirty = true;
      blinds = blindsAt(tn.levels, tn.level);
    }
    this.hand = HandEngine.start({
      handId: `${t.id}:${this.room.handNumber}:${crypto.randomUUID().slice(0, 8)}`,
      rules: { maxSeats: t.maxSeats as MaxSeats, smallBlind: blinds.sb, bigBlind: blinds.bb, turnMs: t.turnSeconds * 1000 },
      seats: dealt.map((i) => ({ playerId: this.room.seats[i]!.userId, seatIndex: i, stack: this.room.seats[i]!.stack, displayName: this.room.seats[i]!.nickname })),
      buttonSeat: button,
      now,
    });
    this.dealTimeBanks(dealt);
    await this.progress([{ kind: 'handStart', handNumber: this.room.handNumber }, { kind: 'deal' }]);
    // The level and hand count dealt reach D1 now, not only when the hand ends (the operators' page shows them).
    if (tn?.dirty) await this.syncTourney();
  }

  /**
   * Whether the table may deal now: not paused by an admin, no maintenance under way and, at a tournament table, the
   * tournament running without an operator's pause and someone still in who is not away. Players who are all away
   * would only post and fold the blinds to each other for ever (the last level stays), so the table waits — its level
   * clock stopped — until one of them is back (`sitIn`).
   */
  private dealsNow(): boolean {
    const t = this.table!;
    if (t.handsPaused || this.inMaintenance()) return false;
    if (t.roomType !== 'tournament') return true;
    const tn = this.room.tourney;
    return !!tn && tn.status === 'running' && !tn.pauseRequested && this.room.seats.some((s) => !!s && s.phase === 'seated' && s.stack > 0 && !s.sittingOut);
  }

  // ------------------------------------------------------------------ tournament

  /**
   * The tournament as D1 has it (table load and `reload`). The first time — or after this room lost its storage — the
   * players sit down with their tournament chips as D1 last had them; after that the room's own state leads, and D1 only
   * brings an operator's pause request and an abort. Returns whether anything changed.
   */
  private async takeTourney(row: TournamentRow | null): Promise<boolean> {
    if (this.table?.roomType !== 'tournament' || !row) return false;
    const now = Date.now();
    const tn = this.room.tourney;
    if (!tn) {
      if (row.status !== 'running' && row.status !== 'finished' && row.status !== 'aborted') return false;
      const seeded = seedTourney(row, now);
      this.room.tourney = seeded;
      if (seeded.status === 'running') {
        for (const e of row.entries) {
          const stack = e.stack ?? row.startStack;
          if (e.status !== 'playing' || stack <= 0 || this.seatIndexOf(e.userId) !== null) continue;
          const free = e.seat !== null && e.seat >= 0 && e.seat < this.room.seats.length && !this.room.seats[e.seat] ? e.seat : this.room.seats.findIndex((x) => !x);
          if (free < 0) continue;
          const role = publicRole(e.role);
          this.room.seats[free] = {
            userId: e.userId,
            nickname: e.nickname,
            avatarUrl: e.avatarUrl,
            ...(role ? { role } : {}),
            ...(!role && e.vip ? { vip: e.vip } : {}),
            stack,
            // Not a table session: nothing of this seat is in the ledger.
            tableSessionId: `tny:${row.id}:${e.userId}`,
            phase: 'seated',
            buyIn: row.startStack,
            sittingOut: false,
            sitOutSince: null,
            leaveAfterHand: false,
            timeouts: 0,
            joinedAt: now,
          };
        }
      }
      await this.save();
      return true;
    }
    let changed = false;
    if (tn.status === 'running' && tn.pauseRequested !== row.pauseRequested) {
      tn.pauseRequested = row.pauseRequested;
      changed = true;
    }
    if (row.status === 'aborted' && tn.status !== 'aborted') {
      markAborted(tn, now);
      changed = true;
    }
    if (changed) await this.save();
    return changed;
  }

  /** A running tournament whose table deals no hand now (paused, maintenance): its level clock stops until the next deal. */
  private async stopTourneyClock() {
    const tn = this.room.tourney;
    if (this.table?.roomType !== 'tournament' || tn?.status !== 'running' || (this.hand && !this.hand.isSettled)) return;
    if (!stopClock(tn, Date.now())) return;
    tn.dirty = true;
    await this.save();
    await this.syncTourney();
  }

  /**
   * Writes the tournament's progress to D1 (`syncTournament`); a failure leaves it to the retry alarm, and the table does
   * not close before D1 has the result. D1 answers with the operator's pause request and an abort, taken on here.
   */
  private async syncTourney(): Promise<boolean> {
    const tn = this.room.tourney;
    if (!tn?.dirty || !this.tableId) return true;
    const now = Date.now();
    const stacks = this.room.seats.filter((x): x is SeatState => !!x && Object.hasOwn(tn.players, x.userId)).map((x) => ({ userId: x.userId, stack: x.stack }));
    const read = ++this.maintReads;
    let r: Awaited<ReturnType<typeof syncTournament>>;
    try {
      r = await syncTournament(this.env.DB, tn, stacks, now);
    } catch (e) {
      this.fault('tournament sync failed; will retry', e);
      return false;
    }
    tn.dirty = false;
    tn.confirmed = tn.places.length;
    if (this.takeMaint(r.maintenance, read)) void this.run(() => this.maintenanceChanged());
    if (tn.status === 'running') tn.pauseRequested = r.pauseRequested;
    const aborted = r.status === 'aborted' && tn.status !== 'aborted';
    if (aborted) markAborted(tn, now);
    await this.save();
    if (aborted && !this.room.closing) await this.beginClose();
    return true;
  }

  /** The tournament as the table shows it to `userId`. */
  private tourneyView(userId: string): TournamentTableView | null {
    const tn = this.room.tourney;
    if (this.table?.roomType !== 'tournament' || !tn) return null;
    const b = blindsAt(tn.levels, tn.level);
    const mine = tn.places.find((p) => p.userId === userId);
    const status: TournamentTableView['you']['status'] =
      tn.winnerId === userId ? 'won' : mine ? 'eliminated' : !Object.hasOwn(tn.players, userId) ? 'watching' : tn.status === 'aborted' ? 'stopped' : 'playing';
    return {
      id: tn.id,
      name: tn.name,
      status: tn.status,
      level: tn.level,
      levelCount: tn.levels.length,
      smallBlind: b.sb,
      bigBlind: b.bb,
      next: tn.level < tn.levels.length - 1 ? blindsAt(tn.levels, tn.level + 1) : null,
      levelEndsAt: tn.levelEndsAt,
      levelLeftMs: tn.levelLeftMs,
      paused: tn.pauseRequested,
      playersLeft: playersLeft(tn),
      entrants: Object.keys(tn.players).length,
      startStack: tn.startStack,
      places: [...tn.places].sort((x, y) => x.place - y.place).map((p) => ({ nickname: p.nickname, place: p.place, ...(p.vip ? { vip: p.vip } : {}) })),
      you: { status, place: mine?.place ?? null },
    };
  }

  // ------------------------------------------------------------------ time bank

  /**
   * At the deal: fixes the hand's time bank rules (the policy as this room last read it: a change reaches a table from
   * its next hand, never a deadline already running) and gives each member dealt in their bank. One they already have
   * here stays, one kept from an earlier seat at this table comes back, and only a first hand brings a new one. A bank
   * over a lowered maximum is cut to it. Table bots have none.
   */
  private dealTimeBanks(dealt: number[]) {
    const rules = this.nextBankRules();
    this.room.bankRules = rules;
    this.room.tbCount = null;
    if (!rules) return;
    for (const i of dealt) {
      const s = this.room.seats[i]!;
      if (s.bot) continue;
      const bank = s.bank ?? this.takeBank(s.userId) ?? { ms: rules.initialMs, hands: 0 };
      s.bank = { ms: Math.min(bank.ms, rules.maxMs), hands: Math.min(bank.hands, rules.refillHands - 1) };
    }
  }

  /** The time bank rules a hand dealt now gets: a tournament's own (from its template), otherwise the service policy's. */
  private nextBankRules(): TimeBankRules | null {
    const t = this.table!;
    if (t.roomType === 'tournament') return tournamentTimeBankRules(this.room.tourney?.tb ?? null);
    return timeBankRulesFor(t.timeBank, t.roomType);
  }

  /** After a hand, for each member dealt in who still has their seat: one more hand, and the refill when it is due. */
  private refillTimeBanks(h: HandEngine) {
    const rules = this.room.bankRules;
    if (!rules) return;
    for (const p of h.startingSeats) {
      const i = this.seatIndexOf(p.playerId);
      const s = i === null ? null : this.room.seats[i]!;
      if (!s?.bank || s.bot) continue;
      const hands = s.bank.hands + 1;
      s.bank = hands >= rules.refillHands ? { ms: Math.min(rules.maxMs, s.bank.ms + rules.refillMs), hands: 0 } : { ms: s.bank.ms, hands };
    }
  }

  /** Keeps a member's time bank when they give up their seat, for BANK_KEEP_MS: sitting down again here brings it back. */
  private keepBank(seat: SeatState) {
    if (seat.bot || !seat.bank) return;
    const now = Date.now();
    const others = Object.entries(this.room.banks ?? {})
      .filter(([u, b]) => u !== seat.userId && now - b.at < BANK_KEEP_MS)
      .sort((x, y) => y[1].at - x[1].at)
      .slice(0, BANK_KEEP_MAX - 1);
    this.room.banks = Object.fromEntries([...others, [seat.userId, { ms: seat.bank.ms, hands: seat.bank.hands, at: now }]]);
  }

  /** A member's kept bank (taken out: it is theirs again), or null when none was kept or it is too old. */
  private takeBank(userId: string): { ms: number; hands: number } | null {
    const b = this.room.banks?.[userId];
    if (!b) return null;
    delete this.room.banks![userId];
    return Date.now() - b.at < BANK_KEEP_MS ? { ms: b.ms, hands: b.hands } : null;
  }

  /** The member's bank here: their seat's, or the one kept since they last sat (what `dealTimeBanks` will give back). */
  private bankOf(userId: string): { ms: number; hands: number } | null {
    const i = this.seatIndexOf(userId);
    const s = i === null ? null : this.room.seats[i]!;
    if (!s || s.bot) return null;
    if (s.bank) return s.bank;
    const b = this.room.banks?.[userId];
    return b && Date.now() - b.at < BANK_KEEP_MS ? { ms: b.ms, hands: b.hands } : null;
  }

  /** Adds to the current hand's time bank counters (written with its record; statistics only). */
  private countTimeBank(handId: string, metric: TimeBankMetric, n: number) {
    if (this.room.tbCount?.handId !== handId) this.room.tbCount = { handId, n: {} };
    this.room.tbCount.n[metric] = (this.room.tbCount.n[metric] ?? 0) + n;
  }

  /**
   * Adds time from the player's time bank to their turn (packages/types/src/timebank.ts). `seq` and `seen` are what the
   * player saw: a request sent again (same id) is only answered, and a second tap sent before the first one's result
   * arrived adds nothing (stale_version). The bank pays in the same save that moves the deadline. Using it does not
   * clear the player's timeouts: a turn that still runs out counts as before.
   */
  private async useTimeBank(ws: WebSocket, userId: string, msg: Extract<ClientMessage, { t: 'timeBank' }>) {
    if (this.room.recentReqs.includes(msg.reqId)) return this.ack(ws, msg.reqId);
    const seat = this.seatedSeat(userId);
    const h = this.hand;
    if (!h || h.isSettled || h.handId !== msg.handId) throw new CommandError('conflict', 'no such hand in progress');
    if (msg.seq !== h.version || msg.seen !== h.turnExtraMs) throw new CommandError('stale_version', 'table state changed; refresh and retry');
    if (h.actorId() !== userId || h.isStalled()) throw new CommandError('not_your_turn', 'not your turn');
    const rules = this.room.bankRules;
    if (seat.bot || !rules || !seat.bank) throw new CommandError('time_bank_off', 'no time bank at this table');
    // A closing table or a maintenance under way: the hand plays out at its normal pace. (Not `table_closed`: a client
    // takes that as the table gone and stops, while this hand still has to be played.)
    if (this.room.closing) throw new CommandError('time_bank_off', 'table is closing');
    if (this.inMaintenance()) throw new CommandError('maintenance', 'service maintenance');
    if (seat.bank.ms < TIME_BANK_MIN_USE_MS) {
      // (Counted with the next save; nothing else changed.)
      this.countTimeBank(h.handId, 'tb_empty', 1);
      throw new CommandError('time_bank_empty', 'time bank is empty');
    }
    const ms = Math.min(rules.unitMs, seat.bank.ms);
    const r = h.extendTurn(userId, ms);
    if (!r.ok) throw new CommandError(r.code === 'hand_over' ? 'conflict' : 'not_your_turn', r.reason);
    seat.bank = { ms: seat.bank.ms - ms, hands: seat.bank.hands };
    this.countTimeBank(h.handId, 'tb_use', 1);
    this.countTimeBank(h.handId, 'tb_sec', Math.round(ms / 1000));
    this.remember(msg.reqId);
    await this.save();
    this.broadcast();
    this.ack(ws, msg.reqId);
    await this.schedule();
  }

  private idleCloseMs() {
    return this.room.idleCloseMs ?? MEMBER_IDLE_CLOSE_MS;
  }

  /** Notes when a member room became empty (or that it no longer is). Returns whether that changed. */
  private trackEmpty(now: number): boolean {
    const empty = this.table?.roomType === 'member' && !this.room.closing && !this.room.closed && this.room.seats.every((s) => !s);
    const since = empty ? (this.room.emptySince ?? now) : null;
    if (since === (this.room.emptySince ?? null)) return false;
    this.room.emptySince = since;
    return true;
  }

  /** Arm the single DO alarm for the earliest pending deadline. */
  private async schedule() {
    if (this.trackEmpty(Date.now())) await this.ctx.storage.put('room', this.room);
    const times: number[] = [];
    if (this.room.emptySince) times.push(this.room.emptySince + this.idleCloseMs());
    if (this.room.closed && this.room.closedAt && this.chat.length) times.push(this.room.closedAt + PLAYER_REPORT_WINDOW_MS);
    if (this.hand && !this.hand.isSettled) {
      const d = this.hand.deadline();
      if (d) times.push(d);
      const botAt = this.botActAt();
      if (botAt !== null) times.push(botAt);
    }
    // Table bots to seat or send away (a failed seating waits out its back-off).
    if (this.loaded && this.table && !this.room.closed) {
      const plan = this.botPlan();
      if (plan.leave.length) times.push(Date.now());
      else if (plan.join) times.push(Math.max(Date.now(), this.room.botRetryAt ?? 0));
    }
    if (this.room.nextHandAt) times.push(this.room.nextHandAt);
    if (this.room.reservation) times.push(this.room.reservation.until);
    // (A tournament player who is away keeps the seat.)
    if (this.table?.roomType !== 'tournament') for (const s of this.room.seats) if (s?.sittingOut && s.sitOutSince) times.push(s.sitOutSince + SIT_OUT_STAND_UP_MS);
    if (this.room.tourney?.closeAt && !this.room.closing) times.push(this.room.tourney.closeAt);
    // Maintenance: its start is shown on the table, its end deals again.
    const m = this.maint;
    if (m && !this.room.closed) {
      if (m.startsAt > Date.now()) times.push(m.startsAt);
      times.push(m.endsAt);
    }
    if (!this.loaded || this.unfinishedWork()) times.push(Date.now() + RETRY_MS);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(...times)));
  }

  override async alarm() {
    await this.run(async () => {
      if (!this.tableId) return;
      try {
        await this.ensureLoaded();
      } catch (e) {
        if (e instanceof CommandError) return; // the table row is gone
        // D1 unreachable: keep retrying here rather than rely on the runtime's few alarm retries.
        this.fault('alarm: load failed; will retry', e);
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
        return;
      }
      if (this.unfinishedWork()) await this.finishWorkSafely();
      const now = Date.now();
      // Turn timer (a table bot moves once it has thought; if it could not, the clock decides as for anyone).
      if (this.hand && !this.hand.isSettled) {
        const d = this.hand.deadline();
        const actor = this.hand.actorId();
        const botAt = this.botActAt();
        const played = botAt !== null && botAt <= now && (await this.playBotTurn(now));
        if (!played && d && actor && d <= now) await this.timeOutTurn(actor, d, now);
      }
      // Waitlist reservation expiry.
      if (this.room.reservation && this.room.reservation.until <= now) {
        const expired = this.room.reservation;
        this.room.waitlist = this.room.waitlist.filter((w) => w.userId !== expired.userId);
        this.room.reservation = null;
        await this.save();
        this.broadcast();
      }
      // Long sit-outs stand up (not at a tournament table).
      for (let i = 0; i < this.room.seats.length && this.table?.roomType !== 'tournament'; i++) {
        const s = this.room.seats[i];
        if (s?.sittingOut && s.sitOutSince && s.sitOutSince + SIT_OUT_STAND_UP_MS <= now && s.phase === 'seated' && !this.handHasPlayer(s.userId)) {
          try {
            await this.standUp(i);
            this.broadcast([{ kind: 'leave', seatIndex: i }]);
          } catch (e) {
            // Left 'cashing' for the retry; the rest of the alarm (turn timers, the next hand) still runs.
            this.fault('cash-out failed; will retry', e);
          }
        }
      }
      // Maintenance start and end. At each D1 is asked once more, since an admin may have moved, extended or cancelled
      // it without this room hearing; when it is over, a seat freed meanwhile goes to the waitlist and dealing starts again.
      let ended = false;
      const m = this.maint;
      if (m && !this.room.closed && (m.endsAt <= now || (m.startsAt <= now && !this.maintShown))) {
        const read = ++this.maintReads;
        try {
          this.takeMaint(await loadMaintenance(this.env.DB, now), read);
        } catch (e) {
          // At the end, over by this room's clock: play resumes (a window still running reaches the room with its next
          // D1 write). At the start, the window as planned holds.
          if (m.endsAt <= now) this.takeMaint(null, read);
          this.fault('maintenance check failed', e);
        }
        ended = !this.inMaintenance(now);
      }
      if (!this.room.closed && (ended || this.inMaintenance(now) !== this.maintShown)) {
        if (!this.inMaintenance(now)) await this.offerFreedSeat();
        this.broadcast();
        await this.afterChange();
      }
      // Table bots sit down or leave.
      if (!this.room.closed) {
        const plan = this.botPlan();
        if (plan.leave.length || (plan.join && (this.room.botRetryAt ?? 0) <= now)) await this.balanceBots(plan);
      }
      // A finished tournament's table closes once its result has been on screen for a while.
      const tn = this.room.tourney;
      if (tn?.closeAt && tn.closeAt <= now && !this.room.closing) await this.beginClose();
      // Next hand.
      if (this.room.nextHandAt && this.room.nextHandAt <= now && (!this.hand || this.hand.isSettled)) {
        this.hand = null;
        await this.startHand();
      }
      // A member room nobody has sat in for a while closes itself.
      if (this.room.emptySince && this.room.emptySince + this.idleCloseMs() <= now && !this.room.closing && this.room.seats.every((s) => !s)) {
        await this.beginClose();
      }
      // A closed room keeps its chat only while players can still report from it.
      if (this.room.closed && this.room.closedAt && this.room.closedAt + PLAYER_REPORT_WINDOW_MS <= now && this.chat.length) {
        this.chat = [];
        await this.ctx.storage.delete('chat');
      }
      await this.schedule();
    });
  }

  /**
   * The actor's turn ran out (deadline `d`, time bank time included): the engine checks or folds for them, and a member's
   * timeout counts toward sitting them out. Returns whether it was applied.
   */
  private async timeOutTurn(actor: string, d: number, now: number): Promise<boolean> {
    const h = this.hand!;
    const handId = h.handId;
    const extended = h.turnExtraMs > 0;
    const r = await h.timeout(actor, now);
    if (!r.ok) return false;
    // For the time bank statistics: a turn that ran out, one that did although time was added, and a timer that ran late.
    this.countTimeBank(handId, 'tb_timeout', 1);
    if (extended) this.countTimeBank(handId, 'tb_expired', 1);
    if (now - d > OVERDUE_MS) this.countTimeBank(handId, 'tb_late', 1);
    const seat = this.room.seats[this.seatIndexOf(actor) ?? -1];
    if (seat && !seat.bot) {
      seat.timeouts += 1;
      if (seat.timeouts >= TIMEOUTS_BEFORE_SIT_OUT && !seat.sittingOut) {
        seat.sittingOut = true;
        seat.sitOutSince = now;
      }
    }
    await this.progress(r.cues);
    return true;
  }

  /**
   * An admin's timer recovery (POST /api/admin/tables/:id/timer-recover), by the room's own rules only: a turn already
   * past its deadline is decided now as the alarm would have decided it (a table bot moves, a member's turn times out,
   * counted as usual); anything else only has its alarm set again from the saved state. No deadline, time bank, card or
   * stack is set by hand.
   */
  private async recoverTimer() {
    const now = Date.now();
    const alarmBefore = await this.ctx.storage.getAlarm();
    const h = this.hand;
    const live = !!h && !h.isSettled && !h.isStalled();
    const handId = h && !h.isSettled ? h.handId : null;
    const d = live ? h!.deadline() : null;
    const actor = live ? h!.actorId() : null;
    let result: 'timed_out' | 'bot_moved' | 'rearmed' | 'none' = 'none';
    if (live && actor && d) {
      const botAt = this.botActAt();
      if (botAt !== null && botAt <= now && (await this.playBotTurn(now))) result = 'bot_moved';
      else if (d <= now && (await this.timeOutTurn(actor, d, now))) result = 'timed_out';
    }
    await this.schedule();
    const alarmAfter = await this.ctx.storage.getAlarm();
    if (result === 'none' && alarmAfter !== null) result = 'rearmed';
    return { ok: true, result, handId, deadline: d, lateMs: d ? Math.max(0, now - d) : 0, alarmBefore, alarmAfter };
  }

  // ------------------------------------------------------------------ table bots

  /** The seat of `userId` when a table bot holds it. */
  private botSeat(userId: string): SeatState | null {
    const i = this.seatIndexOf(userId);
    const s = i === null ? null : this.room.seats[i]!;
    return s?.bot ? s : null;
  }

  /** Whether bots may sit here: an official table that allows them, open, while the service has them on. */
  private botsAllowed(): boolean {
    const t = this.table!;
    return t.roomType === 'official' && t.bots.enabled && t.botPolicyOn && t.status === 'open' && !this.room.closing && !this.room.closed;
  }

  /**
   * What the table's bots should do now. Members always come first: bots sit only beside enough members who are
   * playing, never past the table's limits, never ahead of a member waiting for a seat; and they leave — between hands
   * at once, otherwise once the hand is over — when bots are switched off, too few members stay, the limits went down,
   * or (when the table says so) a member is waiting for a seat no one else is freeing. `leave` lists the bots to go,
   * first those not in the hand, then the latest to sit; `join` says one more bot should sit down (the back-off after a
   * failed seating is the caller's to check).
   */
  private botPlan(): { leave: number[]; reason: string; join: boolean } {
    const t = this.table!;
    // A closing room cashes everyone out itself.
    if (this.room.closing || this.room.closed) return { leave: [], reason: 'closing', join: false };
    const staying: number[] = [];
    let leaving = 0;
    let pending = false;
    let members = 0;
    let playing = 0;
    this.room.seats.forEach((s, i) => {
      if (!s) return;
      if (s.phase === 'pending') pending = true;
      if (s.bot) {
        if (s.leaveAfterHand) leaving++;
        else if (s.phase === 'seated') staying.push(i);
      } else if (s.phase === 'seated' && !s.leaveAfterHand) {
        members++;
        if (!s.sittingOut) playing++;
      }
    });
    const allowed = this.botsAllowed();
    const waiting = t.bots.yieldSeat ? Math.max(0, this.room.waitlist.length - this.openSeats() - leaving) : 0;
    let keep = staying.length;
    let reason = 'limit';
    if (!allowed) {
      keep = 0;
      reason = 'bots_off';
    } else if (members < t.bots.minHumans) {
      keep = 0;
      reason = 'no_members';
    } else {
      if (waiting > 0) reason = 'yield';
      keep = Math.max(0, Math.min(staying.length - waiting, t.bots.max, t.bots.fillTo - members));
    }
    const inHand = (i: number) => (this.handHasPlayer(this.room.seats[i]!.userId) ? 1 : 0);
    const order = [...staying].sort((a, b) => inHand(a) - inHand(b) || this.room.seats[b]!.joinedAt - this.room.seats[a]!.joinedAt);
    const leave = order.slice(0, staying.length - keep);
    const join =
      allowed &&
      leave.length === 0 &&
      leaving === 0 &&
      !pending &&
      !t.entryBlocked &&
      !t.handsPaused &&
      !this.inMaintenance() &&
      playing >= t.bots.minHumans &&
      staying.length < t.bots.max &&
      members + staying.length < t.bots.fillTo &&
      this.openSeats() > 0 &&
      this.room.waitlist.length === 0 &&
      !this.room.reservation;
    return { leave, reason, join };
  }

  /** Carries out `plan`: bots leave (between hands at once, otherwise after the hand), then at most one sits down. */
  private async balanceBots(plan: ReturnType<TableRoom['botPlan']>) {
    const left: TableCue[] = [];
    for (const i of plan.leave) {
      const s = this.room.seats[i]!;
      s.leaveAfterHand = true;
      await this.save();
      await this.logBot('leave', s.userId, plan.reason);
      // In the hand: it plays it out and stands up when it settles.
      if (this.handHasPlayer(s.userId)) continue;
      try {
        await this.standUp(i);
        left.push({ kind: 'leave', seatIndex: i });
      } catch (e) {
        // Left 'cashing' for the retry alarm (its ledger key makes a repeat a no-op).
        this.fault('bot cash-out failed; will retry', e);
      }
    }
    if (plan.leave.length) {
      this.broadcast(left);
      await this.afterChange();
    }
    if (plan.join) await this.seatBot();
  }

  /**
   * Seats one bot in the first free seat with its own buy-in (botBuyInOf: its big blinds or the default, within the
   * table's range), the way `sit` seats a member: the seat is held durably before any chips move, so a restart half way is settled by `recoverPendingSeats`.
   * When no bot can sit (bots switched off, the fund or the service's bot count used up, D1 unreachable), the next try
   * waits, longer after each failure in a row.
   */
  private async seatBot() {
    const t = this.table!;
    const seatIndex = this.room.seats.findIndex((s, i) => !s && i < t.maxSeats && !this.handHolds(i));
    if (seatIndex < 0) return;
    let failure: string = 'busy';
    try {
      const exclude = this.room.seats.flatMap((s) => (s?.bot ? [s.userId] : []));
      for (let attempt = 0; attempt < 3; attempt++) {
        const bot = await pickBot(this.env.DB, exclude);
        const play = botPlayOf(bot.id, bot.profile, t.bots);
        const amount = botBuyInOf(bot.profile, t);
        const seat: SeatState = {
          userId: bot.id,
          nickname: bot.nickname,
          avatarUrl: null,
          stack: amount,
          tableSessionId: crypto.randomUUID(),
          phase: 'pending',
          buyIn: amount,
          sittingOut: false,
          sitOutSince: null,
          leaveAfterHand: false,
          timeouts: 0,
          joinedAt: Date.now(),
          bot: play.level,
          botStyle: play.style,
          botProfile: bot.profile,
        };
        this.room.seats[seatIndex] = seat;
        await this.save();
        const r = await botBuyIn(this.env.DB, { bot, tableId: t.id, tableSessionId: seat.tableSessionId, seatIndex, amount });
        if (r.ok) {
          seat.phase = 'seated';
          this.room.botFails = 0;
          this.room.botRetryAt = null;
          await this.save();
          this.broadcast([{ kind: 'seat', seatIndex, nickname: bot.nickname }]);
          await this.logBot('join', bot.id, r.funded ? `funded ${r.funded}` : null);
          await this.afterChange();
          return;
        }
        this.room.seats[seatIndex] = null;
        await this.save();
        failure = r.code;
        if (r.code === 'policy_off') t.botPolicyOn = false;
        // Another table seated this bot first: try another one.
        if (r.code !== 'busy') break;
        exclude.push(bot.id);
      }
    } catch (e) {
      // A seat left pending (its buy-in outcome unknown) is settled by the retry alarm.
      this.fault('bot join failed', e);
      failure = 'error';
    }
    const fails = (this.room.botFails ?? 0) + 1;
    this.room.botFails = fails;
    this.room.botRetryAt = Date.now() + Math.min(BOT_RETRY_MS.max, BOT_RETRY_MS.first * 2 ** Math.min(fails - 1, 10));
    await this.save();
    await this.logBot(failure === 'fund_exhausted' ? 'fund_exhausted' : 'join_failed', null, failure);
  }

  /** When the table bot to act moves: once it has thought a moment (the same moment however often this is asked). */
  private botActAt(): number | null {
    const h = this.hand;
    const actor = h && !h.isSettled ? h.actorId() : null;
    if (!h || !actor || !h.deadline() || h.isStalled() || !this.botSeat(actor)) return null;
    const turnMs = h.rules.turnMs;
    const think = BOT_THINK_MS.min + Math.round(unitHash(`${h.handId}:${h.version}`) * (BOT_THINK_MS.max - BOT_THINK_MS.min));
    // From the start of its turn (a bot has no time bank, so its deadline is always the table's turn time).
    return h.turnStartedAt + Math.min(think, Math.floor(turnMs / 2));
  }

  /**
   * The table bot to act moves, from what its own seat sees (`botView`: its cards, the board, the pot, the bets and its
   * legal moves — never another player's cards or the deck) and the members' public statistics at this table, through
   * the engine's checks like anyone's move. Its level and style were fixed at the deal (`startHand`): its account's own
   * settings, else the table's. A choice the engine refuses becomes a check, or a fold when it must call. False when it
   * could not move at all.
   */
  private async playBotTurn(now: number): Promise<boolean> {
    const h = this.hand!;
    const actor = h.actorId();
    const seat = actor ? this.botSeat(actor) : null;
    if (!actor || !seat?.bot) return false;
    const plannedAt = this.botActAt();
    let failed: string | null = null;
    let fellBack = false;
    let r: ActResult | null = null;
    try {
      const v = botView(h, actor, h.rules.bigBlind);
      if (!v) failed = 'no_view';
      else {
        const stats = statsBySeat(await this.oppStats(), this.room.seats, now);
        const onFallback = () => (fellBack = true);
        r = await h.act(actor, decideBot(seat.bot, v, Math.random, { style: seat.botStyle ?? styleFor(actor), stats, onFallback }), `bot-${h.version}`, now);
        if (!r.ok) failed = r.code;
      }
    } catch (e) {
      failed = 'error';
      console.error('bot decision', STRATEGY_VERSION, e instanceof Error ? e.message : e);
    }
    if (!r?.ok) {
      const type = h.legalOptions(actor).some((o) => o.type === 'check') ? 'check' : 'fold';
      r = await h.act(actor, { type }, `bot-safe-${h.version}`, now);
      if (!r.ok) {
        this.fault('bot turn failed', new Error(r.reason));
        return false;
      }
    }
    // Counted with the move (saved with it below); tournament hands are not recorded, so their moves are not counted.
    if (this.table?.roomType !== 'tournament') {
      const lagMs = plannedAt === null ? 0 : now - plannedAt;
      this.room.botStats = countMove(this.room.botStats, now, seat.bot, { lagMs, fallback: fellBack || !!failed, failed: !!failed });
    }
    if (failed) await this.logBot('action_failed', actor, failed);
    await this.progress(r.cues);
    return true;
  }

  /**
   * Reads the seated bots' own settings into their seats, for the next deal to apply: when an administrator changes one
   * (`bot-profiles`), else at a deal once BOT_SYNC_MS passed since the last read (and the first after the room wakes).
   * One D1 call, never per move. A failed or slow read (BOT_SYNC_WAIT_MS) keeps what the seats had and is tried again at
   * the next deal.
   */
  private async syncBotProfiles(force: boolean): Promise<boolean> {
    const bots = this.room.seats.filter((s): s is SeatState => !!s?.bot);
    const now = Date.now();
    if (!bots.length || (!force && this.botSyncAt && now - this.botSyncAt < BOT_SYNC_MS)) return true;
    try {
      const found = await within(readBotProfiles(this.env.DB, bots.map((s) => s.userId)), BOT_SYNC_WAIT_MS);
      for (const s of bots) s.botProfile = found.get(s.userId) ?? null;
      this.botSyncAt = now;
      return true;
    } catch (e) {
      this.botSyncAt = 0;
      console.error('bot profiles', e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** A line in the bots' operations log; a failure to write it changes nothing else. */
  private async logBot(kind: BotEventKind, botId: string | null, code: string | null = null) {
    try {
      await botEvent(this.env.DB, { tableId: this.tableId!, botId, kind, code });
    } catch (e) {
      console.error('bot event', e instanceof Error ? e.message : e);
    }
  }

  // ------------------------------------------------------------------ admin

  /** Stops entries and new hands; once no hand is running everyone is cashed out and the table closes. Safe to repeat. */
  private async beginClose() {
    if (!this.room.closing) {
      this.room.closing = true;
      this.room.waitlist = [];
      this.room.reservation = null;
      await this.save();
    }
    await this.continueCloseSafely();
    this.broadcast();
    await this.schedule();
  }

  /**
   * With no hand running: settle seats whose buy-in or cash-out was cut short, cash out the rest and close. Each
   * cash-out is keyed by its table session in the ledger, so repeating this after a failure or a restart pays once.
   */
  private async continueClose() {
    if (this.room.closed || (this.hand && !this.hand.isSettled)) return;
    await this.recoverPendingSeats();
    for (let i = 0; i < this.room.seats.length; i++) if (this.room.seats[i]?.phase === 'seated') await this.standUp(i);
    await this.finishCloseIfIdle();
  }

  /** A failure (D1 unreachable) leaves the rest to the retry alarm `schedule` arms while the close is unfinished. */
  private async continueCloseSafely() {
    try {
      await this.continueClose();
    } catch (e) {
      this.fault('close unfinished; will retry', e);
    }
  }

  /**
   * Work a failed D1 call left behind: a buy-in, leave or cash-out cut short, a close, a finished hand not yet recorded.
   */
  private unfinishedWork(): boolean {
    if (this.unrecorded.size > 0 || this.room.tourney?.dirty) return true;
    if (this.room.closing && !this.room.closed && !(this.hand && !this.hand.isSettled)) return true;
    return this.room.seats.some(
      (s) => s && (s.phase === 'pending' || ((s.phase === 'cashing' || (s.phase === 'seated' && s.leaveAfterHand)) && !this.waitsForHand(s))),
    );
  }

  private async finishWorkSafely() {
    try {
      const { cues, notices } = await this.recoverPendingSeats();
      await this.standFolded();
      await this.retryUnrecorded();
      await this.syncTourney();
      if (this.room.closing && !this.room.closed) await this.continueClose();
      this.broadcast(cues);
      this.notify(notices);
    } catch (e) {
      this.fault('retry failed; will retry', e);
    }
  }

  /**
   * Writes the finished hands D1 does not have yet, oldest first; each stays in storage until its write succeeds. The
   * write reads the maintenance window back, so a room the admin's fan-out missed deals no hand after one starts.
   */
  private async retryUnrecorded() {
    for (const key of [...this.unrecorded].sort()) {
      const u = await this.ctx.storage.get<UnrecordedHand>(key);
      const read = ++this.maintReads;
      try {
        const r = u
          ? await recordHand(this.env.DB, this.tableId!, u.handNumber, u.record, u.log, { bots: u.bots ?? 0, botPolicy: !!this.table?.bots.enabled, timeBank: u.timeBank, botStats: u.botStats })
          : undefined;
        if (r && this.takeMaint(r.maintenance, read)) void this.run(() => this.maintenanceChanged());
        // Bots switched on or off service-wide: `schedule` seats them or sends them away.
        if (r && r.botPolicyOn !== null && this.table) this.table.botPolicyOn = r.botPolicyOn;
        // A time bank policy the admin's fan-out did not bring here applies from the next hand all the same.
        if (r && this.table) this.table.timeBank = r.timeBank;
        // So does a social policy (reactions, staff badges): the next view sent shows it.
        if (r && this.table) this.takeSocial(this.table.social, r.social);
      } catch (e) {
        this.fault('recordHand failed; will retry', e);
        return;
      }
      await this.ctx.storage.delete(key);
      this.unrecorded.delete(key);
    }
  }

  private async finishCloseIfIdle() {
    // (A tournament's table waits until D1 has its result.)
    if (this.room.seats.some((s) => s) || this.room.tourney?.dirty) return;
    // D1 first: a room that counts itself closed retries nothing, so D1 must not be left saying 'closing'.
    await markTableClosed(this.env.DB, this.tableId!);
    this.room.closed = true;
    this.room.closedAt = Date.now();
    this.room.nextHandAt = null;
    this.hand = null;
    await this.save();
    // What the bots learned of the members here is of no use once the table is closed. Only a table where they counted a
    // hand has any to delete; should deleting fail, the table still closes and tells its players.
    if (this.room.oppStats) {
      try {
        await this.ctx.storage.delete(OPP_STATS_KEY);
        this.opp = null;
        this.oppRead = true;
      } catch (e) {
        console.error('bot statistics', STRATEGY_VERSION, e instanceof Error ? e.message : e);
      }
    }
    for (const ws of this.sockets()) {
      this.send(ws, { t: 'error', code: 'table_closed', message: 'table closed' });
      try {
        ws.close(4002, 'table closed');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Evidence for a player report: the reported player's recent chat and the current
   * (or last finished) hand. Both players must be here: seated, watching, or in the chat.
   */
  private reportContext(target: string, reporter: string) {
    const connected = this.connectedUsers();
    const present = (u: string) => this.seatIndexOf(u) !== null || connected.has(u) || this.chat.some((l) => l.userId === u);
    const live = this.hand && !this.hand.isSettled;
    return {
      tableName: this.table?.name ?? '',
      targetPresent: !!target && present(target),
      reporterPresent: !!reporter && present(reporter),
      handId: live ? this.hand!.handId : this.room.settledHandId,
      handNumber: live || this.room.settledHandId ? this.room.handNumber : null,
      chat: this.chat.filter((l) => l.userId === target).slice(-10).map((l) => ({ text: l.text, at: l.at })),
    };
  }

  /** Closes a connection an admin ended (4004), saying why: the client shows it and does not reconnect by itself. */
  private endConnection(ws: WebSocket, code: 'suspended' | 'disconnected') {
    this.send(ws, { t: 'error', code, message: code === 'suspended' ? 'account suspended' : 'disconnected by an admin' });
    try {
      ws.close(4004, code);
    } catch {
      /* already closing */
    }
  }

  /**
   * An admin ended a member's connections here (a suspension, or a disconnect): each socket is told why and closed
   * (4004), and handshakes authorised before now are turned away. With `leave` the member also leaves the waitlist and
   * their seat, the way a player leaving does: between hands the stack goes back to the wallet at once; in a hand their
   * cards are folded on their turn (now, if it is theirs) and the seat is cashed out once the hand settles, so the
   * others play it out. Nothing is taken: chips already in the pot stay there, and an all-in is settled at showdown.
   */
  private async kick(userId: string, code: 'suspended' | 'disconnected', leave: boolean) {
    if (!userId) throw new CommandError('bad_request', 'user required');
    const now = Date.now();
    const kicks = Object.fromEntries(Object.entries(this.room.kicks ?? {}).filter(([, at]) => at + KICK_WINDOW_MS > now));
    kicks[userId] = now;
    this.room.kicks = kicks;
    let sockets = 0;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a.userId !== userId) continue;
      ws.serializeAttachment({ ...a, kicked: true });
      this.endConnection(ws, code);
      sockets++;
    }
    const waiting = this.room.waitlist.some((w) => w.userId === userId);
    const i = this.seatIndexOf(userId);
    let seat: 'none' | 'kept' | 'left' | 'after_hand' | 'retrying' = i === null ? 'none' : 'kept';
    await this.save();
    // A tournament seat stays: its player is dealt in and checks or folds once they time out (docs/TOURNAMENT.md).
    if (leave && this.table?.roomType !== 'tournament') {
      if (waiting || this.room.reservation?.userId === userId) {
        this.room.waitlist = this.room.waitlist.filter((w) => w.userId !== userId);
        if (this.room.reservation?.userId === userId) this.room.reservation = null;
        await this.save();
      }
      if (i !== null) {
        try {
          await this.leave(userId);
          // Still seated and in the hand: their fold waits for their turn, or they are all in (a fold stands them up at once).
          const j = this.seatIndexOf(userId);
          seat = j === null ? 'left' : this.room.seats[j]!.phase === 'seated' && this.handHasPlayer(userId) ? 'after_hand' : 'retrying';
        } catch (e) {
          // A cash-out cut short stays 'cashing' (a buy-in or top-up not confirmed stays as it was, marked as leaving):
          // the retry alarm finishes it.
          this.fault('disconnect: leave unfinished; will retry', e);
          seat = 'retrying';
        }
      }
    }
    this.broadcast();
    await this.schedule();
    return { ok: true, sockets, seat, waitlist: waiting };
  }

  /**
   * The room as the admin table page shows it, with what looks wrong (`issues`). Never cards: no hole cards and no
   * deck, only what everyone at the table can already see. `known` is the table row this room is working from, for the
   * api to compare with D1 (a setting that never reached the room).
   */
  private async adminStatus() {
    const connected = this.connectedUsers();
    const t = this.table!;
    const h = this.hand;
    const live = !!h && !h.isSettled;
    const now = Date.now();
    const deadline = live ? h!.deadline() : null;
    const alarmAt = await this.ctx.storage.getAlarm();
    const issues: string[] = [];
    if (live && h!.isStalled()) issues.push('stalled_hand');
    if (deadline && deadline + OVERDUE_MS < now) issues.push('turn_overdue');
    // (No hand is due while the table is paused or the service is in maintenance.)
    const dealing = this.dealsNow();
    if (!live && dealing && this.room.nextHandAt && this.room.nextHandAt + OVERDUE_MS < now) issues.push('next_hand_overdue');
    if (!live && dealing && !this.room.nextHandAt && !this.room.closing && t.status === 'open' && this.eligibleSeats().length >= 2) issues.push('no_hand_scheduled');
    if (this.room.seats.some((s) => s?.phase === 'pending')) issues.push('pending_seat');
    if (this.room.seats.some((s) => s?.phase === 'cashing' && !this.waitsForHand(s))) issues.push('cashing_seat');
    if (this.room.seats.some((s) => s?.topUp?.state === 'debiting')) issues.push('topup_debiting');
    if (this.unrecorded.size > 0) issues.push('unrecorded_hands');
    if (this.room.closing && !this.room.closed && !live) issues.push('close_unfinished');
    if (this.unfinishedWork() && !alarmAt) issues.push('no_retry_alarm');
    // A running turn whose alarm is missing or set past its deadline: nothing would time it out.
    if (live && deadline && !h!.isStalled() && (!alarmAt || alarmAt > Math.max(deadline, now) + 1_000)) issues.push('timer_unarmed');
    const tn = this.room.tourney;
    if (tn?.dirty) issues.push('tournament_unsynced');
    const nextRules = this.nextBankRules();
    return {
      tableId: this.tableId,
      handNumber: this.room.handNumber,
      handInProgress: live,
      stage: h?.stage ?? null,
      closing: this.room.closing,
      closed: this.room.closed,
      connections: this.sockets().length,
      bots: {
        allowed: this.botsAllowed(),
        settings: t.bots,
        policyOn: t.botPolicyOn,
        retryAt: this.room.botRetryAt ?? null,
        failures: this.room.botFails ?? 0,
      },
      chipsOnTable: this.room.seats.reduce((a, s) => a + (s ? (live ? (h!.finalStacks().get(s.userId) ?? s.stack) : s.stack) : 0), 0) + (live ? h!.handView().potTotal : 0),
      seats: this.room.seats.map((s, i) =>
        s
          ? {
              seatIndex: i,
              userId: s.userId,
              nickname: s.nickname,
              stack: s.stack,
              phase: s.phase,
              sittingOut: s.sittingOut,
              connected: connected.has(s.userId),
              buyIn: s.buyIn,
              inHand: this.handHasPlayer(s.userId),
              // Folded in the hand being played at a cash table: a leave stands them up now, not once it ends.
              folded: this.foldedOut(s),
              leaveAfterHand: s.leaveAfterHand,
              timeouts: s.timeouts,
              sitOutSince: s.sitOutSince,
              topUp: s.topUp ? { state: s.topUp.state, amount: s.topUp.amount, auto: !!s.topUp.auto } : null,
              tableSessionId: s.tableSessionId,
              bot: s.bot ?? null,
              ...(s.bot ? { botStyle: s.botStyle ?? styleFor(s.userId), botProfile: s.botProfile ?? null } : {}),
              // Read only: no one sets a member's time.
              timeBank: s.bank ? { ms: s.bank.ms, hands: s.bank.hands } : null,
            }
          : null,
      ),
      // Empty seats the hand being played still deals to (their players folded and left, paid): free once it ends.
      heldSeats: this.room.seats.flatMap((s, i) => (!s && this.handHolds(i) ? [i] : [])),
      // The running turn's clock: when it began, the table's turn time, time bank time added, the deadline, the alarm.
      timer:
        live && deadline
          ? { turnStartedAt: h!.turnStartedAt, baseMs: h!.rules.turnMs, extraMs: h!.turnExtraMs, deadline, alarmAt, lateMs: Math.max(0, now - deadline) }
          : null,
      timeBank: {
        // The rules of the hand being played (or the last one), and those the next hand will get from the policy as
        // this room last read it.
        hand: this.room.bankRules ?? null,
        next: nextRules,
        policyVersion: t.timeBank?.version ?? null,
        kept: Object.values(this.room.banks ?? {}).filter((b) => now - b.at < BANK_KEEP_MS).length,
        handUses: live && this.room.tbCount?.handId === h!.handId ? (this.room.tbCount.n.tb_use ?? 0) : 0,
      },
      // The social policy version this room last read (null: none, the defaults) and whether reactions are taken here.
      social: { policyVersion: t.social?.version ?? null, reactions: !!reactionRulesOf(t.social) },
      waitlist: this.room.waitlist.length,
      paused: t.handsPaused,
      maintenance: this.maint ? { ...this.maint, active: this.inMaintenance(now) } : null,
      hand: live ? { id: h!.handId, stage: h!.stage, actorSeat: h!.handView().actorSeat, deadline, stalled: h!.isStalled() } : null,
      settledHandId: this.room.settledHandId,
      nextHandAt: this.room.nextHandAt,
      reservation: this.room.reservation ? { seatIndex: this.room.reservation.seatIndex, until: this.room.reservation.until } : null,
      unrecordedHands: this.unrecorded.size,
      alarmAt,
      version: this.room.version,
      known: { status: t.status, entryBlocked: t.entryBlocked, handsPaused: t.handsPaused },
      // The tournament as this room plays it (read only: no stack, card, winner or place is set from here).
      tournament: tn
        ? {
            id: tn.id,
            status: tn.status,
            level: tn.level,
            levelCount: tn.levels.length,
            levelEndsAt: tn.levelEndsAt,
            levelLeftMs: tn.levelLeftMs,
            clockStoppedAt: tn.stoppedAt,
            pauseRequested: tn.pauseRequested,
            hands: tn.hands,
            playersLeft: playersLeft(tn),
            entrants: Object.keys(tn.players).length,
            places: tn.places.map((p) => ({ userId: p.userId, nickname: p.nickname, place: p.place, hand: p.hand })),
            unsynced: tn.dirty,
            closeAt: tn.closeAt,
          }
        : null,
      issues,
      at: now,
    };
  }

  // ------------------------------------------------------------------ projection

  private view(a: Attachment, connected: Set<string>): TableView {
    const t = this.table!;
    const h = this.hand;
    const mySeat = this.seatIndexOf(a.userId);
    const isSeated = mySeat !== null;
    const showHand = isSeated || t.allowSpectators;
    const muck = h ? this.muckOf(h) : undefined;
    const info = h && showHand ? h.seatInfo(isSeated ? a.userId : null, muck) : null;
    const hv = h && showHand ? { ...h.handView(muck), number: this.room.handNumber } : null;
    const revealed = new Set((hv?.result?.showdown ?? []).map((x) => x.seatIndex));
    const shown = h && hv?.result && this.room.shown?.handId === h.handId ? this.room.shown.cards : {};
    const seats: SeatView[] = this.room.seats.map((s, i) => {
      // A seat its player folded and left mid-hand: nobody, and no cards, only the chips they put in on this street.
      if (!s && this.handHolds(i)) return { seatIndex: i, state: 'empty', held: true, stack: 0, streetBet: info?.get(i)?.streetBet ?? 0, connected: false, hasCards: false };
      if (!s) return { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, connected: false, hasCards: false };
      // The hand's word on a seat is about the player it dealt there. A seat it held is free once it settles, while its
      // result still shows: a player who sits there then was not in it (not folded, no action, no bet of theirs).
      const hi = h?.startingSeats.some((p) => p.seatIndex === i && p.playerId === s.userId) ? info?.get(i) : undefined;
      let state: SeatView['state'] = s.sittingOut ? 'sittingOut' : 'waiting';
      if (hi?.inHand) state = hi.folded ? 'folded' : hi.allIn ? 'allin' : 'active';
      // Only the chosen positions carry a card: the other one stays unknown to everybody but its owner.
      const picked = !revealed.has(i) ? shown[s.userId] : undefined;
      const dealt = picked?.length ? h!.holeCardsOf(s.userId) : null;
      // A staff badge the social policy hides is left out; the seat keeps the role. Staff and bots never show VIP.
      const role = shownRole(s.role, t.social);
      const vip = !s.role && !s.bot ? s.vip : undefined;
      return {
        seatIndex: i,
        state,
        userId: s.userId,
        nickname: s.nickname,
        avatarUrl: s.avatarUrl,
        ...(role ? { role } : {}),
        ...(vip ? { vip } : {}),
        // Once the hand is settled the seat holds its final stack plus any top-up made since.
        stack: hi && !h!.isSettled ? hi.stack : s.stack,
        streetBet: hi?.streetBet ?? 0,
        // A table bot is played by the room itself: never shown as away.
        connected: !!s.bot || connected.has(s.userId),
        ...(s.bot ? { bot: s.bot, botStyle: s.botStyle ?? styleFor(s.userId), ...(s.leaveAfterHand ? { botLeaving: true } : {}) } : {}),
        lastAction: hi?.lastAction ?? null,
        hasCards: !!hi?.inHand && !hi.folded,
        holeCards: hi?.holeCards ?? null,
        ...(dealt ? { shown: dealt.map((c, k) => (picked!.includes(k) ? c : null)) } : {}),
      };
    });
    const myLegal = h && isSeated && !h.isSettled && h.actorId() === a.userId && !h.isStalled() ? h.legalOptions(a.userId) : [];
    const myPre = isSeated ? this.room.seats[mySeat]!.preAction : null;
    const myAuto = isSeated ? (this.room.seats[mySeat]!.autoBuy ?? null) : null;
    const res = this.room.reservation;
    const reservationLive = res && res.until > Date.now() ? res : null;
    const access = this.hasAccess(a);
    const tv = this.tourneyView(a.userId);
    const canSit =
      !isSeated &&
      !tv &&
      access &&
      t.status === 'open' &&
      !t.entryBlocked &&
      !this.inMaintenance() &&
      !this.room.closing &&
      !this.handHasPlayer(a.userId) &&
      this.openSeats() > 0 &&
      (!reservationLive || reservationLive.userId === a.userId) &&
      (this.room.waitlist.length === 0 || this.room.waitlist[0]!.userId === a.userId || this.openSeats() > this.room.waitlist.length);
    return {
      version: this.room.version,
      table: {
        id: t.id,
        name: t.name,
        maxSeats: t.maxSeats as MaxSeats,
        // (A tournament's blinds are its level's.)
        smallBlind: tv ? tv.smallBlind : t.smallBlind,
        bigBlind: tv ? tv.bigBlind : t.bigBlind,
        minBuyIn: t.minBuyIn,
        maxBuyIn: t.maxBuyIn,
        turnSeconds: t.turnSeconds,
        allowSpectators: t.allowSpectators,
        isPrivate: t.isPrivate,
        roomType: t.roomType,
        hostId: t.roomType === 'member' ? t.createdBy : null,
      },
      status: this.room.closed ? 'closed' : this.room.closing ? 'closing' : h && !h.isSettled ? 'playing' : 'waiting',
      seats,
      hand: hv,
      spectatorCount: this.spectatorsOf(connected),
      waitlist: this.room.waitlist.map((w) => w.nickname),
      reservation: reservationLive ? { nickname: reservationLive.nickname, until: reservationLive.until } : null,
      // No countdown to a hand a pause or maintenance will not deal.
      nextHandAt: t.handsPaused || (tv && tv.paused) || (this.room.nextHandAt && this.inMaintenance(this.room.nextHandAt)) ? null : this.room.nextHandAt,
      paused: t.handsPaused,
      maintenance: this.maint ? { ...this.maint, active: this.inMaintenance() } : null,
      timeBank: publicRules(h && !h.isSettled ? (this.room.bankRules ?? null) : this.nextBankRules()),
      reactions: reactionRulesOf(t.social),
      tournament: tv,
      you: {
        userId: a.userId,
        seatIndex: mySeat,
        legal: myLegal,
        sittingOut: isSeated ? this.room.seats[mySeat]!.sittingOut : false,
        leaving: isSeated ? this.room.seats[mySeat]!.leaveAfterHand : false,
        inWaitlist: this.room.waitlist.some((w) => w.userId === a.userId),
        canSit,
        needsCode: !isSeated && !access,
        topUpQueued: isSeated && this.room.seats[mySeat]!.topUp?.state === 'queued' ? this.room.seats[mySeat]!.topUp!.amount : null,
        autoRebuy: isSeated && myAuto?.mode === 'rebuy' ? { amount: myAuto.amount, cap: myAuto.cap, spent: myAuto.spent } : null,
        autoBuy: isSeated ? myAuto : null,
        preAction: myPre && h && !h.isSettled && myPre.handId === h.handId && myPre.stage === h.stage ? myPre.kind : null,
        // The same conditions as the `show` command (still true once both are shown, so the page marks them shown).
        canShow:
          isSeated &&
          !!hv?.result &&
          this.room.settledHandId === h!.handId &&
          !!h!.holeCardsOf(a.userId) &&
          h!.startingSeats.find((p) => p.playerId === a.userId)?.seatIndex === mySeat &&
          !revealed.has(mySeat),
        // Only the viewer's own bank, never anyone else's.
        timeBank: isSeated ? this.bankOf(a.userId) : null,
      },
    };
  }

  /** Who mucks in `h`: fixed when it settled (nobody's cards are shown before then). */
  private muckOf(h: HandEngine): ReadonlySet<string> {
    const m = this.room.muck;
    return new Set(m && m.handId === h.handId ? m.ids : []);
  }

  /** A chat line as players see it: a staff badge the social policy hides is left out (the stored line keeps its role). */
  private shownLine(l: ChatMessage): ChatMessage {
    if (!l.role || shownRole(l.role, this.table?.social)) return l;
    const { role: _hidden, ...rest } = l;
    return rest;
  }

  /**
   * A social policy read from D1 (an admin's reload, a hand record). When it shows or hides a staff badge, the chat
   * lines already on screen are sent again with the new display; seats show it with the next view.
   */
  private takeSocial(before: SocialPolicy | null | undefined, next: SocialPolicy | null) {
    if (this.table) this.table.social = next;
    const badges = (p: SocialPolicy | null | undefined) => `${!!shownRole('admin', p)}:${!!shownRole('super_admin', p)}`;
    if (badges(before) === badges(next) || !this.chat.some((l) => l.role)) return;
    const messages = this.chat.map((l) => this.shownLine(l));
    for (const s of this.sockets()) this.send(s, { t: 'chatHistory', messages });
  }

  /** Puts the staff role of `users.role` on the member's seat, if they have one here. True when the seat changed. */
  private setSeatRole(userId: string, stored: string): boolean {
    const i = this.seatIndexOf(userId);
    const seat = i === null ? null : this.room.seats[i]!;
    const next = publicRole(stored);
    if (!seat || seat.role === next) return false;
    if (next) seat.role = next;
    else delete seat.role;
    // Staff never carry VIP (the api ends it with the promotion).
    if (next) delete seat.vip;
    return true;
  }

  /** Puts the VIP color others see (or none: anything not in the palette) on the member's seat. True when it changed. */
  private setSeatVip(userId: string, shown: string | undefined): boolean {
    const i = this.seatIndexOf(userId);
    const seat = i === null ? null : this.room.seats[i]!;
    const next = isVipColor(shown) && !seat?.role && !seat?.bot ? shown : undefined;
    if (!seat || seat.vip === next) return false;
    if (next) seat.vip = next;
    else delete seat.vip;
    return true;
  }

  /**
   * An admin changed a member's VIP state: the identity of their open connections (their next chat lines carry it) and
   * their seat, shown to everyone with one view at once. Nothing else moves: no hand, turn, stack or connection is
   * touched, and lines already posted keep the color they were posted with. Returns whether the member holds a seat.
   */
  private async refreshVip(userId: string, shown: string): Promise<boolean> {
    if (!userId) return false;
    const vip = isVipColor(shown) ? shown : undefined;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a.userId !== userId || a.vip === vip) continue;
      const { vip: _old, ...rest } = a;
      ws.serializeAttachment(vip ? { ...rest, vip } : rest);
    }
    // A tournament's places on screen follow too. The api reaches only the tables the member sits at, so the place of
    // one already out keeps the color it had until the finished table closes.
    let placed = false;
    for (const p of this.room.tourney?.places ?? []) {
      if (p.userId !== userId || p.vip === vip) continue;
      if (vip) p.vip = vip;
      else delete p.vip;
      placed = true;
    }
    if (this.setSeatVip(userId, vip) || placed) {
      await this.save();
      this.broadcast();
    }
    return this.seatIndexOf(userId) !== null;
  }

  /**
   * An admin changed a member's role: the identity of their open connections (so their next chat lines carry it) and
   * their seat, shown to everyone at once. Lines already posted keep the role they were posted with. Returns whether the
   * member holds a seat here.
   */
  private async refreshRole(userId: string, stored: string): Promise<boolean> {
    if (!userId) return false;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a.userId !== userId || a.role === stored) continue;
      const { vip: _vip, ...rest } = a;
      // A promotion to staff ends VIP; going back to member does not bring it back (the api cleared it).
      ws.serializeAttachment(publicRole(stored) ? { ...rest, role: stored } : { ...a, role: stored });
    }
    if (this.setSeatRole(userId, stored)) {
      await this.save();
      this.broadcast();
    }
    return this.seatIndexOf(userId) !== null;
  }

  /**
   * After the settled hand `h` (record `rec`): the bots dealt in that turn over their cards (into `room.shown`, as a
   * member's show) and the quick reactions to send once the result is out (bot-manners.ts). Only seats still held by
   * the bot that played them; at most one reaction.
   */
  private botManners(h: HandEngine, rec: HandRecord, now: number): Extract<ServerMessage, { t: 'react' }>[] {
    const reactionsOn = !!reactionRulesOf(this.table?.social);
    const revealed = this.revealedSeats(h);
    const out: Extract<ServerMessage, { t: 'react' }>[] = [];
    for (const p of rec.players) {
      const seat = this.botSeat(p.playerId);
      if (!seat || this.room.seats[p.seatIndex] !== seat) continue;
      const m = botManners(
        p.playerId,
        { level: seat.bot ?? 'normal', style: seat.botStyle ?? styleFor(p.playerId) },
        { hole: p.holeCards, board: rec.board, bigBlind: h.rules.bigBlind, potTotal: rec.potTotal, net: p.net, wentToShowdown: p.wentToShowdown, shown: p.shown || revealed.has(p.seatIndex) },
        this.room.handNumber,
        now,
        this.botReacts,
        { reactionsOn, reactedThisHand: out.length > 0 },
        Math.random,
      );
      if (m.show) {
        const prev = this.room.shown?.handId === h.handId ? this.room.shown.cards : {};
        this.room.shown = { handId: h.handId, cards: { ...prev, [p.playerId]: [...addShown(prev[p.playerId] ?? [], m.show)] } };
      }
      if (m.reaction) out.push({ t: 'react', seatIndex: p.seatIndex, userId: p.playerId, reaction: m.reaction, at: now });
    }
    return out;
  }

  /** Seats whose cards the showdown of the settled hand `h` turned over for everybody. */
  private revealedSeats(h: HandEngine): Set<number> {
    return new Set((h.handView(this.muckOf(h)).result?.showdown ?? []).map((x) => x.seatIndex));
  }
}

/** Time bank rules as players see them (the policy version stays with the admin status). */
function publicRules(r: TimeBankRules | null): TableView['timeBank'] {
  return r ? { initialMs: r.initialMs, maxMs: r.maxMs, unitMs: r.unitMs, refillHands: r.refillHands, refillMs: r.refillMs } : null;
}

/** The move a pre-action makes given the legal options, or null when it no longer fits. Never a call, bet or raise. */
function preActionMove(legal: LegalOption[], kind: PreActionKind): 'check' | 'fold' | null {
  const can = (t: 'check' | 'fold') => legal.some((o) => o.type === t);
  // A fold is never made while checking is free.
  if (can('check')) return kind === 'fold' ? null : 'check';
  return kind !== 'check' && can('fold') ? 'fold' : null;
}

/** A number in [0, 1) fixed by `s` (FNV-1a), for a pause that must come out the same every time it is computed. */
function unitHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 2 ** 32;
}

function emptyRoom(maxSeats: number): RoomState {
  return {
    v: 1,
    seats: Array.from({ length: maxSeats }, () => null),
    buttonSeat: null,
    handNumber: 0,
    waitlist: [],
    reservation: null,
    nextHandAt: null,
    closing: false,
    closed: false,
    recentReqs: [],
    settledHandId: null,
    version: 0,
  };
}
