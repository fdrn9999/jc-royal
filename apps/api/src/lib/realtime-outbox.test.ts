// The realtime outbox (@jc/db realtime-outbox, lib/realtime.ts): its rows written by the statements a change's batch
// carries, on SQLite with the real migrations (the guards read `changes()` of the statement before them, as in a D1
// batch), and the send right after the commit and the minute cron's retries against hubs that answer as a test says.
// What only workerd shows (D1's own batch, the hub Durable Object) is in tests/integration/realtime.test.ts ('realtime outbox').
import {
  createDb,
  IF_CHANGED,
  LEDGER_GUARD,
  REALTIME_OUTBOX_BACKOFF_MS,
  REALTIME_OUTBOX_GRACE_MS,
  REALTIME_OUTBOX_MAX_ATTEMPTS,
  REALTIME_OUTBOX_TTL_MS,
  realtimeOutboxForMembers,
  realtimeOutboxRetryAt,
  realtimeOutboxStatement,
  realtimeOutboxValues,
  schema,
} from '@jc/db';
import { eq } from 'drizzle-orm';
import { REALTIME_SHARDS, realtimeShardOf } from '@jc/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { flushRealtimeOutbox, outboxToAll, outboxToUsers, publishOutbox, sendOutboxNow } from './realtime';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface NodeParts {
  DatabaseSync: new (path: string) => SqliteDb;
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}

let node: NodeParts;
beforeAll(async () => {
  // Node built-ins, loaded by name: this package is typed for the Workers runtime only.
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<object>;
  node = { ...(await load('node:sqlite')), ...(await load('node:fs')) } as NodeParts;
});

const MIGRATIONS = new URL('../../../../packages/db/migrations/', (import.meta as unknown as { url: string }).url);
const NOW = Date.parse('2026-11-02T03:00:00Z');

/** Every migration and two members. */
function database(): SqliteDb {
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  for (const u of ['me', 'fr']) db.prepare(`INSERT INTO users (id, email, nickname, password_hash) VALUES (?1, ?1 || '@test.dev', ?1, 'x')`).run(u);
  return db;
}

/** `old`: a game-worker from before the outbox, with /publish only. */
type Answer = 'ok' | 'down' | 'bad event' | 'old';
interface Hubs {
  /** The calls each hub got: its shard and the items of each /publish-batch (a /publish: its one item). */
  calls: { shard: number; op: string; items: { event: { eventId: string }; users?: string[] }[] }[];
  /** How a hub answers (all ok unless set). */
  answer: Map<number, Answer>;
}

