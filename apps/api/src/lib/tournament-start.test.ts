// Starting a tournament (tournament.ts startTournament) while a player stops qualifying: the start reads who qualifies,
// then writes in one batch. A suspension, or a seat taken in another tournament, between the two changes neither the
// tournament's version nor its roster, so the batch itself has to find the player still qualifying. A D1 stand-in on
// SQLite with the real migrations makes the change land exactly between the read and the batch.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { startTournament } from './tournament';

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
const TN = 'tnstartrace1';
const PLAYERS = ['u-1', 'u-2', 'u-3', 'u-4'];

/** Every migration, an administrator, and four verified members registered for a tournament of `capacity` seats that starts from two players. */
function database(capacity = 6): SqliteDb {
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const tournament = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                  tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, roster)
         VALUES (?1, ?1, ?2, ?3, 2, 1500, '[{"sb":10,"bb":20},{"sb":15,"bb":30}]', 300000, 20, 1, 30000, 60000, 10000, 10, 5000, 0, 1, 0, 4)`,
      )
      .run(id, status, capacity);
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash, role) VALUES ('admin', 'admin@test.dev', 'admin', 'x', 'super_admin')`).run();
  tournament(TN, 'registering');
  tournament('tnotherone01', 'registering');
  for (const [i, u] of PLAYERS.entries()) {
    db.prepare(`INSERT INTO users (id, email, nickname, password_hash, email_verified_at) VALUES (?1, ?1 || '@test.dev', ?1, 'x', 1)`).run(u);
    db.prepare(`INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at) VALUES (?1, ?2, 'registered', ?3)`).run(TN, u, i + 1);
  }
  return db;
}

/**
 * D1 as startTournament uses it (each call answers after a turn of the event loop, a batch runs in one transaction),
 * running `between` once, right after the start has read who qualifies.
 */
function env(db: SqliteDb, between: string | null): Env {
  let pending = between;
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
      const out = exec(this.sql, this.params);
      if (pending && /FROM tournament_entries e JOIN users u/.test(this.sql)) {
        db.exec(pending);
        pending = null;
      }
      return out;
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
  // The room answers the reload.
  const TABLES = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  return { DB, TABLES, INTERNAL_SECRET: 'test-secret' } as unknown as Env;
}

const entries = (db: SqliteDb) =>
  Object.fromEntries(db.prepare(`SELECT user_id AS u, status FROM tournament_entries WHERE tournament_id = ?1 ORDER BY user_id`).all(TN).map((r) => [r.u, r.status]));
const started = (db: SqliteDb) => db.prepare(`SELECT user_id AS u FROM messages WHERE id LIKE 'tn:' || ?1 || ':started:%' ORDER BY user_id`).all(TN).map((r) => r.u);

describe('starting a tournament while a player stops qualifying', () => {
  it('starts without a player suspended between the read and the batch, who is dropped and sent no start notice', async () => {
    const db = database();
    const r = await startTournament(env(db, `UPDATE users SET status = 'suspended' WHERE id = 'u-2'`), TN, { actorId: 'admin', auto: false });
    expect(r).toMatchObject({ started: true, players: 3, dropped: [{ userId: 'u-2', reason: 'suspended' }] });
    expect(entries(db)).toEqual({ 'u-1': 'playing', 'u-2': 'dropped', 'u-3': 'playing', 'u-4': 'playing' });
    expect(started(db)).toEqual(['u-1', 'u-3', 'u-4']);
    expect(db.prepare(`SELECT status, players_left AS left FROM tournaments WHERE id = ?1`).all(TN)).toEqual([{ status: 'running', left: 3 }]);
  });

  it('drops a player who took a seat in another tournament meanwhile', async () => {
    const db = database();
    const r = await startTournament(
      env(db, `INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at) VALUES ('tnotherone01', 'u-3', 'registered', 9)`),
      TN,
      { actorId: 'admin', auto: false },
    );
    expect(r).toMatchObject({ started: true, players: 3, dropped: [{ userId: 'u-3', reason: 'active_elsewhere' }] });
    expect(entries(db)).toEqual({ 'u-1': 'playing', 'u-2': 'playing', 'u-3': 'dropped', 'u-4': 'playing' });
  });

  it('an automatic start (every seat taken) does not start, and keeps registration open for the freed seat', async () => {
    const db = database(4);
    const r = await startTournament(env(db, `UPDATE users SET status = 'suspended' WHERE id = 'u-4'`), TN, { actorId: null, auto: true });
    expect(r).toMatchObject({ started: false, reason: 'ineligible', dropped: [{ userId: 'u-4', reason: 'suspended' }] });
    expect(entries(db)).toEqual({ 'u-1': 'registered', 'u-2': 'registered', 'u-3': 'registered', 'u-4': 'dropped' });
    expect(db.prepare(`SELECT status, table_id AS tableId FROM tournaments WHERE id = ?1`).all(TN)).toEqual([{ status: 'registering', tableId: null }]);
    expect(started(db)).toEqual([]);
  });

  it('starts everyone at once when nothing changes', async () => {
    const db = database();
    const r = await startTournament(env(db, null), TN, { actorId: 'admin', auto: false });
    expect(r).toMatchObject({ started: true, players: 4, dropped: [] });
    expect(Object.values(entries(db))).toEqual(['playing', 'playing', 'playing', 'playing']);
    const seats = db.prepare(`SELECT seat_index AS s, stack FROM tournament_entries WHERE tournament_id = ?1`).all(TN);
    expect(new Set(seats.map((s) => s.s)).size).toBe(4);
    expect(seats.every((s) => s.stack === 1500)).toBe(true);
  });
});
