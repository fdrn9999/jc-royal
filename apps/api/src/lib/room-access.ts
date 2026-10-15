import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { hmacSign, hmacVerify } from './crypto';
import { fail } from './http';
import { isSecure } from './session';

/**
 * Join-code tickets for private tables. Entering the right code sets an HttpOnly cookie scoped to that table's
 * WebSocket path, so the code itself never travels in a page or socket URL (history, logs, Referer, shared links).
 *
 * The ticket signs the table, the user and the table's current join code hash: changing the code (or making the table
 * public and private again with a new code) invalidates every ticket issued before, without storing any.
 */

/** How long a ticket lasts. Seated players never need it to come back; it only lets its holder sit or join the waitlist. */
export const ROOM_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

const TABLE_ID = /^[\w-]{1,64}$/;

/** One cookie per table, so tickets for several private tables can coexist. */
export const roomAccessCookie = (tableId: string) => `jc_room_${tableId}`;

const message = (tableId: string, userId: string, joinCodeHash: string, exp: number) =>
  `room-access:${tableId}:${userId}:${joinCodeHash}:${exp}`;

export async function issueRoomAccess(c: Context<AppEnv>, tableId: string, userId: string, joinCodeHash: string) {
  if (!TABLE_ID.test(tableId)) fail(404, 'not_found', 'table not found');
  if (!c.env.INTERNAL_SECRET) fail(500, 'internal', 'server misconfigured');
  const exp = Date.now() + ROOM_ACCESS_TTL_MS;
  const sig = await hmacSign(c.env.INTERNAL_SECRET, message(tableId, userId, joinCodeHash, exp));
  setCookie(c, roomAccessCookie(tableId), `${exp}.${sig}`, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Strict',
    path: `/ws/tables/${tableId}`,
    maxAge: Math.floor(ROOM_ACCESS_TTL_MS / 1000),
  });
}

/** True when the request carries an unexpired ticket for this user and the table's current join code. */
export async function hasRoomAccess(c: Context<AppEnv>, tableId: string, userId: string, joinCodeHash: string | null) {
  if (!joinCodeHash || !c.env.INTERNAL_SECRET || !TABLE_ID.test(tableId)) return false;
  const raw = getCookie(c, roomAccessCookie(tableId));
  const dot = raw?.indexOf('.') ?? -1;
  if (!raw || dot < 1) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= Date.now()) return false;
  return hmacVerify(c.env.INTERNAL_SECRET, message(tableId, userId, joinCodeHash, exp), raw.slice(dot + 1));
}
