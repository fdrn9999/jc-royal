import { REALTIME_OUTBOX_MAX_ATTEMPTS, realtimeOutboxRetryAt, writeOps, type RealtimeOutboxRow } from '@jc/db';
import type { Context } from 'hono';
import {
  REALTIME_PUBLISH_BATCH_MAX,
  REALTIME_SHARDS,
  realtimeHubName,
  realtimeShardOf,
  type PersonalRealtimeEvent,
  type PublicRealtimeEvent,
  type RealtimeEvent,
} from '@jc/types';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';
import type { SignOutScope } from './presence';

/**
 * Publishing to the realtime hubs (docs/REALTIME.md). Called only after the D1 write it reports has committed, in the
 * background: a hub that cannot be reached loses the event (the page catches up on its next read, reconnect or poll)
 * and never fails or repeats what the request did. A personal event goes only to the hub holding that member's
 * sockets; a public one, which must carry nothing but what every member may see, to every hub.
 *
 * The events a member should not miss for long (a grant, a VIP or role change, a friend request, a message, a notice:
 * docs/REALTIME.md (10)) go through the realtime outbox instead: a row written in the batch of the change itself
 * (outboxToUsers / outboxToAll, then realtimeOutboxStatement from @jc/db), sent right after the commit
 * (realtimeOutboxSend) and by the minute cron again while a hub did not take it (flushRealtimeOutbox). Delivered at
 * least once: a page that gets one twice handles it once (its eventId).
 */

