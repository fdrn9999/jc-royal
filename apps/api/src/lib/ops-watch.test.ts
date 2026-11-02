// The control center's persistent alerts (lib/ops-watch.ts): what one minute check opens, counts, raises and resolves
// in ops_alerts and logs in ops_events, on SQLite with the real migrations and a stand-in for the rooms' answers. The
// cron, the admin routes and the console are in tests/integration/ops-log.test.ts.
import { opsBucket } from '@jc/db';
import type { MonitorRoom, OpsSeverity } from '@jc/types';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { changeStatements, controlEvent, OPS_THRESHOLDS, OPS_WATCH_ROOMS_MAX, reconcile, watchOps, type OpenAlert, type Observation } from './ops-watch';
import { d1Of, loadSqlite, migratedDb, type SqliteDb } from './test-sqlite';

beforeAll(loadSqlite);

const NOW = Date.parse('2026-11-02T03:00:00Z');
const MIN = 60_000;

type Answer = MonitorRoom | null | Error;
const room = (...issues: string[]) => ({ status: 'waiting', issues }) as unknown as MonitorRoom;

function setup() {
  const db = migratedDb();
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash) VALUES ('me', 'me@test.dev', 'Nickname Kim', 'x')`).run();
  const d1 = d1Of(db);
  const env = { DB: d1 } as unknown as Env;
  /** What each room answers this check (unlisted: a quiet room). */
  let answers: Record<string, Answer> = {};
  const asked: string[] = [];
  const check = async (at: number, a: Record<string, Answer> = {}) => {
    answers = a;
    asked.length = 0;
    return watchOps(env, at, async (id) => {
      asked.push(id);
      const r = id in answers ? answers[id]! : room();
      if (r instanceof Error) throw r;
      return r;
    });
  };
  const alerts = () =>
    db.prepare(`SELECT code, severity, table_id, detail, confirmed_at, resolved_at, seen FROM ops_alerts ORDER BY first_seen_at, code`).all() as {
      code: string;
      severity: OpsSeverity;
      table_id: string | null;
      detail: string;
      confirmed_at: number | null;
      resolved_at: number | null;
      seen: number;
    }[];
  const open = () => alerts().filter((a) => a.resolved_at === null && a.confirmed_at !== null);
  const events = () => db.prepare(`SELECT kind, code, severity, table_id, summary, alert_id FROM ops_events ORDER BY at, rowid`).all() as Record<string, string>[];
  return { db, d1, env, check, alerts, open, events, asked };
}

/** An open table; `playing`: a hand runs, `members`: members seated (beside `bots`). */
function table(db: SqliteDb, id: string, o: { status?: string; playing?: boolean; members?: number; bots?: number; updatedAt?: number } = {}) {
  const seated = (o.members ?? 0) + (o.bots ?? 0);
  db.prepare(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, live_playing, live_seated, live_bots, updated_at)
     VALUES (?1, ?1, 6, 1, 2, 40, 200, ?2, ?3, ?4, ?5, ?6)`,
  ).run(id, o.status ?? 'open', o.playing ? 1 : 0, seated, o.bots ?? 0, o.updatedAt ?? NOW - 60 * MIN);
}
const metric = (db: SqliteDb, at: number, name: string, n: number) =>
  db.prepare(`INSERT INTO ops_metrics (bucket, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT DO UPDATE SET n = n + excluded.n`).run(opsBucket(at), name, n);

