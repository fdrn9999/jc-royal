import type { ActionType, AutoBuyRequest, ChatMessage, ClientMessage, ErrorCode, NoticeCode, PreActionKind, ReactionId, ServerMessage, TableCue, TableView } from '@jc/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepSeats } from './keepSeats';
import { Heartbeat, Outbox, type Outgoing } from './link';
import { preActionSpot } from './preAction';
import { REACTION_SHOW_MS, type SeatReaction } from './Reactions';

/** `locked`: a private table that needs the join code first (the room closed the socket with 4003). */
export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'closed' | 'unauthorized' | 'locked' | 'kicked';

export interface CueEvent {
  id: number;
  cue: TableCue;
  /** Snapshot the cue belongs to (positions are resolved against it). */
  state: TableView;
}

export interface TableSocketApi {
  status: ConnStatus;
  state: TableView | null;
  chat: ChatMessage[];
  cues: CueEvent[];
  consumeCues: (upToId: number) => void;
  /** Quick reactions showing now: the latest per seat, each for REACTION_SHOW_MS. */
  reactions: SeatReaction[];
  lastError: { code: ErrorCode; message: string; at: number } | null;
  /** Latest top-up / automatic rebuy or top-up outcome the room reported to this player. */
  lastNotice: { code: NoticeCode; amount?: number; at: number } | null;
  /**
   * Sends a command and resolves on its ack. A connection lost on the way is replaced and the command sent again with
   * the same id, which the server applies once. Rejects with `internal` when there is no connection, or no answer
   * within the deadline: pass the same `reqId` to retry such a request.
   */
  request: (
    msg:
      | { t: 'sit'; seatIndex: number; buyIn: number; autoBuy?: AutoBuyRequest }
      | { t: 'leave' }
      | { t: 'topUp'; amount: number }
      | { t: 'autoRebuy'; on: boolean; amount?: number; cap?: number; consent?: true }
      | { t: 'autoBuy'; policy: AutoBuyRequest }
      | { t: 'timeBank'; handId: string; seq: number; seen: number },
    reqId?: string,
  ) => Promise<void>;
  /**
   * Like request, without a result: a refusal shows in `lastError`. A reaction goes once, as is: one that missed its
   * moment is not worth sending again after a reconnect.
   */
  send: (
    msg:
      | { t: 'sitOut' }
      | { t: 'sitIn' }
      | { t: 'waitlist'; join: boolean }
      | { t: 'chat'; text: string }
      | { t: 'sync' }
      | { t: 'cancelTopUp' }
      // Only to a room from an older game worker (olderRooms.ts); current rooms acknowledge it and change nothing.
      | { t: 'muck'; on: boolean }
      // One card at a time, which every room understands ("both" goes as two).
      | { t: 'show'; card: 0 | 1 }
      | { t: 'react'; reaction: ReactionId },
  ) => void;
  act: (type: ActionType, amount?: number) => boolean;
  /**
   * Chooses (or with null clears) a pre-action for this street, against the hand, street and amount to call shown now.
   * The room keeps it only if those still hold when it arrives; `you.preAction` in the next state says what it kept.
   */
  preAct: (kind: PreActionKind | null) => void;
  /** True while an action is in flight (until the next state arrives). */
  acting: boolean;
  /** Skip the backoff wait and reconnect now (no-op while connected). */
  reconnect: () => void;
  /** Open a fresh connection even while connected: after a join code ticket, which only a new connection carries. */
  reopen: () => void;
}

export class RequestError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export const rid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 24);

/** What the hook keeps with a command until its answer. */
interface Waiting {
  /** request()'s promise. */
  resolve?: () => void;
  reject?: (e: RequestError) => void;
  /** An action: the hand and seq it was taken on. */
  turn?: string;
}

/** Refusals of a command sent again that only mean its first copy did the work, or its moment passed. */
const RESENT_OK = new Set<ErrorCode>(['stale_version', 'conflict', 'duplicate', 'not_your_turn']);
/** Exactly the text the room answers without waking up (its WebSocket auto-response). */
const PING = '{"t":"ping"}';
const SYNC = '{"t":"sync"}';
const TICK_MS = 2_000;

/**
 * Connection to a table room. Server state is authoritative: the hook only
 * stores the latest TableView and queues the cues for animations/sounds.
 */
