import type { UnreadCountsDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { refreshService } from './service';

/** Unread counters (inbox, 1:1 messages, friend requests) shared by the header badges and the pages. */
let counts: UnreadCountsDto = { unread: 0, dmUnread: 0, friendRequests: 0 };
const subs = new Set<() => void>();

export async function refreshUnread() {
  try {
    const r = await api<UnreadCountsDto>('/api/messages/unread-count');
    if (r.serviceRev !== undefined) refreshService(r.serviceRev);
    if (r.unread === counts.unread && r.dmUnread === counts.dmUnread && r.friendRequests === counts.friendRequests) return;
    counts = r;
    subs.forEach((f) => f());
  } catch {
    /* logged out or offline */
  }
}

/** Polls while the tab is visible, and at once when it becomes visible again: a hidden tab does not poll. */
export function useUnread(pollMs = 30_000): UnreadCountsDto {
  useEffect(() => {
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
  }, [pollMs]);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => counts,
  );
}
