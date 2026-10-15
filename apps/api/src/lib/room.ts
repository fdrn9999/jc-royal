import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';
import { fail } from './http';

type RoomAction = 'status' | 'reload' | 'close' | 'seat-check';

/** Calls a table room's internal endpoint with the worker's bindings (also from the cron handler). Null when unreachable. */
export async function roomCallEnv(env: Env, tableId: string, action: RoomAction, query: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  try {
    const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
    const headers: Record<string, string> = { [INTERNAL_HEADER]: env.INTERNAL_SECRET };
    if (env.MEMBER_IDLE_CLOSE_MS) headers['x-jc-idle-close-ms'] = env.MEMBER_IDLE_CLOSE_MS;
    const q = new URLSearchParams(query).toString();
    const res = await stub.fetch(`https://room/internal/${tableId}/${action}${q ? `?${q}` : ''}`, { method: 'POST', headers });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Calls a table room's internal endpoint. Returns null when the room cannot be reached. */
export function roomCall(c: Context<AppEnv>, tableId: string, action: RoomAction, query: Record<string, string> = {}) {
  return roomCallEnv(c.env, tableId, action, query);
}

/** How long a close may stay unfinished before the daily sweep nudges the room. */
export const SWEEP_CLOSING_AFTER_MS = 15 * 60_000;
/** An empty member room older than this whose room never armed its idle close (its opening call failed). */
export const SWEEP_EMPTY_ROOM_AFTER_MS = 60 * 60_000;

/**
 * Part of the daily cron: wakes rooms D1 says are still closing (the room retries on its own while it is alive; this
 * covers one whose retry stopped) and empty member rooms, so their idle close runs. A reload is safe to repeat: each
 * cash-out is keyed in the ledger. Bounded per run; anything left is picked up the next day.
 */
export async function sweepRooms(env: Env, now = Date.now()) {
  const { results: closing } = await env.DB.prepare(`SELECT id FROM tables WHERE status = 'closing' AND updated_at < ?1 LIMIT 20`)
    .bind(now - SWEEP_CLOSING_AFTER_MS)
    .all<{ id: string }>();
  const { results: idle } = await env.DB.prepare(
    `SELECT id FROM tables WHERE status = 'open' AND room_type = 'member' AND live_seated = 0 AND created_at < ?1 LIMIT 50`,
  )
    .bind(now - SWEEP_EMPTY_ROOM_AFTER_MS)
    .all<{ id: string }>();
  let reached = 0;
  for (const { id } of [...closing, ...idle]) if (await roomCallEnv(env, id, 'reload')) reached += 1;
  return { closing: closing.length, idleRooms: idle.length, reached };
}

/**
 * For changes the room must take on (open, reload settings, close): tries twice, then fails the request with 503
 * room_unavailable. What D1 already holds stays, and repeating the request is safe, so the caller can simply retry.
 */
export async function roomCallOrFail(c: Context<AppEnv>, tableId: string, action: 'reload' | 'close', details?: Record<string, unknown>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await roomCallEnv(c.env, tableId, action);
    if (r) return r;
  }
  return fail(503, 'room_unavailable', 'the table did not respond; try again', details);
}
