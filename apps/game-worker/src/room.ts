/**
 * TableRoom — one Durable Object per poker table.
 *
 * All table mutations are serialised through `run()` (a promise chain), so the
 * awaits on D1 inside a command cannot interleave with another command. State
 * that must survive eviction/restarts lives in Durable Object storage:
 *   room  — seats, button, hand counter, waitlist, timers
 *   hand  — the current hand's engine log (HandEngine.persist())
 *   chat  — recent chat lines
 * Sockets use the WebSocket Hibernation API; each socket carries the verified
 * identity forwarded by the API worker in its attachment.
 */
import { DurableObject } from 'cloudflare:workers';
import { HandEngine, nextButtonSeat, type HandRecord, type PersistedHand } from '@jc/poker-engine';
import {
  AUTO_REBUY_MAX_TIMES,
  ClientMessageSchema,
  MEMBER_IDLE_CLOSE_MS,
  PLAYER_REPORT_WINDOW_MS,
  type ChatMessage,
  type ClientMessage,
  type ErrorCode,
  type HandStage,
  type LegalOption,
  type MaxSeats,
  type NoticeCode,
  type PreActionKind,
  type SeatView,
  type ServerMessage,
  type TableCue,
  type TableView,
} from '@jc/types';
import {
  buyIn,
  buyInCommitted,
  cashOut,
  committedTopUp,
  loadTable,
  markTableClosed,
  publishLiveStats,
  recordHand,
  topUp,
  walletBalance,
  type TableRow,
} from './settlement';

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
  /** Join code hash of the ticket this connection brought (verified by the api), or null. */
  codeHash: string | null;
}

interface Attachment extends Identity {
  connId: string;
  connectedAt: number;
}

interface SeatState {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
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
   * `auto` marks an automatic rebuy.
   */
  topUp?: { key: string; amount: number; state: 'queued' | 'debiting'; auto?: boolean } | null;
  /** Automatic rebuy after busting, turned on by the player for this seat only: chips per rebuy, total limit, used. */
  autoRebuy?: { amount: number; cap: number; spent: number } | null;
  /**
   * What the player chose for their next turn of this street, with the amount they faced when choosing. `progress`
   * carries it out when the turn comes, only as a check or a fold the engine still allows.
   */
  preAction?: { handId: string; stage: HandStage; kind: PreActionKind; toCall: number } | null;
  /** Ids of the player's recent pre-action requests: one sent again is answered, not applied again. */
  preReqs?: string[];
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
}

const BETWEEN_HANDS_MS = 4_000;
const FIRST_HAND_DELAY_MS = 2_500;
const RESERVATION_MS = 30_000;
const SIT_OUT_STAND_UP_MS = 10 * 60_000;
const TIMEOUTS_BEFORE_SIT_OUT = 2;
const CHAT_HISTORY = 50;
const MSG_RATE = { capacity: 20, refillPerSec: 10 };
/** How soon the room retries work a failed D1 call left unfinished (a cash-out, a close, a hand record). */
const RETRY_MS = 15_000;
const UNRECORDED_PREFIX = 'unrecorded:';