const hubFetch = (env: Env, shard: number, op: 'publish' | 'publish-batch' | 'revoke', body: unknown): Promise<Response> =>
  env.REALTIME.get(env.REALTIME.idFromName(realtimeHubName(shard))).fetch(`https://realtime/${op}`, {
    method: 'POST',
    headers: { [INTERNAL_HEADER]: env.INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const hubPost = async (env: Env, shard: number, op: 'publish' | 'revoke', body: unknown): Promise<void> => {
  const res = await hubFetch(env, shard, op, body);
  // The reply is not needed: left unread it keeps the hub busy (apps/game-worker/src/admin-monitor-publish.ts).
  await res.body?.cancel().catch(() => {});
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

// ------------------------------------------------------------------ the realtime outbox

/** A personal event's outbox row: stamped now, for the batch of the change it reports. */
export function outboxToUsers(userIds: readonly string[], e: PersonalRealtimeEvent, now = Date.now()): RealtimeOutboxRow {
  const event = { ...e, eventId: crypto.randomUUID(), occurredAt: now } as RealtimeEvent;
  return { id: event.eventId, type: e.type, users: [...new Set(userIds)], event, now };
}

/** A public event's outbox row (only what every member may see). */
export function outboxToAll(e: PublicRealtimeEvent, now = Date.now()): RealtimeOutboxRow {
  const event = { ...e, eventId: crypto.randomUUID(), occurredAt: now } as RealtimeEvent;
  return { id: event.eventId, type: e.type, users: null, event, now };
}

/** An outbox event as it is sent: the event, and its members (null: every hub). */
type Outgoing = { id: string; users: readonly string[] | null; event: unknown };
type BatchItem = { event: unknown; users?: string[] };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Sends outbox events, one call a hub for all of them (/publish-batch), and gives back why the ones that failed did: a
 * hub that could not be reached or refused fails every event it was to get, and a public event needs every hub.
 */
export async function publishOutbox(env: Env, rows: readonly Outgoing[]): Promise<Map<string, string>> {
  const byShard = new Map<number, { id: string; item: BatchItem }[]>();
  const add = (shard: number, id: string, item: BatchItem) => byShard.set(shard, [...(byShard.get(shard) ?? []), { id, item }]);
  for (const r of rows) {
    if (!r.users) {
      for (let shard = 0; shard < REALTIME_SHARDS; shard++) add(shard, r.id, { event: r.event });
      continue;
    }
    const mine = new Map<number, string[]>();
    for (const u of new Set(r.users)) {
      const s = realtimeShardOf(u);
      mine.set(s, [...(mine.get(s) ?? []), u]);
    }
    for (const [shard, ids] of mine) for (let i = 0; i < ids.length; i += 500) add(shard, r.id, { event: r.event, users: ids.slice(i, i + 500) });
  }
  const failed = new Map<string, string>();
  const finish = (shard: number, part: readonly { id: string }[], results: readonly unknown[] | undefined) =>
    part.forEach((p, k) => {
      const r = results?.[k];
      if (typeof r !== 'number' && !failed.has(p.id)) failed.set(p.id, `hub ${shard}: ${typeof r === 'string' ? r : 'no result'}`);
    });
  const calls: Promise<void>[] = [];
  for (const [shard, list] of byShard) {
    for (let i = 0; i < list.length; i += REALTIME_PUBLISH_BATCH_MAX) {
      const part = list.slice(i, i + REALTIME_PUBLISH_BATCH_MAX);
      calls.push(
        (async () => {
          let results: unknown[] | undefined;
          try {
            const res = await hubFetch(env, shard, 'publish-batch', { items: part.map((p) => p.item) });
            if (res.status === 404) {
              // A game-worker deployed before the outbox has no /publish-batch: its /publish takes the same item, one a call.
              await res.body?.cancel().catch(() => {});
              results = await Promise.all(
                part.map((p) =>
                  hubPost(env, shard, 'publish', p.item).then(
                    () => 0,
                    (e: unknown) => errorText(e),
                  ),
                ),
              );
              return finish(shard, part, results);
            }
            if (!res.ok) {
              await res.body?.cancel().catch(() => {});
              throw new Error(`hub ${shard}: ${res.status}`);
            }
            results = ((await res.json()) as { results?: unknown[] }).results;
          } catch (e) {
            for (const p of part) if (!failed.has(p.id)) failed.set(p.id, errorText(e));
            return;
          }
          finish(shard, part, results);
        })(),
      );
    }
  }
  await Promise.all(calls);
  return failed;
}

/**
 * Sends outbox events right after the batch that wrote them committed, in the background, and saves how it went: sent,
 * or tried once and due again on the minute cron. Only rows still pending and not held by the cron change, so a row the
 * batch did not write (its guard was false) changes nothing. Pass only the events of a change that happened.
 */
export function realtimeOutboxSend(c: Context<AppEnv>, rows: readonly RealtimeOutboxRow[]) {
  if (rows.length === 0) return;
  c.executionCtx.waitUntil(sendOutboxNow(c.env, rows).catch((err) => console.warn('realtime outbox send failed', String(err))));
}


export async function sendOutboxNow(env: Env, rows: readonly RealtimeOutboxRow[], clock: () => number = Date.now): Promise<void> {
  const failed = await publishOutbox(env, rows);
  const at = clock();
  const db = env.DB;
  await db.batch(
    rows.map((r) => {
      const why = failed.get(r.id);
      return why === undefined
        ? db.prepare(`UPDATE realtime_outbox SET status = 'sent', attempts = attempts + 1, done_at = ?2 WHERE id = ?1 AND status = 'pending' AND lease_until IS NULL`).bind(r.id, at)
        : db
            .prepare(`UPDATE realtime_outbox SET attempts = attempts + 1, last_error = ?2, next_attempt_at = ?3 WHERE id = ?1 AND status = 'pending' AND lease_until IS NULL`)
            .bind(r.id, why, realtimeOutboxRetryAt(1, at));
    }),
  );
  if (failed.size) {
    console.warn(`realtime outbox: ${failed.size} of ${rows.length} events wait for a retry`);
    await writeOps(db, 'rt_outbox_retry', failed.size, at);
  }
}

/** What one cron pass over the outbox did. */
export interface OutboxFlush {
  claimed: number;
  sent: number;
  retried: number;
  /** Given up: tried REALTIME_OUTBOX_MAX_ATTEMPTS times, or past its expiry. */
  dropped: number;
}

/** A claim lasts this long: a run that stops meanwhile leaves its rows to the next. */
const OUTBOX_LEASE_MS = 60_000;

/**
 * The minute cron's pass over the outbox: gives up the rows past their expiry or their tries (the pages have read on
 * their own by then), then sends the due ones, `limit` at most, one call a hub (a run costs at most REALTIME_SHARDS
 * subrequests next to the push outbox's), and saves each outcome under the claim it holds.
 */
export async function flushRealtimeOutbox(env: Env, opts: { limit?: number; clock?: () => number } = {}): Promise<OutboxFlush> {
  const out: OutboxFlush = { claimed: 0, sent: 0, retried: 0, dropped: 0 };
  const db = env.DB;
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  const gone = await db
    .prepare(
      `UPDATE realtime_outbox SET status = CASE WHEN expires_at <= ?1 THEN 'expired' ELSE 'failed' END, done_at = ?1, lease_until = NULL
        WHERE status = 'pending' AND (expires_at <= ?1 OR attempts >= ?2) AND (lease_until IS NULL OR lease_until <= ?1)`,
    )
    .bind(start, REALTIME_OUTBOX_MAX_ATTEMPTS)
    .run();
  out.dropped = gone.meta.changes ?? 0;
  const lease = start + OUTBOX_LEASE_MS;
  const { results: rows } = await db
    .prepare(
      `UPDATE realtime_outbox SET lease_until = ?2, attempts = attempts + 1
        WHERE id IN (SELECT id FROM realtime_outbox
                      WHERE status = 'pending' AND next_attempt_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1)
                      ORDER BY next_attempt_at LIMIT ?3)
          AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?1)
        RETURNING id, recipients, event, attempts`,
    )
    .bind(start, lease, Math.max(1, Math.min(opts.limit ?? 50, REALTIME_PUBLISH_BATCH_MAX)))
    .all<{ id: string; recipients: string | null; event: string; attempts: number }>();
  out.claimed = rows.length;
  if (rows.length) {
    const outgoing: Outgoing[] = [];
    const unreadable = new Set<string>();
    for (const r of rows) {
      try {
        outgoing.push({ id: r.id, users: r.recipients === null ? null : (JSON.parse(r.recipients) as string[]), event: JSON.parse(r.event) as unknown });
      } catch {
        unreadable.add(r.id);
      }
    }
    const failed = outgoing.length ? await publishOutbox(env, outgoing) : new Map<string, string>();
    for (const id of unreadable) failed.set(id, 'unreadable row');
    const at = clock();
    await db.batch(
      rows.map((r) => {
        const why = failed.get(r.id);
        if (why === undefined) {
          out.sent++;
          return db.prepare(`UPDATE realtime_outbox SET status = 'sent', done_at = ?2, lease_until = NULL WHERE id = ?1 AND lease_until = ?3 AND status = 'pending'`).bind(r.id, at, lease);
        }
        const last = r.attempts >= REALTIME_OUTBOX_MAX_ATTEMPTS || unreadable.has(r.id);
        if (last) out.dropped++;
        else out.retried++;
        return db
          .prepare(
            `UPDATE realtime_outbox SET status = ?4, done_at = ?5, next_attempt_at = ?6, last_error = ?2, lease_until = NULL
              WHERE id = ?1 AND lease_until = ?3 AND status = 'pending'`,
          )
          .bind(r.id, why, lease, last ? 'failed' : 'pending', last ? at : null, realtimeOutboxRetryAt(r.attempts, at));
      }),
    );
  }
  if (out.retried) await writeOps(db, 'rt_outbox_retry', out.retried, start);
  if (out.dropped) await writeOps(db, 'rt_outbox_failed', out.dropped, start);
  return out;
}

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
