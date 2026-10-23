// Standing up mid-hand after a fold (room.ts `standFolded`): a folded player's stack is final, so it goes back to the
// wallet at once and the others play the hand on; what they put in stays in the pot, their seat stays the hand's until
// it ends, and the hand's record keeps them. A player all in is never folded by leaving: they stand up once it settles.
import type { AutoBuyRequest, HandDetailDto, HandView, ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
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
}

async function player(tableId: string) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId);
  open.push(ws);
  return { ...u, ws };
}

async function sit(p: Player, seatIndex: number, buyIn: number, autoBuy?: AutoBuyRequest) {
  const r = await p.ws.request({ t: 'sit', seatIndex, buyIn, ...(autoBuy ? { autoBuy } : {}) });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  await p.ws.waitState((s) => s.you.seatIndex === seatIndex);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallet = async (p: Player) => (await p.client.get('/api/auth/me')).body.balance as number;
const ledger = async (p: Player) => (await p.client.get('/api/me/ledger?limit=100')).body as LedgerRow[];
const rows = async (p: Player, type: string) => (await ledger(p)).filter((l) => l.type === type);
const mySeat = (p: Player) => p.ws.state!.you.seatIndex!;
const myStack = (p: Player) => p.ws.state!.seats[mySeat(p)]!.stack;
const leftSeat = (p: Player) => p.ws.wait((m) => m.t === 'notice' && m.code === 'left_seat', 15_000, 'left_seat notice') as Promise<Notice>;
const settled = (p: Player, handId: string) =>
  p.ws.wait((m) => m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage === 'settled', 30_000, 'the hand settled').then((m) => (m as StateMsg).state);
/**
 * The hand over and `gone` no longer seated, as `p` saw it. A player who stands up when the hand ends is paid after
 * its result goes out, so the first settled view still shows their stack on the seat, after their wallet has it too.
 */
const settledWithout = (p: Player, handId: string, gone: Player) =>
  p.ws
    .wait(
      (m) => m.t === 'state' && m.state.hand?.id === handId && m.state.hand.stage === 'settled' && !m.state.seats.some((s) => s.userId === gone.me.id),
      30_000,
      'the hand settled and the leaver stood up',
    )
    .then((m) => (m as StateMsg).state);

/** The admin console, as the super admin the global setup signed in (sign-ins are rate limited per account). */
const adminClient = async () => sharedAdmin();
/** Re-confirms the admin's password, as the console asks before an emergency control, unless still confirmed. */
async function reauth(c: Client) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
interface LiveTable {
  seats: ({ userId: string; phase: string; leaveAfterHand: boolean; inHand: boolean; folded: boolean } | null)[];
  heldSeats: number[];
  /** Every chip the room holds: the seats' stacks and the pot. */
  chipsOnTable: number;
  issues: string[];
}
const liveTable = async (admin: Client, id: string) => (await admin.get(`/api/admin/tables/${id}`)).body.live as LiveTable;

/** Polls an async read until `ok` holds. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(300)) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(v).slice(0, 400)}`);
  }
}

/** Whoever is to act in hand `handId`, once their own socket shows it; null once any socket shows the hand over. */
async function turn(ps: Player[], handId: string, ms = 20_000): Promise<Player | null> {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    if (ps.some((p) => !p.ws.state?.hand || p.ws.state.hand.id !== handId || p.ws.state.hand.stage === 'settled')) return null;
    const p = ps.find((x) => isMyTurn(x.ws.state!));
    if (p) return p;
    if (Date.now() > end) throw new Error(`nobody to act in ${handId}: ${JSON.stringify(ps.map((x) => [x.ws.state?.you.seatIndex, x.ws.state?.hand?.seq, x.ws.state?.hand?.actorSeat]))}`);
  }
}

async function act(p: Player, type: string, amount?: number) {
  const { result } = await p.ws.act(type, amount);
  expect(result.t, JSON.stringify(result)).toBe('state');
}

/**
 * Checks or calls (or plays `choose`'s pick) for whoever is to act, until `stop` holds where someone is to act (that
 * player is returned, nothing played) or the hand ends (null).
 */
