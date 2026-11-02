// For unit tests only (never imported by the worker): D1 on an in-memory SQLite with every migration, from Node's own
// node:sqlite. The guards in a batch read `changes()` of the statement before them, as they do in a D1 batch.

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface NodeParts {
  DatabaseSync: new (path: string) => SqliteDb;
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}

let node: NodeParts | undefined;
/** Loads the Node built-ins (call in beforeAll): this package is typed for the Workers runtime only. */
export async function loadSqlite(): Promise<void> {
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<object>;
  node = { ...(await load('node:sqlite')), ...(await load('node:fs')) } as NodeParts;
}

const MIGRATIONS = new URL('../../../../packages/db/migrations/', (import.meta as unknown as { url: string }).url);

/** An empty database with every migration applied. */
export function migratedDb(): SqliteDb {
  if (!node) throw new Error('loadSqlite() first');
  const db = new node.DatabaseSync(':memory:');
  for (const f of node.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(node.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  return db;
}

/** D1 on that SQLite (a batch in one transaction), with D1's cap of 100 bound values a statement (SQLite's is far higher). */
export function d1Of(db: SqliteDb): D1Database {
  const exec = (sql: string, params: unknown[]) => {
    if (params.length > 100) throw new Error(`too many SQL variables (${params.length})`);
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
  return {
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
  } as unknown as D1Database;
}
