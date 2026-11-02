// The control center's persistent alerts and operations log (docs/CONTROL_CENTER.md '지속 경고와 운영 기록'): the minute
// cron finds what D1, the counters and the rooms say is wrong, keeps it for a console opened later, ends it when it is no
// longer seen, and logs the administrators' table controls. Only table duty reads it; nothing it keeps names a member,
// repeats a typed reason or holds a card; and the daily cron forgets it after the retention period.
//
// Its own worker and state, not the shared one: the check reads the whole service (every table in play, every counter),
// and the other files' tables and failures would raise and end alerts under it.
import { resolve } from 'node:path';
import type { OpsAlertDto, OpsAlertsResponse, OpsEventsResponse, OpsIncidentResponse } from '@jc/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupBody, uniq, WEB_ORIGIN } from '../support/client';
import { d1 as d1At } from '../support/d1';
import { ALL_GRANTS, promoteSql } from '../support/grants';
import { prepareState, root, startWorker, type RunningWorker } from '../support/worker';

const ADMIN_ORIGIN = 'http://localhost:5174';
const DAY = 24 * 60 * 60_000;

let own: RunningWorker | undefined;
let where: { base: string; state: string };
let admin: Client;

beforeAll(async () => {
  const state = resolve(root, 'tests/.state/ops-log');
  await prepareState(state, [
    { id: 'it-ops-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
    { id: 'it-ops-closed', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  ]);
  own = await startWorker(8819, state);
  where = { base: own.url, state };
  admin = await staffWith(ALL_GRANTS);
}, 240_000);

afterAll(async () => {
  await own?.stop();
});

const d1 = <T = Record<string, unknown>>(sql: string) => d1At<T>(sql, where.state);

async function newUser() {
  const client = new Client(WEB_ORIGIN, where.base);
  const email = `${uniq('e')}@test.dev`;
  const r = await client.post('/api/auth/register', await signupBody(client, { email, nickname: uniq('p').slice(0, 14) }));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { client, me: r.body as { id: string; nickname: string }, email };
}

/** A member promoted to staff with these duties, signed in to the console. */
async function staffWith(grants: readonly string[]) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  const c = new Client(ADMIN_ORIGIN, where.base);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  return c;
}

/** Runs a cron of this file's api worker (local wrangler dev runs them only on request). */
async function cron(expr: string) {
  const r = await fetch(`${where.base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(expr)}`);
  expect(r.status, await r.text()).toBe(200);
}
/** The minute cron: the realtime outbox, push, then the check. */
const check = () => cron('* * * * *');

const alerts = async (query = '') => {
  const r = await admin.get<OpsAlertsResponse>(`/api/admin/monitor/alerts${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const events = async (query = '') => {
  const r = await admin.get<OpsEventsResponse>(`/api/admin/monitor/events${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const openOf = async (code: OpsAlertDto['code'], table?: string) => (await alerts('?state=open')).items.find((a) => a.code === code && (table === undefined || a.tableId === table));

describe('persistent alerts', () => {
  it('a seat left open on a closed table: raised by the check, kept for a console opened later, ended by the first check that no longer sees it', async () => {
    const member = await newUser();
    await d1(`UPDATE tables SET status = 'closed' WHERE id = 'it-ops-closed'`);
    await d1(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('ops-seat-1', 'it-ops-closed', '${member.me.id}', 0, 100, 'seated')`);
    expect(await openOf('seated_on_closed')).toBeUndefined();

    await check();
    const list = await alerts('?state=open');
    const a = list.items.find((x) => x.code === 'seated_on_closed')!;
    expect(a).toMatchObject({ tableId: 'it-ops-closed', severity: 'critical', table: { name: 'it-ops-closed', status: 'closed' }, resolvedAt: null, handling: 'new', seen: 1 });
    // The check says when it last looked, so a quiet list is not mistaken for a healthy one.
    expect(list.watch!.checkedAt).toBeGreaterThan(Date.now() - 60_000);

    // Seen again: the same alert, counted.
    await check();
    const again = (await openOf('seated_on_closed'))!;
    expect(again.id).toBe(a.id);
    expect(again.seen).toBe(2);

    const opened = (await events('?table=it-ops-closed&kind=alert_opened')).items;
    expect(opened.map((e) => e.alertId)).toEqual([a.id]);

    const inc = await admin.get<OpsIncidentResponse>(`/api/admin/monitor/alerts/${a.id}`);
    expect(inc.status).toBe(200);
    expect(inc.body.alert.id).toBe(a.id);
    expect(inc.body.table).toMatchObject({ id: 'it-ops-closed', status: 'closed' });
    expect(inc.body.table!.flags).toContain('seated_on_closed');
    expect(inc.body.events.map((e) => e.kind)).toContain('alert_opened');

    // Nothing kept or shown names the member.
    const shown = JSON.stringify([list, inc.body, await events()]);
    for (const secret of [member.me.id, member.me.nickname, member.email]) expect(shown).not.toContain(secret);
    const kept = JSON.stringify([await d1(`SELECT * FROM ops_alerts`), await d1(`SELECT * FROM ops_events`)]);
    for (const secret of [member.me.id, member.me.nickname, member.email]) expect(kept).not.toContain(secret);

    // The seat is settled: the next check ends the alert and says so.
    await d1(`UPDATE table_sessions SET status = 'closed', cash_out = 100, closed_at = ${Date.now()} WHERE id = 'ops-seat-1'`);
    await check();
    expect(await openOf('seated_on_closed')).toBeUndefined();
    const ended = (await alerts('?state=resolved&table=it-ops-closed')).items.find((x) => x.id === a.id)!;
    expect(ended.resolvedAt).not.toBeNull();
    expect((await events(`?alert=${a.id}`)).items.map((e) => e.kind)).toEqual(['alert_resolved', 'alert_opened']);
  });

  it("failed cash-outs in the counters are an error alert with the counters per minute; an administrator's note is kept, logged and audited, and does not end it", async () => {
    const bucket = Math.floor(Date.now() / 60_000) * 60_000;
    await d1(`INSERT INTO ops_metrics (bucket, metric, n) VALUES (${bucket}, 'cashout_fail', 2) ON CONFLICT (bucket, metric) DO UPDATE SET n = n + 2`);
    await check();
    const a = (await openOf('settlement_failed'))!;
    expect(a).toMatchObject({ severity: 'error', tableId: null, detail: { metric: 'cashout_fail' } });
    expect(a.detail.n).toBeGreaterThanOrEqual(2);

    const inc = (await admin.get<OpsIncidentResponse>(`/api/admin/monitor/alerts/${a.id}`)).body;
    expect(inc.table).toBeNull();
    expect(inc.metrics).toContainEqual({ bucket, metric: 'cashout_fail', n: expect.any(Number) });

    expect((await admin.post(`/api/admin/monitor/alerts/${a.id}/handling`, { handling: 'bogus' })).status).toBe(400);
    const set = await admin.post(`/api/admin/monitor/alerts/${a.id}/handling`, { handling: 'investigating' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ ok: true, changed: true });
    expect((await admin.post(`/api/admin/monitor/alerts/${a.id}/handling`, { handling: 'investigating' })).body).toEqual({ ok: true, changed: false });

    const noted = (await openOf('settlement_failed'))!;
    expect(noted).toMatchObject({ id: a.id, handling: 'investigating', resolvedAt: null });
    expect(noted.handledAt).not.toBeNull();
    const [line] = (await events(`?alert=${a.id}&kind=alert_handled`)).items;
    expect(line!.summary).toBe('handling new -> investigating');
    const [row] = await d1<{ action: string; detail: string }>(`SELECT action, detail FROM admin_audit_log WHERE id = '${line!.correlationId}'`);
    expect(row!.action).toBe('monitor.alert_handling');
    expect(JSON.parse(row!.detail)).toMatchObject({ alert: a.id, code: 'settlement_failed', from: 'new', to: 'investigating' });

    // The note is not the check's word: the alert is still open while the counters show the failures.
    await check();
    expect((await openOf('settlement_failed'))!.id).toBe(a.id);
  });

  it('a table in play is asked for its own diagnosis; a room that answers clean raises nothing', async () => {
    await d1(`UPDATE tables SET live_seated = 1, live_bots = 0, live_updated_at = ${Date.now()} WHERE id = 'it-ops-0'`);
    await check();
    const { watch } = await alerts('?state=open');
    expect(watch).toMatchObject({ rooms: 1, unanswered: 0, skipped: 0 });
    expect((await alerts('?state=open&table=it-ops-0')).items).toEqual([]);
    await d1(`UPDATE tables SET live_seated = 0 WHERE id = 'it-ops-0'`);
  });

  it("a table control is a line in the log: which control and how it ended, linked to its audit row, never who or the reason typed", async () => {
    const r1 = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const pause = await admin.post('/api/admin/tables/it-ops-0/control', { action: 'pause', reason: 'ops log check pause' });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    const [line] = (await events('?kind=admin_control&table=it-ops-0')).items;
    expect(line).toMatchObject({ code: 'table.control', tableId: 'it-ops-0', alertId: null });
    expect(line!.summary).toMatch(/^table\.control pause( saved, room did not confirm)?$/);
    expect(line!.severity).toBe(line!.summary.endsWith('confirm') ? 'warning' : 'info');
    const [row] = await d1<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM admin_audit_log WHERE id = '${line!.correlationId}'`);
    expect(row!.action).toBe('table.control');
    expect(JSON.stringify(line)).not.toContain('ops log check');
    expect(JSON.stringify(line)).not.toContain(row!.actor_id);

    expect((await admin.post('/api/admin/tables/it-ops-0/control', { action: 'resume', reason: 'ops log check done' })).status).toBe(200);
    expect((await events('?kind=admin_control&table=it-ops-0')).items.map((e) => e.summary.split(' ')[1])).toEqual(['resume', 'pause']);
  });
});

describe('who reads it, and what it refuses', () => {
  it('table duty reads and notes it; staff without it are refused everything', async () => {
    const [a] = (await alerts('?state=open')).items;
    expect(a).toBeDefined();
    const without = await staffWith(ALL_GRANTS.filter((g) => g !== 'tables'));
    for (const r of [
      await without.get('/api/admin/monitor/alerts'),
      await without.get('/api/admin/monitor/events'),
      await without.get(`/api/admin/monitor/alerts/${a!.id}`),
      await without.post(`/api/admin/monitor/alerts/${a!.id}/handling`, { handling: 'ack' }),
    ])
      expect(r.status).toBe(403);
    const reader = await staffWith(['tables']);
    expect((await reader.get('/api/admin/monitor/alerts')).status).toBe(200);
    expect((await reader.get(`/api/admin/monitor/alerts/${a!.id}`)).status).toBe(200);
    // A member's session is not a console session.
    const member = await newUser();
    expect((await new Client(ADMIN_ORIGIN, where.base).get('/api/admin/monitor/alerts')).status).toBe(401);
    expect((await member.client.get('/api/admin/monitor/alerts')).status).not.toBe(200);
  });

  it('an unknown filter is refused, not ignored; an unknown alert is not found', async () => {
    for (const q of ['?state=bogus', '?severity=loud', '?code=nope', '?limit=-1']) expect((await admin.get(`/api/admin/monitor/alerts${q}`)).status, q).toBe(400);
    for (const q of ['?kind=bogus', '?code=DROP%20TABLE', '?from=x']) expect((await admin.get(`/api/admin/monitor/events${q}`)).status, q).toBe(400);
    expect((await admin.get('/api/admin/monitor/alerts/no-such-alert')).status).toBe(404);
    expect((await admin.post('/api/admin/monitor/alerts/no-such-alert/handling', { handling: 'ack' })).status).toBe(404);
  });

  it('pages of the log follow each other without a gap or a repeat', async () => {
    const all = (await events('?limit=100')).items;
    expect(all.length).toBeGreaterThanOrEqual(4);
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const page = await events(`?limit=2${cursor}`);
      seen.push(...page.items.map((e) => e.id));
      if (page.nextBefore === null) break;
      cursor = `&before=${page.nextBefore}&beforeId=${page.nextBeforeId}`;
    }
    expect(seen).toEqual(all.map((e) => e.id));
  });
});

describe('retention', () => {
  it('the daily cron forgets log lines and ended alerts past 90 days, and an unconfirmed sighting after a day; it keeps what is open', async () => {
    const now = Date.now();
    const old = now - 91 * DAY;
    await d1(
      `INSERT INTO ops_events (id, at, kind, code, severity, table_id, summary) VALUES ('ops-old-ev', ${old}, 'alert_opened', 'server_errors', 'warning', NULL, 'old');
       INSERT INTO ops_alerts (id, dedupe_key, code, severity, table_id, summary, first_seen_at, confirmed_at, last_seen_at, seen, resolved_at, handling)
         VALUES ('ops-old-end', 'server_errors:old', 'server_errors', 'warning', NULL, 'old', ${old}, ${old}, ${old}, 1, ${old}, 'new'),
                ('ops-old-open', 'close_overdue:old', 'close_overdue', 'warning', NULL, 'still open', ${old}, ${old}, ${now}, 9, NULL, 'new'),
                ('ops-unconfirmed', 'table_stale:old', 'table_stale', 'warning', NULL, 'once', ${now - 2 * DAY}, NULL, ${now - 2 * DAY}, 1, NULL, 'new');`,
    );
    await cron('30 18 * * *');
    const left = (await d1<{ id: string }>(`SELECT id FROM ops_alerts WHERE id LIKE 'ops-%' UNION ALL SELECT id FROM ops_events WHERE id LIKE 'ops-%'`)).map((r) => r.id);
    expect(left).toEqual(['ops-old-open']);
    // The recent log stays.
    expect((await events()).items.length).toBeGreaterThan(0);
  });
});
