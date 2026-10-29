// "Where does this member sit now?" runs on every lobby read, refill, VIP change and bot pick, and "which closed tables
// still hold a seat?" on every control center and dashboard read. Both must start from the open seats: a member's closed
// seats and the closed tables are never deleted, so anything that reads them only gets slower (docs/LOAD_TEST.md §7).
// The plans come from the real migration files in an in-memory SQLite (the engine D1 runs), for statements copied from
// the source, which is checked to still hold them.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../packages/db/migrations/', import.meta.url);
const source = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

function migrated() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort())
    for (const stmt of readFileSync(new URL(f, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  return db;
}

const planOf = (db: DatabaseSync, sql: string, args: (string | null)[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail);

const U = 'member-1';

/** One member's open seats: [file, the statement or the part of it in the source, a statement to plan, its arguments]. */
const MEMBER_SEATS: [string, string, string, (string | null)[]][] = [
  // Drizzle writes this one (the lobby's myParticipation, routes/tables.ts seatedTables); the worker log shows it so.
  ['', '', `select "table_id" from "table_sessions" where ("table_sessions"."user_id" = ? and "table_sessions"."status" = ?)`, [U, 'seated']],
  ...(
    [
      ['apps/api/src/lib/room.ts', `SELECT DISTINCT table_id AS id FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`],
      ['apps/api/src/routes/admin-vip.ts', `SELECT COUNT(DISTINCT table_id) AS n FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`],
      ['apps/api/src/lib/refill.ts', `SELECT id, table_id AS tableId FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`],
      ['apps/api/src/routes/admin.ts', `SELECT id, table_id AS tableId, seat_index AS seatIndex, buy_in AS buyIn, created_at AS createdAt FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`],
    ] as const
  ).map(([f, sql]): [string, string, string, (string | null)[]] => [f, sql, sql, [U]]),
  ['apps/api/src/lib/refill.ts', `(SELECT COUNT(*) FROM table_sessions WHERE user_id = ?9 AND status = 'seated')`,
    `SELECT (SELECT COUNT(*) FROM table_sessions WHERE user_id = ?9 AND status = 'seated') AS n`, [null, null, null, null, null, null, null, null, U]],
  ['apps/game-worker/src/bots.ts', `EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = ?1 AND s.status = 'seated') AS busy`,
    `SELECT EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = ?1 AND s.status = 'seated') AS busy`, [U]],
  // Every bot account is asked in turn when a room looks for an idle bot, and bots sit down and stand up all day.
  ['apps/game-worker/src/bots.ts', `NOT EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = u.id AND s.status = 'seated')`,
    `SELECT u.id FROM users u WHERE u.is_bot = 1 AND NOT EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = u.id AND s.status = 'seated')`, []],
  // The control center's search by the nickname of a seated member.
  ['apps/api/src/routes/admin-monitor.ts', `SELECT s.table_id FROM table_sessions s JOIN users m ON m.id = s.user_id WHERE lower(m.nickname) = lower(`,
    `SELECT t.id FROM tables t WHERE t.id IN (SELECT s.table_id FROM table_sessions s JOIN users m ON m.id = s.user_id WHERE lower(m.nickname) = lower(?1) AND s.status = 'seated')`, ['someone']],
];

/** Closed tables that still hold a seat (the control center list and the dashboard). */
const SEATED_ON_CLOSED: [string, string][] = [
  ['apps/api/src/routes/admin-monitor.ts', `SELECT DISTINCT s.table_id AS id FROM table_sessions s CROSS JOIN tables t ON t.id = s.table_id WHERE s.status = 'seated' AND t.status = 'closed' LIMIT 50`],
  ['apps/api/src/lib/ops.ts', `SELECT ts.table_id AS id, t.name AS name, COUNT(*) AS n FROM table_sessions ts CROSS JOIN tables t ON t.id = ts.table_id
       WHERE ts.status = 'seated' AND t.status = 'closed' GROUP BY ts.table_id LIMIT 10`],
];

describe('open seat lookups', () => {
  it('one member\'s open seats are found through the open-seat index, never through every seat they ever closed', () => {
    const db = migrated();
    for (const [file, inSource, sql, args] of MEMBER_SEATS) {
      if (file) expect(source(file), file).toContain(inSource);
      const plan = planOf(db, sql, args);
      expect(plan.join(' | '), sql).toContain('INDEX tsess_seated_user_idx (user_id=?)');
      expect(plan.join(' | '), sql).not.toContain('tsess_user_idx');
    }
  });

  it('a member\'s seat history still has its own index (newest first, closed seats included)', () => {
    const db = migrated();
    const plan = planOf(db, `SELECT id FROM table_sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10`, [U]);
    expect(plan.join(' | ')).toContain('INDEX tsess_user_idx (user_id=?)');
  });

  it('closed tables holding a seat are found from the open seats, not from every closed table', () => {
    const db = migrated();
    for (const [file, sql] of SEATED_ON_CLOSED) {
      expect(source(file), file).toContain(sql);
      const plan = planOf(db, sql, []);
      expect(plan.join(' | '), sql).not.toContain('tables_status_idx');
      expect(plan.find((d) => /^SCAN /.test(d)), sql).toMatch(/^SCAN (s|ts) USING COVERING INDEX tsess_(open_user_uq|seated_user_idx)\b/);
      expect(plan.join(' | '), sql).toMatch(/SEARCH t USING INDEX sqlite_autoindex_tables_1 \(id=\?\)/);
    }
  });
});
