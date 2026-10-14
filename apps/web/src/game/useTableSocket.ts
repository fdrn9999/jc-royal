import type { ActionType, ChatMessage, ErrorCode, ServerMessage, TableCue, TableView } from '@jc/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'closed' | 'unauthorized';

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
  lastError: { code: ErrorCode; message: string; at: number } | null;
  request: (msg: { t: 'sit'; seatIndex: number; buyIn: number } | { t: 'leave' }) => Promise<void>;
  send: (msg: { t: 'sitOut' } | { t: 'sitIn' } | { t: 'waitlist'; join: boolean } | { t: 'chat'; text: string } | { t: 'sync' }) => void;
  act: (type: ActionType, amount?: number) => boolean;
  /** True while an action is in flight (until the next state arrives). */
  acting: boolean;
  /** Skip the backoff wait and reconnect now (no-op while connected). */
  reconnect: () => void;
}

export class RequestError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

const rid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 24);

/**
 * Connection to a table room. Server state is authoritative: the hook only
 * stores the latest TableView and queues the cues for animations/sounds.
 */
export function useTableSocket(tableId: string, code: string | null): TableSocketApi {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [state, setState] = useState<TableView | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [cues, setCues] = useState<CueEvent[]>([]);
  const [lastError, setLastError] = useState<TableSocketApi['lastError']>(null);
  const [acting, setActing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, { resolve: () => void; reject: (e: RequestError) => void }>());
  const stateRef = useRef<TableView | null>(null);
  const cueSeq = useRef(0);
  const stop = useRef(false);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    stop.current = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/tables/${encodeURIComponent(tableId)}${code ? `?code=${encodeURIComponent(code)}` : ''}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setStatus('open');
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'ping' })), 25_000);
      };
      ws.onmessage = (ev) => {
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
            stateRef.current = m.state;
            setState(m.state);
            setActing(false);
            if (m.cues.length) {
              const evs = m.cues.map((cue) => ({ id: ++cueSeq.current, cue, state: m.state }));
              setCues((q) => [...q, ...evs].slice(-60));
            }
            return;
          }
          case 'chatHistory':
            setChat(m.messages);
            return;
          case 'chat':
            setChat((c) => [...c, m.message].slice(-100));
            return;
          case 'ack': {
            pending.current.get(m.reqId)?.resolve();
            pending.current.delete(m.reqId);
            return;
          }
          case 'error': {
            setActing(false);
            if (m.reqId && pending.current.has(m.reqId)) {
              pending.current.get(m.reqId)!.reject(new RequestError(m.code, m.message));
              pending.current.delete(m.reqId);
            } else {
              setLastError({ code: m.code, message: m.message, at: Date.now() });
            }
            if (m.code === 'stale_version') ws.send(JSON.stringify({ t: 'sync' }));
            if (m.code === 'table_closed') {
              stop.current = true;
              setStatus('closed');
            }
            return;
          }
          case 'replaced':
            stop.current = true;
            setStatus('replaced');
            return;
          case 'pong':
            return;
        }
      };
      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return; // superseded by a manual reconnect
        clearInterval(ping);
        for (const p of pending.current.values()) p.reject(new RequestError('internal', 'connection closed'));
        pending.current.clear();
        setActing(false);
        if (stop.current || ev.code === 4001 || ev.code === 4002) return;
        if (!opened && attempt >= 2) {
          // Handshake keeps failing: most likely the session expired.
          void fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => {
            if (r.status === 401) {
              stop.current = true;
              setStatus('unauthorized');
            }
          });
        }
        setStatus('reconnecting');
        const delay = Math.min(10_000, 800 * 2 ** attempt++);
        timer = setTimeout(() => !stop.current && connect(), delay);
      };
    };
    kick.current = () => {
      const rs = wsRef.current?.readyState;
      if (stop.current || rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
      clearTimeout(timer);
      attempt = 0;
      connect();
    };
    connect();
    // Mobile browsers drop sockets in the background: resync, or reconnect at once on return.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: 'sync' }));
      else kick.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop.current = true;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
    };
  }, [tableId, code]);

  const raw = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const request = useCallback<TableSocketApi['request']>((msg) => {
    const reqId = rid();
    return new Promise<void>((resolve, reject) => {
      pending.current.set(reqId, { resolve, reject });
      if (!raw({ ...msg, reqId })) {
        pending.current.delete(reqId);
        reject(new RequestError('internal', 'not connected'));
      }
    });
  }, []);

  const send = useCallback<TableSocketApi['send']>((msg) => {
    raw(msg);
  }, []);

  const act = useCallback((type: ActionType, amount?: number) => {
    const s = stateRef.current;
    if (!s?.hand) return false;
    const ok = raw({ t: 'action', intentId: rid(), handId: s.hand.id, seq: s.hand.seq, type, amount });
    if (ok) setActing(true);
    return ok;
  }, []);

  const consumeCues = useCallback((upToId: number) => setCues((q) => q.filter((c) => c.id > upToId)), []);
  const reconnect = useCallback(() => kick.current(), []);

  return { status, state, chat, cues, consumeCues, lastError, request, send, act, acting, reconnect };
}
