import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';
import { fail } from './http';

type RoomAction = 'status' | 'reload' | 'close' | 'seat-check' | 'kick' | 'role' | 'holdings' | 'muck' | 'timer-recover';

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

/** Most rooms one disconnect asks: every table the member sits at comes first, then rooms that have connections. */
export const KICK_MAX_ROOMS = 60;

export interface KickReport {
  /** Rooms asked, and those that answered. */
  tables: number;
  reached: number;
  /** Rooms that did not answer: the member may still hold a connection or a seat there. */
  unreached: string[];
  /** More rooms had connections than were asked. */
  truncated: boolean;
  /** Connections closed. */
  sockets: number;
  /** Where the member sat, and what became of the seat ('left', 'after_hand' when it is cashed out after the hand, …). */
  seats: { tableId: string; seat: string }[];
}

/**
 * Ends a member's live table connections, for a suspension or an admin's disconnect. A connection leaves no row of its
 * own, so the rooms asked are every table with an open seat of theirs, then open tables that have any connections (a
 * spectator is only there), up to KICK_MAX_ROOMS. With `leave` the member also leaves seats and waitlists the way a
 * player leaving does (see the room's `kick`). Rooms are asked in parallel, each twice at most; one that does not answer
 * is reported to the admin.
 */
export async function kickEverywhere(env: Env, userId: string, reason: 'suspended' | 'disconnected', leave: boolean): Promise<KickReport> {
  const [seated, live] = await env.DB.batch<{ id: string }>([
    env.DB.prepare(`SELECT DISTINCT table_id AS id FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`).bind(userId),
    env.DB.prepare(`SELECT id FROM tables WHERE status IN ('open', 'closing') AND live_connections > 0 ORDER BY live_connections DESC LIMIT ?1`).bind(KICK_MAX_ROOMS + 1),
  ]);
  const ids = [...new Set([...(seated?.results ?? []), ...(live?.results ?? [])].map((r) => r.id))];
  const asked = ids.slice(0, Math.max(KICK_MAX_ROOMS, seated?.results.length ?? 0));
  const query = { user: userId, reason, leave: leave ? '1' : '0' };
  const answers = await Promise.all(
    asked.map(async (id) => ({ id, r: (await roomCallEnv(env, id, 'kick', query)) ?? (await roomCallEnv(env, id, 'kick', query)) })),
  );
  const report: KickReport = { tables: asked.length, reached: 0, unreached: [], truncated: ids.length > asked.length, sockets: 0, seats: [] };
  for (const { id, r } of answers) {
    if (!r) {
      report.unreached.push(id);
      continue;
    }
    report.reached += 1;
    report.sockets += Number(r.sockets) || 0;
    if (typeof r.seat === 'string' && r.seat !== 'none') report.seats.push({ tableId: id, seat: r.seat });
  }
  return report;
}

/**
 * After an admin changes a member's role: the tables where they sit show the new staff badge (or none) at once. A room
 * that does not answer catches up when the member next connects (the handshake carries the role read from D1), so this
 * never fails the change. Spectating connections pick up the role the same way.
 */
export async function refreshRoleEverywhere(env: Env, userId: string, role: string): Promise<{ tables: number; reached: number }> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT table_id AS id FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`)
    .bind(userId)
    .all<{ id: string }>();
  const answers = await Promise.all(results.map(({ id }) => roomCallEnv(env, id, 'role', { user: userId, role })));
  return { tables: results.length, reached: answers.filter(Boolean).length };
}

/**
 * After a member's account auto-muck changed (their own save on any device, or an administrator's reset or restore):
 * the seats they hold take it on for the next showdown. A room that does not answer keeps the seat's value until the
 * member's table screen sends theirs (it compares the two when it connects), so this never fails the change.
 */
export async function pushMuckEverywhere(env: Env, userId: string, on: boolean): Promise<{ tables: number; reached: number }> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT table_id AS id FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`)
    .bind(userId)
    .all<{ id: string }>();
  const answers = await Promise.all(results.map(({ id }) => roomCallEnv(env, id, 'muck', { user: userId, on: on ? '1' : '0' })));
  return { tables: results.length, reached: answers.filter(Boolean).length };
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
