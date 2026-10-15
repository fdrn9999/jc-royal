// Two administrators doing the same thing at the same moment. Whatever both ask for happens once: one change of status
// and one notice, one payout per seat, one balance correction, one maintenance window, one chip grant. The second one
// is told it was already done (or gets the same answer as the first), and every wallet still equals its ledger.
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
const first = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** A second super admin (so it may correct a balance too): a member promoted in D1, signed in once. */
let other: Promise<Client> | null = null;
function secondAdmin() {
  other ??= (async () => {
    const u = await newUser();
    await d1(`UPDATE users SET role = 'super_admin' WHERE id = '${u.me.id}'`);
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return c;
  })();
  return other;
}

async function reauth(c: Client) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Both administrators, each with the password confirmed. */
async function both() {
  const second = await secondAdmin();
  await reauth(first);
  await reauth(second);
  return [first, second] as const;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();
const balance = async (id: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${id}'`))[0]!.balance;
const ledgerSum = async (id: string) => (await d1<{ s: number }>(`SELECT COALESCE(SUM(amount), 0) AS s FROM chip_ledger WHERE user_id = '${id}'`))[0]!.s;
const ledger = (id: string) => d1<{ type: string; amount: number; idempotency_key: string }>(`SELECT type, amount, idempotency_key FROM chip_ledger WHERE user_id = '${id}' ORDER BY created_at, rowid`);
const audits = (action: string, targetId: string) => d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}'`);
const messages = (id: string) => d1<{ category: string; title: string }>(`SELECT category, title FROM messages WHERE user_id = '${id}'`);
const tableRow = async (id: string) =>
  (await d1<{ status: string; hands_played: number; hands: number }>(`SELECT status, hands_played, (SELECT COUNT(*) FROM hands WHERE table_id = '${id}') AS hands FROM tables WHERE id = '${id}'`))[0]!;

async function sock(c: Client, tableId: string) {
  const s = await TableSocket.open(c, tableId);
  open.push(s);
  return s;
}

/** Two new members seated at `tableId`, a hand running with someone to act. */
async function seatTwo(tableId: string, buyIns: [number, number]) {
  const a = await newUser();
  const b = await newUser();
  const wa = await sock(a.client, tableId);
  const wb = await sock(b.client, tableId);
  expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: buyIns[0] })).toMatchObject({ t: 'ack' });
  expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: buyIns[1] })).toMatchObject({ t: 'ack' });
  const live = (s: NonNullable<typeof wa.state>) => !!s.hand && s.hand.stage !== 'settled' && s.hand.actorSeat !== null;
  await wa.waitState(live, 20_000, 'hand start');
  await wb.waitState(live);
  return { a, b, wa, wb };
}

/** Plays `ws`'s turns (check, else call) until the current hand has ended. */
async function playOut(ws: TableSocket) {
  for (let i = 0; i < 40; i++) {
    const s = ws.state!;
    if (!s.hand || s.hand.stage === 'settled') return;
    if (isMyTurn(s)) await ws.act(s.you.legal.some((l) => l.type === 'check') ? 'check' : 'call');
    else await ws.waitNext((m) => m.t === 'state', 15_000, 'next state');
  }
  throw new Error('the hand did not end');
}

/** A member's buy-ins and cash-outs at one table, and that the wallet still equals the ledger. */
async function settled(userId: string, tableId: string) {
  const rows = await d1<{ type: string; amount: number }>(`SELECT type, amount FROM chip_ledger WHERE user_id = '${userId}' AND table_id = '${tableId}' ORDER BY created_at, rowid`);
  expect(await ledgerSum(userId)).toBe(await balance(userId));
  return rows;
}

