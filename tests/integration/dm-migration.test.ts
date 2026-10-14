import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// Runs the real migration files on an in-memory SQLite, with rows written the way the app wrote them before seq.
const dir = new URL('../../packages/db/migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const apply = (db: DatabaseSync, file: string) => {
  for (const stmt of readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
};

describe('migration 0009_dm_seq', () => {
  it('numbers existing 1:1 messages per conversation by (time, id) and then refuses a repeated seq', () => {
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
    const at = files.findIndex((f) => f.startsWith('0009_'));
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) apply(db, f);

    const insert = db.prepare('INSERT INTO direct_messages (id, pair_key, sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    // a:b has two messages in the same millisecond (ordered by id) and one older; a:c has its own count.
    insert.run('m-x2', 'a:b', 'a', 'b', 'same ms, later id', 100);
    insert.run('m-x1', 'a:b', 'b', 'a', 'same ms, earlier id', 100);
    insert.run('m-z', 'a:b', 'a', 'b', 'oldest', 50);
    insert.run('m-c', 'a:c', 'c', 'a', 'other conversation', 75);

    apply(db, files[at]!);
    for (const f of files.slice(at + 1)) apply(db, f);

    const rows = db.prepare('SELECT pair_key AS pair, seq, id, body FROM direct_messages ORDER BY pair_key, seq').all();
    expect(rows).toEqual([
      { pair: 'a:b', seq: 1, id: 'm-z', body: 'oldest' },
      { pair: 'a:b', seq: 2, id: 'm-x1', body: 'same ms, earlier id' },
      { pair: 'a:b', seq: 3, id: 'm-x2', body: 'same ms, later id' },
      { pair: 'a:c', seq: 1, id: 'm-c', body: 'other conversation' },
    ]);
    expect(() =>
      db.prepare('INSERT INTO direct_messages (id, pair_key, sender_id, recipient_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)').run('dup', 'a:b', 'a', 'b', 'x', 200, 3),
    ).toThrow(/UNIQUE/);
  });
});
