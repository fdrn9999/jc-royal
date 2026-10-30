import type { UnreadCountsDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { coalesced, onRealtime, onRealtimeResync, realtimeUp } from './realtime';
import { refreshService } from './service';

const NONE: UnreadCountsDto = { unread: 0, dmUnread: 0, friendRequests: 0 };

/** Unread counters (inbox, 1:1 messages, friend requests) shared by the header badges and the pages. */
let counts: UnreadCountsDto = NONE;
/** The account the counters are about; another account's are never shown, and their late answers are dropped. */
let owner: string | null = null;
let gen = 0;
/**
 * Reads in the order they were asked, and the last whose answer shows: an answer to a read asked before that one is
 * older than what shows, and changes nothing (it would put back counters from before, and a message the newer read
 * already told of would be news again).
 */
let asks = 0;
let showing = 0;
/** Whether `counts` were read for this account: until then a read is where the counters start, not something new. */
let known = false;
const subs = new Set<() => void>();

export type UnreadKind = 'unread' | 'dmUnread' | 'friendRequests';
const KINDS: UnreadKind[] = ['unread', 'dmUnread', 'friendRequests'];
/** The counters that went up from `prev` to `next` (something new arrived), in a fixed order. */
export const risen = (prev: UnreadCountsDto, next: UnreadCountsDto): UnreadKind[] => KINDS.filter((k) => next[k] > prev[k]);
const rises = new Set<(kinds: UnreadKind[], counts: UnreadCountsDto, dmFrom: readonly string[]) => void>();
/**
 * `f` hears of each counter going up for the account it counts for, with the counters now and whose 1:1 messages the
 * socket told of meanwhile (`dmFrom`: who a rise of `dmUnread` may be from; none when a poll alone found it) — the
 * arrival notice. The first read after signing in, loading the page or a sign-in that was gone is where they start, and
 * is never news.
 */
export function onUnreadRise(f: (kinds: UnreadKind[], counts: UnreadCountsDto, dmFrom: readonly string[]) => void): () => void {
  rises.add(f);
  return () => rises.delete(f);
}

/**
 * The other members of the conversations the socket told of a 1:1 message in (from them, or to them from another of
 * my devices), each until a read of the counters begun after it ends: that read holds the message, while one already
 * out may not.
 */
const heard = new Map<string, number>();
let heardTick = 0;
/** The socket told of a 1:1 message in the conversation with `peer`. */
export function heardDm(peer: string) {
  heard.set(peer, ++heardTick);
}

function set(next: UnreadCountsDto) {
  counts = next;
  subs.forEach((f) => f());
}

/** The counters are about `account` from now on: another account's go. */
function own(account: string) {
  if (account === owner) return;
  owner = account;
  gen++;
  known = false;
  heard.clear();
  set(NONE);
}

export async function refreshUnread() {
  const asked = gen;
  const ask = ++asks;
  const upTo = heardTick;
  try {
    const r = await api<UnreadCountsDto>('/api/messages/unread-count');
    if (r.serviceRev !== undefined) refreshService(r.serviceRev);
    // Asked for the account before this one (signed out and in as someone else meanwhile), or before a read whose
    // answer already shows.
    if (asked !== gen || ask < showing) return;
    showing = ask;
    const dmFrom = [...heard.keys()];
    for (const [peer, at] of heard) if (at <= upTo) heard.delete(peer);
    const news = known ? risen(counts, r) : [];
    known = true;
    if (r.unread === counts.unread && r.dmUnread === counts.dmUnread && r.friendRequests === counts.friendRequests) return;
    set(r);
    if (news.length) rises.forEach((f) => f(news, r, dmFrom));
  } catch (e) {
    // Signed out (here or on every device): nothing unread is shown for a sign-in that is gone. Offline: kept.
    if (asked === gen && ask > showing && e instanceof ApiError && e.status === 401) {
      showing = ask;
      known = false;
      heard.clear();
      if (counts !== NONE) set(NONE);
    }
  }
}

/** The counters as shown for `account`: none until they are this account's (not the account before's). */
export function unreadOf(account: string): UnreadCountsDto {
  return owner === account ? counts : NONE;
}

/** While the realtime socket is up, events keep the counters current: the poll asks only every this many ticks. */
const SLOW_TICKS = 4;

/**
 * Keeps the counters for the signed-in `account` until the returned function stops it: polls while the tab is visible,
 * and at once when it becomes visible again (a hidden tab does not poll). A message, friend or 1:1 event reads them at
 * once in a visible tab (a hidden one reads when it is shown), one announcement to many after its random wait, and the
 * poll slows down while those events arrive; a socket back after being down reads them once. A notice or maintenance
 * change has the banners read the service status after its random wait too.
 */
export function watchUnread(account: string, pollMs: number): () => void {
  own(account);
  const read = coalesced(refreshUnread);
  let ticks = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const shown = () => {
    if (document.visibilityState === 'visible') void read();
  };
  const tick = () => {
    if (document.visibilityState === 'visible' && (!realtimeUp() || ++ticks % SLOW_TICKS === 0)) void read();
  };
  const later = (ms: number, f: () => void) => {
    if (!ms) return f();
    const h = setTimeout(() => {
      timers.delete(h);
      f();
    }, Math.random() * ms);
    timers.add(h);
  };
  const spread = (ms: number) => later(ms, shown);
  // A notice or maintenance change: the banners read the status again unless they hold that revision (a hidden tab
  // reads it with the counters when it is shown).
  const service = (rev: number) => {
    if (document.visibilityState === 'visible') refreshService(rev);
  };
  void refreshUnread();
  const h = setInterval(tick, pollMs);
  document.addEventListener('visibilitychange', shown);
  const off = [
    onRealtime('message.changed', (e) => spread(e.payload?.spreadMs ?? 0)),
    onRealtime('inbox.broadcast', (e) => spread(e.payload.spreadMs)),
    onRealtime('service.changed', (e) => later(e.payload.spreadMs, () => service(e.payload.rev))),
    onRealtime('social.friend.changed', shown),
    onRealtime('social.dm.created', (e) => {
      heardDm(e.payload.peerId);
      shown();
    }),
    onRealtime('social.dm.read', shown),
    onRealtimeResync(shown),
  ];
  return () => {
    clearInterval(h);
    for (const t of timers) clearTimeout(t);
    document.removeEventListener('visibilitychange', shown);
    for (const f of off) f();
  };
}

/** The signed-in account's counters (watchUnread while on screen). */
export function useUnread(account: string, pollMs = 30_000): UnreadCountsDto {
  useEffect(() => watchUnread(account, pollMs), [account, pollMs]);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => unreadOf(account),
  );
}
