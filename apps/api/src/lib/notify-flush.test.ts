// The push sender (notify.ts flushPush) and the outbox writer (@jc/db outboxOne) on a D1 stand-in on SQLite with the
// real migrations, with a clock the test moves while a run is under way and push services that answer at once (fetch
// is replaced; nothing leaves the process). What the integration tests cannot fix: the server's clock (Korean night,
// a claim running out) and the order of the steps of one run.
import { outboxOne } from '@jc/db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { flushPush, MAX_ATTEMPTS } from './notify';
import { b64url } from './webpush';

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
let vapid: { publicKey: string; privateKey: string };
beforeAll(async () => {
  // Node built-ins, loaded by name: this package is typed for the Workers runtime only.
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<object>;
  node = { ...(await load('node:sqlite')), ...(await load('node:fs')) } as NodeParts;
  // A VAPID key pair made here, at test time (no key is written into the code).
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  vapid = { publicKey: b64url(raw), privateKey: ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d! };
});

const MIGRATIONS = new URL('../../../../packages/db/migrations/', (import.meta as unknown as { url: string }).url);
/** A moment in Korean time (UTC+9, no daylight saving). */
const kst = (iso: string) => Date.parse(`${iso}+09:00`);
const NOON = kst('2026-10-19T12:00:00');
const LEASE_MS = 60_000;
// The browser's keys from RFC 8291's worked example (published test values).
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

/** Every migration; a member "me" with service consent (night consent as given), a browser of a live sign-in, and a friend "fr". */
function database(night = false, devices = 1): SqliteDb {
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  for (const u of ['me', 'fr']) db.prepare(`INSERT INTO users (id, email, nickname, password_hash, email_verified_at) VALUES (?1, ?1 || '@test.dev', ?1, 'x', 1)`).run(u);
  db.prepare(`INSERT INTO friendships (user_a, user_b, requester_id, status, accepted_at) VALUES ('fr', 'me', 'fr', 'accepted', 1)`).run();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, kind, expires_at) VALUES ('s-me', 'me', 'th-me', 'user', ?1)`).run(NOON + 30 * 86_400_000);
  db.prepare(`INSERT INTO notification_settings (user_id, service, night) VALUES ('me', 1, ?1)`).run(night ? 1 : 0);
  for (let i = 0; i < devices; i++)
    db.prepare(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?1, 'me', 's-me', ?2, ?1, ?3, ?4)`).run(
      `dev-${i}`,
      `https://fcm.googleapis.com/fcm/send/dev-${i}`,
      UA_PUBLIC,
      UA_AUTH,
    );
  return db;
}

/** An event for "me", as the outbox writes it (or as a sender left it: `attempts`, `lease`; `expires`: an hour on by default). */
function queue(db: SqliteDb, id: string, type: string, coalesce: string | null, createdAt: number, extra: { attempts?: number; lease?: number; expires?: number } = {}) {
  db.prepare(
    `INSERT INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, lease_until, expires_at, created_at)
     VALUES (?1, ?1, 'me', ?2, '/friends', ?3, 'pending', ?4, ?5, ?6, ?7, ?5)`,
  ).run(id, type, coalesce, extra.attempts ?? 0, createdAt, extra.lease ?? null, extra.expires ?? createdAt + 3_600_000);
}

const event = (db: SqliteDb, id: string) =>
  db.prepare(`SELECT status, reason, attempts, lease_until AS lease, next_attempt_at AS next FROM notification_events WHERE id = ?1`).all(id)[0];

/**
 * D1 as the sender uses it (each call answers after a turn of the event loop, a batch runs in one transaction). The
 * presence hub says nobody is reading the conversation and runs `onViewing` first: the step right after the account,
 * relation, cooldown and cap checks of a direct message, and right before its browsers are read and it is sent.
 * `failOn`: the first statement matching it fails (D1 unreachable for a moment), or the first `failTimes` of them.
 */