export function useTableSocket(tableId: string): TableSocketApi {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [state, setState] = useState<TableView | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [cues, setCues] = useState<CueEvent[]>([]);
  const [reactions, setReactions] = useState<SeatReaction[]>([]);
  const reactionSeq = useRef(0);
  const [lastError, setLastError] = useState<TableSocketApi['lastError']>(null);
  const [lastNotice, setLastNotice] = useState<TableSocketApi['lastNotice']>(null);
  const [acting, setActing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  /** Commands waiting for their answer (see link.ts). */
  const [box] = useState(() => new Outbox<ClientMessage, Waiting>());
  const [beat] = useState(() => new Heartbeat());
  const stateRef = useRef<TableView | null>(null);
  /** Hand and seq of the action in flight: one action per betting turn until the server answers. */
  const sentFor = useRef<string | null>(null);
  const cueSeq = useRef(0);
  /** The last cue the table has played (consumeCues). */
  const played = useRef(0);
  const stop = useRef(false);
  const kick = useRef<() => void>(() => {});
  const fresh = useRef<() => void>(() => {});

  useEffect(() => {
    stop.current = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Gives up on the current connection without waiting for the browser to notice it is gone. */
    let drop = () => {};

    /** The connection ended for good: nothing waiting will be answered. */
    const failAll = () => {
      for (const o of box.drain()) o.h.reject?.(new RequestError('internal', 'connection closed'));
      sentFor.current = null;
      setActing(false);
    };

    /**
     * The last view goes, and its cues with it: played ones stay queued until the next batch, and the table drawn for a
     * later view (reopened with a join code) starts counting cues from none, so it would play them again.
     */
    const dropView = () => {
      stateRef.current = null;
      setState(null);
      setCues([]);
    };

    /** No answer in time: a request fails; anything else gives up quietly (the caller then fetches the state). */
    const expire = (o: Outgoing<ClientMessage, Waiting>) => {
      o.h.reject?.(new RequestError('internal', 'no answer'));
      if (o.h.turn && sentFor.current === o.h.turn) {
        sentFor.current = null;
        setActing(false);
      }
    };

    /** `retry`: the previous connection was lost; the room counts these for the admin dashboard (`?r=1`). */
    const connect = (retry = false) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // A private table's join code is never in this URL: the api checks the ticket cookie set by /access.
      const url = `${proto}://${location.host}/ws/tables/${encodeURIComponent(tableId)}${retry ? '?r=1' : ''}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setStatus('open');
        const now = Date.now();
        beat.reset(now);
        // Commands the last connection lost the answers to, with the ids they had: the room applies each once.
        for (const o of box.resend(now)) ws.send(JSON.stringify(o.msg));
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return; // superseded by reopen
        beat.received(Date.now());
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (m.t) {
          case 'state': {
            const prev = stateRef.current;
            // Ignore out-of-order snapshots (version is monotonic per room).
            if (prev && m.state.version < prev.version) return;
            const view = keepSeats(prev, m.state);
            stateRef.current = view;
            setState(view);
            setActing(false);
            // An action whose turn has passed was applied or overtaken: either way nothing is waiting for it.
            const turn = m.state.hand ? `${m.state.hand.id}:${m.state.hand.seq}` : null;
            for (const o of box.values()) if (o.h.turn && o.h.turn !== turn) box.take(o.id);
            // A state of the version already shown carries cues already played (a settled hand sent again): the table
            // takes the state, the cues are not played twice.
            if (m.cues.length && !(prev && m.state.version <= prev.version)) {
              const evs = m.cues.map((cue) => ({ id: ++cueSeq.current, cue, state: view }));
              setCues((q) => [...q.filter((c) => c.id > played.current), ...evs].slice(-60));
            }
            return;
          }
          case 'chatHistory':
            setChat(m.messages);
            return;
          case 'chat':
            setChat((c) => [...c, m.message].slice(-100));
            return;
          case 'react': {
            // A page in the background would only queue them up to play all at once on return.
            if (document.hidden) return;
            const r: SeatReaction = { id: ++reactionSeq.current, seatIndex: m.seatIndex, userId: m.userId, reaction: m.reaction };
            setReactions((q) => [...q.filter((x) => x.seatIndex !== r.seatIndex), r]);
            setTimeout(() => setReactions((q) => q.filter((x) => x.id !== r.id)), REACTION_SHOW_MS);
            return;
          }
          case 'ack':
            box.take(m.reqId)?.h.resolve?.();
            return;
          case 'error': {
            sentFor.current = null;
            setActing(false);
            if (!m.reqId && (m.code === 'suspended' || m.code === 'disconnected')) {
              // An admin ended this connection (the close, 4004, follows): the page says so instead of a toast, and
              // the last view goes (it showed my turn and its buttons, which the room no longer takes).
              stop.current = true;
              dropView();
              setStatus('kicked');
              return;
            }
            const o = m.reqId ? box.take(m.reqId) : undefined;
            if (o?.h.reject) o.h.reject(new RequestError(m.code, m.message));
            else if (!(o && o.sends > 1 && RESENT_OK.has(m.code)) && m.code !== 'join_code_required') {
              // (For a missing join code the page asks for it instead: `locked` or `you.needsCode`.)
              setLastError({ code: m.code, message: m.message, at: Date.now() });
            }
            if (m.code === 'stale_version') ws.send(SYNC);
            if (m.code === 'table_closed') {
              stop.current = true;
              setStatus('closed');
            }
            return;
          }
          case 'notice':
            setLastNotice({ code: m.code, amount: m.amount, at: Date.now() });
            return;
          case 'replaced':
            stop.current = true;
            setStatus('replaced');
            return;
          case 'pong':
            return;
        }
      };
      const closed = (code: number) => {
        box.detach();
        if (code === 4003) {
          // Private table without a valid join code: wait for the code rather than retrying. What was shown before
          // (the code may have changed while connected) is dropped.
          failAll();
          stop.current = true;
          dropView();
          setChat([]);
          setStatus('locked');
          return;
        }
        if (code === 4004) {
          // Ended by an admin: no retry. Signing in again is checked anew (a suspended account cannot).
          failAll();
          stop.current = true;
          dropView();
          setStatus('kicked');
          return;
        }
        if (stop.current || code === 4001 || code === 4002) {
          failAll();
          return;
        }
        // Commands still waiting go out again on the next connection.
        if (!opened && attempt >= 2) {
          // Handshake keeps failing: most likely the session expired.
          void fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => {
            if (r.status === 401) {
              stop.current = true;
              failAll();
              setStatus('unauthorized');
            }
          });
        }
        setStatus('reconnecting');
        // Spread a quarter either way: when a room restarts (a deploy), everyone at it would otherwise call back at the
        // same instants. The same waits on average.
        const delay = Math.min(10_000, 800 * 2 ** attempt++ * (0.75 + Math.random() * 0.5));
        timer = setTimeout(() => !stop.current && connect(true), delay);
      };
      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return; // superseded by a manual reconnect
        closed(ev.code);
      };
      drop = () => {
        if (wsRef.current !== ws) return;
        // A dead link can take a minute or more to report its close: stop listening and start over now.
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
        closed(1006);
      };
    };
    kick.current = () => {
      const rs = wsRef.current?.readyState;
      if (stop.current || rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
      clearTimeout(timer);
      attempt = 0;
      connect(true);
    };
    fresh.current = () => {
      clearTimeout(timer);
      failAll();
      stop.current = false;
      attempt = 0;
      const old = wsRef.current;
      // Detach first: the old socket's late messages (a `replaced`) and close are ignored.
      wsRef.current = null;
      old?.close();
      setStatus('connecting');
      connect();
    };
    connect();
    const tick = setInterval(() => {
      const now = Date.now();
      const { late, expired } = box.sweep(now);
      for (const o of expired) expire(o);
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (expired.length) ws.send(SYNC);
      // An answer is late: find out whether the connection still carries anything at all.
      if (late && beat.check(now)) ws.send(PING);
      const b = beat.tick(now);
      if (b === 'ping') ws.send(PING);
      else if (b === 'dead') drop();
    }, TICK_MS);
    // Mobile browsers drop sockets in the background: resync, or reconnect at once on return.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        // The socket may have died while the page slept; the answer to the sync shows it did not.
        beat.check(Date.now());
        ws.send(SYNC);
      } else kick.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop.current = true;
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      failAll();
      wsRef.current?.close();
    };
  }, [tableId, box, beat]);

  const raw = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const request = useCallback<TableSocketApi['request']>(
    (msg, reqId = rid()) => {
      return new Promise<void>((resolve, reject) => {
        const full = { ...msg, reqId } as ClientMessage;
        if (!raw(full)) return reject(new RequestError('internal', 'not connected'));
        box.add(reqId, full, { resolve, reject }, Date.now());
      });
    },
    [box],
  );

  const send = useCallback<TableSocketApi['send']>(
    (msg) => {
      if (msg.t === 'sync' || msg.t === 'react') {
        raw(msg);
        return;
      }
      const reqId = rid();
      const full = { ...msg, reqId } as ClientMessage;
      if (raw(full)) box.add(reqId, full, {}, Date.now());
    },
    [box],
  );

  const act = useCallback(
    (type: ActionType, amount?: number) => {
      const s = stateRef.current;
      if (!s?.hand) return false;
      // A second press (or key) before the server answers carries the same seq and would only come back as an error toast.
      const turn = `${s.hand.id}:${s.hand.seq}`;
      if (sentFor.current === turn) return false;
      const msg: ClientMessage = { t: 'action', intentId: rid(), handId: s.hand.id, seq: s.hand.seq, type, amount };
      const ok = raw(msg);
      if (ok) {
        box.add(msg.intentId, msg, { turn }, Date.now());
        sentFor.current = turn;
        setActing(true);
      }
      return ok;
    },
    [box],
  );

  const preAct = useCallback(
    (kind: PreActionKind | null) => {
      const s = stateRef.current;
      const spot = s && preActionSpot(s);
      if (!spot) return;
      const reqId = rid();
      const msg: ClientMessage = { t: 'preAction', reqId, handId: spot.handId, stage: spot.stage, toCall: spot.toCall, kind };
      if (raw(msg)) box.add(reqId, msg, {}, Date.now());
    },
    [box],
  );

  // The table keeps track of the cues it has played (CueLayer); they leave the queue with the next batch. Taken out at
  // once, they drew the whole page a second time before the frame that brought them was painted (TEST_REPORT).
  const consumeCues = useCallback((upToId: number) => {
    played.current = Math.max(played.current, upToId);
  }, []);
  const reconnect = useCallback(() => kick.current(), []);
  const reopen = useCallback(() => fresh.current(), []);

  return { status, state, chat, cues, consumeCues, reactions, lastError, lastNotice, request, send, act, preAct, acting, reconnect, reopen };
}
