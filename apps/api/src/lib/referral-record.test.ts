// Recording signups made with a code (referral.ts recordReferral) when they arrive together: each is decided against
// what the table holds when its row is written (an earlier referral of the same inbox, a burst from one network), not
// against what was there when it was read. A D1 stand-in on SQLite with the real migrations lets every signup read
// before any of them writes, an order a busy worker can run them in.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { recordReferral, type Referrer } from './referral';

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

/** An in-memory database with every migration applied and a referral policy that is on. */
function database(burstLimit: number): SqliteDb {
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  db.prepare(
    `INSERT INTO referral_policies (version, enabled, paused, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, change)
     VALUES (2, 1, 0, 1000, 700, 20, 100, 0, ?1, 'test')`,
  ).run(burstLimit);
  return db;
}

/**
 * D1 as recordReferral uses it: every call answers after a turn of the event loop, a batch runs in one transaction, and
 * an INSERT waits until `reads` batches have run.
 */
function fakeD1(db: SqliteDb, reads: number) {
  let batches = 0;
  let release = () => {};
  const readsDone = new Promise<void>((r) => (release = r));
  const turn = () => new Promise((r) => setTimeout(r, 0));
  const exec = (sql: string, params: unknown[]) =>
    /^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...params), meta: { changes: 0 } } : { results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
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
      if (/^\s*INSERT/i.test(this.sql)) await readsDone;
      await turn();
      return exec(this.sql, this.params);
    }
  }
  return {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      await turn();
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        db.exec('COMMIT');
        if (++batches >= reads) release();
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const REFERRER: Referrer = { id: 'u-ref', nickname: 'ref', email: 'ref@test.dev', code: 'JCABCDE' };

/** Records one signup per entry, all at once, and returns each one's row. */
async function together(db: SqliteDb, signups: { email: string; ip: string }[]) {
  const env = { DB: fakeD1(db, signups.length), INTERNAL_SECRET: 'test-secret' } as unknown as Env;
  const ids = await Promise.all(
    signups.map((s, i) => recordReferral(env, { referrer: REFERRER, inviteeId: `u-${i}`, email: s.email, emailVerified: true, verificationRequired: true, ip: s.ip })),
  );
  return ids.map(
    (id) =>
      db.prepare(`SELECT status, referrer_status AS referrerStatus, invitee_status AS inviteeStatus, failure_code AS failure FROM referrals WHERE id = ?1`).all(id)[0],
  );
}

describe('recording referrals that arrive together', () => {
  it('rewards one inbox once: of its addresses signing up at once, one is pending and the rest unpaid', async () => {
    const db = database(1000);
    const rows = await together(
      db,
      ['same+one@test.dev', 'same+two@test.dev', 'SAME+three@test.dev', 'same@test.dev'].map((email, i) => ({ email, ip: `198.51.100.${i + 1}` })),
    );
    expect(rows.filter((r) => r?.status === 'pending'), JSON.stringify(rows)).toEqual([{ status: 'pending', referrerStatus: 'pending', inviteeStatus: 'pending', failure: null }]);
    expect(rows.filter((r) => r?.status !== 'pending')).toEqual(Array(3).fill({ status: 'unpaid', referrerStatus: 'unpaid', inviteeStatus: 'unpaid', failure: 'repeat_email' }));
  });

  it('holds a burst from one network for review: from the limit on, every signup that arrived at once', async () => {
    const db = database(2);
    const rows = await together(
      db,
      Array.from({ length: 4 }, (_, i) => ({ email: `friend${i}@test.dev`, ip: '203.0.113.7' })),
    );
    expect(rows.map((r) => r?.status).sort(), JSON.stringify(rows)).toEqual(['pending', 'review', 'review', 'review']);
    expect(rows.filter((r) => r?.status === 'review')).toEqual(Array(3).fill({ status: 'review', referrerStatus: 'pending', inviteeStatus: 'pending', failure: 'burst' }));
  });

  it("keeps the order of reasons: the referrer's own inbox and a repeat inbox are unpaid, never held as a burst", async () => {
    // A limit of one makes every signup from the network a burst (lower than the console accepts), so only the order decides.
    const db = database(1);
    const rows = await together(db, [
      { email: 'ref+alias@test.dev', ip: '203.0.113.9' },
      { email: 'new@test.dev', ip: '203.0.113.9' },
      { email: 'new+again@test.dev', ip: '203.0.113.9' },
    ]);
    expect(rows[0]).toMatchObject({ status: 'unpaid', failure: 'repeat_email' });
    // Of the other two, the one written first is held; the other is the same inbox again.
    expect(rows.slice(1).map((r) => `${r?.status}/${r?.failure}`).sort()).toEqual(['review/burst', 'unpaid/repeat_email']);
  });
});