function env(db: SqliteDb, opts: { onViewing?: () => void; failOn?: RegExp; failTimes?: number } = {}): Env {
  let failOn = opts.failOn ?? null;
  let fails = opts.failTimes ?? 1;
  const turn = () => new Promise((r) => setTimeout(r, 0));
  const exec = (sql: string, params: unknown[]) => {
    if (failOn?.test(sql)) {
      if (--fails <= 0) failOn = null;
      throw new Error('D1_ERROR: network connection lost');
    }
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
      await turn();
      return exec(this.sql, this.params);
    }
    async first() {
      await turn();
      return exec(this.sql, this.params).results[0] ?? null;
    }
    async run() {
      await turn();
      return exec(this.sql, this.params);
    }
  }
  const DB = {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      await turn();
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
  const PRESENCE = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async () => {
        opts.onViewing?.();
        return Response.json({ ok: true, viewing: false });
      },
    }),
  };
  return {
    DB,
    PRESENCE,
    INTERNAL_SECRET: 'test-secret',
    ENVIRONMENT: 'test',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'https://jc-royal.site',
  } as unknown as Env;
}

let pushes: ReturnType<typeof vi.fn>;
beforeEach(() => {
  pushes = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', pushes);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flushPush, one event after another', () => {
  it("a friend's second message in the same run, within the minute, is not pushed again", async () => {
    const db = database();
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 2_000);
    queue(db, 'e2', 'dm', 'dm:fr', NOON - 1_000);
    const r = await flushPush(env(db), { clock: () => NOON });
    expect(r).toMatchObject({ claimed: 2, sent: 1, skipped: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'sent' });
    expect(event(db, 'e2')).toMatchObject({ status: 'skipped', reason: 'cooldown' });
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it("the hourly cap counts the push this run has just sent", async () => {
    const db = database();
    for (let i = 0; i < 29; i++)
      db.prepare(
        `INSERT INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, expires_at, created_at, sent_at)
         VALUES (?1, ?1, 'me', 'dm', '/friends', 'dm:someone', 'sent', 1, ?2, ?3, ?2, ?2)`,
      ).run(`old-${i}`, NOON - 600_000, NOON + 3_000_000);
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 2_000);
    queue(db, 'e2', 'invite', 'invite:fr', NOON - 1_000);
    const r = await flushPush(env(db), { clock: () => NOON });
    expect(r).toMatchObject({ sent: 1, skipped: 1 });
    expect(event(db, 'e2')).toMatchObject({ status: 'skipped', reason: 'hourly_cap' });
  });

  it('the hourly cap and the cooldown count when pushes went out, not when their events happened', async () => {
    const db = database();
    // Events of three hours ago that went out within the hour (they had waited): fr's 30 s ago, then 29 from others.
    const sent = (id: string, coalesce: string, at: number) =>
      db.prepare(
        `INSERT INTO notification_events (id, dedupe_key, user_id, type, url, coalesce_key, status, attempts, next_attempt_at, expires_at, created_at, sent_at)
         VALUES (?1, ?1, 'me', 'dm', '/friends', ?2, 'sent', 1, ?3, ?4, ?3, ?5)`,
      ).run(id, coalesce, NOON - 3 * 3_600_000, NOON + 3_000_000, at);
    sent('fr-old', 'dm:fr', NOON - 30_000);
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 2_000);
    expect(await flushPush(env(db), { clock: () => NOON })).toMatchObject({ sent: 0, skipped: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'skipped', reason: 'cooldown' });
    for (let i = 0; i < 29; i++) sent(`old-${i}`, 'dm:someone', NOON - 600_000);
    queue(db, 'e2', 'invite', 'invite:fr', NOON - 1_000);
    expect(await flushPush(env(db), { clock: () => NOON })).toMatchObject({ sent: 0, skipped: 1 });
    expect(event(db, 'e2')).toMatchObject({ status: 'skipped', reason: 'hourly_cap' });
    expect(pushes).not.toHaveBeenCalled();
  });

  it('a push that went out but could not be saved, twice over, ends the run: the rest are given back untried', async () => {
    const db = database();
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 3_000);
    queue(db, 'e2', 'dm', 'dm:fr', NOON - 2_000);
    queue(db, 'e3', 'tournament_result', 'tournament_result:tn1', NOON - 1_000);
    // The outcome batch, then the error path's own save of e1, both fail.
    const r = await flushPush(env(db, { failOn: /SET status = \?2/, failTimes: 2 }), { clock: () => NOON });
    // e2 is not pushed: nothing saved says e1 went out, so its cooldown could not be kept.
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ claimed: 3, sent: 0 });
    expect(event(db, 'e1')).toMatchObject({ status: 'pending', lease: NOON + LEASE_MS });
    for (const id of ['e2', 'e3']) expect(event(db, id)).toMatchObject({ status: 'pending', attempts: 0, lease: null });
  });

  it('a push asks the push service to keep it no longer than its event lasts', async () => {
    const db = database();
    queue(db, 'e1', 'tournament_start', 'tournament_start:tn1', NOON - 1_000, { expires: NOON + 30_000 });
    expect(await flushPush(env(db), { clock: () => NOON })).toMatchObject({ sent: 1 });
    const init = pushes.mock.calls[0]![1] as RequestInit;
    expect(Number(new Headers(init.headers).get('TTL'))).toBe(30);
  });

  it('an event running out while its push is being made is not sent, and its browser is not counted as failing', async () => {
    let t = NOON;
    const db = database();
    queue(db, 'e1', 'tournament_start', 'tournament_start:tn1', NOON - 1_000, { expires: NOON + 30_000 });
    // Encrypting the body is the last step before the push service is called: the event runs out during it.
    const real = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...a: Parameters<SubtleCrypto['encrypt']>) => {
      t = NOON + 30_000;
      return real(...a);
    });
    try {
      expect(await flushPush(env(db), { clock: () => t })).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(pushes).not.toHaveBeenCalled();
    expect(event(db, 'e1')).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(db.prepare(`SELECT failures, last_failure_at AS at FROM push_subscriptions`).all()).toEqual([{ failures: 0, at: null }]);
  });

  it('night beginning while the run checks is judged again right before sending: not sent without night consent', async () => {
    let t = kst('2026-10-19T20:59:59');
    const db = database(false);
    queue(db, 'e1', 'dm', 'dm:fr', t - 1_000);
    const r = await flushPush(env(db, { onViewing: () => (t = kst('2026-10-19T21:00:00')) }), { clock: () => t });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'skipped', reason: 'night' });
    expect(pushes).not.toHaveBeenCalled();
  });

  it('… and sent with night consent', async () => {
    let t = kst('2026-10-19T20:59:59');
    const db = database(true);
    queue(db, 'e1', 'dm', 'dm:fr', t - 1_000);
    const r = await flushPush(env(db, { onViewing: () => (t = kst('2026-10-19T21:00:00')) }), { clock: () => t });
    expect(r).toMatchObject({ sent: 1 });
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it('with too little of the claim left to send and save, the event and the rest are given back untried', async () => {
    let t = NOON;
    const db = database();
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 2_000);
    queue(db, 'e2', 'tournament_result', 'tournament_result:tn1', NOON - 1_000);
    // The checks took 40 s: 20 s of the claim are left, less than the slowest answer (10 s) and the save (15 s).
    const r = await flushPush(env(db, { onViewing: () => (t = NOON + LEASE_MS - 20_000) }), { clock: () => t });
    expect(r).toMatchObject({ claimed: 2, sent: 0, skipped: 0 });
    for (const id of ['e1', 'e2']) expect(event(db, id)).toMatchObject({ status: 'pending', attempts: 0, lease: null });
    expect(pushes).not.toHaveBeenCalled();
    // The next run sends both.
    expect(await flushPush(env(db), { clock: () => t })).toMatchObject({ sent: 2 });
  });

  it("past the run's budget, the event and the rest wait untried for the next run", async () => {
    const db = database(false, 10);
    for (let i = 0; i < 5; i++) queue(db, `e${i}`, 'tournament_result', `tournament_result:tn${i}`, NOON - 5_000 + i);
    const r = await flushPush(env(db), { clock: () => NOON });
    // Ten browsers each: four events use the 40 pushes a run may make.
    expect(r).toMatchObject({ claimed: 5, sent: 4 });
    expect(pushes).toHaveBeenCalledTimes(40);
    expect(event(db, 'e4')).toMatchObject({ status: 'pending', attempts: 0, lease: null });
  });

  it('an error after the claim is saved as a retry (not left claimed), and the retry sends it', async () => {
    const db = database();
    queue(db, 'e1', 'tournament_result', 'tournament_result:tn1', NOON - 1_000);
    const r = await flushPush(env(db, { failOn: /FROM push_subscriptions ps\s+JOIN sessions/ }), { clock: () => NOON });
    expect(r).toMatchObject({ claimed: 1, retried: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'pending', reason: 'error', attempts: 1, lease: null, next: NOON + 60_000 });
    expect(await flushPush(env(db), { clock: () => NOON + 60_000 })).toMatchObject({ sent: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it(`an event a sender left claimed after its last try is failed, never tried more than ${MAX_ATTEMPTS} times`, async () => {
    const db = database();
    queue(db, 'e1', 'tournament_result', 'tournament_result:tn1', NOON - 1_000, { attempts: MAX_ATTEMPTS });
    const r = await flushPush(env(db), { clock: () => NOON });
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'failed', reason: 'retries' });
    expect(pushes).not.toHaveBeenCalled();
  });

  it("while another sender holds one of a member's messages or invites, no other of them is claimed (other types are)", async () => {
    const db = database();
    queue(db, 'held', 'dm', 'dm:fr', NOON - 3_000, { attempts: 1, lease: NOON + 30_000 });
    queue(db, 'e1', 'invite', 'invite:fr', NOON - 2_000);
    queue(db, 'e2', 'tournament_result', 'tournament_result:tn1', NOON - 1_000);
    const r = await flushPush(env(db), { clock: () => NOON });
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(event(db, 'e1')).toMatchObject({ status: 'pending', attempts: 0, lease: null });
    expect(event(db, 'e2')).toMatchObject({ status: 'sent' });
  });

  it('a message or invite the member has read since (another device, or before a retry) is not pushed; an unread one is', async () => {
    const db = database();
    const dm = (id: string, seq: number, kind: string, readAt: number | null) =>
      db.prepare(
        `INSERT INTO direct_messages (id, pair_key, sender_id, recipient_id, body, kind, created_at, seq, read_at) VALUES (?1, 'fr:me', 'fr', 'me', 'hi', ?2, ?3, ?4, ?5)`,
      ).run(id, kind, NOON - 10_000 + seq, seq, readAt);
    dm('m1', 1, 'text', NOON - 500);
    dm('m2', 2, 'invite', NOON - 500);
    dm('m3', 3, 'text', null);
    // The event's dedupe key names the message (queue() gives the key the event's id).
    queue(db, 'dm:m1', 'dm', 'dm:fr', NOON - 3_000);
    queue(db, 'invite:m2', 'invite', 'invite:fr', NOON - 2_000);
    queue(db, 'dm:m3', 'dm', 'dm:fr', NOON - 1_000);
    const r = await flushPush(env(db), { clock: () => NOON });
    expect(r).toMatchObject({ claimed: 3, sent: 1, skipped: 2 });
    expect(event(db, 'dm:m1')).toMatchObject({ status: 'skipped', reason: 'read' });
    expect(event(db, 'invite:m2')).toMatchObject({ status: 'skipped', reason: 'read' });
    expect(event(db, 'dm:m3')).toMatchObject({ status: 'sent' });
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it('a block of a friend who is now staff does not stop their pushes (as it does not stop their messages); a block of a member does', async () => {
    const db = database();
    db.prepare(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('me', 'fr')`).run();
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = 'fr'`).run();
    queue(db, 'e1', 'dm', 'dm:fr', NOON - 1_000);
    expect(await flushPush(env(db), { clock: () => NOON })).toMatchObject({ sent: 1 });
    db.prepare(`UPDATE users SET role = 'user' WHERE id = 'fr'`).run();
    queue(db, 'e2', 'friend_accepted', 'fa:fr', NOON - 500);
    expect(await flushPush(env(db), { clock: () => NOON + 1_000 })).toMatchObject({ sent: 0, skipped: 1 });
    expect(event(db, 'e2')).toMatchObject({ status: 'skipped', reason: 'no_relation' });
  });
});

describe('outboxOne at night', () => {
  const write = (db: SqliteDb, key: string, night: boolean) =>
    outboxOne(env(db).DB, { dedupeKey: key, userId: 'me', type: 'dm', url: '/friends', coalesceKey: 'dm:fr', now: NOON, night }).run();

  it('queues nothing at night for a member without night consent (consent given later never reaches back)', async () => {
    const db = database(false);
    expect((await write(db, 'k-night', true)).meta.changes).toBe(0);
    expect((await write(db, 'k-day', false)).meta.changes).toBe(1);
  });

  it('queues at night for a member with night consent', async () => {
    const db = database(true);
    expect((await write(db, 'k-night', true)).meta.changes).toBe(1);
  });
});
