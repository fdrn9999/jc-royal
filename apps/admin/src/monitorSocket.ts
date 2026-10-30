/**
 * The control center page's socket (GET /ws/admin/monitor, docs/CONTROL_CENTER.md): the console's own sign-in, never a
 * member's. It only tells the page that something changed; the page reads the list again whenever the socket (re)opens,
 * so an event lost while it was down costs nothing. One socket per page, closed when the page is left.
 *
 * Closes the hub sends: 4401 the sign-in ended (the console checks it and shows the sign-in page), 4000 a role or a duty
 * changed (connect again at once, and the api checks again), 4008 the administrator opened more pages than the hub
 * keeps (this one waits until it is used again).
 */
import { ADMIN_MONITOR_CLOSE, AdminMonitorEventSchema, type AdminMonitorEvent } from '@jc/types';
import { useEffect, useRef, useState } from 'react';
import { SeenEvents } from './monitor';

export type MonitorSocketStatus = 'off' | 'connecting' | 'open' | 'down' | 'parked';

/** A ping this often keeps an idle socket from being dropped by the network; no answer this soon after closes it. */
const PING_MS = 45_000;
const PONG_WAIT_MS = 10_000;
/** Waits before connecting again, from the first failure on (with jitter), as the member site's realtime client. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

export interface MonitorSocketOptions {
  /** false: no socket (an administrator the hub would refuse); default true. */
  enabled?: boolean;
  /** The tables open in the panel: their rooms' summaries come on the socket too (at most ADMIN_MONITOR_WATCH_MAX). */
  watch: string[];
  onEvent: (e: AdminMonitorEvent) => void;
  /** The socket opened (also after every reconnect): read the list again. `at`: the hub's clock. */
  onHello: (at: number) => void;
  /** The hub ended the socket for a sign-in or a duty: the console asks the api who is signed in. */
  onCheck: () => void;
}

export function useMonitorSocket(opts: MonitorSocketOptions) {
  const [status, setStatus] = useState<MonitorSocketStatus>('off');
  const lastAt = useRef<number | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const sendWatch = useRef<() => void>(() => undefined);
  const wakeNow = useRef<() => void>(() => undefined);
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let gen = 0;
    let ws: WebSocket | null = null;
    let opened = false;
    let attempt = 0;
    let stopped = false;
    let parked = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let pongWait: ReturnType<typeof setTimeout> | undefined;
    const seen = new SeenEvents();

    const quiet = () => {
      clearInterval(ping);
      clearTimeout(pongWait);
    };
    const later = (ms?: number) => {
      clearTimeout(retry);
      const base = ms ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      attempt += 1;
      retry = setTimeout(connect, Math.round(base * (0.5 + Math.random() / 2)));
    };
    function connect() {
      clearTimeout(retry);
      if (stopped) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setStatus('down');
        return;
      }
      const my = ++gen;
      parked = false;
      opened = false;
      setStatus('connecting');
      let s: WebSocket;
      try {
        s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/admin/monitor`);
      } catch {
        setStatus('down');
        later();
        return;
      }
      ws = s;
      s.onopen = () => {
        if (my !== gen) return;
        ping = setInterval(() => {
          if (s.readyState !== WebSocket.OPEN) return;
          s.send('{"t":"ping"}');
          clearTimeout(pongWait);
          pongWait = setTimeout(() => s.close(), PONG_WAIT_MS);
        }, PING_MS);
      };
      s.onmessage = (ev) => {
        if (my !== gen) return;
        lastAt.current = Date.now();
        clearTimeout(pongWait);
        let f: { t?: unknown; at?: unknown; e?: unknown };
        try {
          f = JSON.parse(String(ev.data)) as typeof f;
        } catch {
          return;
        }
        if (f.t === 'hello') {
          attempt = 0;
          opened = true;
          setStatus('open');
          sendWatch.current();
          latest.current.onHello(typeof f.at === 'number' ? f.at : Date.now());
        } else if (f.t === 'event') {
          const p = AdminMonitorEventSchema.safeParse(f.e);
          if (p.success && seen.add(p.data.eventId)) latest.current.onEvent(p.data);
        }
      };
      s.onclose = (ev) => {
        if (my !== gen) return;
        ws = null;
        opened = false;
        quiet();
        if (stopped) return;
        if (ev.code === ADMIN_MONITOR_CLOSE.tooMany) {
          parked = true;
          setStatus('parked');
          return;
        }
        setStatus('down');
        if (ev.code === ADMIN_MONITOR_CLOSE.signedOut) {
          latest.current.onCheck();
          later(BACKOFF_MS[BACKOFF_MS.length - 1]);
        } else if (ev.code === ADMIN_MONITOR_CLOSE.reauth) {
          latest.current.onCheck();
          later(1_000);
        } else later();
      };
    }

    sendWatch.current = () => {
      if (ws && opened && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'watch', tables: latest.current.watch }));
    };
    /** Back in view, back online or used again: a socket that is down (or gave way to another page) connects now. */
    const wake = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (ws || (!parked && retry === undefined)) return;
      attempt = 0;
      connect();
    };
    wakeNow.current = () => {
      if (stopped || ws) return;
      attempt = 0;
      connect();
    };
    const onPointer = () => {
      if (parked) wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pointerdown', onPointer, { passive: true });
    window.addEventListener('keydown', onPointer);
    connect();
    return () => {
      stopped = true;
      gen += 1;
      quiet();
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onPointer);
      ws?.close(1000);
      ws = null;
      sendWatch.current = () => undefined;
      wakeNow.current = () => undefined;
      setStatus('off');
    };
  }, [enabled]);

  const watchKey = opts.watch.join(',');
  useEffect(() => {
    sendWatch.current();
  }, [watchKey]);

  return {
    status,
    /** When the socket last said anything (an event, a hello or a pong). */
    lastMessageAt: () => lastAt.current,
    /** Connect now (after giving way to another page, or to skip a wait). */
    reconnect: () => wakeNow.current(),
  };
}
