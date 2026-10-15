// Chip economy: reconciliation that keeps one event per mismatch, adjustments that are refused or repeated, the policy
// on large adjustments, the economy page's figures and anomalies, a mismatch's evidence and its explicit correction.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
/** The bootstrapped super admin. */
const admin = sharedAdmin();

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

let plain: Promise<{ c: Client; id: string }> | null = null;
function plainAdmin() {
  plain ??= (async () => {
    const u = await newUser();
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${u.me.id}'`);
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return { c, id: u.me.id };
  })();
  return plain;
}

type Ev = { id: string; scope: string; subjectId: string; expected: number; actual: number; resolvedAt: number | null; resolution: string | null; detail: string | null };
const events = async (subject: string) => ((await admin.get('/api/admin/reconcile')).body as Ev[]).filter((e) => e.subjectId === subject);
const openEvents = async (subject: string) => (await events(subject)).filter((e) => !e.resolvedAt);
const key = () => `k-${crypto.randomUUID()}`;
const grant = async (id: string, amount: number, c: Client = admin, idempotencyKey = key()) => {
  await reauth(c);
  return c.post(`/api/admin/users/${id}/chips`, { amount, memo: 'economy test', idempotencyKey });
};
const audits = (action: string, targetId: string) => d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}'`);
const balance = async (id: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${id}'`))[0]!.balance;
const ledger = (id: string) => d1<{ type: string; amount: number; balance_after: number; idempotency_key: string; memo: string | null }>(`SELECT type, amount, balance_after, idempotency_key, memo FROM chip_ledger WHERE user_id = '${id}' ORDER BY created_at, rowid`);
const resolve = async (id: string, body: { note: string; action?: string }, c: Client = admin) => {
  await reauth(c);
  return c.post(`/api/admin/reconcile/${id}/resolve`, body);
};
/** Corrupts a wallet outside the ledger and has reconciliation record it; returns the member and the event. */
async function mismatch(change: number) {
  const u = await newUser();
  await d1(`UPDATE users SET balance = balance + ${change} WHERE id = '${u.me.id}'`);
  await admin.post('/api/admin/reconcile/run', {});
  const [ev] = await openEvents(u.me.id);
  expect(ev).toBeTruthy();
  return { u, ev: ev! };
}

interface Flow { n: number; sum: number; plus: number; minus: number }
interface Economy {
  wallets: { balance: number };
  tables: { chips: number };
  issued: { signup: number; admin: number; reconcile: number; total: number };
  gap: number;
  period: { counts: Record<string, Flow>; moved: number; series: { n: number; moved: number }[] };
  reconciliation: { open: Record<string, number>; lastRun: { at: number; mismatches: number | null } | null };
  failures: { cashout: number; room: number };
  anomalies: {
    rapidGrants: { userId: string; count: number; sum: number }[];
    largeAdjustments: { userId: string; amount: number }[];
    refused: { action: string; userId: string; detail: { reason?: string; amount?: number } | null }[];
    staleSessions: { id: string; reason: string }[];
  };
  rowsRead: number;
}
async function economy(days = 7): Promise<Economy> {
  const r = await admin.get(`/api/admin/economy?days=${days}&tz=540`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Economy;
}

/** Polls until `ok` holds: rooms write their counters with their next stats write (within 10 s when idle). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(v).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const sockets: TableSocket[] = [];
const cleanup: string[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (cleanup.length) await d1(cleanup.join('; '));
});

describe('reconciliation events', () => {
  it('keeps one open event for a mismatch while the member keeps playing', async () => {
    const u = await newUser();
    await d1(`UPDATE users SET balance = balance + 777 WHERE id = '${u.me.id}'`);
    await admin.post('/api/admin/reconcile/run', {});
    expect(await openEvents(u.me.id)).toHaveLength(1);
    // Balance and ledger move together (a grant, a buy-in): the difference is the same mismatch.
    expect((await grant(u.me.id, 100)).status).toBe(200);
    await admin.post('/api/admin/reconcile/run', {});
    expect(await openEvents(u.me.id)).toHaveLength(1);
  });

  it('does not reopen a mismatch an administrator acknowledged with a note', async () => {
    const u = await newUser();
    await d1(`UPDATE users SET balance = balance + 55 WHERE id = '${u.me.id}'`);
    await admin.post('/api/admin/reconcile/run', {});
    const [ev] = await openEvents(u.me.id);
    await reauth();
    expect((await admin.post(`/api/admin/reconcile/${ev!.id}/resolve`, { note: 'known test change' })).status).toBe(200);
    await admin.post('/api/admin/reconcile/run', {});
    expect(await openEvents(u.me.id)).toHaveLength(0);
  });

  it('records a table whose open sessions the room does not hold once while it lasts', async () => {
    const u = await newUser();
    const sess = `econ-${crypto.randomUUID()}`;
    await d1(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${sess}', 'it-econ-0', '${u.me.id}', 0, 100, 'seated')`);
    try {
      await admin.post('/api/admin/reconcile/run', {});
      await admin.post('/api/admin/reconcile/run', {});
      expect(await openEvents('it-econ-0')).toHaveLength(1);
    } finally {
      await d1(`UPDATE table_sessions SET status = 'closed', closed_at = ${Date.now()} WHERE id = '${sess}'`);
    }
  });
});

describe('chip adjustments', () => {
  it('records refused and repeated adjustments', async () => {
    const u = await newUser();
    const k = key();
    expect((await grant(u.me.id, 10, admin, k)).body).toMatchObject({ duplicate: false });
    expect((await grant(u.me.id, 10, admin, k)).body).toMatchObject({ duplicate: true });
    expect(await audits('user.chips_duplicate', u.me.id)).toHaveLength(1);
    expect((await grant(u.me.id, -999_999)).status).toBe(409);
    expect(await audits('user.chips_refused', u.me.id)).toHaveLength(1);
  });

  it('leaves large adjustments to a super admin', async () => {
    const u = await newUser();
    const p = await plainAdmin();
    const r = await grant(u.me.id, 100_000, p.c);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('large_adjustment');
    // Below the line a plain admin still adjusts; a super admin adjusts any amount the schema takes.
    expect((await grant(u.me.id, 99_999, p.c)).status).toBe(200);
    expect((await grant(u.me.id, 100_000)).status).toBe(200);
    expect(await balance(u.me.id)).toBe(u.me.balance + 199_999);
  });
});

describe('economy page', () => {
  it('adds new chips to what was issued and a wallet change without a ledger row to the gap', async () => {
    const before = await economy();
    const u = await newUser();
    expect((await grant(u.me.id, 1234)).status).toBe(200);
    await d1(`UPDATE users SET balance = balance + 321 WHERE id = '${u.me.id}'`);
    const after = await economy();
    // Rooms left by earlier files may still stand players up meanwhile: those move wallets and tables, never these.
    expect(after.issued.signup - before.issued.signup).toBe(u.me.balance);
    expect(after.issued.admin - before.issued.admin).toBe(1234);
    expect(after.gap - before.gap).toBe(321);
    expect(after.period.counts.signup_grant!.n - before.period.counts.signup_grant!.n).toBe(1);
    expect(after.period.counts.admin_adjust!.n - before.period.counts.admin_adjust!.n).toBe(1);
    expect(after.period.counts.admin_adjust!.plus - before.period.counts.admin_adjust!.plus).toBe(1234);
    // Everything in wallets and on tables is what was issued, plus what changed off the ledger.
    expect(after.wallets.balance + after.tables.chips).toBe(after.issued.total + after.gap);
    expect(after.period.series).toHaveLength(7);
    expect(after.period.series.reduce((s, d) => s + d.moved, 0)).toBe(after.period.moved);
    expect(after.rowsRead).toBeGreaterThan(0);
    expect((await economy(90)).period.series).toHaveLength(90);
    // Another period falls back to 7 days.
    expect((await admin.get('/api/admin/economy?days=5')).body.days).toBe(7);
    // Any administrator reads it; a member does not.
    expect((await (await plainAdmin()).c.get('/api/admin/economy?days=30')).status).toBe(200);
    expect((await u.client.get('/api/admin/economy')).status).toBe(403);
  });

  it('lists repeated grants, large adjustments and refused or repeated requests', async () => {
    const u = await newUser();
    for (const amount of [100, 200, 300]) expect((await grant(u.me.id, amount)).status).toBe(200);
    const big = await newUser();
    expect((await grant(big.me.id, 100_000)).status).toBe(200);
    const k = key();
    await grant(big.me.id, 5, admin, k);
    await grant(big.me.id, 5, admin, k);
    await grant(big.me.id, 100_000, (await plainAdmin()).c);
    const e = await economy();
    expect(e.anomalies.rapidGrants).toContainEqual(expect.objectContaining({ userId: u.me.id, count: 3, sum: 600 }));
    expect(e.anomalies.rapidGrants.some((r) => r.userId === big.me.id)).toBe(false);
    expect(e.anomalies.largeAdjustments).toContainEqual(expect.objectContaining({ userId: big.me.id, amount: 100_000 }));
    const mine = e.anomalies.refused.filter((r) => r.userId === big.me.id);
    expect(mine.map((r) => [r.action, r.detail?.reason ?? null, r.detail?.amount]).sort()).toEqual([
      ['user.chips_duplicate', null, 5],
      ['user.chips_refused', 'large_adjustment', 100_000],
    ]);
  });

  it('lists seats left on closed or closing tables and seats held for long', async () => {
    const tag = uniq('econ');
    const u = await newUser();
    const other = await newUser();
    const now = Date.now();
    await d1(
      [
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('${tag}-closed', 'econ closed', 6, 5, 10, 100, 1000, 'closed')`,
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, entry_blocked, updated_at) VALUES ('${tag}-closing', 'econ closing', 6, 5, 10, 100, 1000, 'closing', 1, ${now - 20 * 60_000})`,
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('${tag}-open', 'econ open', 6, 5, 10, 100, 1000, 'open')`,
        `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${tag}-a', '${tag}-closed', '${u.me.id}', 0, 300, 'seated')`,
        `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${tag}-b', '${tag}-closing', '${u.me.id}', 0, 300, 'seated')`,
        `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status, created_at) VALUES ('${tag}-c', '${tag}-open', '${u.me.id}', 0, 300, 'seated', ${now - 13 * 3_600_000})`,
        `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${tag}-d', '${tag}-open', '${other.me.id}', 1, 300, 'seated')`,
      ].join('; '),
    );
    cleanup.push(`DELETE FROM table_sessions WHERE id LIKE '${tag}-%'`, `DELETE FROM tables WHERE id LIKE '${tag}-%'`);
    try {
      const stale = (await economy()).anomalies.staleSessions.filter((s) => s.id.startsWith(tag));
      expect(stale.map((s) => [s.id, s.reason]).sort()).toEqual([
        [`${tag}-a`, 'closed_table'],
        [`${tag}-b`, 'closing_table'],
        [`${tag}-c`, 'long'],
      ]);
    } finally {
      // Closed before the next reconciliation run, which would otherwise raise these tables.
      await d1(cleanup.splice(0).join('; '));
    }
  });

  it('counts a cash-out that failed, and the seat is paid once when it is retried', async () => {
    const before = await economy();
    const u = await newUser();
    const ws = await TableSocket.open(u.client, 'it-econ-1');
    sockets.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await ws.waitState((s) => s.you.seatIndex === 0);
    await eventually(() => balance(u.me.id), (b) => b === u.me.balance - 300, 'buy-in taken');
    const release = holdD1WriteLock();
    try {
      expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      release();
    }
    const e = await eventually(economy, (x) => x.failures.cashout >= before.failures.cashout + 1, 'cashout_fail +1');
    expect(e.failures.cashout).toBe(before.failures.cashout + 1);
    // Standing up again pays the stack back, once.
    expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(await balance(u.me.id)).toBe(u.me.balance);
    expect((await ledger(u.me.id)).filter((r) => r.type === 'cash_out')).toHaveLength(1);
  });
});

describe('mismatch evidence and correction', () => {
  it('shows where the wallet left its ledger', async () => {
    const u = await newUser();
    expect((await grant(u.me.id, 100)).status).toBe(200);
    await d1(`UPDATE users SET balance = balance + 40 WHERE id = '${u.me.id}'`);
    expect((await grant(u.me.id, 10)).status).toBe(200);
    await admin.post('/api/admin/reconcile/run', {});
    const [ev] = await openEvents(u.me.id);
    const r = await admin.get(`/api/admin/reconcile/${ev!.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.member).toMatchObject({ id: u.me.id, balance: u.me.balance + 150 });
    expect(r.body.ledger).toMatchObject({ count: 3, sum: u.me.balance + 110, truncated: false });
    expect(r.body.difference).toEqual({ event: 40, current: 40 });
    // The +40 happened between the first grant and the second: the second row left 40 more than it should.
    expect(r.body.breakCount).toBe(1);
    expect(r.body.breaks[0]).toMatchObject({ type: 'admin_adjust', amount: 10, expected: u.me.balance + 110, difference: 40 });
    expect(r.body.afterLast.amount).toBe(0);
    expect(r.body.recent).toHaveLength(3);
    // A change after the latest row shows there, and the event's difference is no longer the wallet's.
    await d1(`UPDATE users SET balance = balance + 5 WHERE id = '${u.me.id}'`);
    const r2 = await admin.get(`/api/admin/reconcile/${ev!.id}`);
    expect(r2.body.difference).toEqual({ event: 40, current: 45 });
    expect(r2.body.afterLast.amount).toBe(5);
    expect((await resolve(ev!.id, { action: 'record', note: 'after it moved' })).body.error?.code).toBe('reconcile_stale');
    expect(await balance(u.me.id)).toBe(u.me.balance + 155);
  });

  it('records a difference in the ledger without changing the balance', async () => {
    const { u, ev } = await mismatch(30);
    const b = await balance(u.me.id);
    const r = await resolve(ev.id, { action: 'record', note: 'gift the member keeps' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: 'record', balanceAfter: b });
    expect(r.body.ledgerIds).toHaveLength(1);
    expect(await balance(u.me.id)).toBe(b);
    const rows = await ledger(u.me.id);
    expect(rows.at(-1)).toMatchObject({ type: 'reconcile', amount: 30, balance_after: b, idempotency_key: `reconcile:${ev.id}:record`, memo: 'recorded difference' });
    expect(rows.reduce((s, x) => s + x.amount, 0)).toBe(b);
    await admin.post('/api/admin/reconcile/run', {});
    expect(await openEvents(u.me.id)).toHaveLength(0);
    expect((await events(u.me.id))[0]).toMatchObject({ resolution: 'record' });
    expect((await events(u.me.id))[0]!.detail).toContain(' | record: gift the member keeps');
    const [a] = await audits('user.reconcile', u.me.id);
    expect(JSON.parse(a!.detail)).toMatchObject({ eventId: ev.id, action: 'record', difference: 30, balanceBefore: b, balanceAfter: b });
    // One correction per event, whichever is asked next.
    expect((await resolve(ev.id, { action: 'revert', note: 'and again' })).body.error.code).toBe('already_resolved');
    expect((await resolve(ev.id, { action: 'record', note: 'and again' })).body.error.code).toBe('already_resolved');
    expect(await ledger(u.me.id)).toHaveLength(rows.length);
    const evidence = (await admin.get(`/api/admin/reconcile/${ev.id}`)).body;
    expect(evidence.difference.current).toBe(0);
    expect(evidence.recorded).toBe(30);
    expect(evidence.corrections).toHaveLength(1);
  });

  it('reverts a balance to its ledger after a note, and tells the member', async () => {
    const { u, ev } = await mismatch(60);
    const b = await balance(u.me.id);
    // Acknowledged first; a super admin can still correct it.
    expect((await resolve(ev.id, { note: 'looking into it' })).status).toBe(200);
    const r = await resolve(ev.id, { action: 'revert', note: 'not from any grant' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: 'revert', balanceAfter: b - 60 });
    expect(await balance(u.me.id)).toBe(b - 60);
    const rows = await ledger(u.me.id);
    expect(rows.slice(-2)).toMatchObject([
      { type: 'reconcile', amount: 60, balance_after: b, memo: 'recorded difference' },
      { type: 'reconcile', amount: -60, balance_after: b - 60, memo: 'balance corrected' },
    ]);
    expect(rows.reduce((s, x) => s + x.amount, 0)).toBe(b - 60);
    const msgs = (await u.client.get('/api/messages')).body as { title: string; body: string }[];
    expect(msgs.find((m) => m.title === '가상 칩 잔액 정정 안내')?.body).toContain('-60');
    // The internal note never reaches the member.
    expect(JSON.stringify(msgs)).not.toContain('not from any grant');
    await admin.post('/api/admin/reconcile/run', {});
    expect(await openEvents(u.me.id)).toHaveLength(0);
    // Once reverted, the second ask is a no-op refusal and the balance stays.
    expect((await resolve(ev.id, { action: 'revert', note: 'twice' })).status).toBe(409);
    expect(await balance(u.me.id)).toBe(b - 60);
  });

  it('refuses corrections from a plain admin, on a table, below zero, and notes twice', async () => {
    const p = await plainAdmin();
    const { u, ev } = await mismatch(25);
    const b = await balance(u.me.id);
    const plainTry = await resolve(ev.id, { action: 'revert', note: 'not mine to do' }, p.c);
    expect(plainTry.status).toBe(403);
    expect(plainTry.body.error.code).toBe('forbidden');
    expect(await balance(u.me.id)).toBe(b);
    // A plain admin can acknowledge; the note can't be given twice.
    expect((await resolve(ev.id, { note: 'seen it' }, p.c)).status).toBe(200);
    expect((await resolve(ev.id, { note: 'seen it again' })).status).toBe(404);
    expect((await resolve(ev.id, { action: 'record', note: 'x' })).status).toBe(400);

    const tableEvent = uniq('econ-ev');
    await d1(`INSERT INTO reconciliation_events (id, scope, subject_id, expected, actual, created_at) VALUES ('${tableEvent}', 'table', 'nowhere', 1, 0, ${Date.now()})`);
    cleanup.push(`DELETE FROM reconciliation_events WHERE id = '${tableEvent}'`);
    expect((await admin.get(`/api/admin/reconcile/${tableEvent}`)).body).toMatchObject({ table: null, diagnosis: null });
    expect((await resolve(tableEvent, { action: 'revert', note: 'a table' })).status).toBe(400);
    expect((await resolve(tableEvent, { note: 'a table' })).status).toBe(200);

    // A ledger that sums below zero: reverting the wallet to it would leave the wallet below zero.
    const low = await newUser();
    await d1(`INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, memo) VALUES ('${uniq('econ-l')}', '${low.me.id}', 'admin_adjust', ${-(low.me.balance + 500)}, 0, '${uniq('econ-k')}', 'test')`);
    await admin.post('/api/admin/reconcile/run', {});
    const [lowEv] = await openEvents(low.me.id);
    const below = await resolve(lowEv!.id, { action: 'revert', note: 'would go negative' });
    expect(below.status).toBe(409);
    expect(below.body.error.code).toBe('insufficient_balance');
    expect(await balance(low.me.id)).toBe(low.me.balance);
    expect((await admin.get(`/api/admin/reconcile/nope-${crypto.randomUUID()}`)).status).toBe(404);
  });
});