/** D1 on that SQLite (a batch in one transaction), and the realtime hubs. */
function env(db: SqliteDb): { env: Env; hubs: Hubs } {
  const exec = (sql: string, params: unknown[]) => {
    if (/^\s*SELECT|RETURNING/i.test(sql)) return { results: db.prepare(sql).all(...params), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
  };
  class Stmt {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Stmt(this.sql, params);
    }
    async all() {
      return exec(this.sql, this.params);
    }
    async first() {
      return exec(this.sql, this.params).results[0] ?? null;
    }
    async run() {
      return exec(this.sql, this.params);
    }
  }
  const DB = {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const hubs: Hubs = { calls: [], answer: new Map() };
  const REALTIME = {
    idFromName: (name: string) => Number(name.slice(name.lastIndexOf('-') + 1)),
    get: (shard: number) => ({
      fetch: async (url: string, init: RequestInit) => {
        const op = new URL(url).pathname.slice(1);
        const body = JSON.parse(String(init.body)) as { items: Hubs['calls'][number]['items'] } & Hubs['calls'][number]['items'][number];
        hubs.calls.push({ shard, op, items: op === 'publish' ? [{ event: body.event, users: body.users }] : body.items });
        const how = hubs.answer.get(shard) ?? 'ok';
        if (how === 'down') return new Response('unavailable', { status: 503 });
        if (op === 'publish') return Response.json({ ok: true, delivered: 1 });
        if (how === 'old') return new Response('not found', { status: 404 });
        return Response.json({ ok: true, results: body.items.map(() => (how === 'ok' ? 1 : 'bad event')) });
      },
    }),
  };
  return { env: { DB, REALTIME, INTERNAL_SECRET: 'test-secret', ENVIRONMENT: 'test' } as unknown as Env, hubs };
}

const row = (db: SqliteDb, id: string) =>
  db
    .prepare(`SELECT status, recipients, event, attempts, next_attempt_at AS next, lease_until AS lease, expires_at AS expires, done_at AS done, last_error AS error FROM realtime_outbox WHERE id = ?1`)
    .all(id)[0] as
    | { status: string; recipients: string | null; event: string; attempts: number; next: number; lease: number | null; expires: number; done: number | null; error: string | null }
    | undefined;

const ops = (db: SqliteDb, metric: string) => Number(db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM ops_metrics WHERE metric = ?1`).all(metric)[0]!.n);

/** Runs statements as one D1 batch would. */
const batch = (e: Env, stmts: D1PreparedStatement[]) => e.DB.batch(stmts);

const wallet = (users: string[], now = NOW) => outboxToUsers(users, { scope: 'user', type: 'wallet.changed' }, now);

describe('the outbox row a change writes', () => {
  it('is pending, waits out the grace before the cron, expires, and keeps each member once', async () => {
    const db = database();
    const { env: e } = env(db);
    const w = wallet(['me', 'fr', 'me']);
    await batch(e, [realtimeOutboxStatement(e.DB, w)]);
    const r = row(db, w.id)!;
    expect(r).toMatchObject({ status: 'pending', attempts: 0, next: NOW + REALTIME_OUTBOX_GRACE_MS, expires: NOW + REALTIME_OUTBOX_TTL_MS, lease: null, done: null });
    expect(JSON.parse(r.recipients!)).toEqual(['me', 'fr']);
    expect(JSON.parse(r.event)).toEqual(w.event);
    const pub = outboxToAll({ scope: 'lobby', type: 'tournament.changed', resourceId: 't1' }, NOW);
    await batch(e, [realtimeOutboxStatement(e.DB, pub)]);
    expect(row(db, pub.id)!.recipients).toBeNull();
  });

  it('IF_CHANGED: only with a change of the statement before it (an update, an insert, an insert that was ignored)', async () => {
    const db = database();
    const { env: e } = env(db);
    const update = (id: string) => e.DB.prepare(`UPDATE users SET nickname = 'renamed' WHERE id = ?1`).bind(id);
    const [hit, miss] = [wallet(['me']), wallet(['me'])];
    await batch(e, [update('me'), realtimeOutboxStatement(e.DB, hit, IF_CHANGED)]);
    await batch(e, [update('nobody'), realtimeOutboxStatement(e.DB, miss, IF_CHANGED)]);
    expect(row(db, hit.id)?.status).toBe('pending');
    expect(row(db, miss.id)).toBeUndefined();
    const ask = () => e.DB.prepare(`INSERT OR IGNORE INTO friendships (user_a, user_b, requester_id, status) VALUES ('fr', 'me', 'me', 'pending')`);
    const [first, again] = [wallet(['fr']), wallet(['fr'])];
    await batch(e, [ask(), realtimeOutboxStatement(e.DB, first, IF_CHANGED)]);
    await batch(e, [ask(), realtimeOutboxStatement(e.DB, again, IF_CHANGED)]);
    expect(row(db, first.id)?.status).toBe('pending');
    expect(row(db, again.id)).toBeUndefined();
  });

  it('in a Drizzle batch, next to the change (a role change)', async () => {
    const db = database();
    const { env: e } = env(db);
    const orm = createDb(e.DB);
    const told = outboxToUsers(['me'], { scope: 'user', type: 'account.changed' }, NOW);
    await orm.batch([
      orm.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, 'me')),
      orm.insert(schema.realtimeOutbox).values(realtimeOutboxValues(told)),
    ]);
    const r = row(db, told.id)!;
    expect(r).toMatchObject({ status: 'pending', attempts: 0, next: NOW + REALTIME_OUTBOX_GRACE_MS, expires: NOW + REALTIME_OUTBOX_TTL_MS });
    expect(JSON.parse(r.recipients!)).toEqual(['me']);
    expect(JSON.parse(r.event)).toEqual(told.event);
    // The same id again fails the batch, and the change with it.
    await expect(
      orm.batch([orm.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, 'me')), orm.insert(schema.realtimeOutbox).values(realtimeOutboxValues(told))]),
    ).rejects.toThrow();
    expect(db.prepare(`SELECT role FROM users WHERE id = 'me'`).all()[0]).toEqual({ role: 'admin' });
  });

  it('a guard with its own parameters: numbered after the row (the ledger entry of a grant)', async () => {
    const db = database();
    const { env: e } = env(db);
    db.prepare(
      `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, created_at) VALUES ('led-1', 'me', 'admin_grant', 100, 100, 'k1', ?1)`,
    ).run(NOW);
    const [made, none] = [wallet(['me']), wallet(['me'])];
    await batch(e, [realtimeOutboxStatement(e.DB, made, { sql: LEDGER_GUARD, params: ['led-1'] }), realtimeOutboxStatement(e.DB, none, { sql: LEDGER_GUARD, params: ['led-2'] })]);
    expect(row(db, made.id)?.status).toBe('pending');
    expect(row(db, none.id)).toBeUndefined();
  });

  it('a value read in the batch is set in the event (its parameters before the guard’s); a path that is not plain is refused', async () => {
    const db = database();
    const { env: e } = env(db);
    const dm = outboxToUsers(['fr'], { scope: 'user', type: 'social.dm.created', payload: { peerId: 'me', seq: 0 } }, NOW);
    await batch(e, [realtimeOutboxStatement(e.DB, dm, { sql: '? = 7', params: [7] }, { path: '$.payload.seq', sql: 'SELECT ? + 1', params: [41] })]);
    expect(JSON.parse(row(db, dm.id)!.event)).toEqual({ ...dm.event, payload: { peerId: 'me', seq: 42 } });
    expect(() => realtimeOutboxStatement(e.DB, dm, undefined, { path: "$.a'); DROP TABLE users; --", sql: 'SELECT 1' })).toThrow(/bad outbox fill path/);
  });

  it('for members the batch chooses: all it finds, or no row when it finds none', async () => {
    const db = database();
    const { env: e } = env(db);
    const [both, nobody] = [wallet([]), wallet([])];
    await batch(e, [
      realtimeOutboxForMembers(e.DB, both, { sql: `SELECT id AS user_id FROM users WHERE id IN (?, ?)`, params: ['me', 'fr'] }),
      realtimeOutboxForMembers(e.DB, nobody, { sql: `SELECT id AS user_id FROM users WHERE id = ?`, params: ['ghost'] }),
    ]);
    expect(JSON.parse(row(db, both.id)!.recipients!).sort()).toEqual(['fr', 'me']);
    expect(row(db, nobody.id)).toBeUndefined();
  });

  it('a failed change writes no row (the batch rolls back)', async () => {
    const db = database();
    const { env: e } = env(db);
    const w = wallet(['me']);
    await expect(batch(e, [realtimeOutboxStatement(e.DB, w), e.DB.prepare(`INSERT INTO users (id) VALUES (NULL)`)])).rejects.toThrow();
    expect(row(db, w.id)).toBeUndefined();
  });

  it('waits longer after each failed send, then the longest wait repeats', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => realtimeOutboxRetryAt(n, NOW) - NOW)).toEqual([...REALTIME_OUTBOX_BACKOFF_MS, 600_000, 600_000]);
    expect(realtimeOutboxRetryAt(0, NOW) - NOW).toBe(REALTIME_OUTBOX_BACKOFF_MS[0]);
  });
});

/** Members that land on two different hubs. */
function twoShards(): [string, string] {
  const a = 'member-0';
  for (let i = 1; i < 200; i++) if (realtimeShardOf(`member-${i}`) !== realtimeShardOf(a)) return [a, `member-${i}`];
  throw new Error('no two shards');
}

describe('publishOutbox', () => {
  it('one call a hub for all the events it gets; a public event goes to every hub and fails with one of them', async () => {
    const { env: e, hubs } = env(database());
    const [a, b] = twoShards();
    const personal = wallet([a, b]);
    const pub = outboxToAll({ scope: 'lobby', type: 'tournament.changed', resourceId: 't1' }, NOW);
    expect((await publishOutbox(e, [personal, pub])).size).toBe(0);
    expect(hubs.calls).toHaveLength(REALTIME_SHARDS);
    expect(hubs.calls.every((c) => c.op === 'publish-batch')).toBe(true);
    const toA = hubs.calls.find((c) => c.shard === realtimeShardOf(a))!;
    expect(toA.items.find((i) => i.event.eventId === personal.id)?.users).toEqual([a]);
    expect(toA.items.find((i) => i.event.eventId === pub.id)?.users).toBeUndefined();

    hubs.calls.length = 0;
    hubs.answer.set(realtimeShardOf(b), 'down');
    const failed = await publishOutbox(e, [wallet([a]), personal, pub]);
    expect([...failed.keys()].sort()).toEqual([personal.id, pub.id].sort());
    expect(failed.get(pub.id)).toMatch(/503/);
  });

  it('an event a hub refuses fails alone', async () => {
    const { env: e, hubs } = env(database());
    hubs.answer.set(realtimeShardOf('me'), 'bad event');
    const failed = await publishOutbox(e, [wallet(['me'])]);
    expect([...failed.values()]).toEqual([`hub ${realtimeShardOf('me')}: bad event`]);
  });

  it('a hub without /publish-batch (a game-worker deployed before it) gets each event on /publish', async () => {
    const { env: e, hubs } = env(database());
    const [a, b] = twoShards();
    hubs.answer.set(realtimeShardOf(a), 'old');
    const first = wallet([a, b]);
    const second = wallet([a]);
    expect((await publishOutbox(e, [first, second])).size).toBe(0);
    const toA = hubs.calls.filter((c) => c.shard === realtimeShardOf(a));
    expect(toA.map((c) => c.op)).toEqual(['publish-batch', 'publish', 'publish']);
    expect(toA.slice(1).map((c) => [c.items[0]!.event.eventId, c.items[0]!.users])).toEqual([
      [first.id, [a]],
      [second.id, [a]],
    ]);
    expect(hubs.calls.filter((c) => c.shard === realtimeShardOf(b)).map((c) => c.op)).toEqual(['publish-batch']);
  });
});

describe('the send right after the commit', () => {
  it('saves a sent event as sent and one a hub missed as due again after the first wait', async () => {
    const db = database();
    const { env: e, hubs } = env(db);
    const [a, b] = twoShards();
    const [ok, missed] = [wallet([a]), wallet([b])];
    await batch(e, [realtimeOutboxStatement(e.DB, ok), realtimeOutboxStatement(e.DB, missed)]);
    hubs.answer.set(realtimeShardOf(b), 'down');
    const at = NOW + 150;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendOutboxNow(e, [ok, missed], () => at);
    warn.mockRestore();
    expect(row(db, ok.id)).toMatchObject({ status: 'sent', attempts: 1, done: at });
    expect(row(db, missed.id)).toMatchObject({ status: 'pending', attempts: 1, next: at + REALTIME_OUTBOX_BACKOFF_MS[0]!, done: null });
    expect(row(db, missed.id)!.error).toMatch(/503/);
    expect(ops(db, 'rt_outbox_retry')).toBe(1);
  });

  it('leaves a row the cron holds alone, and changes nothing for a row the batch did not write', async () => {
    const db = database();
    const { env: e } = env(db);
    const [held, unwritten] = [wallet(['me']), wallet(['me'])];
    await batch(e, [realtimeOutboxStatement(e.DB, held)]);
    db.prepare(`UPDATE realtime_outbox SET lease_until = ?2, attempts = 1 WHERE id = ?1`).run(held.id, NOW + 60_000);
    await sendOutboxNow(e, [held, unwritten], () => NOW);
    expect(row(db, held.id)).toMatchObject({ status: 'pending', attempts: 1, lease: NOW + 60_000 });
    expect(row(db, unwritten.id)).toBeUndefined();
  });
});

describe('the minute cron', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('leaves an event alone during its grace, then sends what is due in one call a hub', async () => {
    const db = database();
    const { env: e, hubs } = env(db);
    const [w, pub] = [wallet(['me']), outboxToAll({ scope: 'lobby', type: 'tournament.changed', resourceId: 't1' }, NOW)];
    await batch(e, [realtimeOutboxStatement(e.DB, w), realtimeOutboxStatement(e.DB, pub)]);
    expect(await flushRealtimeOutbox(e, { clock: () => NOW + 1_000 })).toEqual({ claimed: 0, sent: 0, retried: 0, dropped: 0 });
    expect(hubs.calls).toHaveLength(0);
    const at = NOW + REALTIME_OUTBOX_GRACE_MS;
    expect(await flushRealtimeOutbox(e, { clock: () => at })).toEqual({ claimed: 2, sent: 2, retried: 0, dropped: 0 });
    expect(hubs.calls).toHaveLength(REALTIME_SHARDS);
    expect(row(db, w.id)).toMatchObject({ status: 'sent', attempts: 1, lease: null, done: at });
    expect(row(db, pub.id)).toMatchObject({ status: 'sent', attempts: 1, lease: null, done: at });
    // Sent is sent: the next run has nothing.
    hubs.calls.length = 0;
    expect((await flushRealtimeOutbox(e, { clock: () => at + 60_000 })).claimed).toBe(0);
    expect(hubs.calls).toHaveLength(0);
  });

  it('retries with longer waits, gives up after the last try, and counts both', async () => {
    const db = database();
    const { env: e, hubs } = env(db);
    const w = wallet(['me']);
    await batch(e, [realtimeOutboxStatement(e.DB, w)]);
    hubs.answer.set(realtimeShardOf('me'), 'down');
    const warn = quiet();
    let at = NOW + REALTIME_OUTBOX_GRACE_MS;
    for (let n = 1; n < REALTIME_OUTBOX_MAX_ATTEMPTS; n++) {
      expect(await flushRealtimeOutbox(e, { clock: () => at })).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
      expect(row(db, w.id)).toMatchObject({ status: 'pending', attempts: n, lease: null, next: realtimeOutboxRetryAt(n, at) });
      // Not before its wait.
      expect((await flushRealtimeOutbox(e, { clock: () => realtimeOutboxRetryAt(n, at) - 1 })).claimed).toBe(0);
      at = realtimeOutboxRetryAt(n, at);
    }
    expect(at).toBeLessThan(w.now + REALTIME_OUTBOX_TTL_MS);
    expect(await flushRealtimeOutbox(e, { clock: () => at })).toMatchObject({ claimed: 1, sent: 0, retried: 0, dropped: 1 });
    warn.mockRestore();
    expect(row(db, w.id)).toMatchObject({ status: 'failed', attempts: REALTIME_OUTBOX_MAX_ATTEMPTS, done: at });
    expect(ops(db, 'rt_outbox_retry')).toBe(REALTIME_OUTBOX_MAX_ATTEMPTS - 1);
    expect(ops(db, 'rt_outbox_failed')).toBe(1);
  });

  it('a hub that comes back gets the event on the next due run', async () => {
    const db = database();
    const { env: e, hubs } = env(db);
    const w = wallet(['me']);
    await batch(e, [realtimeOutboxStatement(e.DB, w)]);
    hubs.answer.set(realtimeShardOf('me'), 'down');
    const warn = quiet();
    await sendOutboxNow(e, [w], () => NOW);
    warn.mockRestore();
    hubs.answer.clear();
    expect((await flushRealtimeOutbox(e, { clock: () => NOW + REALTIME_OUTBOX_BACKOFF_MS[0]! })).sent).toBe(1);
    expect(row(db, w.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(hubs.calls.at(-1)!.items[0]!.event.eventId).toBe(w.id);
  });

  it('drops an event past its expiry without sending it', async () => {
    const db = database();
    const { env: e, hubs } = env(db);
    const w = wallet(['me']);
    await batch(e, [realtimeOutboxStatement(e.DB, w)]);
    const at = NOW + REALTIME_OUTBOX_TTL_MS;
    expect(await flushRealtimeOutbox(e, { clock: () => at })).toEqual({ claimed: 0, sent: 0, retried: 0, dropped: 1 });
    expect(row(db, w.id)).toMatchObject({ status: 'expired', done: at });
    expect(hubs.calls).toHaveLength(0);
  });

  it('leaves a row another run holds, and takes it once that claim ran out', async () => {
    const db = database();
    const { env: e } = env(db);
    const w = wallet(['me']);
    await batch(e, [realtimeOutboxStatement(e.DB, w)]);
    const at = NOW + REALTIME_OUTBOX_GRACE_MS;
    db.prepare(`UPDATE realtime_outbox SET lease_until = ?2, attempts = 1 WHERE id = ?1`).run(w.id, at + 30_000);
    expect((await flushRealtimeOutbox(e, { clock: () => at })).claimed).toBe(0);
    expect(await flushRealtimeOutbox(e, { clock: () => at + 30_000 })).toMatchObject({ claimed: 1, sent: 1 });
    expect(row(db, w.id)).toMatchObject({ status: 'sent', attempts: 2, lease: null });
  });

  it('gives up a row it cannot read, and sends the others of the run', async () => {
    const db = database();
    const { env: e } = env(db);
    const [bad, good] = [wallet(['me']), wallet(['fr'])];
    await batch(e, [realtimeOutboxStatement(e.DB, bad), realtimeOutboxStatement(e.DB, good)]);
    db.prepare(`UPDATE realtime_outbox SET recipients = 'not json' WHERE id = ?1`).run(bad.id);
    expect(await flushRealtimeOutbox(e, { clock: () => NOW + REALTIME_OUTBOX_GRACE_MS })).toMatchObject({ claimed: 2, sent: 1, dropped: 1 });
    expect(row(db, bad.id)).toMatchObject({ status: 'failed', error: 'unreadable row' });
    expect(row(db, good.id)?.status).toBe('sent');
  });

  it('claims at most `limit` rows, oldest due first', async () => {
    const db = database();
    const { env: e } = env(db);
    const rows = [0, 1, 2].map((i) => wallet(['me'], NOW + i));
    await batch(e, rows.map((r) => realtimeOutboxStatement(e.DB, r)));
    expect((await flushRealtimeOutbox(e, { limit: 2, clock: () => NOW + REALTIME_OUTBOX_GRACE_MS + 5 })).claimed).toBe(2);
    expect(rows.map((r) => row(db, r.id)!.status)).toEqual(['sent', 'sent', 'pending']);
  });
});