async function play(ps: Player[], handId: string, stop: (h: HandView, p: Player) => boolean = () => false, choose?: (p: Player) => [string, number?] | null) {
  for (let guard = 0; guard < 300; guard++) {
    const p = await turn(ps, handId);
    if (!p || stop(p.ws.state!.hand!, p)) return p;
    const [type, amount] = choose?.(p) ?? [p.ws.state!.you.legal.some((o) => o.type === 'check') ? 'check' : 'call'];
    await act(p, type!, amount);
  }
  throw new Error('the hand did not end');
}

/** Seats a new player per buy-in (the i-th at seat i) and waits for a hand every one of them is dealt into. */
async function table(tableId: string, buyIns: number[], autoBuy: (AutoBuyRequest | undefined)[] = []) {
  const ps = await Promise.all(buyIns.map(() => player(tableId)));
  // All at once, so the first hand (dealt a moment after the second player sits) is dealt to everybody.
  await Promise.all(ps.map((p, i) => sit(p, i, buyIns[i]!, autoBuy[i])));
  for (let tries = 0; ; tries++) {
    const s = await ps[0]!.ws.waitState((x) => !!x.hand && x.hand.stage !== 'settled', 20_000, 'a hand');
    const handId = s.hand!.id;
    for (const p of ps) await p.ws.waitState((x) => x.hand?.id === handId);
    if (ps.every((p) => p.ws.state!.seats[mySeat(p)]!.hasCards)) return { ps, handId };
    if (tries >= 2) throw new Error('not everybody was dealt in');
    await play(ps, handId);
  }
}

/** The finished hand as `p`'s hand history shows it (the room records it a moment after it settles). */
const replay = (p: Player, handId: string) =>
  eventually(
    () => p.client.get<HandDetailDto>(`/api/me/hands/${handId}`),
    (r) => r.status === 200,
    'the hand record',
  ).then((r) => r.body);

/** Every chip of these players, in their wallets and on their seats in `view`: none made, none lost. */
async function chips(ps: Player[], view: TableView) {
  let sum = 0;
  for (const p of ps) {
    sum += await wallet(p);
    const seat = view.seats.find((s) => s.userId === p.me.id);
    if (seat) sum += seat.stack;
  }
  return sum;
}

/** Each player's wallet equals the sum of their ledger, and nobody was paid out more than `cashOuts` times. */
async function ledgersAddUp(ps: Player[], cashOuts = 1) {
  for (const p of ps) {
    const all = await ledger(p);
    expect(all.reduce((s, l) => s + l.amount, 0)).toBe(await wallet(p));
    expect(all.filter((l) => l.type === 'cash_out').length).toBeLessThanOrEqual(cashOuts);
  }
}

