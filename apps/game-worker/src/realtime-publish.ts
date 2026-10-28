import { REALTIME_SHARDS, realtimeHubName, realtimeShardOf, type PersonalRealtimeEvent, type PublicRealtimeEvent, type RealtimeEvent } from '@jc/types';
import type { Env } from './room';

/**
 * A table room's publishing to the realtime hubs (realtime.ts, docs/REALTIME.md), by the api's rules
 * (apps/api/src/lib/realtime.ts): only after the D1 write it reports has committed, in the background, and never
 * failing or repeating what the room did. A hub that cannot be reached loses the event; the page catches up on its next
 * read, reconnect or poll.
 */

async function hubPost(env: Env, shard: number, body: unknown): Promise<void> {
  const stub = env.REALTIME.get(env.REALTIME.idFromName(realtimeHubName(shard)));
  const res = await stub.fetch('https://realtime/publish', {
    method: 'POST',
    headers: { 'x-jc-internal': env.INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`realtime publish: ${res.status}`);
}

const stamp = (e: PersonalRealtimeEvent | PublicRealtimeEvent): RealtimeEvent => ({ ...e, eventId: crypto.randomUUID(), occurredAt: Date.now() }) as RealtimeEvent;

async function settle(calls: Promise<void>[], what: string) {
  const failed = (await Promise.allSettled(calls)).filter((r) => r.status === 'rejected').length;
  if (failed) console.warn(`realtime ${what} not delivered to ${failed} of ${calls.length} hubs`);
}

/** A personal event for these members' pages (each hub once, with the members it holds). Never throws. */
export async function publishToUsers(env: Env, userIds: readonly string[], e: PersonalRealtimeEvent): Promise<void> {
  if (!env.REALTIME || userIds.length === 0) return;
  const event = stamp(e);
  const byShard = new Map<number, string[]>();
  for (const id of new Set(userIds)) {
    const s = realtimeShardOf(id);
    byShard.set(s, [...(byShard.get(s) ?? []), id]);
  }
  const calls: Promise<void>[] = [];
  for (const [shard, ids] of byShard) for (let i = 0; i < ids.length; i += 500) calls.push(hubPost(env, shard, { users: ids.slice(i, i + 500), event }));
  await settle(calls, e.type);
}

/** A public event (nothing in it but what every member may see) for the pages that want its topic. Never throws. */
export async function publishToAll(env: Env, e: PublicRealtimeEvent): Promise<void> {
  if (!env.REALTIME) return;
  const event = stamp(e);
  await settle(
    Array.from({ length: REALTIME_SHARDS }, (_, shard) => hubPost(env, shard, { event })),
    e.type,
  );
}
