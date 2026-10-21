/**
 * Friends' status on this device (the server decides it: apps/api/src/routes/presence.ts, the hub in the game worker).
 *
 * - While signed in, this page beats every PRESENCE_HEARTBEAT_MS with how long ago the member last did something here (a
 *   key, a click, a touch, the pointer, the page coming back). Activity itself sends nothing: only coming back after a
 *   quiet spell (the server may show away by then), the page being hidden or shown, or another view opening sends a beat
 *   sooner, never closer than a few seconds after the last one. After PRESENCE_IDLE_STOP_MS without activity it stops
 *   beating (the member shows offline from here) until the next activity.
 * - The page closing (or going into the back-forward cache) tells the server at once; otherwise the device expires.
 * - The account's own mode and what friends see come back with every beat, so a change made on another device shows here.
 * - Friends' status is asked for while a friends list or a conversation is on screen and the page is visible.
 * Everything here is the open account's: another account, or signing out, starts from nothing.
 */
import {
  PRESENCE_ACTIVITY_BEAT_MS,
  PRESENCE_AWAY_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_IDLE_STOP_MS,
  PRESENCE_POLL_MS,
  PRESENCE_RANK,
  type FriendsPresenceDto,
  type MyPresenceDto,
  type PresenceMode,
  type PresenceState,
} from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

/** The soonest a beat follows the last one for the page being hidden or shown, or a new view. */
const QUICK_BEAT_MS = 3_000;
/** The longest wait between beats after failures. */
const MAX_BACKOFF_MS = 5 * 60_000;

interface Run {
  uid: string;
  /** This page's device id (a reload is another device; the old one left as the page closed). */
  conn: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the planned beat goes. */
  at: number;
  lastSent: number;
  inFlight: boolean;
  /** No activity for PRESENCE_IDLE_STOP_MS: not beating until the next activity. */
  dormant: boolean;
  failures: number;
  off: () => void;
}

let run: Run | null = null;
let activeAt = Date.now();
let view: string | null = null;

