import { writeOps } from '@jc/db';
import type { Context } from 'hono';
import { REALTIME_SHARDS, realtimeHubName, realtimeShardOf, type PersonalRealtimeEvent, type PublicRealtimeEvent, type RealtimeEvent } from '@jc/types';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';
import type { SignOutScope } from './presence';

/**
 * Publishing to the realtime hubs (docs/REALTIME.md). Called only after the D1 write it reports has committed, in the
 * background: a hub that cannot be reached loses the event (the page catches up on its next read, reconnect or poll)
 * and never fails or repeats what the request did. A personal event goes only to the hub holding that member's
 * sockets; a public one, which must carry nothing but what every member may see, to every hub.
 */

const hubPost = async (env: Env, shard: number, op: 'publish' | 'revoke', body: unknown): Promise<void> => {
  const stub = env.REALTIME.get(env.REALTIME.idFromName(realtimeHubName(shard)));
  const res = await stub.fetch(`https://realtime/${op}`, {
    method: 'POST',
    headers: { [INTERNAL_HEADER]: env.INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`realtime ${op}: ${res.status}`);
};

const stamp = <E extends PersonalRealtimeEvent | PublicRealtimeEvent>(e: E): RealtimeEvent => ({ ...e, eventId: crypto.randomUUID(), occurredAt: Date.now() }) as RealtimeEvent;

/** Sends a personal event to these members' pages (each hub once, with the members it holds). */
export async function sendToUsers(env: Env, userIds: readonly string[], e: PersonalRealtimeEvent): Promise<void> {
  const event = stamp(e);
  const byShard = new Map<number, string[]>();
  for (const id of new Set(userIds)) {
    const s = realtimeShardOf(id);
    byShard.set(s, [...(byShard.get(s) ?? []), id]);
  }
  const calls: Promise<void>[] = [];
  for (const [shard, ids] of byShard) {
    for (let i = 0; i < ids.length; i += 500) calls.push(hubPost(env, shard, 'publish', { users: ids.slice(i, i + 500), event }));
  }
  await settle(env, calls, e.type);
}

/** Sends a public event to every hub, for the pages that want it. */
export async function sendToAll(env: Env, e: PublicRealtimeEvent): Promise<void> {
  const event = stamp(e);
  await settle(
    env,
    Array.from({ length: REALTIME_SHARDS }, (_, shard) => hubPost(env, shard, 'publish', { event })),
    e.type,
  );
}

/** Waits for every hub; the ones that did not take the event are logged and counted (rt_undelivered). */
async function settle(env: Env, calls: Promise<void>[], what: string) {
  const failed = (await Promise.allSettled(calls)).filter((r) => r.status === 'rejected').length;
  if (!failed) return;
  console.warn(`realtime ${what} not delivered to ${failed} of ${calls.length} hubs`);
  await writeOps(env.DB, 'rt_undelivered', failed);
}

/** In the background of a request, after its write: never throws, never delays the response. */
export function realtimeToUsers(c: Context<AppEnv>, userIds: readonly string[], e: PersonalRealtimeEvent) {
  if (userIds.length === 0) return;
  c.executionCtx.waitUntil(sendToUsers(c.env, userIds, e).catch((err) => console.warn('realtime publish failed', e.type, String(err))));
}

export function realtimeToAll(c: Context<AppEnv>, e: PublicRealtimeEvent) {
  c.executionCtx.waitUntil(sendToAll(c.env, e).catch((err) => console.warn('realtime publish failed', e.type, String(err))));
}

/**
 * How long the pages told of one send to `n` members spread their reads over: none for a few, ten milliseconds a member
 * beyond that, at most thirty seconds (so a send to every member is read back at a steady rate, not in one second).
 */
export const spreadFor = (n: number) => Math.min(30_000, Math.max(0, n - 20) * 10);

/**
 * Closes the realtime sockets of ended sign-ins (lib/signout.ts), and has the hub refuse handshakes checked just before.
 * Tried twice (a repeat closes nothing more): a sign-out the hub never hears of leaves those sockets open, getting events
 * that name no content and whose reads the ended sign-in is refused, until the hub's next sweep finds the session gone
 * from D1 (SWEEP_MS, a few minutes).
 */
export function realtimeSignOut(c: Context<AppEnv>, scope: SignOutScope) {
  const body = { ...scope, at: Date.now() };
  const shard = realtimeShardOf(scope.user);
  c.executionCtx.waitUntil(
    hubPost(c.env, shard, 'revoke', body)
      .catch(() => hubPost(c.env, shard, 'revoke', body))
      .catch((err) => {
        console.warn('realtime sign-out not delivered', String(err));
        return writeOps(c.env.DB, 'rt_revoke_fail');
      }),
  );
}
