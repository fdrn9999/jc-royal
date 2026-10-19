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

export interface HubBeat {
  ok: boolean;
  state?: PresenceState;
  limited?: boolean;
}
export interface HubQuery {
  ok: boolean;
  presence?: Record<string, PresenceState>;
  limited?: boolean;
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
 * active members).
 */
export function presenceSignOut(c: Context<AppEnv>, scope: SignOutScope) {
  c.executionCtx.waitUntil(
    hubCall(c.env, 'leave', { ...scope, at: Date.now() }).then((r) => {
      if (!r?.ok) console.warn('presence leave not delivered');
    }),
  );
}

/** Whether a visible page of the member shows this view now (a push would repeat it). False when the hub can't tell. */
export async function isViewing(env: Env, user: string, view: string): Promise<boolean> {
  const r = await hubCall<{ ok: boolean; viewing?: boolean }>(env, 'viewing', { user, view });
  return r?.viewing === true;
}
