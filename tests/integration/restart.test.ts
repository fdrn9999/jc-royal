import type { ServerMessage } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupBody, WEB_ORIGIN } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

/**
 * Kills the workerd process in the middle of a hand and restarts it on the same
 * persisted state (D1 + Durable Object storage). The hand must resume from the
 * event log: same hand id, same sequence, same private cards, chips conserved.
 */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Runs the api worker's daily cron handler (housekeeping, then the room sweep) through wrangler dev and waits for it. */
async function runCron(base: string) {
  const r = await fetch(`${base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('30 18 * * *')}`);
  expect(await r.text()).toBe('ok');
}

/**
 * An administrator closes or pauses these; at the third a buy-in's outcome is unknown; at the fourth the time bank is
 * used across a restart; at the last an automatic top-up waits out a crash (heads-up, long turns so the clock never acts).
 */
const tables = [
  ...TABLES,
  ...['it-restart-close', 'it-restart-pause', 'it-restart-pending', 'it-restart-tb', 'it-restart-auto'].map((id) => ({ id, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
];

describe('server restart recovery', () => {
  const state = resolve(root, 'tests/.state/restart');
  const port = 8811;
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
  });

  async function user(n: string, base: string) {
    const c = new Client(WEB_ORIGIN, base);
    const r = await c.post('/api/auth/register', await signupBody(c, { email: `${n}-${Date.now()}@restart.dev`, nickname: `${n}${Date.now() % 100000}` }));
    expect(r.status).toBe(201);
    return c;
  }

  it('resumes an in-progress hand after a hard process kill', async () => {
    await prepareState(state, tables);
    worker = await startWorker(port, state);
    const base = worker.url;
    const ca = await user('ra', base);
    const cb = await user('rb', base);
    let a = await TableSocket.open(ca, 'it-restart-0', { base });
    let b = await TableSocket.open(cb, 'it-restart-0', { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 600 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    await a.waitState((s) => s.status === 'playing', 15_000, 'hand start');
    await b.waitState((s) => s.status === 'playing');
    // One action before the crash.
    const first = isMyTurn(a.state!) ? a : b;
    const r = await first.act('call');
    expect(r.result.t).toBe('state');
    await new Promise((res) => setTimeout(res, 300));
    const before = { a: a.state!, b: b.state! };
    a.close();
    b.close();

    await worker.stop();
    worker = await startWorker(port, state);

    a = await TableSocket.open(ca, 'it-restart-0', { base });
    b = await TableSocket.open(cb, 'it-restart-0', { base });
    const after = { a: a.state!, b: b.state! };
    expect(after.a.hand!.id).toBe(before.a.hand!.id);
    expect(after.a.hand!.seq).toBe(before.a.hand!.seq);
    expect(after.a.seats[0]!.holeCards).toEqual(before.a.seats[0]!.holeCards);
    expect(after.b.seats[1]!.holeCards).toEqual(before.b.seats[1]!.holeCards);
    expect(after.a.seats[1]!.holeCards ?? null).toBeNull();
    expect(after.a.hand!.potTotal).toBe(before.a.hand!.potTotal);

    // Finish the hand after the restart.
    for (let guard = 0; guard < 200; guard++) {
      const s = a.state!;
      if (s.hand?.stage === 'settled' || s.hand?.id !== before.a.hand!.id) break;
      const actor = [a, b].find((x) => x.state && isMyTurn(x.state));
      if (!actor) {
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      const type = actor.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call';
      await actor.act(type);
    }
    const done = await a.waitState((s) => s.hand?.stage === 'settled' || s.hand?.id !== before.a.hand!.id, 15_000, 'settled');
    expect(done.seats[0]!.stack + done.seats[1]!.stack).toBe(1000);

    // Wallet + table chips are conserved across the crash.
    const wa = (await fetch(`${base}/api/auth/me`, { headers: { Cookie: ca.cookieHeader() } }).then((x) => x.json())) as { balance: number };
    const wb = (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cb.cookieHeader() } }).then((x) => x.json())) as { balance: number };
    expect(wa.balance + wb.balance + done.seats[0]!.stack + done.seats[1]!.stack).toBe(20000);
    a.close();
    b.close();
  }, 240_000);

  it('a top-up queued before a crash is applied once after the restart, and another restart does not repeat it', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('ta', base);
    const cb = await user('tb', base);
    const restart = async () => {
      await worker!.stop();
      worker = await startWorker(port, state);
      return [await TableSocket.open(ca, 'it-restart-1', { base }), await TableSocket.open(cb, 'it-restart-1', { base })] as const;
    };
    const topUps = async () => ((await ca.get('/api/me/ledger?limit=100')).body as { type: string; amount: number }[]).filter((l) => l.type === 'top_up');
    const wallet = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;

    let a = await TableSocket.open(ca, 'it-restart-1', { base });
    let b = await TableSocket.open(cb, 'it-restart-1', { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 100 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 100 })).toMatchObject({ t: 'ack' });
    await a.waitState((s) => s.status === 'playing' && !!s.hand && s.hand.stage !== 'settled', 15_000, 'hand start');
    expect(await a.request({ t: 'topUp', amount: 300 })).toMatchObject({ t: 'ack' });
    await a.waitState((s) => s.you.topUpQueued === 300);
    const handId = a.state!.hand!.id;
    a.close();
    b.close();

    // The queued top-up survives the crash; nothing has been taken from the wallet yet.
    [a, b] = await restart();
    expect(a.state!.hand!.id).toBe(handId);
    expect(a.state!.you.topUpQueued).toBe(300);
    expect(await wallet(ca)).toBe(9900);
    expect(await topUps()).toEqual([]);

    for (let guard = 0; guard < 200; guard++) {
      if (a.state!.hand?.id !== handId || a.state!.hand.stage === 'settled') break;
      const actor = [a, b].find((x) => x.state && isMyTurn(x.state));
      if (!actor) {
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      await actor.act(actor.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call');
    }
    await a.wait((m) => m.t === 'notice' && m.code === 'topup_applied' && m.amount === 300, 15_000);
    expect(await topUps()).toEqual([expect.objectContaining({ amount: -300 })]);
    expect(await wallet(ca)).toBe(9600);
    a.close();
    b.close();

    // A second restart does not take the chips again.
    [a, b] = await restart();
    expect(a.state!.you.topUpQueued).toBeNull();
    expect(await topUps()).toHaveLength(1);
    for (const x of [a, b]) expect(await x.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    for (const x of [a, b]) await x.waitState((s) => s.you.seatIndex === null, 30_000, 'stood up');
    expect(await topUps()).toHaveLength(1);
    expect((await wallet(ca)) + (await wallet(cb))).toBe(20000);
    a.close();
    b.close();
  }, 300_000);

  it('an automatic top-up policy outlives a crash mid-hand, charges once when the hand settles, and another restart does not repeat it', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('aa', base);
    const cb = await user('ab', base);
    const T = 'it-restart-auto';
    const restart = async () => {
      await worker!.stop();
      worker = await startWorker(port, state);
      return [await TableSocket.open(ca, T, { base }), await TableSocket.open(cb, T, { base })] as const;
    };
    const topUps = async () => ((await ca.get('/api/me/ledger?limit=100')).body as { type: string; amount: number; memo: string | null }[]).filter((l) => l.type === 'top_up');
    const wallet = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;

    let a = await TableSocket.open(ca, T, { base });
    let b = await TableSocket.open(cb, T, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 300, autoBuy: { mode: 'topup', target: 500, cap: 2500, consent: true } })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await a.waitState((s) => s.status === 'playing' && !!s.hand && s.hand.stage !== 'settled', 15_000, 'hand start');
    const handId = a.state!.hand!.id;
    const policy = a.state!.you.autoBuy;
    expect(policy).toEqual({ mode: 'topup', target: 500, trigger: 500, partial: false, cap: 2500, spent: 0 });
    a.close();
    b.close();

    // The policy survives the crash; nothing has been taken for it yet.
    [a, b] = await restart();
    expect(a.state!.hand!.id).toBe(handId);
    expect(a.state!.you.autoBuy).toEqual(policy);
    expect(b.state!.you.autoBuy).toBeNull();
    expect(await wallet(ca)).toBe(9700);
    expect(await topUps()).toEqual([]);

    for (let guard = 0; guard < 200; guard++) {
      if (a.state!.hand?.id !== handId || a.state!.hand.stage === 'settled') break;
      const actor = [a, b].find((x) => x.state && isMyTurn(x.state));
      if (!actor) {
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      await actor.act(actor.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call');
    }
    const settled = (await a.wait((m) => m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage === 'settled', 15_000, 'settled')) as Extract<ServerMessage, { t: 'state' }>;
    const want = 500 - settled.state.seats[0]!.stack;
    await a.wait((m) => m.t === 'notice' && m.code === 'autotopup_applied', 15_000, 'automatic top-up');
    expect(a.messages.filter((m) => m.t === 'notice').map((m) => m.t === 'notice' && [m.code, m.amount])).toEqual([['autotopup_applied', want]]);
    expect(await topUps()).toEqual([expect.objectContaining({ amount: -want, memo: 'auto top-up' })]);
    expect(await wallet(ca)).toBe(9700 - want);
    await a.waitState((s) => s.you.autoBuy?.spent === want, 15_000, 'spent counted');
    a.close();
    b.close();

    // A second restart neither takes the chips again nor forgets what the policy has used.
    [a, b] = await restart();
    expect(a.state!.you.autoBuy).toEqual({ ...policy, spent: want });
    expect(await topUps()).toHaveLength(1);
    for (const x of [a, b]) expect(await x.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    for (const x of [a, b]) await x.waitState((s) => s.you.seatIndex === null, 30_000, 'stood up');
    expect(await topUps()).toHaveLength(1);
    expect((await wallet(ca)) + (await wallet(cb))).toBe(20000);
    a.close();
    b.close();
  }, 300_000);

  const balanceOf = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;
  const cashOuts = async (c: Client) => ((await c.get('/api/me/ledger?limit=100')).body as { type: string; amount: number }[]).filter((l) => l.type === 'cash_out');
  const tableRow = async (id: string) =>
    (await d1<{ status: string; hands_played: number; hands: number }>(`SELECT status, hands_played, (SELECT COUNT(*) FROM hands WHERE table_id = '${id}') AS hands FROM tables WHERE id = '${id}'`, state))[0]!;

  it('a close the room never heard about is finished when the room next loads, or by the daily sweep, paying each player once', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('ca', base);
    const cb = await user('cb', base);
    // Each sits alone at a table of its own, so no hand starts.
    const a = await TableSocket.open(ca, 'it-restart-2', { base });
    const b = await TableSocket.open(cb, 'it-restart-3', { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    a.close();
    b.close();

    // D1 says closing, but the rooms never got the call (the request died between the two), and the server restarts.
    // updated_at is set long ago so the sweep counts the close as stalled.
    await worker.stop();
    await d1(`UPDATE tables SET status = 'closing', entry_blocked = 1, updated_at = 0 WHERE id IN ('it-restart-2', 'it-restart-3')`, state);
    worker = await startWorker(port, state);

    // A player coming back wakes the room: it finishes the close, paying the stack back, and refuses the connection.
    await expect(TableSocket.open(ca, 'it-restart-2', { base })).rejects.toThrow();
    expect((await tableRow('it-restart-2')).status).toBe('closed');
    expect(await cashOuts(ca)).toEqual([expect.objectContaining({ amount: 500 })]);
    expect(await balanceOf(ca)).toBe(10_000);

    // Nobody comes back to the other one: the daily cron's sweep wakes it.
    expect((await tableRow('it-restart-3')).status).toBe('closing');
    await runCron(base);
    await until(() => tableRow('it-restart-3'), (t) => t.status === 'closed', 'the sweep closes the room');
    expect(await cashOuts(cb)).toEqual([expect.objectContaining({ amount: 400 })]);
    expect(await balanceOf(cb)).toBe(10_000);

    // Restarting and sweeping again pays no one twice.
    await worker.stop();
    worker = await startWorker(port, state);
    await runCron(base);
    await expect(TableSocket.open(ca, 'it-restart-2', { base })).rejects.toThrow();
    expect(await cashOuts(ca)).toHaveLength(1);
    expect(await cashOuts(cb)).toHaveLength(1);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
  }, 300_000);

  it('cash-outs and the hand record D1 refuses while a room closes are retried by the room until they land, once', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('da', base);
    const cb = await user('db', base);
    const created = await ca.post('/api/rooms', { name: '복구 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const a = await TableSocket.open(ca, id, { base });
    const b = await TableSocket.open(cb, id, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const live = (s: NonNullable<typeof a.state>) => !!s.hand && s.hand.stage !== 'settled' && s.hand.actorSeat !== null;
    await a.waitState(live, 15_000, 'hand start');
    await b.waitState(live);
    // The host closes it mid-hand: the hand plays out first.
    expect((await ca.post(`/api/rooms/${id}/close`, {})).body).toMatchObject({ ok: true, closed: false });

    // D1 is unreachable when the hand ends: the record, the cash-outs and the close all fail.
    const logFrom = worker.log().length;
    const release = holdD1WriteLock(state);
    try {
      const actor = [a, b].find((x) => isMyTurn(x.state!))!;
      await actor.act('fold');
      await until(async () => worker!.log().slice(logFrom), (l) => l.includes('close unfinished; will retry'), 'the close to fail', 90_000);
      expect(worker.log().slice(logFrom)).toContain('cash-out failed; will retry');
      expect(worker.log().slice(logFrom)).toContain('recordHand failed; will retry');
    } finally {
      release();
    }

    // Nobody does anything: the room's retry finishes the close.
    await a.wait((m) => m.t === 'error' && m.code === 'table_closed', 60_000, 'table closed');
    const row = await tableRow(id);
    expect(row).toMatchObject({ status: 'closed', hands: 1, hands_played: 1 });
    const paid = [...(await cashOuts(ca)), ...(await cashOuts(cb))];
    expect(paid).toHaveLength(2);
    expect(paid.reduce((s, l) => s + l.amount, 0)).toBe(900);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
    a.close();
    b.close();

    // A restart and a sweep change nothing.
    await worker.stop();
    worker = await startWorker(port, state);
    await runCron(base);
    await expect(TableSocket.open(ca, id, { base })).rejects.toThrow();
    expect(await tableRow(id)).toMatchObject({ status: 'closed', hands: 1, hands_played: 1 });
    expect([...(await cashOuts(ca)), ...(await cashOuts(cb))]).toHaveLength(2);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
  }, 360_000);

  it('a hand that ends while D1 is down, then a crash before any retry: after the restart it is recorded once and the leaver paid once', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('ka', base);
    const cb = await user('kb', base);
    const created = await ca.post('/api/rooms', { name: '중단 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    let a = await TableSocket.open(ca, id, { base });
    const b = await TableSocket.open(cb, id, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const live = (s: NonNullable<typeof a.state>) => !!s.hand && s.hand.stage !== 'settled' && s.hand.actorSeat !== null;
    await a.waitState(live, 15_000, 'hand start');
    await b.waitState(live);

    // D1 is unreachable as the hand ends: B leaves (folding if it is B's turn, else A folds), so the record and B's
    // cash-out both fail and wait in room storage.
    const logFrom = worker.log().length;
    const release = holdD1WriteLock(state);
    try {
      expect(await b.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
      const s = await a.waitState((x) => !live(x) || isMyTurn(x), 15_000, 'A to act or the hand to end');
      if (live(s)) await a.act('fold');
      await until(async () => worker!.log().slice(logFrom), (l) => l.includes('cash-out failed; will retry'), 'the cash-out to fail', 90_000);
      expect(worker.log().slice(logFrom)).toContain('recordHand failed; will retry');
      // The process dies before the room's retry gets through.
      await worker.stop();
    } finally {
      release();
    }
    a.close();
    b.close();
    // Read straight from D1 while the server is down: no record, no cash-out, B's buy-in still out of the wallet.
    expect(await tableRow(id)).toMatchObject({ hands: 0, hands_played: 0 });
    const sessions = await d1<{ status: string; cash_out: number | null }>(`SELECT status, cash_out FROM table_sessions WHERE table_id = '${id}' ORDER BY seat_index`, state);
    expect(sessions).toEqual([
      { status: 'seated', cash_out: null },
      { status: 'seated', cash_out: null },
    ]);
    expect(await d1(`SELECT id FROM chip_ledger WHERE table_id = '${id}' AND type = 'cash_out'`, state)).toEqual([]);

    // After the restart the room finishes both from storage: one hand record, one cash-out, no chips made or lost.
    worker = await startWorker(port, state);
    a = await TableSocket.open(ca, id, { base });
    await until(async () => ({ row: await tableRow(id), paid: await cashOuts(cb) }), (x) => x.row.hands === 1 && x.paid.length === 1, 'the record and the cash-out', 60_000);
    expect((await tableRow(id)).hands_played).toBe(1);
    const stackA = (await a.waitState((x) => x.seats[1]!.state === 'empty', 15_000, 'B gone')).seats[0]!.stack;
    expect(stackA + (await cashOuts(cb))[0]!.amount).toBe(900);
    expect((await balanceOf(ca)) + (await balanceOf(cb)) + stackA).toBe(20_000);
    a.close();

    // Another restart and the daily sweep repeat neither.
    await worker.stop();
    worker = await startWorker(port, state);
    await runCron(base);
    a = await TableSocket.open(ca, id, { base });
    expect(await tableRow(id)).toMatchObject({ hands: 1, hands_played: 1 });
    expect(await cashOuts(cb)).toHaveLength(1);
    expect(a.state!.seats[0]!.stack).toBe(stackA);
    expect(await a.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await a.waitState((x) => x.you.seatIndex === null, 30_000, 'A stood up');
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
    a.close();
  }, 360_000);

  it('a member room only D1 knows about (its opening call never reached it) is woken by the daily sweep and closes itself', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const ca = await user('oa', base);
    const host = (await ca.get('/api/auth/me')).body.id as string;
    // What is left when the room cannot be woken and closing the new row fails too: open, empty, no idle close armed.
    const id = `it-orphan-${Date.now() % 100_000}`;
    await d1(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, room_type, created_by, created_at, updated_at)
       VALUES ('${id}', '깨지 않은 방', 6, 10, 20, 400, 2000, 20, 'member', '${host}', 0, 0)`,
      state,
    );
    // Longer than the idle close (8 s here): nothing closes it on its own.
    await new Promise((r) => setTimeout(r, 10_000));
    expect((await tableRow(id)).status).toBe('open');
    await runCron(base);
    await until(() => tableRow(id), (t) => t.status === 'closed', 'the woken room to close itself', 60_000);
  }, 180_000);

  /** A console administrator on this worker: a member promoted in D1, signed in, the password confirmed. */
  async function adminOn(base: string) {
    const email = `adm-${Date.now()}@restart.dev`;
    const m = new Client(WEB_ORIGIN, base);
    expect((await m.post('/api/auth/register', await signupBody(m, { email, nickname: `adm${Date.now() % 100000}` }))).status).toBe(201);
    await d1(promoteSql(`id = '${(await m.get('/api/auth/me')).body.id}'`), state);
    const c = new Client('http://localhost:5174', base);
    expect((await c.post('/api/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
    await reauth(c);
    return c;
  }
  const reauth = async (c: Client) => expect((await c.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const seatsAt = (id: string) => d1<{ status: string }>(`SELECT status FROM table_sessions WHERE table_id = '${id}' ORDER BY seat_index`, state);
  const ledgerMatches = async (c: Client) => {
    const id = (await c.get('/api/auth/me')).body.id as string;
    const [r] = await d1<{ balance: number; sum: number }>(`SELECT balance, (SELECT COALESCE(SUM(amount), 0) FROM chip_ledger WHERE user_id = '${id}') AS sum FROM users WHERE id = '${id}'`, state);
    return r!.balance === r!.sum;
  };
  const live = (s: NonNullable<TableSocket['state']>) => !!s.hand && s.hand.stage !== 'settled' && s.hand.actorSeat !== null;
  /** Checks and calls until hand `handId` has ended. */
  async function playOut(a: TableSocket, b: TableSocket, handId: string) {
    for (let guard = 0; guard < 200; guard++) {
      if (a.state!.hand?.id !== handId || a.state!.hand.stage === 'settled') return;
      const actor = [a, b].find((x) => x.state && isMyTurn(x.state));
      if (!actor) {
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      await actor.act(actor.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call');
    }
    throw new Error('the hand did not end');
  }

  it('an administrator closes a table mid-hand and the server dies before the hand ends: after the restart the hand finishes, each seat is paid once, the table closes once', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const id = 'it-restart-close';
    const admin = await adminOn(base);
    const ca = await user('xa', base);
    const cb = await user('xb', base);
    let a = await TableSocket.open(ca, id, { base });
    let b = await TableSocket.open(cb, id, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const handId = (await a.waitState(live, 15_000, 'hand start')).hand!.id;
    await b.waitState(live);

    const preview = await admin.post(`/api/admin/tables/${id}/close`, { preview: true });
    expect(preview.body).toMatchObject({ preview: true, handInProgress: true, roomAnswered: true });
    expect(preview.body.seats).toHaveLength(2);
    const closed = await admin.post(`/api/admin/tables/${id}/close`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.live).toMatchObject({ closed: false, handInProgress: true });
    a.close();
    b.close();

    // The process dies with the hand still running: D1 says closing, both seats are still out of the wallets.
    await worker.stop();
    expect(await tableRow(id)).toMatchObject({ status: 'closing', hands: 0, hands_played: 0 });
    expect(await seatsAt(id)).toEqual([{ status: 'seated' }, { status: 'seated' }]);
    expect(await d1(`SELECT id FROM chip_ledger WHERE table_id = '${id}' AND type = 'cash_out'`, state)).toEqual([]);

    // After the restart the same hand is running at a closing table; it plays out, then the close finishes.
    worker = await startWorker(port, state);
    a = await TableSocket.open(ca, id, { base });
    b = await TableSocket.open(cb, id, { base });
    expect(a.state!.hand?.id).toBe(handId);
    expect(a.state!.status).toBe('closing');
    await playOut(a, b, handId);
    await a.wait((m) => m.t === 'error' && m.code === 'table_closed', 60_000, 'table closed');
    expect(await tableRow(id)).toMatchObject({ status: 'closed', hands: 1, hands_played: 1 });
    expect(await seatsAt(id)).toEqual([{ status: 'closed' }, { status: 'closed' }]);
    const paid = [...(await cashOuts(ca)), ...(await cashOuts(cb))];
    expect(paid).toHaveLength(2);
    expect(paid.reduce((s, l) => s + l.amount, 0)).toBe(900);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
    expect(await ledgerMatches(ca)).toBe(true);
    expect(await ledgerMatches(cb)).toBe(true);
    expect(await d1(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'table.close' AND target_id = '${id}'`, state)).toEqual([{ n: 1 }]);
    a.close();
    b.close();

    // Another restart and the daily sweep pay no one twice; the table cannot be closed again.
    await worker.stop();
    worker = await startWorker(port, state);
    await runCron(base);
    await expect(TableSocket.open(ca, id, { base })).rejects.toThrow();
    expect(await tableRow(id)).toMatchObject({ status: 'closed', hands: 1, hands_played: 1 });
    expect([...(await cashOuts(ca)), ...(await cashOuts(cb))]).toHaveLength(2);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
    await reauth(admin);
    expect((await admin.post(`/api/admin/tables/${id}/close`, {})).status).toBe(404);
  }, 360_000);

  it('a table paused mid-hand keeps every stack across a restart, deals nothing while paused, and the next hand when resumed', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const id = 'it-restart-pause';
    const admin = await adminOn(base);
    const ca = await user('pa', base);
    const cb = await user('pb', base);
    let a = await TableSocket.open(ca, id, { base });
    let b = await TableSocket.open(cb, id, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const first = (await a.waitState(live, 15_000, 'hand start')).hand!;
    await b.waitState(live);

    const pause = await admin.post(`/api/admin/tables/${id}/control`, { action: 'pause', reason: 'checking a report' });
    expect(pause.body).toMatchObject({ ok: true, paused: true, handInProgress: true });
    await a.waitState((s) => s.paused === true);
    // The running hand ends normally; no other is dealt.
    await (isMyTurn(a.state!) ? a : b).act('fold');
    const idle = await a.waitState((s) => s.hand === null, 15_000, 'no next hand');
    expect(idle.nextHandAt).toBeNull();
    const stacks = [idle.seats[0]!.stack, idle.seats[1]!.stack];
    expect(stacks[0]! + stacks[1]!).toBe(900);
    a.close();
    b.close();

    await worker.stop();
    worker = await startWorker(port, state);
    a = await TableSocket.open(ca, id, { base });
    b = await TableSocket.open(cb, id, { base });
    expect(a.state).toMatchObject({ paused: true, hand: null, nextHandAt: null });
    expect([a.state!.seats[0]!.stack, a.state!.seats[1]!.stack]).toEqual(stacks);
    // Longer than the wait before a first hand: still nothing dealt.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(a.state!.hand).toBeNull();
    expect(await tableRow(id)).toMatchObject({ status: 'open', hands: 1, hands_played: 1 });
    expect(await seatsAt(id)).toEqual([{ status: 'seated' }, { status: 'seated' }]);
    const detail = (await admin.get(`/api/admin/tables/${id}`)).body;
    expect(detail.table.handsPaused).toBe(true);
    expect(detail.live).toMatchObject({ paused: true, handNumber: first.number, handInProgress: false });
    expect(detail.diagnosis.issues).toEqual([]);

    // Resumed: the next number, dealt from the same stacks.
    await reauth(admin);
    const resume = await admin.post(`/api/admin/tables/${id}/control`, { action: 'resume', reason: 'report closed' });
    expect(resume.body).toMatchObject({ ok: true, paused: false });
    const next = await a.waitState(live, 20_000, 'hand after resume');
    expect(next.hand!.number).toBe(first.number + 1);
    await b.waitState((s) => s.hand?.id === next.hand!.id && live(s));
    await (isMyTurn(a.state!) ? a : b).act('fold');
    await a.waitState((s) => s.hand?.id !== next.hand!.id || s.hand.stage === 'settled', 15_000, 'second hand over');
    for (const x of [a, b]) expect(await x.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    for (const x of [a, b]) await x.waitState((s) => s.you.seatIndex === null, 30_000, 'stood up');
    const paid = [...(await cashOuts(ca)), ...(await cashOuts(cb))];
    expect(paid).toHaveLength(2);
    expect(paid.reduce((s, l) => s + l.amount, 0)).toBe(900);
    expect((await balanceOf(ca)) + (await balanceOf(cb))).toBe(20_000);
    expect(await ledgerMatches(ca)).toBe(true);
    expect(await ledgerMatches(cb)).toBe(true);
    const row = await tableRow(id);
    expect(row.hands).toBe(row.hands_played);
    a.close();
    b.close();
  }, 360_000);

  it('a player who leaves while the buy-in outcome is still unknown is paid back once the ledger shows it landed, not kept seated', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const id = 'it-restart-pending';
    const admin = await adminOn(base);
    const ca = await user('ua', base);
    const uid = (await ca.get('/api/auth/me')).body.id as string;
    const a = await TableSocket.open(ca, id, { base });
    const seatOf = async () => (await admin.get(`/api/admin/tables/${id}`)).body.live.seats[0] as { userId: string; phase: string; tableSessionId: string } | null;

    // D1 is unreachable as A sits: the buy-in's outcome is unknown, so the seat is held as pending.
    const sitLock = holdD1WriteLock(state);
    try {
      expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      sitLock();
    }
    const pending = await seatOf();
    expect(pending).toMatchObject({ userId: uid, phase: 'pending' });
    const tsid = pending!.tableSessionId;

    // A leaves while D1 is still down, before the retry: the room cannot tell whether to pay A back yet. The buy-in
    // had in fact landed (only its reply was lost): the ledger row, the wallet debit and the table session.
    const landed = `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, table_id, ref_id, idempotency_key, memo)
        SELECT '${crypto.randomUUID()}', id, 'buy_in', -500, balance - 500, '${id}', '${tsid}', 'buyin:${tsid}', 'seat 1' FROM users WHERE id = '${uid}';
      UPDATE users SET balance = balance - 500 WHERE id = '${uid}';
      INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${tsid}', '${id}', '${uid}', 0, 500, 'seated');`;
    const leaveLock = holdD1WriteLock(state);
    let asked = false;
    try {
      expect(await a.request({ t: 'leave' })).toMatchObject({ t: 'error', code: 'internal' });
      asked = true;
    } finally {
      leaveLock(asked ? landed : undefined);
    }
    expect(await balanceOf(ca)).toBe(9_500);

    // The retry finds the buy-in in the ledger. A asked to leave, so the chips go back to the wallet: the seat is not
    // kept with a player who left it.
    const settled = await until(seatOf, (s) => !s || s.phase === 'seated', 'the retry to settle the seat', 60_000);
    expect(settled).toBeNull();
    await until(() => seatsAt(id), (s) => s.length === 1 && s[0]!.status === 'closed', 'the table session to close');
    expect((await cashOuts(ca)).map((l) => l.amount)).toEqual([500]);
    expect(await balanceOf(ca)).toBe(10_000);
    expect(await ledgerMatches(ca)).toBe(true);
    await a.waitState((s) => s.you.seatIndex === null && s.seats[0]!.state === 'empty', 15_000, 'the seat freed');
    a.close();

    // A restart pays nothing twice.
    await worker.stop();
    worker = await startWorker(port, state);
    const again = await TableSocket.open(ca, id, { base });
    expect(again.state!.seats[0]!.state).toBe('empty');
    expect(await cashOuts(ca)).toHaveLength(1);
    expect(await balanceOf(ca)).toBe(10_000);
    again.close();
  }, 240_000);

  it('time bank time added before a crash is kept after the restart, once: the same deadline and bank, and the request sent again adds nothing', async () => {
    if (!worker) {
      await prepareState(state, tables);
      worker = await startWorker(port, state);
    }
    const base = worker.url;
    const id = 'it-restart-tb';
    const ca = await user('ta', base);
    const cb = await user('tb', base);
    let a = await TableSocket.open(ca, id, { base });
    let b = await TableSocket.open(cb, id, { base });
    expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await a.waitState(live, 15_000, 'hand start');
    await b.waitState((s) => live(s) && s.hand!.id === a.state!.hand!.id);
    const actor = isMyTurn(a.state!) ? 'a' : 'b';
    const me = actor === 'a' ? a : b;
    const h = me.state!.hand!;
    const reqId = `tb-${crypto.randomUUID()}`;
    const msg = { t: 'timeBank', handId: h.id, seq: h.seq, seen: 0 };
    const answer = me.waitNext((m) => m.t !== 'state' && 'reqId' in m && m.reqId === reqId, 15_000, 'time bank answer');
    me.send({ ...msg, reqId });
    expect(await answer).toMatchObject({ t: 'ack' });
    const used = me.state!;
    expect(used.hand).toMatchObject({ id: h.id, deadline: h.deadline! + 10_000, extraMs: 10_000 });
    expect(used.you.timeBank).toEqual({ ms: 20_000, hands: 0 });
    a.close();
    b.close();

    await worker.stop();
    worker = await startWorker(port, state);
    a = await TableSocket.open(ca, id, { base });
    b = await TableSocket.open(cb, id, { base });
    const back = actor === 'a' ? a : b;
    expect(back.state!.hand).toMatchObject({ id: h.id, seq: h.seq, deadline: h.deadline! + 10_000, extraMs: 10_000 });
    expect(back.state!.you.timeBank).toEqual({ ms: 20_000, hands: 0 });
    // The same request sent again after the restart (as by a client that never saw the answer): nothing more is added.
    const again = back.waitNext((m) => m.t !== 'state' && 'reqId' in m && m.reqId === reqId, 15_000, 'answer again');
    back.send({ ...msg, reqId });
    expect(['ack', 'error']).toContain((await again).t);
    await new Promise((r) => setTimeout(r, 300));
    expect(back.state!.hand).toMatchObject({ deadline: h.deadline! + 10_000, extraMs: 10_000 });
    expect(back.state!.you.timeBank).toEqual({ ms: 20_000, hands: 0 });
    // A new use from what the screen shows works as before the restart.
    expect(await back.request({ t: 'timeBank', handId: h.id, seq: h.seq, seen: 10_000 })).toMatchObject({ t: 'ack' });
    expect(back.state!.hand).toMatchObject({ deadline: h.deadline! + 20_000, extraMs: 20_000 });
    expect(back.state!.you.timeBank).toEqual({ ms: 10_000, hands: 0 });
    // The clock still runs: the room's alarm is set for this turn.
    const admin = await adminOn(base);
    const detail = (await admin.get(`/api/admin/tables/${id}`)).body;
    expect(detail.live.timer).toMatchObject({ deadline: h.deadline! + 20_000, extraMs: 20_000 });
    expect(detail.diagnosis.issues).not.toContain('timer_unarmed');
    a.close();
    b.close();
  }, 240_000);
});