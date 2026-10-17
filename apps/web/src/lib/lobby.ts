/**
 * Lobby helpers: what a table card offers, the list request that keeps only the newest answer, and the recently visited
 * tables (kept on this device per account; nothing about them is sent to the server). The favourite tables are the
 * account's now (prefs.ts); the ones kept here before are handed over once (takeLegacyFavourites).
 */
import type { LobbyTableDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * The main action a table card offers. A full table offers the waitlist (never a seat, and never a plain visit that
 * would only look like watching); a table that takes no entries or is closing offers nothing.
 */
export type Entry = 'join' | 'wait' | 'blocked' | 'closing';

export function entryOf(tb: Pick<LobbyTableDto, 'status' | 'entryBlocked' | 'seated' | 'maxSeats'>): Entry {
  if (tb.status !== 'open') return 'closing';
  if (tb.entryBlocked) return 'blocked';
  return tb.seated >= tb.maxSeats ? 'wait' : 'join';
}

export interface Latest {
  /** Starts a request unless one is out; `replace` drops the one out and starts afresh. Returns whether one started. */
  run(replace?: boolean): boolean;
  /** Drops the request out, and every answer from now on. */
  stop(): void;
  /** Epoch ms when the last request started (0 before the first). */
  readonly startedAt: number;
}

/**
 * One request at a time for a polled resource, applying only the newest answer: a poll that comes due while a
 * request is out is skipped, a manual refresh replaces the request out (whose answer is dropped even if it still
 * arrives), and nothing is applied after `stop`.
 */
export function latest<T>(load: (signal: AbortSignal) => Promise<T>, onData: (data: T) => void, onError: (e: unknown) => void, now = Date.now): Latest {
  let seq = 0;
  let out: AbortController | null = null;
  let stopped = false;
  let startedAt = 0;
  return {
    run(replace = false) {
      if (stopped || (out && !replace)) return false;
      out?.abort();
      const ctl = new AbortController();
      out = ctl;
      const id = ++seq;
      startedAt = now();
      load(ctl.signal)
        .then(
          (data) => {
            if (id === seq && !stopped) onData(data);
          },
          (e: unknown) => {
            if (id === seq && !stopped && !ctl.signal.aborted) onError(e);
          },
        )
        .finally(() => {
          if (out === ctl) out = null;
        });
      return true;
    },
    stop() {
      stopped = true;
      out?.abort();
      out = null;
    },
    get startedAt() {
      return startedAt;
    },
  };
}

/** A visible lobby refreshes the list every POLL_MS while it is used, and every IDLE_POLL_MS once nobody has touched it for IDLE_AFTER_MS. */
export const POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;
export const IDLE_AFTER_MS = 60_000;

/**
 * When the lobby asks for the list again. A hidden page never does. `tick` runs every POLL_MS; `input` on the user's
 * pointer, keys or wheel; `wake` when the page becomes visible, gets focus or the connection returns. A lobby left open
 * with nobody at it slows down, and the first input afterwards brings the list up to date at once.
 */
export function lobbyPoller(f: Pick<Latest, 'run' | 'startedAt'>, visible: () => boolean, now = Date.now) {
  let lastInput = now();
  return {
    tick() {
      const t = now();
      const every = t - lastInput >= IDLE_AFTER_MS ? IDLE_POLL_MS : POLL_MS;
      // Timers fire a little early or late; a second's slack keeps the tick from skipping every other turn.
      if (visible() && t - f.startedAt >= every - 1_000) f.run();
    },
    input() {
      const t = now();
      lastInput = t;
      if (visible() && t - f.startedAt >= POLL_MS) f.run();
    },
    wake() {
      const t = now();
      lastInput = t;
      // Coming back fires visibility and focus together: one request is enough.
      if (visible() && t - f.startedAt >= 1_000) f.run();
    },
  };
}

export interface TablePrefs {
  /** Favourite table ids, newest first. */
  fav: string[];
  /** Tables I opened, most recent first. */
  recent: { id: string; at: number }[];
}
export const RECENT_MAX = 8;
export const FAV_MAX = 50;
const EMPTY: TablePrefs = { fav: [], recent: [] };

export function withVisit(p: TablePrefs, id: string, at: number): TablePrefs {
  return { ...p, recent: [{ id, at }, ...p.recent.filter((r) => r.id !== id)].slice(0, RECENT_MAX) };
}

export function withFav(p: TablePrefs, id: string, on: boolean): TablePrefs {
  const rest = p.fav.filter((x) => x !== id);
  return { ...p, fav: on ? [id, ...rest].slice(0, FAV_MAX) : rest };
}

/** Whatever is stored, as valid prefs (anything unreadable counts as none). */
export function parsePrefs(raw: string | null): TablePrefs {
  try {
    const v = JSON.parse(raw ?? 'null') as { fav?: unknown; recent?: unknown } | null;
    if (!v || typeof v !== 'object') return EMPTY;
    const fav = Array.isArray(v.fav) ? v.fav.filter((x): x is string => typeof x === 'string').slice(0, FAV_MAX) : [];
    const recent = Array.isArray(v.recent)
      ? v.recent.filter((r): r is { id: string; at: number } => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' && typeof (r as { at?: unknown }).at === 'number').slice(0, RECENT_MAX)
      : [];
    return { fav, recent: recent.map(({ id, at }) => ({ id, at })) };
  } catch {
    return EMPTY;
  }
}

const key = (me: string) => `jc.tables:${me}`;
const subs = new Set<() => void>();
let cache: { me: string; prefs: TablePrefs } | null = null;

function read(me: string): TablePrefs {
  if (cache?.me === me) return cache.prefs;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key(me));
  } catch {
    /* storage blocked: nothing saved */
  }
  cache = { me, prefs: parsePrefs(raw) };
  return cache.prefs;
}

function update(me: string, change: (p: TablePrefs) => TablePrefs) {
  const prefs = change(read(me));
  cache = { me, prefs };
  try {
    localStorage.setItem(key(me), JSON.stringify(prefs));
  } catch {
    /* kept for this session only */
  }
  subs.forEach((f) => f());
}

export const rememberVisit = (me: string, id: string) => update(me, (p) => withVisit(p, id, Date.now()));

/** The favourite tables this device kept for the account before they were the account's: handed over once, then dropped here. */
export function takeLegacyFavourites(me: string): string[] {
  const { fav } = read(me);
  if (fav.length) update(me, (p) => ({ ...p, fav: [] }));
  return fav;
}

export function useTablePrefs(me: string | undefined): TablePrefs {
  // Another tab changed them: read again.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (me && e.key === key(me)) {
        cache = null;
        subs.forEach((f) => f());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [me]);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => (me ? read(me) : EMPTY),
  );
}
