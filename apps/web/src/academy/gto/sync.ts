/**
 * Server sync for the Advanced GTO Academy's progress (GET/PUT /api/academy/gto/progress). It runs only while a GTO
 * page is open (the section's layout starts it), so members who never open the course make no extra requests. On
 * start the local and server copies are merged and the result written to both; after that local changes are pushed,
 * debounced.
 */
import type { GtoProgressDto } from '@jc/types';
import { useEffect } from 'react';
import { api } from '../../lib/api';
import { GTO_PROGRESS_VERSION, getGto, mergeGto, migrateGto, onGtoChange, replaceGto, sameGto, type GtoProgress } from './progress';

const push = (p: GtoProgress) => api('/api/academy/gto/progress', { method: 'PUT', body: { version: GTO_PROGRESS_VERSION, updatedAt: p.updatedAt, data: p } });

/** Starts syncing one signed-in member's GTO progress; returns a stop function that pushes a pending change first. */
export function startGtoSync(userId: string): () => void {
  let stopped = false;
  let ready = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    pending = false;
    void push(getGto(userId)).catch(() => {
      pending = true; // offline or rate-limited: the next change (or leaving the course) tries again
    });
  };
  const off = onGtoChange((uid) => {
    if (uid !== userId || !ready) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => !stopped && send(), 1_500);
  });
  void (async () => {
    try {
      const remote = await api<GtoProgressDto>('/api/academy/gto/progress');
      if (stopped) return;
      const server = remote.data ? migrateGto(remote.data) : null;
      const merged = server ? mergeGto(getGto(userId), server) : getGto(userId);
      replaceGto(userId, merged);
      ready = true;
      if ((!server || !sameGto(merged, server)) && merged.updatedAt > 0) await push(merged);
    } catch {
      ready = true; // offline: keep working locally, push on the next change
    }
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
    if (ready && pending) send();
  };
}

export function useGtoSync(userId: string | null | undefined) {
  useEffect(() => (userId ? startGtoSync(userId) : undefined), [userId]);
}
