import type { ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

type Player = Awaited<ReturnType<typeof player>>;
type Notice = Extract<ServerMessage, { t: 'notice' }>;
interface LedgerRow {
  type: string;
  amount: number;
  balanceAfter: number;
  tableId: string | null;
  memo: string | null;
}

async function player(tableId: string) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId);
  open.push(ws);
  return { ...u, ws };
}

async function sit(p: Player, seatIndex: number, buyIn: number, ws = p.ws) {
  const r = await ws.request({ t: 'sit', seatIndex, buyIn });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  await ws.waitState((s) => s.you.seatIndex === seatIndex);
}

const wallet = async (p: Player) => (await p.client.get('/api/auth/me')).body.balance as number;
const ledger = async (p: Player) => (await p.client.get('/api/me/ledger?limit=100')).body as LedgerRow[];
const topUps = async (p: Player) => (await ledger(p)).filter((l) => l.type === 'top_up');
const notices = (p: Player, code?: Notice['code']) => p.ws.messages.filter((m): m is Notice => m.t === 'notice' && (!code || m.code === code));
const handLive = (s: TableView | null) => !!s?.hand && s.status === 'playing' && s.hand.stage !== 'settled';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `f` until it returns something truthy. */
async function until<T>(f: () => T, label: string, ms = 20_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const v = f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
  }
}

/** Sits the player alone at a table with a huge minimum, leaving `left` chips in the wallet. */
async function drain(p: Player, tableId: string, left: number) {
  const ws = await TableSocket.open(p.client, tableId);
  open.push(ws);
  await sit(p, 0, (await wallet(p)) - left, ws);
  expect(await wallet(p)).toBe(left);
  return ws;
}

/** Stands every socket's player up and waits for the cash-out. */
async function leaveAll(...wss: TableSocket[]) {
  for (const ws of wss) expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
  for (const ws of wss) await ws.waitState((s) => s.you.seatIndex === null, 30_000, 'stood up');
}

/** Wallets hold every chip again, and each wallet equals the sum of its ledger. */
async function expectConserved(ps: Player[]) {
  let total = 0;
  for (const p of ps) {
    const w = await wallet(p);
    expect((await ledger(p)).reduce((s, l) => s + l.amount, 0)).toBe(w);
    total += w;
  }
  expect(total).toBe(10_000 * ps.length);
}

/** Drives the current hand to the end, whoever is to act: all in, or call / check when that is all that is left. */
async function playOut(players: Player[], style: 'allin' | 'checkCall') {
  const handId = players[0]!.ws.state!.hand!.id;
  for (let guard = 0; guard < 400; guard++) {
    if (players.every((p) => p.ws.state?.hand?.id !== handId || p.ws.state.hand.stage === 'settled')) return handId;
    const actor = players.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId);
    if (!actor) {
      await sleep(100);
      continue;
    }
    const legal = actor.ws.state!.you.legal.map((o) => o.type);
    const type = style === 'allin' && legal.includes('allin') ? 'allin' : legal.includes('check') ? 'check' : 'call';
    const { result } = await actor.ws.act(type);
    expect(result.t, JSON.stringify(result)).toBe('state');
  }
  throw new Error('hand did not finish');
}

