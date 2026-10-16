import type { MaintenanceDto, ServiceStatusDto } from '@jc/types';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, setMaintenanceListener } from './api';
import { useAuth } from './auth';

/** Service notices and maintenance (GET /api/service/status), shared by the banners and the maintenance page. */
let status: ServiceStatusDto | null = null;
/** Server clock minus this device's, so notices start and end on time on a device whose clock is off. */
let skew = 0;
let pending: Promise<void> | null = null;
const subs = new Set<() => void>();

/** Fetches again, unless `rev` (from the inbox poll) shows nothing changed since the last fetch. */
export function refreshService(rev?: number) {
  if (rev !== undefined && status?.rev === rev) return;
  pending ??= api<ServiceStatusDto>('/api/service/status')
    .then((r) => {
      skew = r.now - Date.now();
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

export const serverNow = () => Date.now() + skew;

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