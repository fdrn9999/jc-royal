import type { UnreadCountsDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { refreshService } from './service';

const NONE: UnreadCountsDto = { unread: 0, dmUnread: 0, friendRequests: 0 };

/** Unread counters (inbox, 1:1 messages, friend requests) shared by the header badges and the pages. */
let counts: UnreadCountsDto = NONE;
/** The account the counters are about; another account's are never shown, and their late answers are dropped. */
let owner: string | null = null;
let gen = 0;
const subs = new Set<() => void>();

function set(next: UnreadCountsDto) {
  counts = next;
  subs.forEach((f) => f());
}

/** The counters are about `account` from now on: another account's go. */
function own(account: string) {
  if (account === owner) return;
  owner = account;
  gen++;
  set(NONE);
}

export async function refreshUnread() {
  const asked = gen;
  try {
    const r = await api<UnreadCountsDto>('/api/messages/unread-count');
    if (r.serviceRev !== undefined) refreshService(r.serviceRev);
    // Asked for the account before this one (signed out and in as someone else meanwhile).
    if (asked !== gen) return;
    if (r.unread === counts.unread && r.dmUnread === counts.dmUnread && r.friendRequests === counts.friendRequests) return;
    set(r);
  } catch (e) {
    // Signed out (here or on every device): nothing unread is shown for a sign-in that is gone. Offline: kept.
    if (asked === gen && e instanceof ApiError && e.status === 401 && counts !== NONE) set(NONE);
  }
}

/** The counters as shown for `account`: none until they are this account's (not the account before's). */
export function unreadOf(account: string): UnreadCountsDto {
  return owner === account ? counts : NONE;
}

/**
 * Keeps the counters for the signed-in `account` until the returned function stops it: polls while the tab is visible,
 * and at once when it becomes visible again (a hidden tab does not poll).
 */
export function watchUnread(account: string, pollMs: number): () => void {
  own(account);
  const tick = () => {
    if (document.visibilityState === 'visible') void refreshUnread();
  };
  void refreshUnread();
  const h = setInterval(tick, pollMs);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(h);
    document.removeEventListener('visibilitychange', tick);
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
