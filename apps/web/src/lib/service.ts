import type { MaintenanceDto, ServiceStatusDto } from '@jc/types';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, setMaintenanceListener } from './api';
import { useAuth } from './auth';

/** Service notices and maintenance (GET /api/service/status), shared by the banners and the maintenance page. */
let status: ServiceStatusDto | null = null;
/**
 * Server clock minus this device's, so notices start and end on time, and turn clocks count the room's seconds, on a
 * device whose clock is off. Read at the middle of the request's round trip (performance.now), so a slow answer does
 * not add its delay: it can be off by `spread`, half the round trip, at most.
 */
let skew = 0;
let spread = Infinity;
let measured = false;
/** Date.now() − performance.now() when it was measured: if that moves, the device clock was set (or it slept). */
let anchor = 0;
let pending: Promise<void> | null = null;
const subs = new Set<() => void>();

/** A round trip this quick is always taken; a slower one only if it is closer than the measure in use. */
const QUICK_MS = 250;
/** A measure from a slower round trip is taken again after this, a few times a page load. */
const REMEASURE_MS = 5_000;
let remeasures = 3;
/** The device clock moved this far against the monotonic one: measure again. */
const JUMP_MS = 1_000;

/** Takes the server's time `server`, read between `t0` and `t1` (performance.now), unless the measure in use is closer. */
function calibrate(server: number, t0: number, t1: number) {
  const half = Math.max(0, t1 - t0) / 2;
  if (half <= spread || 2 * half <= QUICK_MS) {
    anchor = Date.now() - performance.now();
    skew = server - (anchor + t0 + half);
    spread = half;
    measured = true;
  }
  if (2 * spread > QUICK_MS && remeasures > 0) {
    remeasures--;
    setTimeout(() => refreshService(), REMEASURE_MS);
  }
}

/** Fetches again, unless `rev` (from the inbox poll) shows nothing changed since the last fetch. */
export function refreshService(rev?: number) {
  if (rev !== undefined && status?.rev === rev) return;
  const t0 = performance.now();
  pending ??= api<ServiceStatusDto>('/api/service/status')
    .then((r) => {
      calibrate(r.now, t0, performance.now());
      status = r;
      subs.forEach((f) => f());
    })
    .catch(() => {
      /* offline: the banner waits for the next try */
    })
    .finally(() => {
      pending = null;
    });
}

setMaintenanceListener(() => refreshService());

export const serverNow = () => {
  const now = Date.now();
  const moved = now - performance.now() - anchor;
  if (measured && Math.abs(moved) > JUMP_MS) {
    // The device clock was set, or the device slept with performance.now() paused (some do): which one cannot be
    // told, so the device clock stays the base and the server is asked again, its answer taken whatever its round trip.
    anchor += moved;
    spread = Infinity;
    refreshService();
  }
  return now + skew;
};

/** Short local date and time, e.g. "10. 15. 오후 11:00" / "10/15, 11:00 PM". */
export const when = (at: number, locale: string) =>
  new Date(at).toLocaleString(locale === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Fetched once per page load (and when the inbox poll reports a change); re-renders every 30 s so notices start and end
 * on time. A list the server cut short is fetched again at its `refreshAt`, when a notice left out may come in.
 */
export function useService() {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!status) refreshService();
    const h = setInterval(() => {
      tick((n) => n + 1);
      if (status?.refreshAt != null && serverNow() >= status.refreshAt) refreshService();
    }, 30_000);
    return () => clearInterval(h);
  }, []);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => status,
  );
}

/** The maintenance window under way at `now` (the server's clock), or null. */
export function maintenanceUnderWay(st: ServiceStatusDto | null, now = serverNow()): MaintenanceDto | null {
  const m = st?.maintenance;
  return m && m.startsAt <= now && now < m.endsAt ? m : null;
}

/**
 * What maintenance under way pauses for the signed-in viewer, as the server refuses it: `games` (a new room, quick
 * play, taking a seat or the waiting list; for everyone) and `posting` (posts and comments; members only, staff post
 * the notices about it). Null when nothing is paused; the buttons come back on their own within 30 s of the end.
 */
export function useMaintenance(): { games: MaintenanceDto | null; posting: MaintenanceDto | null } {
  const m = maintenanceUnderWay(useService());
  const { me } = useAuth();
  const staff = me?.role === 'admin' || me?.role === 'super_admin';
  return { games: m, posting: staff ? null : m };
}