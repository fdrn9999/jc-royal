import { ADMIN_MONITOR_HUB, type AdminMonitorEvent, type AdminMonitorEventInput } from '@jc/types';
import type { Env } from './room';

/**
 * A table room's publishing to the control center's hub (admin-monitor.ts, docs/CONTROL_CENTER.md): after the D1
 * write or the state it reports, in the background, never failing or delaying what the room did. A hub that cannot be
 * reached loses the event; the console catches up on its next read or reconnect. Returns 1 when the hub missed it
 * (the room counts it, rt_undelivered), else 0. Never throws.
 */
export async function publishToAdmins(env: Env, e: AdminMonitorEventInput): Promise<number> {
  if (!env.ADMIN_MONITOR) return 0;
  try {
    const event = { ...e, eventId: crypto.randomUUID(), occurredAt: Date.now() } as AdminMonitorEvent;
    const stub = env.ADMIN_MONITOR.get(env.ADMIN_MONITOR.idFromName(ADMIN_MONITOR_HUB));
    const res = await stub.fetch('https://admin-monitor/publish', {
      method: 'POST',
      headers: { 'x-jc-internal': env.INTERNAL_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    if (res.ok) return 0;
    console.warn(`admin monitor ${e.type} refused: ${res.status}`);
  } catch (err) {
    console.warn(`admin monitor ${e.type} not delivered`, err instanceof Error ? err.message : String(err));
  }
  return 1;
}
