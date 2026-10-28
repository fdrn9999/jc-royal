import { useEffect, useRef, useSyncExternalStore } from 'react';
import { REALTIME_CLOSE, RealtimeEventSchema, type RealtimeEventOf, type RealtimeEventType, type RealtimeTopic } from '@jc/types';

/**
 * The page's one realtime socket (GET /ws/realtime, docs/REALTIME.md), shared by every screen of this tab and opened for
 * the signed-in member only (AuthProvider). An event only says that something changed: the screen showing it reads it
 * again through the API (once, however many events came), or applies the public counts the event carries. Nothing here
 * computes a balance or a state from an event. Screens keep polling while the socket is down, and more slowly while it
 * is up (`realtimeUp`), so a lost event costs at most one slow poll.
 */

export type RealtimeStatus = 'off' | 'connecting' | 'open' | 'down';

const PING_MS = 45_000;
const PONG_WAIT_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

type Handler = (e: never) => void;
const handlers = new Map<RealtimeEventType, Set<Handler>>();
const resyncs = new Set<() => void>();
const statusSubs = new Set<() => void>();
const topicCount = new Map<RealtimeTopic, number>();
/** Ids of events already handled: a hub may deliver one twice (two tabs never share these). */
const seen: string[] = [];
const seenSet = new Set<string>();

let account: string | null = null;
/** Bumped on every start and stop: callbacks of an earlier socket see a newer value and do nothing. */
let gen = 0;
let ws: WebSocket | null = null;
let status: RealtimeStatus = 'off';
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let ping: ReturnType<typeof setInterval> | undefined;
let pongWait: ReturnType<typeof setTimeout> | undefined;
/** Closed for too many pages: waits until this page is used again. */
let parked = false;
let onSignedOut: (() => void) | null = null;

const setStatus = (s: RealtimeStatus) => {
  if (status === s) return;
  status = s;
  for (const f of statusSubs) f();
};

const socketUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/realtime`;

function connect(g: number) {
  if (g !== gen || !account) return;
  clearTimeout(retry);
  setStatus('connecting');
  let s: WebSocket;
  try {
    s = new WebSocket(socketUrl());
  } catch {
    later(g);
    return;
  }
  ws = s;
  s.onmessage = (ev) => {
    if (g !== gen) return;
    clearTimeout(pongWait);
    let frame: { t?: string; e?: unknown };
    try {
      frame = JSON.parse(String(ev.data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.t === 'hello') {
      attempt = 0;
      setStatus('open');
      sendTopics();
      // The hub keeps nothing for a socket that was not there: what changed before this one opened (since the screens'
      // first read, or while a socket was down) arrives as no event. Screens read what they show once more.
      for (const f of [...resyncs]) f();
      return;
    }
    if (frame.t !== 'event') return;
    const parsed = RealtimeEventSchema.safeParse(frame.e);
    // An event this page does not know (a newer server) is left alone.
    if (!parsed.success) return;
    const e = parsed.data;
    if (seenSet.has(e.eventId)) return;
    seenSet.add(e.eventId);
    seen.push(e.eventId);
    if (seen.length > 300) seenSet.delete(seen.shift()!);
    for (const h of [...(handlers.get(e.type) ?? [])]) {
      try {
        (h as (e: unknown) => void)(e);
      } catch (err) {
        console.warn('realtime handler failed', e.type, err);
      }
    }
  };
  s.onclose = (ev) => {
    if (g !== gen) return;
    stopTimers();
    ws = null;
    setStatus('down');
    if (ev.code === REALTIME_CLOSE.signedOut) {
      // The sign-in ended (here or elsewhere): the account is read again, which signs this page out if so.
      onSignedOut?.();
      later(g, BACKOFF_MS[BACKOFF_MS.length - 1]);
    } else if (ev.code === REALTIME_CLOSE.tooMany) parked = true;
    else if (ev.code === REALTIME_CLOSE.reauth) later(g, Math.random() * 1_000);
    else later(g);
  };
  stopTimers();
  ping = setInterval(() => {
    if (g !== gen || s.readyState !== WebSocket.OPEN) return;
    s.send('{"t":"ping"}');
    clearTimeout(pongWait);
    pongWait = setTimeout(() => {
      if (g === gen) s.close();
    }, PONG_WAIT_MS);
  }, PING_MS);
}

function later(g: number, ms?: number) {
  if (g !== gen) return;
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  attempt++;
  clearTimeout(retry);
  retry = setTimeout(() => connect(g), ms ?? base * (0.5 + Math.random() / 2));
}

function stopTimers() {
  clearInterval(ping);
  clearTimeout(pongWait);
}

function sendTopics() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const topics = [...topicCount].filter(([, n]) => n > 0).map(([t]) => t);
  ws.send(JSON.stringify({ t: 'sub', topics }));
}

/** Back on the page, or back online: a socket that is down tries at once instead of waiting out its backoff. */
function wake() {
  if (!account || document.visibilityState !== 'visible') return;
  if (status === 'down' || parked) {
    parked = false;
    attempt = 0;
    connect(gen);
  }
}

/** Opens the socket for this member (AuthProvider, once signed in); another member's socket closes first. */
export function startRealtime(accountId: string, signedOut: () => void) {
  onSignedOut = signedOut;
  if (account === accountId && status !== 'off') return;
  stopRealtime();
  account = accountId;
  const g = ++gen;
  if (typeof WebSocket === 'undefined') return;
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  connect(g);
}

/** Closes it (signed out, or another member signed in): nothing of the previous member's arrives after. */
export function stopRealtime() {
  gen++;
  account = null;
  parked = false;
  attempt = 0;
  clearTimeout(retry);
  stopTimers();
  document.removeEventListener('visibilitychange', wake);
  window.removeEventListener('online', wake);
  const s = ws;
  ws = null;
  if (s) {
    s.onclose = null;
    s.onmessage = null;
    s.close(1000);
  }
  seen.length = 0;
  seenSet.clear();
  setStatus('off');
}

export function onRealtime<T extends RealtimeEventType>(type: T, h: (e: RealtimeEventOf<T>) => void): () => void {
  const set = handlers.get(type) ?? new Set<Handler>();
  handlers.set(type, set);
  set.add(h as Handler);
  return () => set.delete(h as Handler);
}

/** Called each time a socket opens, the first one too (what changed before it opened arrives as no event). */
export function onRealtimeResync(f: () => void): () => void {
  resyncs.add(f);
  return () => resyncs.delete(f);
}

/** Whether events arrive now: screens poll more slowly then. */
export const realtimeUp = () => status === 'open';

/** Asks for a public topic while the calling screen is shown. */
export function wantTopic(topic: RealtimeTopic): () => void {
  topicCount.set(topic, (topicCount.get(topic) ?? 0) + 1);
  sendTopics();
  return () => {
    topicCount.set(topic, Math.max(0, (topicCount.get(topic) ?? 1) - 1));
    sendTopics();
  };
}

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (f) => {
      statusSubs.add(f);
      return () => statusSubs.delete(f);
    },
    () => status,
    () => 'off',
  );
}

/** Runs `h` for each event of this type while the component is mounted (the latest `h`, without resubscribing). */
export function useRealtime<T extends RealtimeEventType>(type: T, h: (e: RealtimeEventOf<T>) => void, enabled = true) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => (enabled ? onRealtime(type, (e) => ref.current(e)) : undefined), [type, enabled]);
}

/**
 * One run at a time of `fn`; calls while it runs share one more run after it (the latest state), however many came.
 * For the reads events ask for: ten events in a burst cost two requests, not ten.
 */
export function coalesced(fn: () => Promise<unknown>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn().catch(() => {});
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return run;
}
