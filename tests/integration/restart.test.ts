import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, signupBody, WEB_ORIGIN } from '../support/client';
import { prepareState, root, startWorker, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

/**
 * Kills the workerd process in the middle of a hand and restarts it on the same
 * persisted state (D1 + Durable Object storage). The hand must resume from the
 * event log: same hand id, same sequence, same private cards, chips conserved.
 */
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
});
