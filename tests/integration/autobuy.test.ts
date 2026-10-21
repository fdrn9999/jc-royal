// Automatic chip policies (`autoBuy`), chosen with the buy-in or while seated: a rebuy for a busted stack, or a top-up
// back to a target for a stack a hand left below its trigger. Only between hands, at most once per hand, through the
// top-up ledger path (one key per seat session and hand); a wallet or limit that runs out turns it off with one notice.
import type { AutoBuyRequest, ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser, sharedAdmin } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

type Player = Awaited<ReturnType<typeof player>>;
type Notice = Extract<ServerMessage, { t: 'notice' }>;
type StateMsg = Extract<ServerMessage, { t: 'state' }>;
interface LedgerRow {
  type: string;
  amount: number;
  memo: string | null;
}

async function player(tableId: string) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId);
  open.push(ws);
  return { ...u, ws };
}

async function sit(p: Player, seatIndex: number, buyIn: number, autoBuy?: AutoBuyRequest, ws = p.ws) {
  const r = await ws.request({ t: 'sit', seatIndex, buyIn, ...(autoBuy ? { autoBuy } : {}) });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  await ws.waitState((s) => s.you.seatIndex === seatIndex);
}

/** A top-up policy as the buy-in screen sends it: consent given, a limit of five top-ups from nothing unless set. */
const topup = (target: number, more: { trigger?: number; partial?: boolean; cap?: number } = {}): AutoBuyRequest => ({ mode: 'topup', target, cap: target * 5, consent: true, ...more });

const wallet = async (p: Player) => (await p.client.get('/api/auth/me')).body.balance as number;
const ledger = async (p: Player) => (await p.client.get('/api/me/ledger?limit=100')).body as LedgerRow[];
const topUps = async (p: Player) => (await ledger(p)).filter((l) => l.type === 'top_up');
/** The player's top-up ledger rows with their keys, oldest first. */
const keyed = (p: Player) => d1<{ idempotency_key: string; amount: number; memo: string | null }>(`SELECT idempotency_key, amount, memo FROM chip_ledger WHERE user_id = '${p.me.id}' AND type = 'top_up' ORDER BY created_at, rowid`);
const sessionBuyIn = async (p: Player, tableId: string) => (await d1<{ buy_in: number }>(`SELECT buy_in FROM table_sessions WHERE user_id = '${p.me.id}' AND table_id = '${tableId}'`))[0]?.buy_in;
const notices = (p: Player, code?: Notice['code']) => p.ws.messages.filter((m): m is Notice => m.t === 'notice' && (!code || m.code === code));
const handLive = (s: TableView | null) => !!s?.hand && s.status === 'playing' && s.hand.stage !== 'settled';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Polls `f` until it returns something truthy. */
async function until<T>(f: () => T, label: string, ms = 20_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const v = f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
  }
}

/** Polls an async read until `ok` holds (the rooms write their operations counters within about 10 s). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 25_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(500)) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(v).slice(0, 400)}`);
  }
}

/** Sits the player alone at a table with a huge minimum, leaving `left` chips in the wallet. */
async function drain(p: Player, tableId: string, left: number) {
  const ws = await TableSocket.open(p.client, tableId);
  open.push(ws);
  await sit(p, 0, (await wallet(p)) - left, undefined, ws);
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

/** The next hand dealt to all of these players (not `last`). */
async function nextHand(ps: Player[], last: string | null) {
  await until(() => ps.every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'next hand', 30_000);
  return ps[0]!.ws.state!;
}

/** Drives the current hand to the end, whoever is to act; `before` runs ahead of each action. */
async function playOut(players: Player[], style: 'allin' | 'checkCall', before?: (s: TableView) => void) {
  const handId = players[0]!.ws.state!.hand!.id;
  for (let guard = 0; guard < 400; guard++) {
    if (players.every((p) => p.ws.state?.hand?.id !== handId || p.ws.state.hand.stage === 'settled')) break;
    const actor = players.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId);
    if (!actor) {
      await sleep(100);
      continue;
    }
    before?.(actor.ws.state!);
    const legal = actor.ws.state!.you.legal.map((o) => o.type);
    const type = style === 'allin' && legal.includes('allin') ? 'allin' : legal.includes('check') ? 'check' : 'call';
    const { result } = await actor.ws.act(type);
    expect(result.t, JSON.stringify(result)).toBe('state');
  }
  return (await players[0]!.ws.wait((m) => m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage === 'settled', 15_000, 'settled')) as StateMsg;
}

