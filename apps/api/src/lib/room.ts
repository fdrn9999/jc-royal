import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';

/** Calls a table room's internal endpoint. Returns null when the room cannot be reached. */
export async function roomCall(c: Context<AppEnv>, tableId: string, action: 'status' | 'reload' | 'close'): Promise<Record<string, unknown> | null> {
  try {
    const stub = c.env.TABLES.get(c.env.TABLES.idFromName(tableId));
    const headers: Record<string, string> = { [INTERNAL_HEADER]: c.env.INTERNAL_SECRET };
    if (c.env.MEMBER_IDLE_CLOSE_MS) headers['x-jc-idle-close-ms'] = c.env.MEMBER_IDLE_CLOSE_MS;
    const res = await stub.fetch(`https://room/internal/${tableId}/${action}`, { method: 'POST', headers });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
