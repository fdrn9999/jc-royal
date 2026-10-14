import type { UnreadCountsDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/** Unread counters (inbox, 1:1 messages, friend requests) shared by the header badges and the pages. */
let counts: UnreadCountsDto = { unread: 0, dmUnread: 0, friendRequests: 0 };
const subs = new Set<() => void>();

export async function refreshUnread() {
  try {
    const r = await api<UnreadCountsDto>('/api/messages/unread-count');
    if (r.unread === counts.unread && r.dmUnread === counts.dmUnread && r.friendRequests === counts.friendRequests) return;
    counts = r;
    subs.forEach((f) => f());
  } catch {
    /* logged out or offline */
  }
}

export function useUnread(pollMs = 30_000): UnreadCountsDto {
  useEffect(() => {
    void refreshUnread();
    const h = setInterval(refreshUnread, pollMs);
    return () => clearInterval(h);
  }, [pollMs]);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => counts,
  );
}