describe('standing up right after a fold', () => {
  it.each([
    ['preflop', 'it-fold-0'],
    ['flop', 'it-fold-1'],
    ['turn', 'it-fold-2'],
    ['river', 'it-fold-3'],
  ] as const)('folded on the %s, a player stands up at once: paid what they kept, once, while the others play the hand on', async (stage, tableId) => {
    const { ps, handId } = await table(tableId, [500, 400, 300]);
    const total = ps.reduce((s, p) => s + p.me.balance, 0);
    const f = (await play(ps, handId, (h) => h.stage === stage))!;
    expect(f, `nobody reached the ${stage}`).not.toBeNull();
    const seat = mySeat(f);
    await act(f, 'fold');
    const stack = myStack(f);
    const before = await wallet(f);
    expect(await f.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    const after = await f.ws.waitState((s) => s.you.seatIndex === null, 15_000, 'stood up');
    // The hand is still being played, by the other two.
    expect(after.hand).toMatchObject({ id: handId, stage });
    expect(after.seats[seat]).toMatchObject({ state: 'empty', held: true, stack: 0, hasCards: false });
    expect(after.seats[seat]!.userId).toBeUndefined();
    expect(await wallet(f)).toBe(before + stack);
    expect(await rows(f, 'cash_out')).toEqual([expect.objectContaining({ amount: stack })]);
    expect(await leftSeat(f)).toMatchObject({ amount: stack });
    const others = ps.filter((p) => p !== f);
    for (const p of others) expect((await p.ws.waitState((s) => s.seats[seat]!.state === 'empty')).seats[seat]!.held).toBe(true);

    expect(await play(others, handId)).toBeNull();
    const end = await settled(others[0]!, handId);
    expect(end.seats[seat]!.held).toBeUndefined();
    expect(await chips(ps, end)).toBe(total);
    await ledgersAddUp(ps);
    // Nothing more for the leaver when the hand ends.
    expect(await wallet(f)).toBe(before + stack);

    // The hand's record keeps them: their fold, and what they lost is what they put in.
    const mine = await replay(f, handId);
    expect(mine.players).toHaveLength(3);
    const me = mine.players.find((x) => x.isYou)!;
    expect(me).toMatchObject({ seatIndex: seat, won: 0, net: stack - me.stackStart });
    expect(mine.actions).toContainEqual(expect.objectContaining({ seatIndex: seat, stage, type: 'fold' }));
    // Another player's replay never shows the leaver's folded cards.
    const theirs = await replay(others[0]!, handId);
    expect(theirs.players.find((x) => x.userId === f.me.id)).toMatchObject({ holeCards: null, net: me.net });
  });

  it('leaving on their turn folds and stands them up at once; the seat stays the hand’s until it ends, and they sit down again here only then', async () => {
    const { ps, handId } = await table('it-fold-4', [500, 400, 300]);
    const f = (await turn(ps, handId))!;
    const seat = mySeat(f);
    const stack = myStack(f);
    const before = await wallet(f);
    expect(await f.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    const after = await f.ws.waitState((s) => s.you.seatIndex === null, 15_000, 'stood up');
    expect(after.hand!.id).toBe(handId);
    expect(after.hand!.stage).not.toBe('settled');
    expect(after.you.canSit).toBe(false);
    expect(await wallet(f)).toBe(before + stack);

    // Nobody takes the seat the hand still holds, and its player waits for the hand to end to sit here again.
    const q = await player('it-fold-4');
    expect(await q.ws.request({ t: 'sit', seatIndex: seat, buyIn: 200 })).toMatchObject({ t: 'error', code: 'seat_taken' });
    expect(await f.ws.request({ t: 'sit', seatIndex: 5, buyIn: 200 })).toMatchObject({ t: 'error', code: 'hand_in_progress' });
    expect(await wallet(f)).toBe(before + stack);
    // Another empty seat is free, for the next hand.
    await sit(q, 4, 200);

    const others = ps.filter((p) => p !== f);
    expect(await play(others, handId)).toBeNull();
    await settled(f, handId);
    await f.ws.waitState((s) => s.you.canSit, 15_000, 'may sit again');
    await sit(f, seat, 200);
    expect(await wallet(f)).toBe(before + stack - 200);
    const mine = await replay(f, handId);
    expect(mine.players.find((x) => x.isYou)).toMatchObject({ seatIndex: seat });
    expect(mine.players.map((x) => x.userId).sort()).toEqual(ps.map((p) => p.me.id).sort());
    await ledgersAddUp([...ps, q]);
  });

  it('leaving before their turn: the room folds them when it comes and stands them up then, while the others play on', async () => {
    const { ps, handId } = await table('it-fold-5', [500, 400, 300]);
    const actor = (await turn(ps, handId))!;
    const l = ps.find((p) => p !== actor)!;
    const seat = mySeat(l);
    const stack = myStack(l);
    const before = await wallet(l);
    expect(await l.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    // Still seated, marked as leaving, nothing paid until their fold.
    expect((await l.ws.waitState((s) => s.you.leaving)).you.seatIndex).toBe(seat);
    expect(await rows(l, 'cash_out')).toEqual([]);
    // The admin console's live table shows the same: leaving, still in the hand, not folded yet.
    const admin = await adminClient();
    expect((await liveTable(admin, 'it-fold-5')).seats[seat]).toMatchObject({ userId: l.me.id, leaveAfterHand: true, inHand: true, folded: false });
    expect((await liveTable(admin, 'it-fold-5')).chipsOnTable).toBe(500 + 400 + 300);
    const others = ps.filter((p) => p !== l);
    const p = await play(others, handId, (_h, x) => x.ws.state!.seats[seat]!.state === 'empty');
    // Stood up while somebody still has to act in this hand.
    expect(p).not.toBeNull();
    await l.ws.waitState((s) => s.you.seatIndex === null, 15_000, 'stood up');
    expect(l.ws.state!.hand!.id).toBe(handId);
    expect(await wallet(l)).toBe(before + stack);
    expect(await leftSeat(l)).toMatchObject({ amount: stack });
    expect(l.ws.state!.seats[seat]!.held).toBe(true);
    // The console: the seat is empty, held by the hand, and the room holds what the leaver put in, not what they took.
    expect(await liveTable(admin, 'it-fold-5')).toMatchObject({ heldSeats: [seat], chipsOnTable: 500 + 400 + 300 - stack });
    expect((await liveTable(admin, 'it-fold-5')).seats[seat]).toBeNull();
    const n = await player('it-fold-5');
    expect(await play(others, handId)).toBeNull();
    const end = await settled(others[0]!, handId);
    expect((await liveTable(admin, 'it-fold-5')).chipsOnTable).toBe(500 + 400 + 300 - stack);
    expect(await chips(ps, end)).toBe(ps.reduce((s, x) => s + x.me.balance, 0));
    await ledgersAddUp(ps);
    // Free once the hand is over.
    await eventually(() => liveTable(admin, 'it-fold-5'), (x) => !x.heldSeats.includes(seat), 'the seat freed');
    // Whoever sits there while the result still shows was not in the hand: not shown folded, nor with the leaver's last
    // action, to them or to the others (the first-hands coaching counts a hand its player folded).
    await sit(n, seat, 200);
    for (const x of [n, ...others]) {
      const v = await x.ws.waitState((s) => s.seats[seat]!.userId === n.me.id, 15_000, 'the newcomer seated');
      expect(v.hand).toMatchObject({ id: handId, stage: 'settled' });
      expect(v.seats[seat]).toMatchObject({ state: 'waiting', hasCards: false, streetBet: 0, lastAction: null });
    }
  });

  it('heads-up: leaving folds the hand to the other player, and the leaver is paid what was left, once, and told so', async () => {
    const buyIns = [500, 400];
    const { ps, handId } = await table('it-fold-hu', buyIns);
    const f = (await turn(ps, handId))!;
    const w = ps.find((p) => p !== f)!;
    const seat = mySeat(f);
    const stack = myStack(f);
    const before = await wallet(f);
    expect(await f.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await f.ws.waitState((s) => s.you.seatIndex === null, 15_000, 'stood up');
    // Their fold ends the hand: the result goes out with them still seated, their stack untouched, and they stand up
    // right after it.
    expect((await settled(f, handId)).seats[seat]).toMatchObject({ userId: f.me.id, stack });
    const end = await settledWithout(f, handId, f);
    // The other player won only what the leaver had put in.
    expect(end.seats[mySeat(w)]!.stack).toBe(buyIns[ps.indexOf(w)]! + buyIns[ps.indexOf(f)]! - stack);
    expect(await wallet(f)).toBe(before + stack);
    expect(await leftSeat(f)).toMatchObject({ amount: stack });
    expect(await rows(f, 'cash_out')).toHaveLength(1);
    expect(await chips(ps, end)).toBe(ps.reduce((s, x) => s + x.me.balance, 0));
    await ledgersAddUp(ps);
  });

  it('a player all in is never folded by leaving: they stay in the hand, stand up once it settles, paid what it left them', async () => {
    const { ps, handId } = await table('it-fold-6', [100, 1000, 1000]);
    const short = ps[0]!;
    const seat = mySeat(short);
    const before = await wallet(short);
    // The short stack goes all in at its first turn; the others call it down.
    const s = (await play(ps, handId, (_h, p) => p === short))!;
    await act(s, 'allin');
    expect(short.ws.state!.seats[seat]!.state).toBe('allin');
    expect(await short.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    const marked = await short.ws.waitState((x) => x.you.leaving);
    expect(marked.you.seatIndex).toBe(seat);
    expect(marked.seats[seat]!.state).toBe('allin');
    expect(await rows(short, 'cash_out')).toEqual([]);
    expect(await play(ps.slice(1), handId)).toBeNull();
    await short.ws.waitState((x) => x.you.seatIndex === null, 15_000, 'stood up after the hand');
    const end = await settledWithout(ps[1]!, handId, short);
    const won = end.hand!.result!.winners.filter((w) => w.seatIndex === seat).reduce((a, w) => a + w.amount, 0);
    expect(await wallet(short)).toBe(before + won);
    expect((await leftSeat(short)).amount ?? 0).toBe(won);
    expect(await rows(short, 'cash_out')).toHaveLength(won > 0 ? 1 : 0);
    expect(await chips(ps, end)).toBe(ps.reduce((a, x) => a + x.me.balance, 0));
    await ledgersAddUp(ps);
  });

  it('side pots: a player who folds after putting chips into a pot that splits takes back only what they kept, and the pots add up', async () => {
    const { ps, handId } = await table('it-fold-7', [100, 1000, 1000, 1000]);
    const [short, b, l, c] = ps as [Player, Player, Player, Player];
    const shortIn = myStack(short) + short.ws.state!.seats[mySeat(short)]!.streetBet;
    // Preflop the short stack is all in and everybody calls; on the flop B bets, L folds to it, C calls.
    const choose = (p: Player): [string, number?] | null => {
      const h = p.ws.state!.hand!;
      const legal = p.ws.state!.you.legal;
      if (h.stage === 'preflop' && p === short) return ['allin'];
      if (h.stage === 'flop' && p === b && legal.some((o) => o.type === 'check')) return ['bet', (legal.find((o) => o.type === 'bet') as { min: number }).min];
      return null;
    };
    const atFold = (await play(ps, handId, (h, p) => h.stage === 'flop' && p === l && !p.ws.state!.you.legal.some((o) => o.type === 'check'), choose))!;
    expect(atFold).toBe(l);
    const bet = l.ws.state!.seats[mySeat(b)]!.streetBet;
    expect(bet).toBeGreaterThan(0);
    await act(l, 'fold');
    const stack = myStack(l);
    const lBefore = await wallet(l);
    expect(await l.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await l.ws.waitState((x) => x.you.seatIndex === null, 15_000, 'stood up');
    expect(l.ws.state!.hand!.id).toBe(handId);
    expect(await wallet(l)).toBe(lBefore + stack);
    expect(stack).toBe(1000 - shortIn);

    expect(await play([b, c], handId)).toBeNull();
    const end = await settled(b, handId);
    expect(await chips(ps, end)).toBe(ps.reduce((a, x) => a + x.me.balance, 0));
    await ledgersAddUp(ps);
    // The record: the main pot holds what each of the four put in up to the short stack's all in, L included, and
    // only those still in could win it; the side pot is B's bet and C's call.
    const rec = await replay(l, handId);
    const pots = rec.pots!.filter((p) => !p.uncalled);
    expect(pots).toHaveLength(2);
    const [main, side] = pots as [NonNullable<HandDetailDto['pots']>[number], NonNullable<HandDetailDto['pots']>[number]];
    expect(main.amount).toBe(4 * shortIn);
    expect(main.eligibleSeats).not.toContain(mySeatOf(rec, l));
    expect(side.amount).toBeGreaterThanOrEqual(2 * bet);
    expect(side.eligibleSeats.sort()).toEqual([mySeatOf(rec, b), mySeatOf(rec, c)].sort());
    expect(rec.players.find((x) => x.isYou)).toMatchObject({ net: -shortIn, won: 0 });
  });

  it('a top-up waiting for the hand, an automatic top-up and an automatic rebuy take nothing from players who fold and leave', async () => {
    const topup: AutoBuyRequest = { mode: 'topup', target: 300, cap: 1500, consent: true };
    const rebuy: AutoBuyRequest = { mode: 'rebuy', amount: 300, cap: 300, consent: true };
    const { ps, handId } = await table('it-fold-8', [300, 300, 500, 500], [topup, rebuy]);
    const [x, y] = ps as [Player, Player];
    expect(x.ws.state!.you.autoBuy).toMatchObject({ mode: 'topup', target: 300 });
    expect(y.ws.state!.you.autoBuy).toMatchObject({ mode: 'rebuy', amount: 300 });
    expect(await y.ws.request({ t: 'topUp', amount: 100 })).toMatchObject({ t: 'ack' });
    expect((await y.ws.waitState((s) => s.you.topUpQueued !== null)).you.topUpQueued).toBe(100);
    const before = { x: await wallet(x), y: await wallet(y) };
    const stacks = { x: myStack(x), y: myStack(y) };
    for (const p of [x, y]) expect(await p.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    const stayers = ps.slice(2);
    await play(stayers, handId, () => x.ws.state!.you.seatIndex === null && y.ws.state!.you.seatIndex === null);
    for (const p of [x, y]) await p.ws.waitState((s) => s.you.seatIndex === null, 20_000, 'stood up');
    expect(await play(stayers, handId)).toBeNull();
    const end = await settled(stayers[0]!, handId);
    // A moment for anything the room would do after the hand.
    await sleep(500);
    expect(await wallet(x)).toBe(before.x + stacks.x);
    expect(await wallet(y)).toBe(before.y + stacks.y);
    for (const p of [x, y]) expect(await rows(p, 'top_up')).toEqual([]);
    // Both policies ended with the seat.
    for (const p of [x, y]) expect(p.ws.state!.you.autoBuy).toBeNull();
    expect(await chips(ps, end)).toBe(ps.reduce((a, p) => a + p.me.balance, 0));
    await ledgersAddUp(ps);
  });

  it('a leave sent twice, then the connection drops: carried out once, and the player comes back standing', async () => {
    const { ps, handId } = await table('it-fold-9', [500, 400, 300]);
    const f = (await turn(ps, handId))!;
    await act(f, 'fold');
    const stack = myStack(f);
    const before = await wallet(f);
    const reqId = `leave-twice-${Date.now()}`;
    f.ws.send({ t: 'leave', reqId });
    f.ws.send({ t: 'leave', reqId });
    f.ws.send({ t: 'leave', reqId: `${reqId}-again` });
    f.ws.close();
    await eventually(() => wallet(f), (w) => w === before + stack, 'the cash-out');
    const back = await TableSocket.open(f.client, 'it-fold-9');
    open.push(back);
    expect(back.state!.you.seatIndex).toBeNull();
    const others = ps.filter((p) => p !== f);
    expect(await play(others, handId)).toBeNull();
    const end = await settled(others[0]!, handId);
    expect(await wallet(f)).toBe(before + stack);
    expect(await rows(f, 'cash_out')).toHaveLength(1);
    expect(await chips(ps, end)).toBe(ps.reduce((a, p) => a + p.me.balance, 0));
    await ledgersAddUp(ps);
  });

  /** Two players fold, then leave while D1 refuses writes: each is told it failed and keeps the seat, leaving. */
  async function failedLeaves(tableId: string) {
    const { ps, handId } = await table(tableId, [500, 400, 300, 300]);
    const f1 = (await turn(ps, handId))!;
    await act(f1, 'fold');
    const f2 = (await turn(ps, handId))!;
    await act(f2, 'fold');
    const stacks = [myStack(f1), myStack(f2)] as const;
    const before = [await wallet(f1), await wallet(f2)] as const;
    const release = holdD1WriteLock();
    try {
      for (const p of [f1, f2]) expect(await p.ws.request({ t: 'leave' })).toMatchObject({ t: 'error', code: 'internal' });
    } finally {
      release();
    }
    // Still on their seats, leaving, nothing paid; the hand goes on.
    for (const p of [f1, f2]) expect(p.ws.state!.you).toMatchObject({ seatIndex: expect.any(Number), leaving: true });
    for (const p of [f1, f2]) expect(await rows(p, 'cash_out')).toEqual([]);
    // The console shows both seats folded and cashing, flags the table, and still counts their stacks on it.
    const admin = await adminClient();
    const live = await liveTable(admin, tableId);
    for (const p of [f1, f2]) expect(live.seats[mySeat(p)]).toMatchObject({ userId: p.me.id, phase: 'cashing', leaveAfterHand: true, folded: true });
    expect(live.issues).toContain('cashing_seat');
    expect(live.chipsOnTable).toBe(500 + 400 + 300 + 300);
    return { tableId, admin, ps, handId, f: [f1, f2] as const, stacks, before, others: ps.filter((p) => p !== f1 && p !== f2) };
  }

  /** Both paid once, told so, and the hand the others went on playing adds up. */
  async function paidOnce(t: Awaited<ReturnType<typeof failedLeaves>>) {
    for (const [i, p] of t.f.entries()) {
      expect(await wallet(p)).toBe(t.before[i]! + t.stacks[i]!);
      expect(await leftSeat(p)).toMatchObject({ amount: t.stacks[i] });
    }
    expect(t.others.every((p) => p.ws.state!.hand!.id === t.handId && p.ws.state!.hand!.stage !== 'settled')).toBe(true);
    // The flag is gone, and the room no longer counts what it paid.
    const live = await liveTable(t.admin, t.tableId);
    expect(live.issues).not.toContain('cashing_seat');
    expect(live.chipsOnTable).toBe(500 + 400 + 300 + 300 - t.stacks[0] - t.stacks[1]);
    expect(await play(t.others, t.handId)).toBeNull();
    const end = await settled(t.others[0]!, t.handId);
    for (const [i, p] of t.f.entries()) expect(await rows(p, 'cash_out')).toEqual([expect.objectContaining({ amount: t.stacks[i] })]);
    expect(await chips(t.ps, end)).toBe(t.ps.reduce((a, p) => a + p.me.balance, 0));
    await ledgersAddUp(t.ps);
  }

  it('cash-outs D1 refused mid-hand: the room’s retry pays both seats waiting, once, while the hand goes on', async () => {
    const t = await failedLeaves('it-fold-10');
    for (const p of t.f) await p.ws.waitState((s) => s.you.seatIndex === null, 45_000, 'the retry');
    await paidOnce(t);
  }, 120_000);

  it('a cash-out D1 refused mid-hand is paid at once when the player leaves again (with the other seat waiting on it)', async () => {
    const t = await failedLeaves('it-fold-13');
    expect(await t.f[0].ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(t.f[0].ws.state!.you.seatIndex).toBeNull();
    await t.f[1].ws.waitState((s) => s.you.seatIndex === null, 5_000, 'paid with the first');
    await paidOnce(t);
  }, 120_000);

  it('a cash-out D1 refused mid-hand is paid once when an admin removes the player (with the other seat waiting on it)', async () => {
    const t = await failedLeaves('it-fold-14');
    const [f0, f1] = t.f;
    await reauth(t.admin);
    const r = await t.admin.post(`/api/admin/users/${f0.me.id}/disconnect`, { reason: 'cash-out retry', removeFromTable: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kick.seats).toEqual([{ tableId: 'it-fold-14', seat: 'left' }]);
    await f1.ws.waitState((s) => s.you.seatIndex === null, 5_000, 'paid with the first');
    expect(await leftSeat(f1)).toMatchObject({ amount: t.stacks[1] });
    const live = await liveTable(t.admin, 'it-fold-14');
    expect(live.issues).not.toContain('cashing_seat');
    expect(live.chipsOnTable).toBe(500 + 400 + 300 + 300 - t.stacks[0] - t.stacks[1]);

    // Read from D1: the removed member's sessions are gone. Each paid once, and nothing more when the hand ends.
    const cashOuts = async (p: Player) => (await d1<{ amount: number }>(`SELECT amount FROM chip_ledger WHERE user_id = '${p.me.id}' AND type = 'cash_out'`)).map((x) => x.amount);
    const balance = async (p: Player) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${p.me.id}'`))[0]!.balance;
    expect(await balance(f0)).toBe(t.before[0] + t.stacks[0]);
    expect(await play(t.others, t.handId)).toBeNull();
    const end = await settled(t.others[0]!, t.handId);
    for (const [i, p] of t.f.entries()) expect(await cashOuts(p)).toEqual([t.stacks[i]]);
    let sum = 0;
    for (const p of t.ps) sum += (await balance(p)) + (end.seats.find((s) => s.userId === p.me.id)?.stack ?? 0);
    expect(sum).toBe(t.ps.reduce((a, p) => a + p.me.balance, 0));
  }, 120_000);

  it('the same member at another table keeps their seat and stack there when they fold and leave here', async () => {
    const { ps, handId } = await table('it-fold-11', [500, 400, 300]);
    const f = (await turn(ps, handId))!;
    const elsewhere = await TableSocket.open(f.client, 'it-fold-12');
    open.push(elsewhere);
    expect(await elsewhere.request({ t: 'sit', seatIndex: 0, buyIn: 250 })).toMatchObject({ t: 'ack' });
    await elsewhere.waitState((s) => s.you.seatIndex === 0);
    const stack = myStack(f);
    const before = await wallet(f);
    expect(await f.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await f.ws.waitState((s) => s.you.seatIndex === null, 15_000, 'stood up');
    expect(await wallet(f)).toBe(before + stack);
    await sleep(300);
    expect(elsewhere.state!.you.seatIndex).toBe(0);
    expect(elsewhere.state!.seats[0]!.stack).toBe(250);
    expect(await elsewhere.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(await wallet(f)).toBe(before + stack + 250);
    expect(await play(ps.filter((p) => p !== f), handId)).toBeNull();
    await ledgersAddUp(ps.filter((p) => p !== f));
    await ledgersAddUp([f], 2);
    expect(await rows(f, 'cash_out')).toHaveLength(2);
  });
});

function mySeatOf(rec: HandDetailDto, p: Player) {
  return rec.players.find((x) => x.userId === p.me.id)!.seatIndex;
}
