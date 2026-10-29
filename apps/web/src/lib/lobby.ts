/**
 * Lobby helpers: what a table card offers, the list request that keeps only the newest answer, and the recently visited
 * tables (kept on this device per account; nothing about them is sent to the server). The favourite tables are the
 * account's now (prefs.ts); the ones kept here before are handed over once (takeLegacyFavourites).
 */
import type { LobbyLivePatch, LobbyTableDto, PublicLobbyTable, TableView } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * The main action a table card offers. The player's own seat comes first: whatever the table takes from newcomers
 * (full, closing, blocked, private, no spectators), they go back to it. Their place on its waitlist next: a look at it
 * (`waiting`), never a second sign-up, which would put them at the back. A full table offers the waitlist (never a
 * seat, and never a plain visit that would only look like watching); a table that takes no entries or is closing
 * offers nothing. Only a guide: the table room decides once the player is there.
 */
export type Entry = 'continue' | 'waiting' | 'join' | 'wait' | 'blocked' | 'closing';

export function entryOf(tb: Pick<LobbyTableDto, 'status' | 'entryBlocked' | 'seated' | 'maxSeats' | 'myParticipation'>): Entry {
  if (tb.myParticipation?.status === 'seated') return 'continue';
  if (tb.status !== 'open') return 'closing';
  if (tb.myParticipation?.status === 'waiting') return 'waiting';
  if (tb.entryBlocked) return 'blocked';
  return tb.seated >= tb.maxSeats ? 'wait' : 'join';
}

/**
 * Navigation state of a way back to the player's own seat (계속 플레이) or place on the waitlist (대기 현황 확인). The
 * table page says so when it turns out to be gone already (the lobby list is a few seconds old); it never makes a new
 * one from it.
 */
export const RESUME = { resume: 'seat' } as const;
export const RESUME_WAIT = { resume: 'wait' } as const;
export function resumeOf(state: unknown): 'seat' | 'wait' | null {
  const r = state && typeof state === 'object' ? (state as { resume?: unknown }).resume : null;
  return r === 'seat' || r === 'wait' ? r : null;
}

/**
 * What a player sent to a table to sit (?sit) or wait (?wait) finds there, when it is not a seat to take: read off the
 * room's view of them only, to say what next. The room still decides every command. null: nothing to say (a seat to
 * take, or the join code first). `free`: the table shows a free seat.
 */
export type Arrival = 'seated' | 'waiting' | 'closing' | 'maintenance' | 'full' | 'held' | 'unavailable';

export function arrivalOf(s: Pick<TableView, 'status' | 'maintenance' | 'reservation' | 'waitlist' | 'tournament' | 'you'>, free: boolean): Arrival | null {
  if (s.you.seatIndex !== null) return 'seated';
  if (s.you.inWaitlist) return 'waiting';
  if (s.you.needsCode) return null;
  if (s.status === 'closing' || s.status === 'closed') return 'closing';
  if (s.maintenance?.active) return 'maintenance';
  if (s.you.canSit && free) return null;
  if (!free) return 'full';
  return seatHeld(s, free) ? 'held' : 'unavailable';
}

/**
 * Going to the lobby from a table I sit at is not standing up: my seat, the hand and my turn's clock go on. The table
 * says so the first time on this device (or this visit, storage blocked), never again.
 */
const LOBBY_NOTE = 'jc.lobbyNote';
let lobbyNoteShown = false;
export function lobbyNoteSeen(): boolean {
  if (lobbyNoteShown) return true;
  try {
    return localStorage.getItem(LOBBY_NOTE) === '1';
  } catch {
    return false;
  }
}
export function markLobbyNote() {
  lobbyNoteShown = true;
  try {
    localStorage.setItem(LOBBY_NOTE, '1');
  } catch {
    /* this visit only */
  }
}

/** A free seat the room keeps for someone else: for the head of the waitlist, or for the players waiting. */
export function seatHeld(s: Pick<TableView, 'reservation' | 'waitlist' | 'tournament' | 'you'>, free: boolean): boolean {
  return free && !s.you.canSit && s.you.seatIndex === null && !s.tournament && (!!s.reservation || s.waitlist.length > 0);
}

