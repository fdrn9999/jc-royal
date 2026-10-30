/**
 * Another administrator's change to what a console page shows (docs/CONTROL_CENTER.md): the page hears of it on the
 * control center's socket (admin.monitor.changed for a member's VIP state or a tournament, admin.monitor.table for a
 * table) and says so, with the version it reached; it never replaces what is being typed by itself. A save still names
 * the version it was decided from, so one made from an older state is refused (409) as before.
 *
 * Only administrators with table duty have the socket (the hub refuses the others), and only those with the page's
 * permission hear of its changes (the hub sends each kind only to them). A change made while the socket was down is not
 * heard: the save's version check still catches it.
 */
import type { AdminMonitorEvent } from '@jc/types';
import { useRef, useState } from 'react';
import { hasGrant, useAdmin } from './lib';
import { useMonitorSocket } from './monitorSocket';

const NONE: string[] = [];

/** Every event the page's socket hears, while `on` (off: no socket). */
export function useAdminChanges(on: boolean, onEvent: (e: AdminMonitorEvent) => void) {
  const { me, refresh } = useAdmin();
  useMonitorSocket({ enabled: on && hasGrant(me, 'tables'), watch: NONE, onHello: () => undefined, onEvent, onCheck: () => void refresh() });
}

/**
 * The newest version heard of for `key` (a member, a table, a tournament) from the events `match` takes; null until
 * one is heard, and again when `key` changes. With a null key the page has nothing to hear of and opens no socket.
 */
export function useHeardRevision(key: string | null, match: (e: AdminMonitorEvent) => boolean): number | null {
  const [heard, setHeard] = useState<{ key: string; revision: number } | null>(null);
  const current = useRef(key);
  current.current = key;
  useAdminChanges(key !== null, (e) => {
    const k = current.current;
    if (k === null || !match(e)) return;
    setHeard((h) => (h && h.key === k && h.revision >= e.revision ? h : { key: k, revision: e.revision }));
  });
  return heard && heard.key === key ? heard.revision : null;
}