describe('alerts from D1', () => {
  it('a closed table with seated rows is critical at once, counted while it lasts, resolved when the seats are gone', async () => {
    const { db, check, open, events, alerts } = setup();
    table(db, 'tclosed00001', { status: 'closed' });
    db.prepare(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in) VALUES ('s1', 'tclosed00001', 'me', 0, 100)`).run();

    expect(await check(NOW)).toMatchObject({ opened: 1, resolved: 0 });
    expect(open()).toMatchObject([{ code: 'seated_on_closed', severity: 'critical', table_id: 'tclosed00001', seen: 1 }]);
    await check(NOW + MIN);
    expect(open()).toMatchObject([{ seen: 2 }]);
    expect(events().map((e) => e.kind)).toEqual(['alert_opened']);

    db.prepare(`UPDATE table_sessions SET status = 'closed'`).run();
    expect(await check(NOW + 2 * MIN)).toMatchObject({ opened: 0, resolved: 1 });
    expect(open()).toEqual([]);
    expect(alerts()).toMatchObject([{ resolved_at: NOW + 2 * MIN }]);
    expect(events().map((e) => [e.kind, e.code, e.table_id])).toEqual([
      ['alert_opened', 'seated_on_closed', 'tclosed00001'],
      ['alert_resolved', 'seated_on_closed', 'tclosed00001'],
    ]);

    // It comes back: a new alert, not the old one reopened.
    db.prepare(`UPDATE table_sessions SET status = 'seated'`).run();
    await check(NOW + 3 * MIN);
    expect(alerts()).toHaveLength(2);
    expect(open()).toHaveLength(1);
  });

  it('a close unfinished past the sweep limit is an error, with how late it is', async () => {
    const { db, check, open } = setup();
    table(db, 'tclosing0001', { status: 'closing', updatedAt: NOW - 14 * MIN });
    table(db, 'tclosing0002', { status: 'closing', updatedAt: NOW - 20 * MIN });
    await check(NOW);
    expect(open()).toMatchObject([{ code: 'close_overdue', severity: 'error', table_id: 'tclosing0002' }]);
    expect(JSON.parse(open()[0]!.detail)).toEqual({ sinceMs: 20 * MIN });
  });
});

describe('alerts from the rooms', () => {
  it('asks only the tables in play: a hand running, or a member seated (bots alone are not)', async () => {
    const { db, check, asked } = setup();
    table(db, 'tplaying0001', { playing: true, bots: 2 });
    table(db, 'tmember00001', { members: 1 });
    table(db, 'tbotsonly001', { bots: 3 });
    table(db, 'tempty000001');
    table(db, 'tclosedp0001', { status: 'closed', playing: true });
    await check(NOW);
    expect(asked.sort()).toEqual(['tmember00001', 'tplaying0001']);
  });

  it('a late turn is critical from its first sighting; a seat being bought into only when the next check still sees it', async () => {
    const { db, check, open, alerts, events } = setup();
    table(db, 'tplay0000001', { playing: true, members: 2 });
    await check(NOW, { tplay0000001: room('turn_overdue', 'pending_seat') });
    expect(open()).toMatchObject([{ code: 'room_issue', severity: 'critical', detail: '{"issue":"turn_overdue"}' }]);
    // The bought-into seat waits for a second look: in the table, not shown, not logged.
    expect(alerts().find((a) => a.detail.includes('pending_seat'))).toMatchObject({ confirmed_at: null });
    expect(events()).toHaveLength(1);

    await check(NOW + MIN, { tplay0000001: room('turn_overdue', 'pending_seat') });
    expect(open().map((a) => [JSON.parse(a.detail).issue, a.severity]).sort()).toEqual([
      ['pending_seat', 'warning'],
      ['turn_overdue', 'critical'],
    ]);
    expect(events().map((e) => e.kind)).toEqual(['alert_opened', 'alert_opened']);

    // The room answers clean: both end, and each line says which issue ended.
    expect(await check(NOW + 2 * MIN)).toMatchObject({ resolved: 2 });
    expect(open()).toEqual([]);
    expect(events().filter((e) => e.kind === 'alert_resolved').map((e) => e.summary).sort()).toEqual([
      'room reports pending_seat: no longer seen',
      'room reports turn_overdue: no longer seen',
    ]);
  });

  it('a transient state gone by the next check leaves no alert and no log line', async () => {
    const { db, check, alerts, events } = setup();
    table(db, 'tplay0000001', { playing: true, members: 2 });
    await check(NOW, { tplay0000001: room('cashing_seat') });
    expect(alerts()).toHaveLength(1);
    await check(NOW + MIN);
    expect(alerts()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('a room that does not answer: stale on the second check, critical after ten minutes, and what it reported stays open', async () => {
    const { db, check, open, events } = setup();
    table(db, 'tplay0000001', { playing: true, members: 2 });
    await check(NOW, { tplay0000001: room('stalled_hand') });
    await check(NOW + MIN, { tplay0000001: null });
    // One miss is not yet stale; the stalled hand it reported is not resolved by the silence.
    expect(open().map((a) => a.code)).toEqual(['room_issue']);
    await check(NOW + 2 * MIN, { tplay0000001: new Error('unreachable') });
    expect(open().map((a) => [a.code, a.severity])).toEqual([
      ['room_issue', 'critical'],
      ['table_stale', 'error'],
    ]);
    await check(NOW + 11 * MIN, { tplay0000001: null });
    expect(open().find((a) => a.code === 'table_stale')).toMatchObject({ severity: 'error' });
    await check(NOW + 12 * MIN, { tplay0000001: null });
    expect(open().find((a) => a.code === 'table_stale')).toMatchObject({ severity: 'critical', seen: 4 });
    expect(events().map((e) => `${e.kind} ${e.code} ${e.severity}`)).toEqual([
      'alert_opened room_issue critical',
      'alert_opened table_stale error',
      'alert_raised table_stale critical',
    ]);

    // It answers again, without the stalled hand: both end.
    await check(NOW + 13 * MIN);
    expect(open()).toEqual([]);
  });

  it('a table no longer in play ends its room alerts without being asked', async () => {
    const { db, check, open, asked } = setup();
    table(db, 'tplay0000001', { playing: true, members: 2 });
    await check(NOW, { tplay0000001: room('stalled_hand') });
    db.prepare(`UPDATE tables SET status = 'closed', live_playing = 0, live_seated = 0`).run();
    expect(await check(NOW + MIN)).toMatchObject({ resolved: 1 });
    expect(asked).toEqual([]);
    expect(open()).toEqual([]);
  });

  it(`asks at most ${OPS_WATCH_ROOMS_MAX} rooms, tables with an open alert first, and leaves the alerts of the rest as they are`, async () => {
    const { db, check, open, asked } = setup();
    for (let i = 0; i < OPS_WATCH_ROOMS_MAX + 5; i++) table(db, `tmany${String(i).padStart(7, '0')}`, { members: 1 });
    // An open alert on the table that sorts last (least recently written).
    db.prepare(`UPDATE tables SET live_updated_at = CASE id WHEN 'tmany0000044' THEN 1 ELSE 2 END`).run();
    db.prepare(
      `INSERT INTO ops_alerts (id, dedupe_key, code, severity, table_id, summary, first_seen_at, confirmed_at, last_seen_at)
       VALUES ('a1', 'room_issue:stalled_hand:tmany0000044', 'room_issue', 'critical', 'tmany0000044', 's', ?1, ?1, ?1)`,
    ).run(NOW - MIN);
    await check(NOW, { tmany0000044: room('stalled_hand') });
    expect(asked).toHaveLength(OPS_WATCH_ROOMS_MAX);
    expect(asked).toContain('tmany0000044');
    expect(db.prepare(`SELECT rooms, unanswered, skipped FROM ops_watch`).all()).toEqual([{ rooms: OPS_WATCH_ROOMS_MAX, unanswered: 0, skipped: 5 }]);
    expect(open().map((a) => a.table_id)).toEqual(['tmany0000044']);
  });
});

describe('alerts from the counters', () => {
  it('counts the last five minutes only; a failed cash-out is an error at once', async () => {
    const { db, check, open } = setup();
    metric(db, NOW - 6 * MIN, 'cashout_fail', 3);
    await check(NOW);
    expect(open()).toEqual([]);
    metric(db, NOW - 4 * MIN, 'cashout_fail', 1);
    await check(NOW);
    expect(open()).toMatchObject([{ code: 'settlement_failed', severity: 'error', table_id: null }]);
    expect(JSON.parse(open()[0]!.detail)).toEqual({ metric: 'cashout_fail', n: 1, threshold: 1, windowMs: 5 * MIN });
    // Five minutes on, the failure is out of the window: resolved.
    await check(NOW + 5 * MIN);
    expect(open()).toEqual([]);
  });

  it('server errors: a warning past the first threshold, raised to an error past the second, never lowered while open', async () => {
    const { db, check, open, events } = setup();
    metric(db, NOW, 'api_error', OPS_THRESHOLDS.serverErrors.warning - 1);
    await check(NOW);
    expect(open()).toEqual([]);
    metric(db, NOW, 'room_error', 1);
    await check(NOW);
    expect(open()).toMatchObject([{ code: 'server_errors', severity: 'warning' }]);
    metric(db, NOW + MIN, 'api_error', OPS_THRESHOLDS.serverErrors.error);
    await check(NOW + MIN);
    expect(open()).toMatchObject([{ severity: 'error' }]);
    // Fewer errors, still past the first threshold: still open, still an error.
    db.prepare(`DELETE FROM ops_metrics`).run();
    metric(db, NOW + 6 * MIN, 'api_error', OPS_THRESHOLDS.serverErrors.warning);
    await check(NOW + 6 * MIN);
    expect(open()).toMatchObject([{ severity: 'error' }]);
    expect(events().map((e) => `${e.kind} ${e.severity}`)).toEqual(['alert_opened warning', 'alert_raised error']);
  });

  it('delivery failures, reconnect surges and an outbox backlog', async () => {
    const { db, check, open } = setup();
    metric(db, NOW, 'rt_outbox_retry', OPS_THRESHOLDS.delivery.warning);
    metric(db, NOW, 'ws_retry', OPS_THRESHOLDS.reconnects.warning);
    db.prepare(
      `INSERT INTO realtime_outbox (id, type, event, next_attempt_at, expires_at, created_at) VALUES ('e1', 'x', '{}', ?1, ?2, ?3), ('e2', 'x', '{}', ?1, ?2, ?1)`,
    ).run(NOW, NOW + 60 * MIN, NOW - 6 * MIN);
    await check(NOW);
    expect(open().map((a) => [a.code, a.severity])).toEqual([
      ['delivery_failed', 'warning'],
      ['outbox_backlog', 'warning'],
      ['reconnect_surge', 'warning'],
    ]);
    expect(JSON.parse(open()[1]!.detail)).toEqual({ n: 1 });
    metric(db, NOW, 'rt_outbox_failed', 1);
    await check(NOW);
    expect(open().find((a) => a.code === 'delivery_failed')).toMatchObject({ severity: 'error' });
  });
});

describe('the log', () => {
  it('two checks from the same view (a slow one overlapping the next) open a problem once and log it once', async () => {
    const { d1, db, events } = setup();
    const seen: Observation[] = [{ code: 'seated_on_closed', severity: 'critical', tableId: 't1', detail: {} }];
    let n = 0;
    const id = () => `id${++n}`;
    const first = reconcile([], seen, new Set(['tables']), id);
    const second = reconcile([], seen, new Set(['tables']), id);
    await d1.batch(changeStatements(d1, first, NOW, id));
    await d1.batch(changeStatements(d1, second, NOW, id));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ops_alerts`).all()).toEqual([{ n: 1 }]);
    expect(events()).toHaveLength(1);

    // Two resolving it: one log line.
    const open = db.prepare(`SELECT id, dedupe_key, code, severity, table_id, confirmed_at FROM ops_alerts`).all() as unknown as OpenAlert[];
    for (let i = 0; i < 2; i++) await d1.batch(changeStatements(d1, reconcile(open, [], new Set(['tables']), id), NOW + MIN, id));
    expect(events().map((e) => e.kind)).toEqual(['alert_opened', 'alert_resolved']);
  });

  it('keeps codes, ids and counts only: no nickname, no card, no reason', async () => {
    const { db, check, events, alerts } = setup();
    table(db, 'tplay0000001', { playing: true, members: 1 });
    table(db, 'tclosed00001', { status: 'closed' });
    db.prepare(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in) VALUES ('s1', 'tclosed00001', 'me', 0, 100)`).run();
    metric(db, NOW, 'cashout_fail', 2);
    await check(NOW, { tplay0000001: { ...room('stalled_hand'), seats: [{ nickname: 'Nickname Kim' }], hand: { board: ['As', 'Kd'] } } as unknown as MonitorRoom });
    const text = JSON.stringify([events(), alerts()]);
    expect(text).not.toContain('Nickname');
    expect(text).not.toContain('Kd');
    expect(events().map((e) => e.summary)).toEqual(['closed table still has seated rows', 'room reports stalled_hand', 'cashout_fail 2 in 5 min']);
  });

  it('records when the check last ran and how many rooms did not answer', async () => {
    const { db, check } = setup();
    table(db, 'tplay0000001', { playing: true, members: 1 });
    table(db, 'tplay0000002', { playing: true, members: 1 });
    await check(NOW, { tplay0000002: null });
    expect(db.prepare(`SELECT checked_at, rooms, unanswered, skipped FROM ops_watch`).all()).toEqual([{ checked_at: NOW, rooms: 2, unanswered: 1, skipped: 0 }]);
  });

  it("an administrator's table control: which control and whether the room took it, never the reason typed", () => {
    const t = { type: 'table', id: 'tplay0000001' };
    expect(controlEvent('table.control', t, { action: 'pause', reason: '점검 Nickname Kim', roomConfirmed: true }, 'ok')).toEqual({
      code: 'table.control',
      severity: 'info',
      tableId: 'tplay0000001',
      summary: 'table.control pause',
    });
    expect(controlEvent('table.close', t, { roomConfirmed: false, reason: 'secret' }, 'ok')).toMatchObject({ severity: 'warning', summary: 'table.close saved, room did not confirm' });
    expect(controlEvent('table.timer_recover.failed', t, { status: 403, code: 'forbidden', message: 'no' }, 'failed')).toMatchObject({
      code: 'table.timer_recover',
      severity: 'warning',
      summary: 'table.timer_recover failed 403 forbidden',
    });
    // A failure without a status, or with a code that is not a plain word, says only what it has.
    expect(controlEvent('table.close.failed', t, { code: 'still_seated' }, 'failed')!.summary).toBe('table.close failed still_seated');
    expect(controlEvent('table.close.failed', t, { status: 500, code: 'Oops!' }, 'failed')!.summary).toBe('table.close failed 500');
    // Not a table control, or not on a table: no line.
    expect(controlEvent('user.chips', { type: 'user', id: 'u1' }, {}, 'ok')).toBeNull();
    expect(controlEvent('table.control', undefined, {}, 'ok')).toBeNull();
    // A value that is not a plain code is left out.
    expect(controlEvent('table.control', t, { action: 'pause; DROP TABLE' }, 'ok')!.summary).toBe('table.control');
  });
});