/** No view of the hand before it settled showed the seat with more chips than it was dealt in with. */
function neverGrewDuring(p: Player, handId: string, seat: number, dealt: number) {
  for (const m of p.ws.messages) {
    if (m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage !== 'settled') expect(m.state.seats[seat]!.stack + m.state.seats[seat]!.streetBet).toBeLessThanOrEqual(dealt);
  }
}

describe('automatic rebuy and top-up policies (real workerd + Durable Objects)', () => {
  it('a policy chosen with the buy-in is checked before any chips move, seen only by its player, kept across connections, one at a time, and gone after leaving', async () => {
    const admin = sharedAdmin();
    const invalidCount = async () => ((await admin.get('/api/admin/economy?days=7&tz=540')).body as { failures: { autoBuy: { invalid: number } } }).failures.autoBuy.invalid;
    const invalidBefore = await invalidCount();
    const a = await player('it-autotop-0');
    const watcher = await player('it-autotop-0');
    const sitWith = (autoBuy: unknown) => a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 300, autoBuy });

    // Refused before the wallet is touched: a trigger above the target, a target or rebuy outside the buy-in range, a
    // limit below one top-up from nothing or above five.
    expect(await sitWith({ mode: 'topup', target: 500, trigger: 600, cap: 500, consent: true })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await sitWith({ mode: 'topup', target: 1001, cap: 2000, consent: true })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    expect(await sitWith({ mode: 'topup', target: 500, cap: 499, consent: true })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await sitWith({ mode: 'topup', target: 500, cap: 2501, consent: true })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await sitWith({ mode: 'rebuy', amount: 99, cap: 99, consent: true })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    // Without the player's consent the message itself is refused.
    const refused = a.ws.waitNext((m) => m.t === 'error' && m.message === 'invalid message', 15_000, 'refused message');
    a.ws.send({ t: 'sit', reqId: `no-consent-${Date.now()}`, seatIndex: 0, buyIn: 300, autoBuy: { mode: 'topup', target: 500, cap: 500 } });
    expect(await refused).toMatchObject({ code: 'bad_request' });
    expect(a.ws.state!.seats[0]!.userId).toBeUndefined();
    expect(await wallet(a)).toBe(10_000);
    expect((await ledger(a)).filter((l) => l.type === 'buy_in')).toEqual([]);

    // Taken with the buy-in; the trigger, partial top-ups and what was used start as the room sets them.
    expect(await sitWith(topup(500, { trigger: 400, cap: 1500 }))).toMatchObject({ t: 'ack' });
    const held = await a.ws.waitState((s) => s.you.seatIndex === 0 && !!s.you.autoBuy);
    expect(held.you.autoBuy).toEqual({ mode: 'topup', target: 500, trigger: 400, partial: false, cap: 1500, spent: 0 });
    // (A page from before automatic top-ups sees no rebuy.)
    expect(held.you.autoRebuy).toBeNull();
    expect(await wallet(a)).toBe(9_700);

    // Only the player sees it, and only a seated player can set one.
    await watcher.ws.waitState((s) => !!s.seats[0]!.userId);
    expect(watcher.ws.state!.you.autoBuy).toBeNull();
    expect(JSON.stringify(watcher.ws.messages)).not.toMatch(/"trigger"|"cap":1500/);
    expect(await watcher.ws.request({ t: 'autoBuy', policy: { mode: 'off' } })).toMatchObject({ t: 'error', code: 'forbidden' });

    // A second tab (or the page back after a reconnect) takes over the player's one live connection and gets the same
    // policy; what it changes is what the first tab finds when it connects again.
    const replaced = a.ws.waitNext((m) => m.t === 'replaced', 15_000, 'replaced');
    const tab = await TableSocket.open(a.client, 'it-autotop-0');
    open.push(tab);
    await replaced;
    expect(tab.state!.you.autoBuy).toEqual(held.you.autoBuy);

    // One policy at a time: a rebuy replaces the top-up, and the top-up the rebuy.
    expect(await tab.request({ t: 'autoBuy', policy: { mode: 'rebuy', amount: 200, cap: 400, consent: true } })).toMatchObject({ t: 'ack' });
    expect(tab.state!.you).toMatchObject({ autoBuy: { mode: 'rebuy', amount: 200, cap: 400, spent: 0 }, autoRebuy: { amount: 200, cap: 400, spent: 0 } });
    expect(await tab.request({ t: 'autoBuy', policy: { mode: 'topup', target: 600, cap: 600, consent: true } })).toMatchObject({ t: 'ack' });
    expect(tab.state!.you).toMatchObject({ autoBuy: { mode: 'topup', target: 600, trigger: 600, partial: false, cap: 600, spent: 0 }, autoRebuy: null });
    // A page from before automatic top-ups: turning its rebuy off leaves the top-up alone; turning it on replaces it.
    expect(await tab.request({ t: 'autoRebuy', on: false })).toMatchObject({ t: 'ack' });
    expect(tab.state!.you.autoBuy).toMatchObject({ mode: 'topup' });
    expect(await tab.request({ t: 'autoRebuy', on: true, consent: true, amount: 100, cap: 100 })).toMatchObject({ t: 'ack' });
    expect(tab.state!.you.autoBuy).toEqual({ mode: 'rebuy', amount: 100, cap: 100, spent: 0 });
    // A change the room refuses leaves the policy as it was.
    expect(await tab.request({ t: 'autoBuy', policy: { mode: 'topup', target: 500, trigger: 501, cap: 500, consent: true } })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(tab.state!.you.autoBuy).toMatchObject({ mode: 'rebuy' });

    // The first tab back finds the policy as the second tab left it, and can turn it off.
    const back = await TableSocket.open(a.client, 'it-autotop-0');
    open.push(back);
    expect(back.state!.you.autoBuy).toEqual({ mode: 'rebuy', amount: 100, cap: 100, spent: 0 });
    expect(await back.request({ t: 'autoBuy', policy: { mode: 'off' } })).toMatchObject({ t: 'ack' });
    expect(back.state!.you.autoBuy).toBeNull();

    // It lasts as long as the seat: after leaving and sitting down again without one, there is none.
    expect(await back.request({ t: 'autoBuy', policy: topup(500) })).toMatchObject({ t: 'ack' });
    await leaveAll(back);
    expect(back.state!.you.autoBuy).toBeNull();
    await sit(a, 0, 300, undefined, back);
    expect(back.state!.you.autoBuy).toBeNull();
    expect(await topUps(a)).toEqual([]);
    await leaveAll(back);
    await expectConserved([a, watcher]);

    // The six policies the room refused are counted for the economy page (not the message it could not read).
    await eventually(invalidCount, (n) => n >= invalidBefore + 6, 'autobuy_invalid counted');
  }, 90_000);

  it('after each hand every stack below its trigger is brought back to the target at once, after a waiting manual top-up and never during the hand', async () => {
    const T = 'it-autotop-1';
    const [a, b, c] = [await player(T), await player(T), await player(T)];
    // Bought in below the target: a is topped up after any hand. b's trigger is under what it sat down with; c rebuys at 0 only.
    await sit(a, 0, 300, topup(500));
    await sit(b, 1, 300, topup(500, { trigger: 290 }));
    await sit(c, 2, 300, { mode: 'rebuy', amount: 300, cap: 300, consent: true });
    // The trigger defaults to the target.
    expect(a.ws.state!.you.autoBuy).toEqual({ mode: 'topup', target: 500, trigger: 500, partial: false, cap: 2500, spent: 0 });
    const rules = [
      { p: a, seat: 0, below: 500 },
      { p: b, seat: 1, below: 290 },
      { p: c, seat: 2, below: 0 },
    ];

    let last: string | null = null;
    for (let n = 0; n < 2; n++) {
      const live = await nextHand([a, b, c], last);
      const handId = live.hand!.id;
      last = handId;
      expect(live.seats.filter((x) => x.hasCards)).toHaveLength(3);
      const dealt = rules.map((r) => live.seats[r.seat]!.stack + live.seats[r.seat]!.streetBet);
      const seen = rules.map((r) => notices(r.p).length);
      // In the first hand a also asks for a manual top-up: it waits for the hand, goes first, and the automatic one
      // takes only what is still missing.
      if (n === 0) {
        expect(await a.ws.request({ t: 'topUp', amount: 50 })).toMatchObject({ t: 'ack' });
        await a.ws.waitState((s) => s.you.topUpQueued === 50);
      }
      const settled = await playOut([a, b, c], 'checkCall');
      const settledAt = Date.now();
      // Every notice of a hand goes out before the next deal.
      await nextHand([a, b, c], handId);
      const tookMs = Date.now() - settledAt;
      for (const [i, r] of rules.entries()) {
        neverGrewDuring(r.p, handId, r.seat, dealt[i]!);
        let stack = settled.state.seats[r.seat]!.stack;
        const want: { code: string; amount: number }[] = [];
        if (n === 0 && r.p === a) {
          stack += 50;
          want.push({ code: 'topup_applied', amount: 50 });
        }
        if (stack < r.below) want.push({ code: 'autotopup_applied', amount: 500 - stack });
        expect(notices(r.p).slice(seen[i]).map(({ code, amount }) => ({ code, amount })), `hand ${n}, seat ${r.seat}`).toEqual(want);
      }
      console.log(`[autobuy] hand ${n}: settled to next deal ${tookMs} ms`);
    }

    // What the room says it took is what the ledger took: one key per hand, the seat session's buy-in grown with it.
    expect(a.ws.state!.you.autoBuy).toMatchObject({ spent: sum(notices(a, 'autotopup_applied').map((m) => m.amount!)) });
    await leaveAll(a.ws, b.ws, c.ws);
    for (const r of rules) {
      const autos = notices(r.p, 'autotopup_applied').map((m) => m.amount!);
      const manual = notices(r.p, 'topup_applied').map((m) => m.amount!);
      const rows = await keyed(r.p);
      expect(rows.filter((x) => x.memo === 'auto top-up').map((x) => -x.amount)).toEqual(autos);
      expect(rows.filter((x) => x.memo === 'top-up').map((x) => -x.amount)).toEqual(manual);
      expect(new Set(rows.map((x) => x.idempotency_key)).size).toBe(rows.length);
      for (const x of rows.filter((x) => x.memo === 'auto top-up')) expect(x.idempotency_key).toMatch(new RegExp(`^autotop:[0-9a-f-]{36}:${T}:\\d+:`));
      expect(await sessionBuyIn(r.p, T)).toBe(300 + sum(manual) + sum(autos));
    }
    // (a's first hand always leaves it short of the target.)
    expect(notices(a, 'autotopup_applied').length).toBeGreaterThanOrEqual(1);
    // c rebuys at 0 only. Leaving the hand still being dealt confirms the stand-up (`left_seat`), at most once each:
    // whoever is still in it when the others have gone wins it and stands up between hands, without one.
    expect(notices(c).filter((m) => m.code !== 'left_seat')).toEqual([]);
    for (const r of rules) expect(notices(r.p, 'left_seat').length).toBeLessThanOrEqual(1);
    await expectConserved([a, b, c]);
  }, 150_000);

  it('an all-in lost is restored to the target from 0 once the hand settles; an all-in won is judged on its final stack', async () => {
    const T = 'it-autotop-2';
    const a = await player(T);
    const b = await player(T);
    await sit(a, 0, 500, topup(500));
    await sit(b, 1, 500, topup(500));
    const ps = [a, b];
    let last: string | null = null;
    let busted: number | null = null;
    for (let n = 0; n < 10 && busted === null; n++) {
      last = (await nextHand(ps, last)).hand!.id;
      const settled = await playOut(ps, 'allin');
      const i = settled.state.seats.findIndex((s) => !!s.userId && s.stack === 0);
      // Equal stacks: someone busts unless the pot was split (both keep 500, nothing to top up).
      if (i < 0) continue;
      busted = i;
      const loser = ps[i]!;
      const winner = ps[1 - i]!;
      const note = await until(() => notices(loser, 'autotopup_applied')[0], 'top-up');
      expect(note).toMatchObject({ amount: 500 });
      // Sent after the result: while all in, the stack showed 0 and nothing joined it.
      const settledOnLoser = loser.ws.messages.findIndex((m) => m.t === 'state' && m.state.hand?.id === last && m.state.hand.stage === 'settled');
      expect(loser.ws.messages.indexOf(note)).toBeGreaterThan(settledOnLoser);
      neverGrewDuring(loser, last, i, 500);
      // Still seated with the target, and dealt into the next hand; the winner, at 1000, was not charged.
      await loser.ws.waitState((s) => s.you.seatIndex === i && s.seats[i]!.stack + s.seats[i]!.streetBet === 500, 15_000, 'restored stack');
      expect(notices(winner)).toEqual([]);
      await nextHand(ps, last);
      expect(loser.ws.state!.seats.filter((x) => x.hasCards)).toHaveLength(2);
    }
    expect(busted, 'nobody busted in 10 hands').not.toBeNull();
    const loser = ps[busted!]!;
    expect(await topUps(loser)).toEqual([expect.objectContaining({ amount: -500, memo: 'auto top-up' })]);
    expect(await topUps(ps[1 - busted!]!)).toEqual([]);
    expect(await wallet(loser)).toBe(9_000);
    await leaveAll(a.ws, b.ws);
    await expectConserved(ps);
  }, 150_000);

  it('a short wallet with partial top-ups on takes what it holds when that reaches the table minimum', async () => {
    const T = 'it-autotop-3';
    const a = await player(T);
    const b = await player(T);
    await sit(a, 0, 500, topup(500, { partial: true }));
    await sit(b, 1, 500, topup(500, { partial: true }));
    const drains = [await drain(a, 'it-autotop-drain-0', 300), await drain(b, 'it-autotop-drain-1', 300)];
    const ps = [a, b];
    let last: string | null = null;
    let busted: number | null = null;
    for (let n = 0; n < 10 && busted === null; n++) {
      last = (await nextHand(ps, last)).hand!.id;
      const settled = await playOut(ps, 'allin');
      const i = settled.state.seats.findIndex((s) => !!s.userId && s.stack === 0);
      if (i < 0) continue;
      busted = i;
      const loser = ps[i]!;
      expect(await until(() => notices(loser, 'autotopup_applied')[0], 'partial top-up')).toMatchObject({ amount: 300 });
      await loser.ws.waitState((s) => s.seats[i]!.stack + s.seats[i]!.streetBet === 300, 15_000, 'partial stack');
      // Still on, with what it took counted.
      expect(loser.ws.state!.you.autoBuy).toMatchObject({ mode: 'topup', spent: 300 });
      expect(notices(ps[1 - i]!)).toEqual([]);
    }
    expect(busted, 'nobody busted in 10 hands').not.toBeNull();
    const loser = ps[busted!]!;
    expect(await wallet(loser)).toBe(0);
    expect(await topUps(loser)).toEqual([expect.objectContaining({ amount: -300, memo: 'auto top-up' })]);
    expect(await wallet(ps[1 - busted!]!)).toBe(300);
    await leaveAll(a.ws, b.ws, ...drains);
    await expectConserved(ps);
  }, 150_000);

  it('a wallet that cannot cover it turns the policy off with one notice and takes nothing; the busted player stands up', async () => {
    const T = 'it-autotop-4';
    const a = await player(T);
    const b = await player(T);
    // a: 400 left, short of a top-up from 0 to 500. b: partial on, but 50 cannot reach the table minimum of 100.
    await sit(a, 0, 500, topup(500));
    await sit(b, 1, 500, topup(500, { partial: true }));
    const drains = [await drain(a, 'it-autotop-drain-2', 400), await drain(b, 'it-autotop-drain-3', 50)];
    const ps = [a, b];
    let last: string | null = null;
    let busted: number | null = null;
    for (let n = 0; n < 10 && busted === null; n++) {
      last = (await nextHand(ps, last)).hand!.id;
      const settled = await playOut(ps, 'allin');
      const i = settled.state.seats.findIndex((s) => !!s.userId && s.stack === 0);
      if (i < 0) continue;
      busted = i;
    }
    expect(busted, 'nobody busted in 10 hands').not.toBeNull();
    const loser = ps[busted!]!;
    const winner = ps[1 - busted!]!;
    await loser.ws.waitState((s) => s.you.seatIndex === null && s.you.autoBuy === null, 30_000, 'stood up, policy off');
    // The notice follows the state that stands the player up (room.ts `settle`: the broadcast, then the notices).
    await until(() => notices(loser, 'autotopup_insufficient')[0], 'insufficient notice');
    expect(notices(loser).map((n) => n.code)).toEqual(['autotopup_insufficient']);
    // The winner, alone now, keeps the policy; nothing was taken from either wallet.
    expect(winner.ws.state!.you.autoBuy).toMatchObject({ mode: 'topup', spent: 0 });
    expect(notices(winner)).toEqual([]);
    for (const p of ps) expect(await topUps(p)).toEqual([]);
    expect(await wallet(a)).toBe(400);
    expect(await wallet(b)).toBe(50);
    // No notice again afterwards.
    await sleep(1_500);
    expect(notices(loser)).toHaveLength(1);
    await leaveAll(winner.ws, ...drains);
    await expectConserved(ps);
  }, 150_000);

  it('the policy turns itself off at its limit with one notice, after which a busted player stands up', async () => {
    const T = 'it-autotop-5';
    const a = await player(T);
    const b = await player(T);
    // One top-up of 100 from nothing each: a player's second bust ends it.
    await sit(a, 0, 100, topup(100, { cap: 100 }));
    await sit(b, 1, 100, topup(100, { cap: 100 }));
    const ps = [a, b];
    const capped = () => ps.find((p) => notices(p, 'autotopup_cap').length > 0);
    let last: string | null = null;
    for (let n = 0; n < 20 && !capped(); n++) {
      last = (await nextHand(ps, last)).hand!.id;
      await playOut(ps, 'allin');
      await until(() => capped() || ps.every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'next hand or limit', 30_000);
    }
    const loser = capped();
    expect(loser, 'no player reached the limit in 20 hands').toBeTruthy();
    await loser!.ws.waitState((s) => s.you.seatIndex === null && s.you.autoBuy === null, 30_000, 'stood up, policy off');
    expect(notices(loser!).map((n) => n.code)).toEqual(['autotopup_applied', 'autotopup_cap']);
    for (const p of ps) {
      const applied = notices(p, 'autotopup_applied');
      expect(await topUps(p)).toEqual(applied.map(() => expect.objectContaining({ amount: -100, memo: 'auto top-up' })));
      expect(await sessionBuyIn(p, T)).toBe(100 + 100 * applied.length);
    }
    await leaveAll((loser === a ? b : a).ws);
    await expectConserved(ps);
  }, 240_000);

  it('a top-up D1 cannot take when the hand settles takes nothing then, and each hand is charged at most once after D1 is back', async () => {
    const T = 'it-autotop-6';
    const a = await player(T);
    const b = await player(T);
    await sit(a, 0, 300, topup(500));
    await sit(b, 1, 300);
    const ps = [a, b];
    const first = (await nextHand(ps, null)).hand!.id;
    let release: (() => void) | null = null;
    let settledStack = 0;
    try {
      // Check down; D1 goes away just before the last check on the river ends the hand.
      let riverActs = 0;
      const settled = await playOut(ps, 'checkCall', (s) => {
        if (s.hand!.stage === 'river' && riverActs++ === 1) release = holdD1WriteLock();
      });
      expect(release, 'the hand reached the river').not.toBeNull();
      settledStack = settled.state.seats[0]!.stack;
      // The result went out; the room's D1 calls that follow fail while the lock is held.
      await sleep(4_000);
      expect(notices(a)).toEqual([]);
      for (const m of a.ws.messages) {
        if (m.t === 'state' && m.state.hand?.id === first && m.state.hand.stage === 'settled') expect(m.state.seats[0]!.stack).toBe(settledStack);
      }
    } finally {
      (release as (() => void) | null)?.();
    }

    // D1 is back: the top-up is retried (the hand just settled, or the next one) and lands once per hand.
    let last = first;
    for (let n = 0; n < 3 && notices(a, 'autotopup_applied').length === 0; n++) {
      await until(() => notices(a, 'autotopup_applied').length > 0 || ps.every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'retry or next hand', 30_000);
      if (notices(a, 'autotopup_applied').length > 0) break;
      last = a.ws.state!.hand!.id;
      await playOut(ps, 'checkCall');
      await until(() => notices(a, 'autotopup_applied').length > 0 || ps.every((p) => handLive(p.ws.state) && p.ws.state!.hand!.id !== last), 'top-up or next hand', 30_000);
    }
    expect(notices(a, 'autotopup_applied').length, 'a top-up after D1 came back').toBeGreaterThan(0);
    // Topped up to the target from where the hand left it: dealt in at 500 next.
    expect(notices(a, 'autotopup_applied')).toHaveLength(1);
    await a.ws.waitState((s) => handLive(s) && s.seats[0]!.stack + s.seats[0]!.streetBet === 500, 30_000, 'dealt in at the target');
    await leaveAll(a.ws, b.ws);
    const rows = (await keyed(a)).filter((x) => x.memo === 'auto top-up');
    expect(rows.map((x) => -x.amount)).toEqual(notices(a, 'autotopup_applied').map((m) => m.amount));
    // One key per hand: never charged twice for the same hand.
    expect(new Set(rows.map((x) => x.idempotency_key.split(':').slice(2).join(':'))).size).toBe(rows.length);
    expect(await sessionBuyIn(a, T)).toBe(300 + sum(rows.map((x) => -x.amount)));
    await expectConserved(ps);
  }, 180_000);
});
