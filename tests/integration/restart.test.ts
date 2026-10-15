import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, signupBody, WEB_ORIGIN } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { prepareState, root, startWorker, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

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
    await prepareState(state);
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
      await prepareState(state);
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

  const balanceOf = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;
  const cashOuts = async (c: Client) => ((await c.get('/api/me/ledger?limit=100')).body as { type: string; amount: number }[]).filter((l) => l.type === 'cash_out');
  const tableRow = async (id: string) =>
    (await d1<{ status: string; hands_played: number; hands: number }>(`SELECT status, hands_played, (SELECT COUNT(*) FROM hands WHERE table_id = '${id}') AS hands FROM tables WHERE id = '${id}'`, state))[0]!;

  it('a close the room never heard about is finished when the room next loads, or by the daily sweep, paying each player once', async () => {
    if (!worker) {
      await prepareState(state);
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
      await prepareState(state);
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
});
