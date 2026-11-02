/**
 * The notification inbox (the header's bell and /notifications; apps/api/src/routes/inbox.ts): pages of items and marking
 * them read. The unread count is the counters' (lib/unread.ts `notifications`), so every tab and the badge agree.
 */
import type { InboxFilter, InboxPageDto, InboxReadBody } from '@jc/types';
import { api } from './api';
import { refreshUnread } from './unread';

export interface InboxAsk {
  filter?: InboxFilter;
  unread?: boolean;
  /** The page's `next` (a page after the one that gave it). */
  before?: string | null;
  limit?: number;
}

export function fetchInbox(q: InboxAsk = {}): Promise<InboxPageDto> {
  const p = new URLSearchParams();
  if (q.filter) p.set('filter', q.filter);
  if (q.unread) p.set('unread', '1');
  if (q.before) p.set('before', q.before);
  if (q.limit) p.set('limit', String(q.limit));
  const qs = p.toString();
  return api<InboxPageDto>(`/api/notifications${qs ? `?${qs}` : ''}`);
}

/** Marks items read (by id, or all of a filter); the counters are read again (the server tells the other tabs). */
export async function markInboxRead(body: InboxReadBody): Promise<number> {
  const r = await api<{ read: number }>('/api/notifications/read', { body });
  void refreshUnread();
  return r.read;
}
