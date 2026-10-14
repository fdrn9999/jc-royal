/**
 * Server sync for Academy progress and anonymous content events.
 *
 * On sign-in the local copy (this device) and the server copy (other devices)
 * are merged with `merge()` and the result is written to both. After that every
 * local change is pushed (debounced). Events (answers, lesson/scenario starts and
 * completions) are batched and sent without any user identifier in the payload;
 * the server stores only aggregate counters.
 */
import type { AcademyEvent, AcademyProgressDto, BadgeDto } from '@jc/types';
import { useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { CURRENT_VERSION, getProgress, merge, migrate, onProgressChange, replaceProgress, sameProgress, type Progress } from './progress';

let badges: BadgeDto[] = [];
const badgeListeners = new Set<() => void>();
function setBadges(b: BadgeDto[]) {
  badges = b;
  for (const l of badgeListeners) l();
}

export function useBadges(): BadgeDto[] {
  return useSyncExternalStore(
    (cb) => {
      badgeListeners.add(cb);
      return () => badgeListeners.delete(cb);
    },
    () => badges,
  );
}

async function push(p: Progress) {
  const r = await api<{ ok: true; badges: BadgeDto[] }>('/api/academy/progress', { method: 'PUT', body: { version: CURRENT_VERSION, updatedAt: p.updatedAt, data: p } });
  setBadges(r.badges);
}

/** Starts syncing for a signed-in user; returns a stop function. Network errors are retried on the next change. */
export function startAcademySync(userId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) void push(getProgress(userId)).catch(() => {});
    }, 1_500);
  };
  const off = onProgressChange((uid) => {
    if (uid === userId && ready) schedule();
  });
  void (async () => {
    try {
      const remote = await api<AcademyProgressDto>('/api/academy/progress');
      if (stopped) return;
      setBadges(remote.badges);
      const server = remote.data ? migrate(remote.data) : null;
      const local = getProgress(userId);
      const merged = server ? merge(local, server) : local;
      replaceProgress(userId, merged);
      ready = true;
      if (!server || !sameProgress(merged, server)) {
        if (merged.updatedAt > 0 || server) await push(merged);
      }
    } catch {
      ready = true; // offline: keep working locally, push on the next change
    }
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
    setBadges([]);
  };
}

// ------------------------------------------------------------------ anonymous events

let queue: AcademyEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flush(keepalive = false) {
  clearTimeout(flushTimer);
  const batch = queue.splice(0, 50);
  if (batch.length === 0) return;
  void fetch('/api/academy/events', { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) }).catch(() => {});
  if (queue.length) flush(keepalive);
}

export function track(e: AcademyEvent) {
  queue.push(e);
  if (queue.length >= 20) flush();
  else {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 5_000);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush(true));
}