describe('two administrators at once', () => {
  it('suspend the same member: one change and one notice, the socket ends once and the seat is paid out once', async () => {
    const [x, y] = await both();
    const { a, b, wa, wb } = await seatTwo('it-conc-0', [300, 300]);
    const rs = await Promise.all([
      x.post(`/api/admin/users/${a.me.id}/suspend`, { reason: 'first administrator' }),
      y.post(`/api/admin/users/${a.me.id}/suspend`, { reason: 'second administrator' }),
    ]);
    expect(statuses(rs), JSON.stringify(rs.map((r) => r.body))).toEqual([200, 409]);
    const won = rs.find((r) => r.status === 200)!;
    expect(won.body.kick).toMatchObject({ sockets: 1, unreached: [] });
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('already_suspended');

    // One record of the change (from active), whose reason is the one the account holds, and one notice.
    const logged = await audits('user.suspend', a.me.id);
    expect(logged).toHaveLength(1);
    const detail = JSON.parse(logged[0]!.detail);
    expect(detail).toMatchObject({ from: 'active', to: 'suspended', previousReason: null });
    expect(await d1(`SELECT status, suspended_reason FROM users WHERE id = '${a.me.id}'`)).toEqual([{ status: 'suspended', suspended_reason: detail.reason }]);
    expect((await messages(a.me.id)).filter((m) => m.category === 'sanction')).toHaveLength(1);
    // The refusal is on the record as a failed attempt.
    expect((await audits('user.suspend.failed', a.me.id)).map((r) => JSON.parse(r.detail))).toEqual([expect.objectContaining({ status: 409, code: 'already_suspended' })]);

    // The open socket ends; the other player plays the hand out and the seat is paid out exactly once.
    expect(await wa.waitClose()).toBe(4004);
    await playOut(wb);
    const after = await wb.waitState((s) => !s.seats[0]?.userId, 20_000, 'seat 0 freed');
    expect((await settled(a.me.id, 'it-conc-0')).map((l) => l.type)).toEqual(['buy_in', 'cash_out']);
    expect(await d1(`SELECT status FROM table_sessions WHERE user_id = '${a.me.id}'`)).toEqual([{ status: 'closed' }]);
    expect((await balance(a.me.id)) + (await balance(b.me.id)) + after.seats[1]!.stack).toBe(20_000);
  });

  it('suspending a member who is already suspended, or whose account was withdrawn, changes nothing', async () => {
    const [x] = await both();
    const m = await newUser();
    expect((await x.post(`/api/admin/users/${m.me.id}/suspend`, { reason: 'first time' })).status).toBe(200);
    // A double click, or a page opened before the first suspension: refused, the preview too.
    const again = await x.post(`/api/admin/users/${m.me.id}/suspend`, { reason: 'second time' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_suspended');
    expect((await x.post(`/api/admin/users/${m.me.id}/suspend`, { preview: true })).status).toBe(409);
    expect(await d1(`SELECT suspended_reason FROM users WHERE id = '${m.me.id}'`)).toEqual([{ suspended_reason: 'first time' }]);
    expect(await audits('user.suspend', m.me.id)).toHaveLength(1);
    expect((await messages(m.me.id)).filter((n) => n.category === 'sanction')).toHaveLength(1);

    // A withdrawn account stays withdrawn, and no notice is written for it.
    const gone = await newUser();
    expect((await gone.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect((await x.post(`/api/admin/users/${gone.me.id}/suspend`, { reason: 'after withdrawal' })).status).toBe(404);
    expect(await d1(`SELECT status FROM users WHERE id = '${gone.me.id}'`)).toEqual([{ status: 'deleted' }]);
    expect(await messages(gone.me.id)).toEqual([]);
  });

  it('close the same table during a hand: the hand plays out, each seat is paid once, the table closes once', async () => {
    const [x, y] = await both();
    const { a, b, wa, wb } = await seatTwo('it-conc-1', [500, 400]);
    const rs = await Promise.all([x, y].map((c) => c.post('/api/admin/tables/it-conc-1/close', {})));
    expect(statuses(rs), JSON.stringify(rs.map((r) => r.body))).toEqual([200, 200]);
    for (const r of rs) expect(r.body.live).toMatchObject({ closed: false, handInProgress: true });

    const actor = [wa, wb].find((w) => isMyTurn(w.state!))!;
    await actor.act('fold');
    await wa.wait((m) => m.t === 'error' && m.code === 'table_closed', 30_000, 'table closed');
    expect(await tableRow('it-conc-1')).toMatchObject({ status: 'closed', hands: 1, hands_played: 1 });
    const paid = [...(await settled(a.me.id, 'it-conc-1')), ...(await settled(b.me.id, 'it-conc-1'))].filter((l) => l.type === 'cash_out');
    expect(paid).toHaveLength(2);
    expect(paid.reduce((s, l) => s + l.amount, 0)).toBe(900);
    expect((await balance(a.me.id)) + (await balance(b.me.id))).toBe(20_000);
    expect(await d1(`SELECT DISTINCT status FROM table_sessions WHERE table_id = 'it-conc-1'`)).toEqual([{ status: 'closed' }]);
    // Each administrator's request is on the record.
    expect(await audits('table.close', 'it-conc-1')).toHaveLength(2);
  });

  it('one suspends a member while the other closes their table mid-hand: both seats are paid once', async () => {
    const [x, y] = await both();
    const { a, b, wa, wb } = await seatTwo('it-conc-2', [400, 300]);
    const [s, c] = await Promise.all([x.post(`/api/admin/users/${a.me.id}/suspend`, { reason: 'during a close' }), y.post('/api/admin/tables/it-conc-2/close', {})]);
    expect([s.status, c.status], JSON.stringify([s.body, c.body])).toEqual([200, 200]);
    expect(await wa.waitClose()).toBe(4004);
    // B finishes the hand (A is folded on their turn); then B is cashed out by the close.
    await playOut(wb).catch(() => undefined);
    await wb.wait((m) => m.t === 'error' && m.code === 'table_closed', 30_000, 'table closed');
    expect((await tableRow('it-conc-2')).status).toBe('closed');
    const outs = [...(await settled(a.me.id, 'it-conc-2')), ...(await settled(b.me.id, 'it-conc-2'))];
    expect(outs.filter((l) => l.type === 'cash_out')).toHaveLength(2);
    expect(outs.reduce((sum, l) => sum + l.amount, 0)).toBe(0);
    expect((await balance(a.me.id)) + (await balance(b.me.id))).toBe(20_000);
  });

  it('close the same empty table a moment apart: it stays closed, never set back to closing', async () => {
    const [x, y] = await both();
    const ids: string[] = [];
    // The second request starts a little later each time. It finds the table closed (404) or closes it too; either way the
    // row ends 'closed', never set back to 'closing' over a room that has already closed.
    for (const gap of [0, 5, 10, 15, 20, 30, 40, 60]) {
      const t = await x.post('/api/admin/tables', { name: `동시 종료 ${gap}`, maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000 });
      expect(t.status).toBe(201);
      ids.push(t.body.id);
      const [r1, r2] = await Promise.all([x.post(`/api/admin/tables/${t.body.id}/close`, {}), sleep(gap).then(() => y.post(`/api/admin/tables/${t.body.id}/close`, {}))]);
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect([200, 404], JSON.stringify(r2.body)).toContain(r2.status);
    }
    const list = ids.map((id) => `'${id}'`).join(', ');
    expect(await d1(`SELECT id, status FROM tables WHERE id IN (${list}) AND status <> 'closed'`)).toEqual([]);
    const lobby = (await (await newUser()).client.get('/api/tables')).body as { id: string }[];
    expect(lobby.filter((t) => ids.includes(t.id))).toEqual([]);
  });

  it('two super admins revert the same mismatch: one correction, one refusal, one notice', async () => {
    const [x, y] = await both();
    const u = await newUser();
    await d1(`UPDATE users SET balance = balance + 70 WHERE id = '${u.me.id}'`);
    await x.post('/api/admin/reconcile/run', {});
    const ev = ((await x.get('/api/admin/reconcile')).body as { id: string; subjectId: string; resolvedAt: number | null }[]).find((e) => e.subjectId === u.me.id && !e.resolvedAt)!;
    expect(ev).toBeTruthy();
    const rs = await Promise.all([x, y].map((c, i) => c.post(`/api/admin/reconcile/${ev.id}/resolve`, { action: 'revert', note: `administrator ${i + 1}` })));
    expect(statuses(rs), JSON.stringify(rs.map((r) => r.body))).toEqual([200, 409]);
    expect(['already_resolved', 'reconcile_stale']).toContain(rs.find((r) => r.status === 409)!.body.error.code);
    expect(await balance(u.me.id)).toBe(u.me.balance);
    expect(await ledgerSum(u.me.id)).toBe(u.me.balance);
    expect((await ledger(u.me.id)).filter((l) => l.type === 'reconcile').map((l) => [l.amount, l.idempotency_key])).toEqual([
      [70, `reconcile:${ev.id}:record`],
      [-70, `reconcile:${ev.id}:revert`],
    ]);
    expect(await audits('user.reconcile', u.me.id)).toHaveLength(1);
    expect((await messages(u.me.id)).filter((m) => m.title === '가상 칩 잔액 정정 안내')).toHaveLength(1);
  });

  it('send the same chip grant (one idempotency key): applied once, the other told it was a repeat', async () => {
    const [x, y] = await both();
    const u = await newUser();
    const idempotencyKey = `conc-${crypto.randomUUID()}`;
    const rs = await Promise.all([x, y].map((c) => c.post(`/api/admin/users/${u.me.id}/chips`, { amount: 500, memo: 'concurrent grant', idempotencyKey })));
    expect(statuses(rs), JSON.stringify(rs.map((r) => r.body))).toEqual([200, 200]);
    expect(rs.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
    expect(rs.map((r) => r.body.balanceAfter)).toEqual([u.me.balance + 500, u.me.balance + 500]);
    expect(await balance(u.me.id)).toBe(u.me.balance + 500);
    expect(await ledgerSum(u.me.id)).toBe(u.me.balance + 500);
    expect((await ledger(u.me.id)).filter((l) => l.type === 'admin_adjust').map((l) => l.idempotency_key)).toEqual([`admin:${idempotencyKey}`]);
    expect(await audits('user.chips', u.me.id)).toHaveLength(1);
    expect(await audits('user.chips_duplicate', u.me.id)).toHaveLength(1);
    expect((await messages(u.me.id)).filter((m) => m.category === 'event')).toHaveLength(1);
  });

  it('plan maintenance at once: one window; stop it at once: stopped once', async () => {
    const [x, y] = await both();
    const openWindows = () => d1<{ id: string }>(`SELECT id FROM maintenance_windows WHERE ended_at IS NULL AND cancelled_at IS NULL AND ends_at > ${Date.now()}`);
    expect(await openWindows()).toEqual([]);
    // Hours ahead: no table stops dealing, no sign-in is refused.
    const startsAt = Date.now() + 6 * 3_600_000;
    const body = (n: number) => ({ startsAt, endsAt: startsAt + 3_600_000, messageKo: `동시 점검 ${n}`, messageEn: `concurrent ${n}`, reason: `planned by ${n}` });
    try {
      const made = await Promise.all([x.post('/api/admin/service/maintenance', body(1)), y.post('/api/admin/service/maintenance', body(2))]);
      expect(statuses(made), JSON.stringify(made.map((r) => r.body))).toEqual([201, 409]);
      expect(made.find((r) => r.status === 409)!.body.error.message).toBe('another maintenance window is planned or under way');
      const id = made.find((r) => r.status === 201)!.body.id as string;
      expect(await openWindows()).toEqual([{ id }]);
      expect(await audits('maintenance.schedule', id)).toHaveLength(1);

      const stopped = await Promise.all([x, y].map((c, i) => c.post(`/api/admin/service/maintenance/${id}/stop`, { reason: `stopped by ${i + 1}` })));
      expect(statuses(stopped), JSON.stringify(stopped.map((r) => r.body))).toEqual([200, 409]);
      expect(stopped.find((r) => r.status === 409)!.body.error.message).toBe('this maintenance is already over');
      expect(await openWindows()).toEqual([]);
      expect(await d1(`SELECT ended_at IS NULL AS notEnded, cancelled_at IS NOT NULL AS cancelled FROM maintenance_windows WHERE id = '${id}'`)).toEqual([{ notEnded: 1, cancelled: 1 }]);
      expect(await audits('maintenance.cancel', id)).toHaveLength(1);
    } finally {
      // Nothing planned is left for the other files, whatever failed above.
      await d1(`UPDATE maintenance_windows SET cancelled_at = ${Date.now()} WHERE ended_at IS NULL AND cancelled_at IS NULL`);
    }
  });
});
