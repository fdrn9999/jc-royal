/**
 * Server sync for the Advanced GTO Academy's progress (GET/PUT /api/academy/gto/progress). It runs only while a GTO
 * page is open (the section's layout starts it), so members who never open the course make no extra requests. On
 * start the local and server copies are merged and the result written to both; after that local changes are pushed,
 * debounced, one at a time. Each push names the server copy it was merged with (`base`): when another device wrote
 * in between, the server refuses it (409), and that newer copy is fetched, merged in and the push tried again, so
 * neither device's records are dropped. A conflict costs one extra GET and PUT; without one nothing more is sent.
 */
import type { GtoProgressDto } from '@jc/types';
import { useEffect } from 'react';
import { api, ApiError } from '../../lib/api';
import { GTO_PROGRESS_VERSION, getGto, mergeGto, migrateGto, onGtoChange, replaceGto, sameGto } from './progress';

const PATH = '/api/academy/gto/progress';
/** Pushes refused this many times in a row (devices writing all the while) wait for the next change. */
const TRIES = 3;

/** Starts syncing one signed-in member's GTO progress; returns a stop function that pushes a pending change first. */
export function startGtoSync(userId: string): () => void {
  let stopped = false;
  let ready = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** updatedAt of the server copy last merged with or written (null: the server had none). */
  let base: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** Merges the server copy into the local one; true when the server lacks something the merged copy has. */
  const pull = async () => {
    const remote = await api<GtoProgressDto>(PATH);
    const server = remote.data ? migrateGto(remote.data) : null;
    const local = getGto(userId);
    const merged = server ? mergeGto(local, server) : local;
    if (merged !== local) replaceGto(userId, merged);
    base = remote.updatedAt;
    return server ? !sameGto(merged, server) : merged.updatedAt > 0;
  };

  const write = async () => {
    for (let i = 0; i < TRIES; i++) {
      const p = getGto(userId);
      // The server takes only a later updatedAt than the copy it holds.
      const sent = base !== null && p.updatedAt <= base ? { ...p, updatedAt: base + 1 } : p;
      try {
        await api(PATH, { method: 'PUT', body: { version: GTO_PROGRESS_VERSION, updatedAt: sent.updatedAt, data: sent, base } });
        base = sent.updatedAt;
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        if (!(await pull())) return; // the newer copy already has everything here
      }
    }
    throw new Error('gto progress: still changing on another device');
  };

  const send = () => {
    pending = false;
    queue = queue.then(write).catch(() => {
      pending = true; // offline, rate-limited or still conflicting: the next change (or leaving the course) tries again
    });
  };
  const off = onGtoChange((uid) => {
    if (uid !== userId || !ready) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => !stopped && send(), 1_500);
  });
  queue = (async () => {
    try {
      const missing = await pull();
      if (stopped) return;
      ready = true;
      if (missing) await write();
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