const newConn = () => {
  const raw = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `p-${raw.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);
};

// ------------------------------------------------------------------ the member's own status

let mine: MyPresenceDto | null = null;
const mineListeners = new Set<() => void>();
function setMine(next: MyPresenceDto | null) {
  if (next && mine && next.mode === mine.mode && next.state === mine.state) return;
  mine = next;
  for (const l of mineListeners) l();
}

/** The account's mode and what friends see, once known (null before the first answer, and signed out). */
export function useMyPresence(): MyPresenceDto | null {
  return useSyncExternalStore(
    (cb) => {
      mineListeners.add(cb);
      return () => mineListeners.delete(cb);
    },
    () => mine,
  );
}

/** Reads the account's mode again (a settings screen opening). */
export async function loadMyPresence(): Promise<void> {
  const uid = run?.uid;
  const r = await api<MyPresenceDto>('/api/me/presence');
  if (run?.uid === uid) setMine(r);
}

/** Saves the account's mode (every device of the account follows it); throws when it was not saved. */
export async function choosePresenceMode(mode: PresenceMode): Promise<void> {
  const uid = run?.uid;
  const r = await api<MyPresenceDto>('/api/me/presence', { method: 'PUT', body: { mode } });
  if (run?.uid === uid) setMine(r);
}

// ------------------------------------------------------------------ beating

function plan(r: Run, delay: number) {
  if (r.timer) clearTimeout(r.timer);
  r.at = Date.now() + delay;
  r.timer = setTimeout(() => void beat(r), delay);
}

/** A beat soon: no sooner than `gap` after the last one, and never later than the one already planned. */
function kick(r: Run, gap: number) {
  if (run !== r) return;
  r.dormant = false;
  const wait = Math.max(0, r.lastSent + gap - Date.now());
  if (!r.timer || r.at > Date.now() + wait) plan(r, wait);
}

async function beat(r: Run) {
  r.timer = null;
  if (run !== r) return;
  if (r.inFlight) return plan(r, 1_000);
  const now = Date.now();
  const idleMs = now - activeAt;
  if (idleMs >= PRESENCE_IDLE_STOP_MS) {
    r.dormant = true;
    return;
  }
  r.inFlight = true;
  r.lastSent = now;
  try {
    const body = { conn: r.conn, idleMs: Math.max(0, Math.round(idleMs)), visible: document.visibilityState === 'visible', ...(view ? { view } : {}) };
    const res = await api<MyPresenceDto>('/api/me/presence/heartbeat', { body });
    if (run !== r) return;
    r.failures = 0;
    setMine(res);
    plan(r, PRESENCE_HEARTBEAT_MS);
  } catch (e) {
    if (run !== r) return;
    r.failures++;
    // Too many: a minute's pause. Signed out, suspended or unreachable: slower and slower, up to five minutes (the
    // sign-in checks elsewhere end this run when the account is gone).
    const wait = e instanceof ApiError && e.status === 429 ? 60_000 : Math.min(PRESENCE_HEARTBEAT_MS * 2 ** (r.failures - 1), MAX_BACKOFF_MS);
    plan(r, wait);
  } finally {
    r.inFlight = false;
  }
}

function leave(r: Run) {
  try {
    void fetch('/api/me/presence/leave', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conn: r.conn }),
    }).catch(() => {});
  } catch {
    /* the device expires on its own */
  }
}

/**
 * Starts beating for the signed-in account; the returned function stops it (signed out, another account). Stopping sends
 * nothing: a sign-out ends the server's record of this sign-in's devices itself.
 */
export function startPresence(uid: string): () => void {
  run?.off();
  activeAt = Date.now();
  const r: Run = { uid, conn: newConn(), timer: null, at: 0, lastSent: 0, inFlight: false, dormant: false, failures: 0, off: () => {} };
  const onActivity = () => {
    const before = activeAt;
    activeAt = Date.now();
    // Back after a quiet spell: friends may see away by now, so say so sooner than the next regular beat.
    if (r.dormant || activeAt - before >= PRESENCE_AWAY_MS) kick(r, PRESENCE_ACTIVITY_BEAT_MS);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') activeAt = Date.now();
    kick(r, QUICK_BEAT_MS);
  };
  const onHide = () => leave(r);
  const onShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    activeAt = Date.now();
    kick(r, 0);
  };
  const onOnline = () => kick(r, 0);
  const opts = { capture: true, passive: true } as const;
  const kinds = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const;
  for (const k of kinds) window.addEventListener(k, onActivity, opts);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('online', onOnline);
  r.off = () => {
    for (const k of kinds) window.removeEventListener(k, onActivity, opts);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('online', onOnline);
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
  };
  run = r;
  setMine(null);
  resetFriends();
  plan(r, 0);
  return () => {
    r.off();
    if (run === r) {
      run = null;
      setMine(null);
      resetFriends();
    }
  };
}

/**
 * What this page shows, for the server to skip a push of what the member is already looking at ("dm:<friend id>"); the
 * returned function clears it. A change is sent with a quick beat.
 */
export function setPresenceView(next: string): () => void {
  view = next;
  if (run) kick(run, QUICK_BEAT_MS);
  return () => {
    if (view !== next) return;
    view = null;
    if (run) kick(run, QUICK_BEAT_MS);
  };
}

// ------------------------------------------------------------------ friends' status

/**
 * Online friends first, then away, then offline; within each, the server's order (the latest conversation first). With
 * no status known, the server's order as it is.
 */
export function sortFriends<T extends { id: string }>(list: readonly T[], presence: Record<string, PresenceState> | null): readonly T[] {
  if (!presence) return list;
  const rank = (f: T) => PRESENCE_RANK[presence[f.id] ?? 'offline'];
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

/** Friends' status read longer ago than this is not shown as current (a hidden tab does not ask, nor a closed list). */
const FRIENDS_STALE_MS = PRESENCE_POLL_MS * 2.5;

let friends: Record<string, PresenceState> | null = null;
/** When friends shown offline were last online (the server's, to the minute), read with `friends` and gone with it. */
let lastOnlineOf: Record<string, number> | null = null;
let friendsAt = 0;
let friendsLoading = false;
let watchers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const friendListeners = new Set<() => void>();
function setFriends(next: Record<string, PresenceState> | null, lastOnline: Record<string, number> | null = null) {
  friends = next;
  lastOnlineOf = next ? lastOnline : null;
  for (const l of friendListeners) l();
}
function resetFriends() {
  friendsAt = 0;
  if (friends) setFriends(null);
}

async function pollFriends(force = false) {
  const r = run;
  if (!r || friendsLoading || document.visibilityState !== 'visible') return;
  if (!force && Date.now() - friendsAt < PRESENCE_POLL_MS / 3) return;
  // Back to a tab or a list after a while: what was read then goes while it is asked again, rather than show as current.
  if (friends && Date.now() - friendsAt > FRIENDS_STALE_MS) setFriends(null);
  friendsLoading = true;
  try {
    const res = await api<FriendsPresenceDto>('/api/friends/presence');
    if (run !== r) return;
    friendsAt = Date.now();
    setFriends(res.presence, res.lastOnline ?? {});
  } catch {
    // A status that could not be read again for a while is not shown as if it were current.
    if (run === r && friends && Date.now() - friendsAt > FRIENDS_STALE_MS) setFriends(null);
  } finally {
    friendsLoading = false;
  }
}

const onFriendsVisible = () => {
  if (document.visibilityState === 'visible') void pollFriends();
};

/** Friends' status as known now: null until known, and when it was not read for a while. */
export const friendsPresence = () => friends;
/** When friends shown offline were last online, as known now (null with friendsPresence; no key when not known). */
export const friendsLastOnline = () => lastOnlineOf;

/** Asks for friends' status while a screen shows it (useFriendsPresence); the returned function stops watching. */
export function watchFriendsPresence(): () => void {
  if (watchers++ === 0) {
    pollTimer = setInterval(() => void pollFriends(true), PRESENCE_POLL_MS);
    document.addEventListener('visibilitychange', onFriendsVisible);
  }
  void pollFriends();
  return () => {
    if (--watchers === 0) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      document.removeEventListener('visibilitychange', onFriendsVisible);
    }
  };
}

/**
 * Friends' status (accepted friends only) while the calling screen is on: null until known, and when it could not be
 * read for a while. `refreshKey` asks again when it changes (the friends list changed).
 */
export function useFriendsPresence(refreshKey?: unknown): Record<string, PresenceState> | null {
  useEffect(() => watchFriendsPresence(), []);
  useEffect(() => {
    if (refreshKey !== undefined) void pollFriends();
  }, [refreshKey]);
  return useSyncExternalStore(
    (cb) => {
      friendListeners.add(cb);
      return () => friendListeners.delete(cb);
    },
    friendsPresence,
  );
}

/** With useFriendsPresence on the same screen: when friends shown offline were last online (no key when not known). */
export function useFriendsLastOnline(): Record<string, number> | null {
  return useSyncExternalStore(
    (cb) => {
      friendListeners.add(cb);
      return () => friendListeners.delete(cb);
    },
    friendsLastOnline,
  );
}
