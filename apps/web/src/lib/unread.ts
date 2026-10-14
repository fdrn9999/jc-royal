import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/** Unread message counter shared by the header badge and the inbox. */
let unread = 0;
const subs = new Set<() => void>();

export async function refreshUnread() {
  try {
    const r = await api<{ unread: number }>('/api/messages/unread-count');
    unread = r.unread;
    subs.forEach((f) => f());
  } catch {
    /* logged out or offline */
  }
}

export function useUnread(pollMs = 30_000): number {
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
    () => unread,
  );
}