export interface Latest {
  /** Starts a request unless one is out; `replace` drops the one out and starts afresh. Returns whether one started. */
  run(replace?: boolean): boolean;
  /** A request begun from now on: at once, or as soon as the one out is answered (its read may be older than this). */
  again(): void;
  /** Drops the request out, and every answer from now on. */
  stop(): void;
  /** Epoch ms when the last request started (0 before the first). */
  readonly startedAt: number;
}

/**
 * One request at a time for a polled resource, applying only the newest answer: a poll that comes due while a
 * request is out is skipped, a manual refresh replaces the request out (whose answer is dropped even if it still
 * arrives), `again` asks for one more after the request out, and nothing is applied after `stop`.
 */
export function latest<T>(load: (signal: AbortSignal) => Promise<T>, onData: (data: T) => void, onError: (e: unknown) => void, now = Date.now): Latest {
  let seq = 0;
  let out: AbortController | null = null;
  let stopped = false;
  let startedAt = 0;
  // Asked for while a request was out: one more starts once that one is answered.
  let queued = false;
  const run = (replace = false) => {
    if (stopped || (out && !replace)) return false;
    out?.abort();
    queued = false;
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
        if (out !== ctl) return;
        out = null;
        if (queued) run();
      });
    return true;
  };
  return {
    run,
    again() {
      if (out) queued = true;
      else run();
    },
    stop() {
      stopped = true;
      queued = false;
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
/** While the realtime socket brings each table's changes, the list is read again only this often, as a safety net. */
export const LIVE_POLL_MS = 60_000;

/**
 * When the lobby asks for the list again. A hidden page never does. `tick` runs every POLL_MS; `input` on the user's
 * pointer, keys or wheel; `wake` when the page becomes visible, gets focus or the connection returns. A lobby left open
 * with nobody at it slows down, and the first input afterwards brings the list up to date at once. While `live` (the
 * realtime socket is up and sends the lobby's changes) it asks only every LIVE_POLL_MS, and on coming back after
 * IDLE_POLL_MS; `up` when the socket comes (back) up reads it once more.
 */
export function lobbyPoller(f: Pick<Latest, 'run' | 'again' | 'startedAt'>, visible: () => boolean, now = Date.now, live: () => boolean = () => false) {
  let lastInput = now();
  return {
    tick() {
      const t = now();
      const every = live() ? LIVE_POLL_MS : t - lastInput >= IDLE_AFTER_MS ? IDLE_POLL_MS : POLL_MS;
      // Timers fire a little early or late; a second's slack keeps the tick from skipping every other turn.
      if (visible() && t - f.startedAt >= every - 1_000) f.run();
    },
    input() {
      const t = now();
      lastInput = t;
      if (visible() && t - f.startedAt >= (live() ? LIVE_POLL_MS : POLL_MS)) f.run();
    },
    wake() {
      const t = now();
      lastInput = t;
      // Coming back fires visibility and focus together: one request is enough.
      if (visible() && t - f.startedAt >= (live() ? IDLE_POLL_MS : 1_000)) f.run();
    },
    /**
     * Changes come over the socket from now on; one made before it had no event, so the list is read again: after the
     * request out, if any, whose read may be older than the subscription.
     */
    up() {
      f.again();
    },
  };
}

type Mine = NonNullable<LobbyTableDto['myParticipation']>;
const NO_PLACE: Mine = { status: 'none' };
/** As the API: a place on the waitlist only counts while the table is open. */
const placeAt = (status: LobbyTableDto['status'], mine: Mine | undefined): Mine | undefined => (status !== 'open' && mine?.status === 'waiting' ? NO_PLACE : mine);

/** A table's live counts from the realtime socket onto its card, when they are newer than the ones it shows. */
export function withCounts(t: LobbyTableDto, p: LobbyLivePatch): LobbyTableDto {
  if ((t.liveRev ?? 0) >= p.rev) return t;
  const { id: _, rev, ...counts } = p;
  return { ...t, ...counts, liveRev: rev, myParticipation: placeAt(p.status, t.myParticipation) };
}

/** Of two cards of one table, the newer settings (rev) and the newer counts (liveRev), each on its own. */
export function newerCard<T extends PublicLobbyTable>(t: T, card: PublicLobbyTable): T {
  const settings = (card.rev ?? 0) > (t.rev ?? 0) ? { ...t, ...card } : t;
  const { seated, bots, playing, waitlist, spectators, liveRev } = (card.liveRev ?? 0) > (t.liveRev ?? 0) ? card : t;
  return { ...settings, seated, bots, playing, waitlist, spectators, liveRev };
}

/**
 * A table's card from the realtime socket (or a fresh read of it) onto the one shown: the newer settings, the newer
 * counts, and the player's own place as the card had it (an event never carries anyone's). A table not shown yet is added.
 */
export function withCard(t: LobbyTableDto | undefined, card: PublicLobbyTable): LobbyTableDto {
  if (!t) return { ...card, myParticipation: NO_PLACE };
  const c = newerCard(t, card);
  return { ...c, myParticipation: placeAt(c.status, t.myParticipation) };
}

/** The lobby's order, as GET /api/tables sorts: official tables first, then by big blind, then by name. */
export function lobbyOrder(a: LobbyTableDto, b: LobbyTableDto): number {
  if (a.roomType !== b.roomType) return a.roomType > b.roomType ? -1 : 1;
  if (a.bigBlind !== b.bigBlind) return a.bigBlind - b.bigBlind;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * What the realtime socket told the lobby since its last list read: kept so that a list read that started before an
 * event, and arrives after it, never shows the older state (mergeList). Entries the list has caught up with go.
 */
export interface LobbyLive {
  patches: Map<string, LobbyLivePatch>;
  /** Cards from events (or a fresh read of one table) and when they came, on this page's clock. */
  cards: Map<string, { card: PublicLobbyTable; at: number }>;
  /** The player's own place from a fresh read of one table, and when that read started. */
  mine: Map<string, { p: Mine; at: number }>;
  /** Tables that closed: never shown again (a closed table does not reopen). */
  gone: Set<string>;
}
export const newLobbyLive = (): LobbyLive => ({ patches: new Map(), cards: new Map(), mine: new Map(), gone: new Set() });

/**
 * Keeps a table's card from an event or a fresh read: laid over the one already kept, so a read that started before an
 * event and answers after it never takes back the newer settings or counts the event brought.
 */
export function keepCard(live: LobbyLive, id: string, card: PublicLobbyTable, at: number) {
  const kept = live.cards.get(id);
  live.cards.set(id, kept ? { card: newerCard(kept.card, card), at: Math.max(kept.at, at) } : { card, at });
}

/**
 * A list read that started at `at` (this page's clock), with whatever newer the socket brought meanwhile. What the
 * read already has is forgotten. `fresh` (the read just arrived): so are counts for tables it does not list.
 */
export function mergeList(list: LobbyTableDto[], at: number, live: LobbyLive, fresh = false): LobbyTableDto[] {
  const rows = new Map(list.map((t) => [t.id, t]));
  // A table that opened after the read started is added; one the read should have had and did not has closed.
  for (const [id, c] of live.cards) if (!rows.has(id) && c.at <= at) live.cards.delete(id);
  const out: LobbyTableDto[] = [];
  for (const id of new Set([...rows.keys(), ...live.cards.keys()])) {
    if (live.gone.has(id)) continue;
    const row = rows.get(id);
    let t = row;
    const c = live.cards.get(id);
    if (c) {
      if (row && (row.rev ?? 0) >= (c.card.rev ?? 0) && (row.liveRev ?? 0) >= (c.card.liveRev ?? 0)) live.cards.delete(id);
      else t = withCard(t, c.card);
    }
    if (!t) continue;
    const p = live.patches.get(id);
    if (p) {
      if (row && (row.liveRev ?? 0) >= p.rev) live.patches.delete(id);
      else t = withCounts(t, p);
    }
    const m = live.mine.get(id);
    if (m) {
      if (m.at <= at) live.mine.delete(id);
      else t = { ...t, myParticipation: placeAt(t.status, m.p) };
    }
    out.push(t);
  }
  if (fresh) for (const id of live.patches.keys()) if (!rows.has(id) && !live.cards.has(id)) live.patches.delete(id);
  return out.sort(lobbyOrder);
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