/** A finished hand kept in room storage until its D1 record is written. */
interface UnrecordedHand {
  handNumber: number;
  record: HandRecord;
  log: PersistedHand;
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
  private buckets = new Map<string, { tokens: number; at: number; lastChat: number }>();
  private lastStats = '';
  /** Storage keys of finished hands D1 does not have yet (see `retryUnrecorded`). */
  private unrecorded = new Set<string>();

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
      const t = await loadTable(this.env.DB, this.tableId);
      if (!t) throw new CommandError('not_found', 'table not found');
      this.table = t;
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
      this.loaded = true;
      // A code change this room was not told about (or slept through) still takes effect.
      await this.enforceAccess();
      // Seats a restart left half way (and a close not yet finished) are settled here; if D1 fails, play goes on and
      // the retry alarm `schedule` arms finishes them.
      try {
        await this.recoverPendingSeats();
      } catch (e) {
        console.error('recovery failed; will retry', (e as Error).message);
      }
      if (this.hand?.isSettled && this.room.settledHandId !== this.hand.handId) await this.settle([]);
      if (this.unfinishedWork()) {
        await this.finishWorkSafely();
        await this.schedule();
      }
    }
  }

  private async save(extra: Record<string, unknown> = {}) {
    this.room.version += 1;
    await this.ctx.storage.put({ ...extra, room: this.room, hand: this.hand ? this.hand.persist() : null });
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
    const connected = this.connectedUsers(exclude);
    for (const ws of this.sockets(exclude)) {
      const a = this.att(ws);
      this.send(ws, { t: 'state', state: this.view(a, connected), cues });
    }
    void this.publishStats();
  }

  private async publishStats() {
    if (!this.tableId) return;
    const seated = this.room.seats.filter((s) => s && s.phase !== 'pending').length;
    const conns = this.sockets().map((ws) => this.att(ws).userId);
    const spectators = new Set(conns.filter((u) => this.seatIndexOf(u) === null)).size;
    const stats = { seated, playing: !!this.hand, waitlist: this.room.waitlist.length, spectators, connections: conns.length };
    const key = JSON.stringify(stats);
    if (key === this.lastStats) return;
    this.lastStats = key;
    try {
      await publishLiveStats(this.env.DB, this.tableId, stats);
    } catch (e) {
      console.error('live stats', (e as Error).message);
    }
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
      return this.run(async () => {
        await this.ensureLoaded(tableId);
        if (this.room.closed) return new Response('table closed', { status: 410 });
        return this.openSocket(identity);
      });
    }

    if (kind === 'internal') {
      return this.run(async () => {
        await this.ensureLoaded(tableId);
        switch (action) {
          case 'status':
            return Response.json(this.adminStatus());
          case 'reload': {
            // `wrangler dev --var` reaches only the api worker, so local tests pass their timeout along here.
            const idleMs = Number(request.headers.get('x-jc-idle-close-ms'));
            if (this.env.ENVIRONMENT !== 'production' && idleMs > 0 && this.room.idleCloseMs !== idleMs) {
              this.room.idleCloseMs = idleMs;
              await this.ctx.storage.put('room', this.room);
            }
            const t = await loadTable(this.env.DB, tableId);
            if (t) {
              this.table = t;
              if (t.status === 'closing' && !this.room.closed) await this.beginClose();
              // A room an older build closed before telling D1.
              else if (this.room.closed && t.status !== 'closed') await markTableClosed(this.env.DB, tableId);
              // A new join code, privacy or spectator setting applies to people already here.
              await this.enforceAccess();
            }
            this.broadcast();
            await this.schedule();
            return Response.json({ ok: true, appliesFrom: this.hand ? 'next hand' : 'now' });
          }
          case 'close':
            await this.beginClose();
            return Response.json({ ok: true, closed: this.room.closed, handInProgress: !!this.hand });
          case 'report-context':
            return Response.json(this.reportContext(url.searchParams.get('target') ?? '', url.searchParams.get('reporter') ?? ''));
          case 'seat-check':
            return Response.json(this.seatCheck(url.searchParams.get('user') ?? ''));
          default:
            return new Response('not found', { status: 404 });
        }
      });
    }
    return new Response('not found', { status: 404 });
  }

  private openSocket(identity: Identity): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (this.mustRefuse(identity)) {
      // Accepted only to tell the client why (close 4003), so it asks for the code instead of reconnecting. Not
      // hibernatable and never counted as a connection; another tab of the same user is left alone.
      server.accept();
      this.refuse(server);
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
    const connected = this.connectedUsers();
    connected.add(identity.userId);
    this.send(server, { t: 'state', state: this.view(attachment, connected), cues: [] });
    this.send(server, { t: 'chatHistory', messages: this.chat });
    // Others see the (re)connection.
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = this.att(ws);
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
      try {
        await this.ensureLoaded();
        await this.handle(ws, a, msg);
      } catch (e) {
        const reqId = 'reqId' in msg ? msg.reqId : 'intentId' in msg ? msg.intentId : undefined;
        if (e instanceof CommandError) this.send(ws, { t: 'error', code: e.code, message: e.message, ...(reqId ? { reqId } : {}) });
        else {
          console.error('command failed', (e as Error).message);
          this.send(ws, { t: 'error', code: 'internal', message: 'internal error', ...(reqId ? { reqId } : {}) });
          // A D1 call that failed half way (a cash-out, a buy-in) is retried by the alarm.
          await this.schedule().catch(() => undefined);
        }
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number) {
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
    const b = this.buckets.get(connId) ?? { tokens: MSG_RATE.capacity, at: now, lastChat: 0 };
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
    switch (msg.t) {
      case 'sync':
        this.send(ws, { t: 'state', state: this.view(a, this.connectedUsers()), cues: [] });
        return;
      case 'chat': {
        const id = msg.reqId ? await chatLineId(a.userId, msg.reqId) : crypto.randomUUID();
        // Sent again after its answer was lost: the line is already posted.
        if (msg.reqId && this.chat.some((l) => l.id === id)) return this.ack(ws, msg.reqId);
        const b = this.buckets.get(a.connId)!;
        const now = Date.now();
        if (now - b.lastChat < 1_000) throw new CommandError('rate_limited', 'slow down');
        b.lastChat = now;
        const isSeated = this.seatIndexOf(a.userId) !== null;
        if (!isSeated && !t.allowSpectators) throw new CommandError('forbidden', 'spectator chat is disabled');
        const line: ChatMessage = { id, userId: a.userId, nickname: a.nickname, text: msg.text, at: now };
        this.chat = [...this.chat, line].slice(-CHAT_HISTORY);
        await this.ctx.storage.put('chat', this.chat);
        for (const s of this.sockets()) this.send(s, { t: 'chat', message: line });
        return this.ack(ws, msg.reqId);
      }
      case 'sit':
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        await this.sit(a, msg.seatIndex, msg.buyIn, msg.reqId);
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
        if (this.room.recentReqs.includes(msg.reqId)) return this.send(ws, { t: 'ack', reqId: msg.reqId });
        this.setAutoRebuy(a.userId, msg);
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
          if (!this.hasAccess(a)) throw new CommandError('join_code_required', 'join code required');
          // A place kept from before (re-joining) keeps the code it was taken with.
          const kept = this.room.waitlist.find((x) => x.userId === a.userId)?.codeHash;
          w.push({ userId: a.userId, nickname: a.nickname, codeHash: this.mayEnter(a.userId, a.codeHash) ? a.codeHash : kept });
        }
        this.room.waitlist = w;
        if (msg.reqId) this.remember(msg.reqId);
        await this.save();
        this.broadcast();
        return this.ack(ws, msg.reqId);
      }
      case 'action':
        await this.action(ws, a.userId, msg);
        return;
      case 'preAction':
        await this.preAction(ws, a.userId, msg);
        return;
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
    if (this.room.closing || this.room.closed || t.status !== 'open') throw new CommandError('table_closed', 'table is closed');
    if (t.entryBlocked) throw new CommandError('entry_blocked', 'new entries are blocked');
    if (!codeOk) throw new CommandError('join_code_required', 'join code required');
    if (seatIndex < 0 || seatIndex >= t.maxSeats) throw new CommandError('bad_request', 'invalid seat');
    if (this.seatIndexOf(userId) !== null) throw new CommandError('already_seated', 'already seated');
    if (this.room.seats[seatIndex]) throw new CommandError('seat_taken', 'seat taken');
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
    const free = this.room.seats.findIndex((s, i) => !s && i < this.table!.maxSeats);
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

  private async sit(a: Attachment, seatIndex: number, amount: number, reqId: string) {
    const t = this.table!;
    this.assertSeatFree(a.userId, this.hasAccess(a), seatIndex);
    if (!Number.isSafeInteger(amount) || amount < t.minBuyIn || amount > t.maxBuyIn) throw new CommandError('buyin_out_of_range', 'buy-in out of range');
    this.assertNoWaitlistPriority(a.userId);

    const tableSessionId = crypto.randomUUID();
    const seat: SeatState = {
      userId: a.userId,
      nickname: a.nickname,
      avatarUrl: a.avatarUrl,
      stack: amount,
      tableSessionId,
      phase: 'pending',
      buyIn: amount,
      sittingOut: false,
      sitOutSince: null,
      leaveAfterHand: false,
      timeouts: 0,
      joinedAt: Date.now(),
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
      throw new CommandError(r.code, r.code === 'insufficient_balance' ? 'not enough chips in wallet' : 'already seated at this table');
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
    return this.room.seats.filter((s) => !s).length;
  }

  /** On restart: confirm or roll back seats whose buy-in or top-up outcome is unknown, finish cash-outs. */
  private async recoverPendingSeats() {
    let changed = false;
    for (let i = 0; i < this.room.seats.length; i++) {
      const s = this.room.seats[i];
      if (!s) continue;
      if (s.phase === 'pending') {
        const ok = await buyInCommitted(this.env.DB, s.tableSessionId);
        if (ok) s.phase = 'seated';
        else this.room.seats[i] = null;
        changed = true;
      } else if (!this.handHasPlayer(s.userId)) {
        if (await this.resolveTopUp(s)) changed = true;
        if (s.phase === 'cashing') {
          await cashOut(this.env.DB, { userId: s.userId, tableId: this.tableId!, tableSessionId: s.tableSessionId, amount: s.stack });
          this.room.seats[i] = null;
          changed = true;
        }
      }
    }
    if (changed) await this.save();
  }

  private handHasPlayer(userId: string) {
    return !!this.hand && !this.hand.isSettled && this.hand.startingSeats.some((s) => s.playerId === userId);
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
      // Leaving mid-hand folds the hand (when it is still live) and stands up after settlement.
      seat.leaveAfterHand = true;
      seat.sittingOut = true;
      await this.save();
      if (this.hand!.actorId() === userId && !this.hand!.isStalled()) {
        await this.applyAction(userId, { type: 'fold' }, `leave-${reqId ?? crypto.randomUUID()}`);
      } else {
        this.broadcast();
      }
      return;
    }
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
    // Chips from a top-up whose outcome is unknown are counted first; one still waiting for a hand is simply
    // dropped, since nothing was taken for it.
    await this.resolveTopUp(seat);
    seat.topUp = null;
    seat.phase = 'cashing';
    await this.save();
    await cashOut(this.env.DB, { userId: seat.userId, tableId: this.tableId!, tableSessionId: seat.tableSessionId, amount: seat.stack });
    this.room.seats[i] = null;
    if (this.room.waitlist.length > 0 && !this.room.closing) {
      const head = this.room.waitlist[0]!;
      this.room.reservation = { userId: head.userId, nickname: head.nickname, seatIndex: i, until: Date.now() + RESERVATION_MS };
    }
    await this.save();
  }

  // ------------------------------------------------------------------ top-ups & automatic rebuy

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
    } else if ((await this.debitTopUp(seat, { key, amount })) === 'insufficient') {
      throw new CommandError('insufficient_balance', 'not enough chips in wallet');
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
   */
  private async debitTopUp(seat: SeatState, p: { key: string; amount: number; auto?: boolean }): Promise<'applied' | 'duplicate' | 'insufficient'> {
    if ((await committedTopUp(this.env.DB, p.key)) !== null) {
      seat.topUp = null;
      await this.save();
      return 'duplicate';
    }
    seat.topUp = { ...p, state: 'debiting' };
    await this.save();
    const r = await topUp(this.env.DB, { userId: seat.userId, tableId: this.tableId!, tableSessionId: seat.tableSessionId, amount: p.amount, key: p.key, memo: p.auto ? 'auto rebuy' : 'top-up' });
    seat.topUp = null;
    if (r === 'applied') this.addChips(seat, p.amount, p.auto);
    await this.save();
    return r;
  }

  private addChips(seat: SeatState, amount: number, auto?: boolean) {
    seat.stack += amount;
    seat.buyIn += amount;
    if (auto && seat.autoRebuy) seat.autoRebuy.spent += amount;
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

  /** Turns automatic rebuy on (only with the player's explicit consent, an amount and a total limit) or off. */
  private setAutoRebuy(userId: string, msg: Extract<ClientMessage, { t: 'autoRebuy' }>) {
    const t = this.table!;
    const seat = this.seatedSeat(userId);
    if (!msg.on) {
      seat.autoRebuy = null;
      return;
    }
    const { amount, cap } = msg;
    if (msg.consent !== true || !amount || !cap) throw new CommandError('bad_request', 'consent, an amount and a limit are required');
    if (amount < t.minBuyIn || amount > t.maxBuyIn) throw new CommandError('buyin_out_of_range', 'rebuy amount out of range');
    if (cap < amount || cap > amount * AUTO_REBUY_MAX_TIMES) throw new CommandError('bad_request', 'limit out of range');
    seat.autoRebuy = { amount, cap, spent: 0 };
  }

  /**
   * Between hands: apply the top-ups that waited for the hand to end, then rebuy busted players who turned automatic
   * rebuy on. Neither takes more than the player chose, and the stack stays within the buy-in range. `handId` is the
   * hand just finished (one rebuy per hand). A seat whose D1 write fails keeps its state for the next attempt.
   */
  private async applyTopUps(handId: string | null): Promise<Notice[]> {
    const t = this.table!;
    const notices: Notice[] = [];
    if (this.room.closing || t.status !== 'open') return notices;
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
            const r = await this.debitTopUp(s, { key: q.key, amount });
            if (r === 'applied') notices.push({ userId: s.userId, code: 'topup_applied', amount });
            else if (r === 'insufficient') notices.push({ userId: s.userId, code: 'topup_insufficient' });
          }
        }
        const auto = s.autoRebuy;
        if (auto && s.stack === 0 && !s.leaveAfterHand && handId) {
          const amount = Math.min(auto.amount, t.maxBuyIn);
          let stop: NoticeCode | null = null;
          // (Also when the table's range has since moved past the chosen amount.)
          if (amount < t.minBuyIn || auto.spent + amount > auto.cap) stop = 'rebuy_cap';
          else {
            const r = await this.debitTopUp(s, { key: `rebuy:${s.tableSessionId}:${handId}`, amount, auto: true });
            if (r === 'applied') notices.push({ userId: s.userId, code: 'rebuy_applied', amount });
            else if (r === 'insufficient') stop = 'rebuy_insufficient';
          }
          if (stop) {
            // Off for good: the busted player stands up as usual.
            s.autoRebuy = null;
            await this.save();
            notices.push({ userId: s.userId, code: stop });
          }
        }
      } catch (e) {
        console.error('top-up failed', (e as Error).message);
      }
    }
    return notices;
  }

  private notify(notices: Notice[]) {
    for (const n of notices) {
      for (const ws of this.sockets()) if (this.att(ws).userId === n.userId) this.send(ws, { t: 'notice', code: n.code, ...(n.amount ? { amount: n.amount } : {}) });
    }
  }

  private async action(ws: WebSocket, userId: string, msg: Extract<ClientMessage, { t: 'action' }>) {
    const h = this.hand;
    // Sent again because its answer was lost: it already counted, so only the answer is repeated.
    if (h && h.handId === msg.handId && h.hasApplied(msg.intentId)) return this.ack(ws, msg.intentId);
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
      // Players who left / sit out act instantly instead of burning the clock.
      const actor = h.actorId();
      const seat = actor ? this.room.seats[this.seatIndexOf(actor) ?? -1] : null;
      if (actor && seat && seat.leaveAfterHand) {
        const r = await h.act(actor, { type: 'fold' }, `leave-fold-${h.version}`, now);
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
    if (firstTime) {
      const stacks = h.finalStacks();
      for (const s of this.room.seats) if (s && stacks.has(s.userId)) s.stack = stacks.get(s.userId)!;
      this.room.settledHandId = h.handId;
      this.room.nextHandAt = now + BETWEEN_HANDS_MS;
      // The record is kept with the result until D1 has it, so a failed write (or a crash) is retried, never lost.
      const key = `${UNRECORDED_PREFIX}${String(this.room.handNumber).padStart(10, '0')}`;
      const entry: UnrecordedHand = { handNumber: this.room.handNumber, record: h.record(now), log: h.persist() };
      await this.save({ [key]: entry });
      this.unrecorded.add(key);
    }
    // Results stay visible until the next hand starts. They go out before the D1 write: the result is already saved
    // here, nothing shown depends on D1 having it, and commands sent on seeing it wait in `run` until settle is done.
    this.broadcast(cues);
    await this.retryUnrecorded();
    // Top-ups that waited for this hand and automatic rebuys happen before busted players stand up.
    const notices = await this.applyTopUps(h.handId);
    const left: TableCue[] = [];
    for (let i = 0; i < this.room.seats.length; i++) {
      const s = this.room.seats[i];
      if (!s || s.phase !== 'seated') continue;
      if (s.leaveAfterHand || s.stack === 0 || this.room.closing) {
        try {
          await this.standUp(i);
          left.push({ kind: 'leave', seatIndex: i });
        } catch (e) {
          // The seat stays 'cashing' and the alarm finishes the cash-out (its ledger key makes a repeat a no-op).
          console.error('cash-out failed; will retry', (e as Error).message);
        }
      }
    }
    if (left.length || notices.length) this.broadcast(left);
    this.notify(notices);
    if (this.room.closing) await this.continueCloseSafely();
    await this.schedule();
  }

  // ------------------------------------------------------------------ hands & timers

  private eligibleSeats(): number[] {
    const out: number[] = [];
    this.room.seats.forEach((s, i) => {
      if (s && s.phase === 'seated' && !s.sittingOut && !s.leaveAfterHand && s.stack > 0) out.push(i);
    });
    return out;
  }

  private async afterChange() {
    if (!this.hand && this.eligibleSeats().length >= 2 && !this.room.nextHandAt && !this.room.closing) {
      this.room.nextHandAt = Date.now() + FIRST_HAND_DELAY_MS;
      await this.save();
    }
    await this.schedule();
  }

  private async startHand() {
    const t = this.table!;
    // Normally done when the last hand settled; this catches anything a restart or a failed D1 call left behind.
    this.notify(await this.applyTopUps(this.room.settledHandId));
    const dealt = this.eligibleSeats();
    if (dealt.length < 2 || this.room.closing || t.status !== 'open') {
      this.room.nextHandAt = null;
      this.hand = null;
      await this.save();
      this.broadcast();
      return;
    }
    const button = nextButtonSeat(this.room.buttonSeat, dealt, t.maxSeats);
    this.room.buttonSeat = button;
    this.room.handNumber += 1;
    this.room.nextHandAt = null;
    const now = Date.now();
    this.hand = HandEngine.start({
      handId: `${t.id}:${this.room.handNumber}:${crypto.randomUUID().slice(0, 8)}`,
      rules: { maxSeats: t.maxSeats as MaxSeats, smallBlind: t.smallBlind, bigBlind: t.bigBlind, turnMs: t.turnSeconds * 1000 },
      seats: dealt.map((i) => ({ playerId: this.room.seats[i]!.userId, seatIndex: i, stack: this.room.seats[i]!.stack, displayName: this.room.seats[i]!.nickname })),
      buttonSeat: button,
      now,
    });
    await this.progress([{ kind: 'handStart', handNumber: this.room.handNumber }, { kind: 'deal' }]);
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
    }
    if (this.room.nextHandAt) times.push(this.room.nextHandAt);
    if (this.room.reservation) times.push(this.room.reservation.until);
    for (const s of this.room.seats) if (s?.sittingOut && s.sitOutSince) times.push(s.sitOutSince + SIT_OUT_STAND_UP_MS);
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
        console.error('alarm: load failed; will retry', (e as Error).message);
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
        return;
      }
      if (this.unfinishedWork()) await this.finishWorkSafely();
      const now = Date.now();
      // Turn timer.
      if (this.hand && !this.hand.isSettled) {
        const d = this.hand.deadline();
        const actor = this.hand.actorId();
        if (d && actor && d <= now) {
          const r = await this.hand.timeout(actor, now);
          if (r.ok) {
            const seat = this.room.seats[this.seatIndexOf(actor) ?? -1];
            if (seat) {
              seat.timeouts += 1;
              if (seat.timeouts >= TIMEOUTS_BEFORE_SIT_OUT && !seat.sittingOut) {
                seat.sittingOut = true;
                seat.sitOutSince = now;
              }
            }
            await this.progress(r.cues);
          }
        }
      }
      // Waitlist reservation expiry.
      if (this.room.reservation && this.room.reservation.until <= now) {
        const expired = this.room.reservation;
        this.room.waitlist = this.room.waitlist.filter((w) => w.userId !== expired.userId);
        this.room.reservation = null;
        await this.save();
        this.broadcast();
      }
      // Long sit-outs stand up.
      for (let i = 0; i < this.room.seats.length; i++) {
        const s = this.room.seats[i];
        if (s?.sittingOut && s.sitOutSince && s.sitOutSince + SIT_OUT_STAND_UP_MS <= now && s.phase === 'seated' && !this.handHasPlayer(s.userId)) {
          try {
            await this.standUp(i);
            this.broadcast([{ kind: 'leave', seatIndex: i }]);
          } catch (e) {
            // Left 'cashing' for the retry; the rest of the alarm (turn timers, the next hand) still runs.
            console.error('cash-out failed; will retry', (e as Error).message);
          }
        }
      }
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
      console.error('close unfinished; will retry', (e as Error).message);
    }
  }

  /** Work a failed D1 call left behind: a buy-in or cash-out cut short, a close, a finished hand not yet recorded. */
  private unfinishedWork(): boolean {
    if (this.unrecorded.size > 0) return true;
    if (this.room.closing && !this.room.closed && !(this.hand && !this.hand.isSettled)) return true;
    return this.room.seats.some((s) => s && (s.phase === 'pending' || (s.phase === 'cashing' && !this.handHasPlayer(s.userId))));
  }

  private async finishWorkSafely() {
    try {
      await this.recoverPendingSeats();
      await this.retryUnrecorded();
      if (this.room.closing && !this.room.closed) await this.continueClose();
      this.broadcast();
    } catch (e) {
      console.error('retry failed; will retry', (e as Error).message);
    }
  }

  /** Writes the finished hands D1 does not have yet, oldest first; each stays in storage until its write succeeds. */
  private async retryUnrecorded() {
    for (const key of [...this.unrecorded].sort()) {
      const u = await this.ctx.storage.get<UnrecordedHand>(key);
      try {
        if (u) await recordHand(this.env.DB, this.tableId!, u.handNumber, u.record, u.log);
      } catch (e) {
        console.error('recordHand failed; will retry', (e as Error).message);
        return;
      }
      await this.ctx.storage.delete(key);
      this.unrecorded.delete(key);
    }
  }

  private async finishCloseIfIdle() {
    if (this.room.seats.some((s) => s)) return;
    // D1 first: a room that counts itself closed retries nothing, so D1 must not be left saying 'closing'.
    await markTableClosed(this.env.DB, this.tableId!);
    this.room.closed = true;
    this.room.closedAt = Date.now();
    this.room.nextHandAt = null;
    this.hand = null;
    await this.save();
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

  private adminStatus() {
    const connected = this.connectedUsers();
    return {
      tableId: this.tableId,
      handNumber: this.room.handNumber,
      handInProgress: !!this.hand && !this.hand.isSettled,
      stage: this.hand?.stage ?? null,
      closing: this.room.closing,
      closed: this.room.closed,
      connections: this.sockets().length,
      chipsOnTable: this.room.seats.reduce((a, s) => a + (s ? (this.hand && !this.hand.isSettled ? (this.hand.finalStacks().get(s.userId) ?? s.stack) : s.stack) : 0), 0) + (this.hand && !this.hand.isSettled ? this.hand.handView().potTotal : 0),
      seats: this.room.seats.map((s, i) =>
        s ? { seatIndex: i, userId: s.userId, nickname: s.nickname, stack: s.stack, phase: s.phase, sittingOut: s.sittingOut, connected: connected.has(s.userId), buyIn: s.buyIn } : null,
      ),
      waitlist: this.room.waitlist.length,
    };
  }

  // ------------------------------------------------------------------ projection

  private view(a: Attachment, connected: Set<string>): TableView {
    const t = this.table!;
    const h = this.hand;
    const mySeat = this.seatIndexOf(a.userId);
    const isSeated = mySeat !== null;
    const showHand = isSeated || t.allowSpectators;
    const info = h && showHand ? h.seatInfo(isSeated ? a.userId : null) : null;
    const seats: SeatView[] = this.room.seats.map((s, i) => {
      if (!s) return { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, connected: false, hasCards: false };
      const hi = info?.get(i);
      let state: SeatView['state'] = s.sittingOut ? 'sittingOut' : 'waiting';
      if (hi?.inHand) state = hi.folded ? 'folded' : hi.allIn ? 'allin' : 'active';
      return {
        seatIndex: i,
        state,
        userId: s.userId,
        nickname: s.nickname,
        avatarUrl: s.avatarUrl,
        // Once the hand is settled the seat holds its final stack plus any top-up made since.
        stack: hi && !h!.isSettled ? hi.stack : s.stack,
        streetBet: hi?.streetBet ?? 0,
        connected: connected.has(s.userId),
        lastAction: hi?.lastAction ?? null,
        hasCards: !!hi?.inHand && !hi.folded,
        holeCards: hi?.holeCards ?? null,
      };
    });
    const hv = h && showHand ? { ...h.handView(), number: this.room.handNumber } : null;
    const myLegal = h && isSeated && !h.isSettled && h.actorId() === a.userId && !h.isStalled() ? h.legalOptions(a.userId) : [];
    const myPre = isSeated ? this.room.seats[mySeat]!.preAction : null;
    const res = this.room.reservation;
    const reservationLive = res && res.until > Date.now() ? res : null;
    const access = this.hasAccess(a);
    const canSit =
      !isSeated &&
      access &&
      t.status === 'open' &&
      !t.entryBlocked &&
      !this.room.closing &&
      this.openSeats() > 0 &&
      (!reservationLive || reservationLive.userId === a.userId) &&
      (this.room.waitlist.length === 0 || this.room.waitlist[0]!.userId === a.userId || this.openSeats() > this.room.waitlist.length);
    return {
      version: this.room.version,
      table: {
        id: t.id,
        name: t.name,
        maxSeats: t.maxSeats as MaxSeats,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
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
      spectatorCount: [...connected].filter((u) => this.seatIndexOf(u) === null).length,
      waitlist: this.room.waitlist.map((w) => w.nickname),
      reservation: reservationLive ? { nickname: reservationLive.nickname, until: reservationLive.until } : null,
      nextHandAt: this.room.nextHandAt,
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
        autoRebuy: isSeated ? (this.room.seats[mySeat]!.autoRebuy ?? null) : null,
        preAction: myPre && h && !h.isSettled && myPre.handId === h.handId && myPre.stage === h.stage ? myPre.kind : null,
      },
    };
  }
}

/** The move a pre-action makes given the legal options, or null when it no longer fits. Never a call, bet or raise. */
function preActionMove(legal: LegalOption[], kind: PreActionKind): 'check' | 'fold' | null {
  const can = (t: 'check' | 'fold') => legal.some((o) => o.type === t);
  // A fold is never made while checking is free.
  if (can('check')) return kind === 'fold' ? null : 'check';
  return kind !== 'check' && can('fold') ? 'fold' : null;
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