describe('table top-ups and automatic rebuy (real workerd + Durable Objects)', () => {
  it('between hands a top-up applies at once, keeps the stack within the buy-in range and a retried request takes chips once', async () => {
    const a = await player('it-topup-0');
    await sit(a, 0, 300);
    expect(a.ws.state!.you).toMatchObject({ topUpQueued: null, autoRebuy: null });
    // Like a buy-in, the stack afterwards must stay within the table's range (here at most 1000).
    expect(await a.ws.request({ t: 'topUp', amount: 701 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    expect(await wallet(a)).toBe(9700);

    // The same request sent twice (a retry after a lost ack) is acknowledged twice and applied once.
    const reqId = `topup-retry-${Date.now()}`;
    a.ws.send({ t: 'topUp', reqId, amount: 200 });
    a.ws.send({ t: 'topUp', reqId, amount: 200 });
    await until(() => a.ws.messages.filter((m) => m.t === 'ack' && m.reqId === reqId).length === 2, 'two acks');
    await a.ws.waitState((s) => s.seats[0]!.stack === 500);
    expect(await wallet(a)).toBe(9500);
    expect(await topUps(a)).toEqual([expect.objectContaining({ amount: -200, balanceAfter: 9500, tableId: 'it-topup-0', memo: 'top-up' })]);
    // The table session's buy-in grows with it, so the session's profit stays honest.
    const [session] = await d1<{ buy_in: number }>(`SELECT buy_in FROM table_sessions WHERE user_id = '${a.me.id}' AND table_id = 'it-topup-0' AND status = 'seated'`);
    expect(session?.buy_in).toBe(500);

    // A short wallet is refused and nothing moves.
    const drainWs = await drain(a, 'it-topup-drain-0', 100);
    expect(await a.ws.request({ t: 'topUp', amount: 300 })).toMatchObject({ t: 'error', code: 'insufficient_balance' });
    expect(a.ws.state!.seats[0]!.stack).toBe(500);
    expect(await wallet(a)).toBe(100);
    expect(await topUps(a)).toHaveLength(1);
    expect(await a.ws.request({ t: 'topUp', amount: 100 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.seats[0]!.stack === 600);
    expect(await wallet(a)).toBe(0);
    expect(await a.ws.request({ t: 'topUp', amount: 1 })).toMatchObject({ t: 'error', code: 'insufficient_balance' });

    // Not seated: nothing to top up.
    const spectator = await player('it-topup-0');
    expect(await spectator.ws.request({ t: 'topUp', amount: 100 })).toMatchObject({ t: 'error', code: 'forbidden' });

    await leaveAll(a.ws, drainWs);
    await expectConserved([a, spectator]);
  });

  it('a top-up that cannot reach D1 takes nothing, its retry applies once, and a replay after the room forgot its request id adds no chips', async () => {
    const a = await player('it-topup-5');
    await sit(a, 0, 300);
    const reqId = `topup-replay-${Date.now()}`;
    const reply = (ws: TableSocket) => ws.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === reqId, 15_000, 'reply');

    // D1 fails (another connection holds its write lock): the request fails and nothing moves.
    let release = holdD1WriteLock();
    let r = reply(a.ws);
    try {
      a.ws.send({ t: 'topUp', reqId, amount: 200 });
      expect(await r).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      release();
    }
    expect(a.ws.state!.seats[0]!.stack).toBe(300);
    expect(await wallet(a)).toBe(9700);
    // The client retries with the same id: applied once.
    r = reply(a.ws);
    a.ws.send({ t: 'topUp', reqId, amount: 200 });
    expect(await r).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.seats[0]!.stack === 500);
    expect(await wallet(a)).toBe(9500);

    // The room remembers the last 200 request ids. Push this one out with harmless requests: 20 per connection (the
    // most one may send at once), each new connection replacing the last.
    let ws = a.ws;
    for (let i = 0; i < 200; i++) {
      if (i % 20 === 0) {
        ws = await TableSocket.open(a.client, 'it-topup-5');
        open.push(ws);
      }
      expect(await ws.request({ t: 'autoRebuy', on: false })).toMatchObject({ t: 'ack' });
    }

    // The same request again while D1 fails: it must not leave anything that would later credit the chips again.
    ws = await TableSocket.open(a.client, 'it-topup-5');
    open.push(ws);
    release = holdD1WriteLock();
    try {
      r = reply(ws);
      ws.send({ t: 'topUp', reqId, amount: 200 });
      expect(await r).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      release();
    }
    // And once D1 is back: the ledger already has it, so it is acknowledged and nothing moves.
    r = reply(ws);
    ws.send({ t: 'topUp', reqId, amount: 200 });
    expect(await r).toMatchObject({ t: 'ack' });
    expect(ws.state!.seats[0]!.stack).toBe(500);
    expect(await wallet(a)).toBe(9500);
    // Standing up settles anything left pending, then cashes out the stack.
    await leaveAll(ws);
    expect(await wallet(a)).toBe(10_000);
    expect(await topUps(a)).toEqual([expect.objectContaining({ amount: -200 })]);
    await expectConserved([a]);
  });

  it('during a hand a top-up waits, can be replaced or cancelled, and is applied after the hand without passing the maximum', async () => {
    const a = await player('it-topup-1');
    const b = await player('it-topup-1');
    await sit(a, 0, 100);
    await sit(b, 1, 100);
    const live = await a.ws.waitState(handLive, 20_000, 'hand start');
    await b.ws.waitState((s) => s.hand?.id === live.hand!.id);
    const handId = live.hand!.id;

    // Checked against the chips behind (100 less a blind): 4 more would stay below the minimum, 950 would pass the maximum.
    expect(await a.ws.request({ t: 'topUp', amount: 4 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    expect(await a.ws.request({ t: 'topUp', amount: 950 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    expect(await a.ws.request({ t: 'topUp', amount: 200 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.topUpQueued === 200);
    // A newer request replaces the waiting one; cancelling drops it. Nothing is taken from the wallet meanwhile.
    expect(await a.ws.request({ t: 'topUp', amount: 900 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.topUpQueued === 900);
    a.ws.send({ t: 'cancelTopUp' });
    await a.ws.waitState((s) => s.you.topUpQueued === null);
    expect(await a.ws.request({ t: 'topUp', amount: 900 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.topUpQueued === 900);
    expect(await wallet(a)).toBe(9900);
    // b's top-up is accepted, then b's wallet runs dry before the hand ends.
    expect(await b.ws.request({ t: 'topUp', amount: 200 })).toMatchObject({ t: 'ack' });
    const drainWs = await drain(b, 'it-topup-drain-1', 50);
    // Each player sees only their own pending top-up.
    expect(b.ws.state!.you.topUpQueued).toBe(200);
    expect(a.ws.state!.you.topUpQueued).toBe(900);

    await playOut([a, b], 'checkCall');
    const settled = await a.ws.wait((m) => m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage === 'settled');
    const finalStack = (settled as Extract<ServerMessage, { t: 'state' }>).state.seats[0]!.stack;
    // Never more than asked, never past the table maximum.
    const applied = Math.min(900, 1000 - finalStack);
    expect(await until(() => notices(a, 'topup_applied')[0], 'topup_applied')).toMatchObject({ amount: applied });
    expect(await until(() => notices(b, 'topup_insufficient')[0], 'topup_insufficient')).toBeTruthy();
    await a.ws.wait((m) => m.t === 'state' && m.state.you.topUpQueued === null && m.state.seats[0]!.stack === finalStack + applied);
    // The stack never grew during the hand: every view of it shows at most the chips a sat down with.
    for (const p of [a, b]) {
      for (const m of p.ws.messages) {
        if (m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage !== 'settled') expect(m.state.seats[0]!.stack).toBeLessThanOrEqual(100);
      }
    }
    expect(await wallet(a)).toBe(9900 - applied);
    expect(await topUps(a)).toEqual([expect.objectContaining({ amount: -applied, tableId: 'it-topup-1' })]);
    expect(await wallet(b)).toBe(50);
    expect(await topUps(b)).toEqual([]);
    expect(notices(a).map((n) => n.code)).toEqual(['topup_applied']);

    await leaveAll(a.ws, b.ws, drainWs);
    await expectConserved([a, b]);
  });

  it('automatic rebuy is off by default and turns on only with consent, an amount and a limit', async () => {
    const a = await player('it-topup-2');
    const watcher = await player('it-topup-2');
    await sit(a, 0, 300);
    expect(a.ws.state!.you.autoRebuy).toBeNull();
    const set = (msg: Record<string, unknown>) => a.ws.request({ t: 'autoRebuy', ...msg });
    expect(await set({ on: true, amount: 100, cap: 300 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await set({ on: true, consent: true, amount: 100 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await set({ on: true, consent: true, cap: 300 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await set({ on: true, consent: true, amount: 50, cap: 100 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    expect(await set({ on: true, consent: true, amount: 1001, cap: 2000 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    // The limit covers at least one rebuy and at most five.
    expect(await set({ on: true, consent: true, amount: 100, cap: 99 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await set({ on: true, consent: true, amount: 100, cap: 501 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(a.ws.state!.you.autoRebuy).toBeNull();
    expect(await set({ on: true, consent: true, amount: 200, cap: 1000 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.autoRebuy?.cap === 1000);
    expect(a.ws.state!.you.autoRebuy).toEqual({ amount: 200, cap: 1000, spent: 0 });
    // Only the player sees it, and only a seated player can set it.
    expect(watcher.ws.state!.you.autoRebuy).toBeNull();
    expect(JSON.stringify(watcher.ws.messages)).not.toMatch(/"cap":1000/);
    expect(await watcher.ws.request({ t: 'autoRebuy', on: true, consent: true, amount: 200, cap: 400 })).toMatchObject({ t: 'error', code: 'forbidden' });
    expect(await set({ on: false })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.autoRebuy === null);
    expect(await topUps(a)).toEqual([]);

    await leaveAll(a.ws);
    await expectConserved([a, watcher]);
  });

  it('automatic rebuy refills a busted stack once per hand and turns off at its limit, after which the player stands up', async () => {
    const a = await player('it-topup-3');
    const b = await player('it-topup-3');
    // One rebuy of 100 each: a player's second bust ends it.
    const rebuyOnce = { t: 'autoRebuy', on: true, consent: true, amount: 100, cap: 100 };
    await sit(a, 0, 100);
    expect(await a.ws.request(rebuyOnce)).toMatchObject({ t: 'ack' });
    await sit(b, 1, 100);
    expect(await b.ws.request(rebuyOnce)).toMatchObject({ t: 'ack' });
    const capped = () => [a, b].find((p) => notices(p, 'rebuy_cap').length > 0);
    let last: string | null = null;
    // Both push every hand, so the shorter stack busts about half the time; the limit is reached within a few hands.
    for (let n = 0; n < 20 && !capped(); n++) {
      await until(() => [a, b].every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'next hand');
      last = a.ws.state!.hand!.id;
      await playOut([a, b], 'allin');
      await until(() => capped() || (handLive(a.ws.state) && a.ws.state!.hand!.id !== last), 'next hand or limit');
    }
    const loser = capped();
    expect(loser, 'no player reached the rebuy limit in 20 hands').toBeTruthy();
    const other = loser === a ? b : a;
    // The capped player stood up with automatic rebuy off, after exactly one rebuy.
    await loser!.ws.waitState((s) => s.you.seatIndex === null && s.you.autoRebuy === null);
    expect(notices(loser!, 'rebuy_applied')).toEqual([expect.objectContaining({ amount: 100 })]);
    for (const p of [a, b]) {
      const rebuys = notices(p, 'rebuy_applied');
      expect(await topUps(p)).toEqual(rebuys.map(() => expect.objectContaining({ amount: -100, memo: 'auto rebuy', tableId: 'it-topup-3' })));
      const [session] = await d1<{ buy_in: number }>(`SELECT buy_in FROM table_sessions WHERE user_id = '${p.me.id}' AND table_id = 'it-topup-3'`);
      expect(session?.buy_in).toBe(100 + 100 * rebuys.length);
    }

    await leaveAll(other.ws);
    await expectConserved([a, b]);
  }, 180_000);

  it('automatic rebuy with an empty wallet turns itself off and takes nothing; a waiting top-up is refused up front', async () => {
    const a = await player('it-topup-4');
    const b = await player('it-topup-4');
    await sit(a, 0, 100);
    const drains = [await drain(a, 'it-topup-drain-2', 50)];
    expect(await a.ws.request({ t: 'autoRebuy', on: true, consent: true, amount: 100, cap: 500 })).toMatchObject({ t: 'ack' });
    await sit(b, 1, 100);
    drains.push(await drain(b, 'it-topup-drain-3', 50));
    expect(await b.ws.request({ t: 'autoRebuy', on: true, consent: true, amount: 100, cap: 500 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState(handLive, 20_000, 'hand start');
    // In a hand the wallet is checked when the top-up is asked for, not only when it is applied.
    expect(await a.ws.request({ t: 'topUp', amount: 200 })).toMatchObject({ t: 'error', code: 'insufficient_balance' });
    expect(a.ws.state!.you.topUpQueued).toBeNull();

    const busted = () => [a, b].find((p) => notices(p, 'rebuy_insufficient').length > 0);
    let last: string | null = null;
    for (let n = 0; n < 10 && !busted(); n++) {
      await until(() => [a, b].every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'next hand');
      last = a.ws.state!.hand!.id;
      await playOut([a, b], 'allin');
      // Equal stacks: someone busts unless the pot was split.
      await until(() => busted() || (handLive(a.ws.state) && a.ws.state!.hand!.id !== last), 'next hand or bust');
    }
    const loser = busted();
    expect(loser, 'nobody busted in 10 hands').toBeTruthy();
    await loser!.ws.waitState((s) => s.you.seatIndex === null && s.you.autoRebuy === null);
    expect(notices(loser!, 'rebuy_applied')).toEqual([]);
    for (const p of [a, b]) {
      expect(await topUps(p)).toEqual([]);
      expect(await wallet(p)).toBe(50);
    }

    await leaveAll(...(loser === a ? [b.ws] : [a.ws]), ...drains);
    await expectConserved([a, b]);
  }, 120_000);
});
