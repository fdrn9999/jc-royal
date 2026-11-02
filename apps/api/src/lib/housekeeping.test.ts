// The daily housekeeping (lib/housekeeping.ts) on SQLite with the real migrations: which realtime outbox rows it deletes.
// The cron that runs it is in tests/integration/restart.test.ts.
import { REALTIME_OUTBOX_RETENTION_MS } from '@jc/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { housekeeping } from './housekeeping';
import { d1Of, loadSqlite, migratedDb } from './test-sqlite';

beforeAll(loadSqlite);

const NOW = Date.parse('2026-11-02T03:00:00Z');
const MIN = 60_000;
const CUT = NOW - REALTIME_OUTBOX_RETENTION_MS;

describe('housekeeping: the realtime outbox', () => {
  it('deletes a row done before the retention line and one still pending written before it, and keeps the rest', async () => {
    const db = migratedDb();
    const row = (id: string, status: string, createdAt: number, doneAt: number | null) =>
      db
        .prepare(
          `INSERT INTO realtime_outbox (id, type, recipients, event, status, attempts, next_attempt_at, expires_at, created_at, done_at)
           VALUES (?1, 'balance', '["me"]', '{}', ?2, 1, ?3, ?3 + 1800000, ?3, ?4)`,
        )
        .run(id, status, createdAt, doneAt);
    row('sent-old', 'sent', CUT - 60 * MIN, CUT - 59 * MIN);
    row('failed-old', 'failed', CUT - 60 * MIN, CUT - 30 * MIN);
    row('expired-old', 'expired', CUT - 60 * MIN, CUT - 30 * MIN);
    row('pending-old', 'pending', CUT - 60 * MIN, null);
    // Written before the line, done (given up 30 minutes later, the most it waits) after it: it goes with the next day's run.
    row('done-across', 'failed', CUT - 10 * MIN, CUT + 20 * MIN);
    row('sent-recent', 'sent', NOW - 60 * MIN, NOW - 59 * MIN);
    row('pending-recent', 'pending', NOW - MIN, null);

    const out = await housekeeping(d1Of(db), NOW);

    const left = db.prepare('SELECT id FROM realtime_outbox ORDER BY id').all().map((r) => r.id);
    expect(left).toEqual(['done-across', 'pending-recent', 'sent-recent']);
    expect(out.realtimeEvents).toBe(4);
    await housekeeping(d1Of(db), NOW + 24 * 60 * MIN);
    expect(db.prepare('SELECT id FROM realtime_outbox ORDER BY id').all().map((r) => r.id)).toEqual(['pending-recent', 'sent-recent']);
  });
});
