import type { PresenceMode, PresenceState } from '@jc/types';
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';

/**
 * The api's side of friends' status (docs/PRESENCE.md). The presence hub (apps/game-worker/src/presence.ts) keeps
 * which devices beat lately, in memory; the api authenticates every call, decides who may see whom from D1, and
 * applies each member's mode, which the hub never knows.
 */

type HubOp = 'beat' | 'leave' | 'query' | 'viewing';

/** One hub for now (every member's devices and every question go to it; see docs/PRESENCE.md for when to shard). */
const HUB = 'hub-0';

/** Calls the hub. Null when it can't be reached or refused the call: callers read that as "nobody known". */
export async function hubCall<T extends { ok: boolean }>(env: Env, op: HubOp, body: Record<string, unknown>): Promise<T | null> {
  try {
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName(HUB));
    const res = await stub.fetch(`https://presence/${op}`, {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: env.INTERNAL_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/*
 * The hub tells a time only as how long before it answered (ms, on its clock alone): the api counts that back from when
 * it sent the call, on its own clock, so the hub's clock never reaches a saved or shown time (docs/PRESENCE.md).
 */
export interface HubBeat {
  ok: boolean;
  state?: PresenceState;
  limited?: boolean;
  /** The member's last-online time to save, this long before the call (stampLastOnline). */
  stampAgo?: number;
}
export interface HubLeave {
  ok: boolean;
  stampAgo?: number;
}
export interface HubQuery {
  ok: boolean;
  presence?: Record<string, PresenceState>;
  limited?: boolean;
  /** Asked with `seen: true`: how long before the call each last-online time the hub knows (since it started) was. */
  seenAgo?: Record<string, number>;
}

/**
 * Saves a member's last-online time the hub asked for (`stampAgo` before `sent`, when the api sent the call), in the
 * background: one row write, at most every PRESENCE_STAMP_MS while online (and about once a minute as devices close),
 * never per beat. Only forward, never for a withdrawn account (withdrawal clears it), and updated_at is left alone: it is
 * not a change the member made.
 */
export function stampLastOnline(c: Context<AppEnv>, user: string, sent: number, ago: number | undefined) {
  if (ago !== undefined) c.executionCtx.waitUntil(saveLastOnline(c.env, user, sent - ago));
}

async function saveLastOnline(env: Env, user: string, at: number | undefined): Promise<void> {
  if (typeof at !== 'number' || !Number.isFinite(at)) return;
  try {
    await env.DB.prepare(`UPDATE users SET last_online_at = ?2 WHERE id = ?1 AND status = 'active' AND (last_online_at IS NULL OR last_online_at < ?2)`)
      .bind(user, Math.floor(at))
      .run();
  } catch {
    console.warn('last online not saved');
  }
}

/** What friends see of a member from the hub's state (auto mode) and the member's chosen mode. */
export function applyMode(mode: PresenceMode, state: PresenceState): PresenceState {
  if (mode === 'invisible') return 'offline';
  if (mode === 'away' && state !== 'offline') return 'away';
  return state;
}

/** Which of a member's devices a sign-out ends: one sign-in, every sign-in but one, or all of them. */
export type SignOutScope = { user: string; session: string } | { user: string; except: string } | { user: string };

/**
 * Takes the devices of ended sign-ins off the hub at once, in the background, and has it refuse their beats still on
 * their way for a while (`at`: from this moment). A failure is only logged: the hub forgets a device it no longer hears
 * from within PRESENCE_EXPIRE_MS anyway, and friends' status never outlives the account (the friends query reads only
 * active members). Signing out a device friends could see has its last beat saved as the last-online time, as the hub asks.
 */
export function presenceSignOut(c: Context<AppEnv>, scope: SignOutScope) {
  const at = Date.now();
  c.executionCtx.waitUntil(
    hubCall<HubLeave>(c.env, 'leave', { ...scope, at }).then((r) => {
      if (!r?.ok) console.warn('presence leave not delivered');
      else if (r.stampAgo !== undefined) return saveLastOnline(c.env, scope.user, at - r.stampAgo);
    }),
  );
}

/** Whether a visible page of the member shows this view now (a push would repeat it). False when the hub can't tell. */
export async function isViewing(env: Env, user: string, view: string): Promise<boolean> {
  const r = await hubCall<{ ok: boolean; viewing?: boolean }>(env, 'viewing', { user, view });
  return r?.viewing === true;
}
