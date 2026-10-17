// Table bots (game-worker bots.ts and room.ts "table bots"): they sit beside members on official tables that allow them,
// play through the same engine, give up seats to members and stand up when switched off, and every chip they hold goes
// through the ledger. Once nobody is seated, members' wallets + bots' wallets − what the bot fund issued never changes,
// each table's buy-ins and cash-outs cancel out, and each bot seat has one buy-in, at most one fund row and one cash-out.
import type { HandDetailDto, LobbyTableDto, TableView } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, signupBody, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
const ON = { enabled: true, fundLimit: 1_000_000, maxBots: 20 };

interface Policy { version: number; enabled: boolean; fundLimit: number; maxBots: number }

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await pause(300);
  }
}

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

let plain: Promise<Client> | null = null;
/** An administrator who is not the super admin (the permission table gives them the bots page and the emergency stop). */
function plainAdmin() {
  plain ??= (async () => {
    const u = await newUser();
    await d1(promoteSql(`id = '${u.me.id}'`));
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return c;
  })();
  return plain;
}

const policy = async () => (await admin.get('/api/admin/bots')).body.policy as Policy;
async function setPolicy(change: Partial<Omit<Policy, 'version'>>, reason = 'bots test') {
  await reauth();
  const p = await policy();
  const r = await admin.req('PUT', '/api/admin/bots/policy', { baseVersion: p.version, enabled: p.enabled, fundLimit: p.fundLimit, maxBots: p.maxBots, ...change, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.policy as Policy;
}

const sockets: TableSocket[] = [];
async function watch(c: Client, tableId: string, base?: string) {
  const ws = await TableSocket.open(c, tableId, { base });
  sockets.push(ws);
  return ws;
}
async function sit(ws: TableSocket, seatIndex: number, buyIn: number) {
  const r = await ws.request({ t: 'sit', seatIndex, buyIn });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  return ws.waitState((s) => s.you.seatIndex === seatIndex);
}
async function leave(ws: TableSocket) {
  expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
}

beforeAll(async () => {
  const p = await policy();
  if (!p.enabled || p.fundLimit !== ON.fundLimit || p.maxBots !== ON.maxBots) await setPolicy(ON, 'bots test start');
});
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  // Bots off again (as migration 0021 seeds them) for the files that follow.
  await reauth();
  if ((await policy()).enabled) expect((await admin.post('/api/admin/bots/stop', { reason: 'bots test done' })).status).toBe(200);
});

const botSeats = (s: TableView) => s.seats.filter((x) => x.bot);
const states = (ws: TableSocket) => ws.messages.flatMap((m) => (m.t === 'state' ? [m.state] : []));
const live = (s: TableView) => !!s.hand && s.hand.stage !== 'settled';
const empty = (s: TableView) => s.seats.every((x) => !x.userId);

type Choice = { type: string; amount?: number };
const option = (s: TableView, type: string) => s.you.legal.find((o) => o.type === type);
/** Checks when it costs nothing, calls up to `cap` chips, otherwise folds: a member who never risks much. */
const careful =
  (cap: number) =>
  (s: TableView): Choice => {
    if (option(s, 'check')) return { type: 'check' };
    const call = option(s, 'call');
    return call && call.type === 'call' && call.amount <= cap ? { type: 'call' } : { type: 'fold' };
  };
/** All in whenever that is allowed. */
const shove = (s: TableView): Choice => (option(s, 'allin') ? { type: 'allin' } : option(s, 'call') ? { type: 'call' } : { type: 'check' });

/** Acts for each of `players` on its turn until stopped (the bots act on their own). */
function autoplay(players: TableSocket[], choose: (s: TableView) => Choice) {
  let on = true;
  const busy = new Set<TableSocket>();
  const loop = (async () => {
    while (on) {
      for (const ws of players) {
        const s = ws.state;
        if (busy.has(ws) || ws.closed || !s || !isMyTurn(s)) continue;
        busy.add(ws);
        const c = choose(s);
        void ws
          .act(c.type, c.amount)
          .catch(() => undefined)
          .finally(() => busy.delete(ws));
      }
      await pause(100);
    }
  })();
  return async () => {
    on = false;
    await loop;
    await until(async () => busy.size, (n) => n === 0, 'autoplay to stop', 20_000);
  };
}

const ids = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');
/** Members' wallets + all bots' wallets − what the fund issued: unchanged across a test once nobody is seated. */
async function books(members: string[], state?: string) {
  const [r] = await d1<{ m: number; b: number; i: number }>(
    `SELECT (SELECT COALESCE(SUM(balance), 0) FROM users WHERE id IN (${ids(members)})) AS m,
            (SELECT COALESCE(SUM(balance), 0) FROM users WHERE is_bot = 1) AS b,
            (SELECT issued FROM bot_fund WHERE id = 1) AS i`,
    state,
  );
  return r!.m + r!.b - r!.i;
}
const seatedBots = async () =>
  Number((await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM table_sessions s JOIN users u ON u.id = s.user_id WHERE u.is_bot = 1 AND s.status = 'seated'`))[0]!.n);
const tableNet = async (tableId: string) =>
  Number((await d1<{ n: number }>(`SELECT COALESCE(SUM(amount), 0) AS n FROM chip_ledger WHERE table_id = '${tableId}' AND type IN ('buy_in', 'top_up', 'cash_out')`))[0]!.n);
const events = (tableId: string, kind?: string) =>
  d1<{ kind: string; code: string | null; bot_id: string | null }>(
    `SELECT kind, code, bot_id FROM bot_events WHERE table_id = '${tableId}'${kind ? ` AND kind = '${kind}'` : ''} ORDER BY created_at, rowid`,
  );

/** The bots' ledger rows at a table by seat (table session): each key `botfund:` / `buyin:` / `cashout:` names its session. */
async function botSessions(tableId: string, state?: string) {
  const rows = await d1<{ user_id: string; type: string; amount: number; idempotency_key: string }>(
    `SELECT l.user_id, l.type, l.amount, l.idempotency_key FROM chip_ledger l JOIN users u ON u.id = l.user_id WHERE u.is_bot = 1 AND l.table_id = '${tableId}'`,
    state,
  );
  const by = new Map<string, { bot: string; rows: Record<string, number>; amounts: Record<string, number> }>();
  for (const r of rows) {
    const sid = r.idempotency_key.slice(r.idempotency_key.indexOf(':') + 1);
    const s = by.get(sid) ?? { bot: r.user_id, rows: {}, amounts: {} };
    s.rows[r.type] = (s.rows[r.type] ?? 0) + 1;
    s.amounts[r.type] = (s.amounts[r.type] ?? 0) + Number(r.amount);
    by.set(sid, s);
  }
  return by;
}

/** Once everybody has left `tableId`: no bot seated anywhere, the table's chips all came back, and the books balance. */
async function balanced(tableId: string, members: string[], before: number) {
  expect(await seatedBots()).toBe(0);
  expect(await tableNet(tableId)).toBe(0);
  expect(await books(members)).toBe(before);
  const sessions = await botSessions(tableId);
  expect(sessions.size).toBeGreaterThan(0);
  for (const [sid, s] of sessions) {
    expect(s.rows.buy_in, sid).toBe(1);
    expect(s.rows.cash_out ?? 0, sid).toBeLessThanOrEqual(1);
    expect(s.rows.bot_fund ?? 0, sid).toBeLessThanOrEqual(1);
    expect(Object.keys(s.rows).every((k) => ['buy_in', 'cash_out', 'bot_fund'].includes(k)), JSON.stringify(s.rows)).toBe(true);
  }
  const integrity = (await admin.get('/api/admin/bots/integrity')).body;
  expect(integrity.ok, JSON.stringify(integrity)).toBe(true);
  return sessions;
}

describe('table bots', () => {
  it('a member alone gets a bot heads-up that keeps its cards hidden, shows in the lobby, and leaves with the member', async () => {
    const T = 'it-bot-hu-0';
    const m = await newUser();
    const before = await books([m.me.id]);
    const ws = await watch(m.client, T);
    await sit(ws, 0, 500);
    const joined = await ws.waitState((s) => botSeats(s).length === 1, 15_000, 'a bot to sit down');
    const bot = botSeats(joined)[0]!;
    expect(bot).toMatchObject({ seatIndex: 1, bot: 'normal' });
    expect(bot.nickname).toMatch(/^Bot-[A-Z2-9]{4}$/);
    const botId = bot.userId!;

    // In a hand the member sees that the bot holds cards, never which.
    const hand = await ws.waitState((s) => live(s) && s.seats[1]!.hasCards, 20_000, 'a hand with the bot');
    expect(hand.seats[1]!.holeCards ?? null).toBeNull();
    expect(hand.seats[0]!.holeCards).toHaveLength(2);
    // Sitting with it is not a way to report, befriend or block it.
    const report = await m.client.post('/api/reports', { targetType: 'player', targetId: botId, tableId: T, reason: 'cheating' });
    expect([report.status, report.body.error?.code]).toEqual([409, 'bot_account']);
    const friend = await m.client.post('/api/friends/requests', { userId: botId });
    expect([friend.status, friend.body.error?.code]).toEqual([409, 'bot_account']);

    const stop = autoplay([ws], careful(30));
    const first = hand.hand!.number;
    await ws.waitState((s) => (s.hand?.number ?? 0) >= first + 3, 120_000, 'three hands');
    // The lobby counts it apart from members.
    const row = await until(
      async () => ((await m.client.get('/api/tables')).body as LobbyTableDto[]).find((t) => t.id === T),
      (t) => t?.bots === 1 && t.seated === 2,
      'the lobby to count the bot',
    );
    expect(row).toMatchObject({ botLevel: 'normal', bots: 1, seated: 2 });
    // Every state the member saw kept the bot's cards to itself.
    for (const s of states(ws)) if (s.hand?.stage !== 'settled' && s.hand?.stage !== 'showdown') expect(s.seats[1]?.holeCards ?? null).toBeNull();

    await leave(ws);
    await ws.waitState(empty, 90_000, 'the table to empty');
    await stop();
    expect(await events(T, 'leave')).toEqual([{ kind: 'leave', code: 'no_members', bot_id: botId }]);
    expect((await events(T, 'join')).map((e) => e.bot_id)).toEqual([botId]);
    const hands = await d1<{ bots: number }>(`SELECT bots FROM hands WHERE table_id = '${T}'`);
    expect(hands.length).toBeGreaterThanOrEqual(3);
    expect(hands.every((h) => Number(h.bots) === 1)).toBe(true);

    // The member's replay marks the bot's seat.
    const list = (await m.client.get('/api/me/hands')).body as { id: string; tableId: string }[];
    const detail = (await m.client.get(`/api/me/hands/${list.find((h) => h.tableId === T)!.id}`)).body as HandDetailDto;
    expect(detail.players.find((p) => p.seatIndex === 1)).toMatchObject({ bot: true, userId: botId });
    expect(detail.players.find((p) => p.isYou)!.bot).toBeUndefined();
    expect(detail.players.reduce((a, p) => a + p.net, 0)).toBe(0);

    const sessions = await balanced(T, [m.me.id], before);
    expect(sessions.size).toBe(1);
    const [s] = [...sessions.values()];
    expect(s!.rows).toMatchObject({ buy_in: 1, cash_out: 1 });
    expect(s!.amounts.buy_in).toBe(-1000);
  }, 240_000);

  it('several bots fill up to the table limits, and lowering the limit sends the extra ones away after the hand', async () => {
    const T = 'it-bot-six';
    const m = await newUser();
    const before = await books([m.me.id]);
    const ws = await watch(m.client, T);
    await sit(ws, 0, 500);
    await ws.waitState((s) => botSeats(s).length === 3, 20_000, 'three bots');
    // Wait for a hand all three bots were dealt into, at the member's turn (it cannot end before the member acts).
    for (;;) {
      const s = await ws.waitState((x) => isMyTurn(x), 90_000, 'the member to act');
      if (s.seats.filter((x) => x.bot && x.hasCards).length === 3) break;
      const c = careful(20)(s);
      await ws.act(c.type, c.amount);
    }
    await reauth();
    const patched = await admin.patch(`/api/admin/tables/${T}`, { botMax: 1 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    // The two latest to sit are marked; they play the hand out.
    const marked = await ws.waitState((s) => s.seats.filter((x) => x.botLeaving).length === 2, 10_000, 'two bots marked to leave');
    expect(live(marked)).toBe(true);
    expect(botSeats(marked)).toHaveLength(3);

    const stop = autoplay([ws], careful(20));
    const after = await ws.waitState((s) => botSeats(s).length === 1 && !s.seats.some((x) => x.botLeaving), 120_000, 'one bot left');
    // And no other bot takes their place over the next hand.
    await ws.waitState((s) => (s.hand?.number ?? 0) > (after.hand?.number ?? 0) && live(s), 30_000, 'the next hand');
    expect(botSeats(ws.state!)).toHaveLength(1);
    const view = (await admin.get('/api/admin/bots')).body as { tables: { id: string; max: number; seatedBots: unknown[] }[] };
    expect(view.tables.find((t) => t.id === T)).toMatchObject({ max: 1, seatedBots: [expect.objectContaining({ tableId: T })] });

    await leave(ws);
    await ws.waitState(empty, 90_000, 'the table to empty');
    await stop();
    expect(Math.max(...states(ws).map((s) => botSeats(s).length))).toBe(3);
    const left = await events(T, 'leave');
    expect(left.map((e) => e.code).sort()).toEqual(['limit', 'limit', 'no_members']);
    expect((await events(T, 'join')).length).toBe(3);
    await balanced(T, [m.me.id], before);
  }, 300_000);

  it('all-ins of different sizes against a bot make side pots it is part of, and nothing is lost', async () => {
    const T = 'it-bot-pot';
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const before = await books([a.me.id, b.me.id]);
    const players = [
      { ws: await watch(a.client, T), buyIn: 30 },
      { ws: await watch(b.client, T), buyIn: 60 },
    ];
    await sit(players[0]!.ws, 0, 30);
    await sit(players[1]!.ws, 1, 60);
    const seated = await players[0]!.ws.waitState((s) => botSeats(s).length === 1, 15_000, 'a bot to sit down');
    const botSeat = botSeats(seated)[0]!.seatIndex;

    // Both members shove every hand; one who busts sits down again, and one whose stack grew past what the bot calls
    // stands up and sits down again with the starting stack.
    let on = true;
    const busy = new Set<TableSocket>();
    const loop = (async () => {
      while (on) {
        for (const p of players) {
          const s = p.ws.state;
          if (!s || busy.has(p.ws)) continue;
          const mine = s.you.seatIndex === null ? null : s.seats[s.you.seatIndex]!;
          let job: Promise<unknown> | null = null;
          if (s.you.seatIndex === null) {
            const free = s.seats.find((x) => !x.userId);
            if (free) job = p.ws.request({ t: 'sit', seatIndex: free.seatIndex, buyIn: p.buyIn });
          } else if (isMyTurn(s)) {
            const c = shove(s);
            job = p.ws.act(c.type, c.amount);
          } else if (!live(s) && !s.you.leaving && mine && mine.stack > 120) {
            job = p.ws.request({ t: 'leave' });
          }
          if (job) {
            busy.add(p.ws);
            void job.catch(() => undefined).finally(() => busy.delete(p.ws));
          }
        }
        await pause(100);
      }
    })();

    // A hand whose pots split with the bot in each, as the replay records it and as the table paid it out. (All in before
    // the flop, the board runs out at once: the table shows the payout, not pots in between.)
    const ws = players[0]!.ws;
    const replay = async (id: string) => {
      for (const m of [a, b]) {
        const r = await m.client.get(`/api/me/hands/${id}`);
        if (r.status === 200) return r.body as HandDetailDto;
      }
      return null;
    };
    let found = null as { detail: HandDetailDto; paid: TableView } | null;
    const checked = new Set<string>();
    const startHand = seated.hand?.number ?? 0;
    while (!found) {
      const s = await ws.waitState((x) => !!x.hand, 60_000, 'a hand');
      if (s.hand!.number > startHand + 40) throw new Error('no side pot with the bot in 40 hands');
      for (const x of states(ws)) {
        if (found || x.hand?.stage !== 'settled' || checked.has(x.hand.id)) continue;
        checked.add(x.hand.id);
        const d = await replay(x.hand.id);
        const pots = (d?.pots ?? []).filter((p) => !p.uncalled);
        if (d && pots.length >= 2 && pots.every((p) => p.eligibleSeats.includes(botSeat))) found = { detail: d, paid: x };
      }
      if (!found) await pause(500);
    }
    on = false;
    await loop;
    await until(async () => busy.size, (n) => n === 0, 'the members to stop', 20_000);
    const { detail, paid } = found;
    expect(detail.players.find((p) => p.seatIndex === botSeat)).toMatchObject({ bot: true });
    expect(detail.players.reduce((x, p) => x + p.net, 0)).toBe(0);
    expect((detail.pots ?? []).reduce((x, p) => x + p.amount, 0)).toBe(detail.potTotal);
    // What each seat won pot by pot adds up to what the table paid it.
    const won = (xs: { seatIndex: number; amount: number }[]) => xs.reduce<Record<number, number>>((o, w) => ({ ...o, [w.seatIndex]: (o[w.seatIndex] ?? 0) + w.amount }), {});
    expect(won((detail.pots ?? []).flatMap((p) => p.winners))).toEqual(won(paid.hand!.result!.winners));

    const stop = autoplay(players.map((p) => p.ws), shove);
    for (const p of players) if (p.ws.state!.you.seatIndex !== null && !p.ws.state!.you.leaving) await leave(p.ws);
    await ws.waitState(empty, 90_000, 'the table to empty');
    await stop();
    await balanced(T, [a.me.id, b.me.id], before);
  }, 420_000);

  it('a bot gives its seat to a member on the waitlist after the hand, and no bot takes another', async () => {
    const T = 'it-bot-yield';
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const before = await books([a.me.id, b.me.id]);
    const wa = await watch(a.client, T);
    await sit(wa, 0, 300);
    await wa.waitState((s) => isMyTurn(s) && s.seats[1]!.bot === 'normal' && s.seats[1]!.hasCards, 30_000, 'the member to act beside the bot');
    const wb = await watch(b.client, T);
    expect(await wb.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'ack' });
    const marked = await wa.waitState((s) => !!s.seats[1]!.botLeaving, 10_000, 'the bot marked to leave');
    expect(live(marked)).toBe(true);

    const stop = autoplay([wa, wb], careful(20));
    const offered = await wb.waitState((s) => s.reservation?.nickname === b.me.nickname, 120_000, 'the seat offered to the member');
    expect(botSeats(offered)).toHaveLength(0);
    await sit(wb, 1, 300);
    expect((await events(T, 'leave')).map((e) => e.code)).toEqual(['yield']);
    // Two members fill the table the bots were set to fill: none sits down again.
    await wa.waitState((s) => live(s) && s.seats[1]!.userId === b.me.id, 30_000, 'the members to play');
    expect(states(wa).filter((s) => botSeats(s).length > 0 && s.reservation).length).toBe(0);
    expect((await events(T, 'join')).length).toBe(1);

    await leave(wa);
    await leave(wb);
    await wa.waitState(empty, 90_000, 'the table to empty');
    await stop();
    await balanced(T, [a.me.id, b.me.id], before);
  }, 300_000);

  it('any administrator can stop the bots at once: they finish the hand and stand up, and only the super admin turns them on', async () => {
    const T = 'it-bot-stop';
    const m = await newUser();
    const before = await books([m.me.id]);
    const ws = await watch(m.client, T);
    await sit(ws, 0, 300);
    await ws.waitState((s) => isMyTurn(s) && s.seats[1]!.bot === 'hard' && s.seats[1]!.hasCards, 30_000, 'the member to act beside the bot');

    const op = await plainAdmin();
    await reauth(op);
    expect((await op.post('/api/admin/bots/stop', { reason: 'x' })).status).toBe(400); // a reason is required
    const stopped = await op.post('/api/admin/bots/stop', { reason: 'bots test emergency' });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body).toMatchObject({ policy: { enabled: false }, rooms: { reached: stopped.body.rooms.tables } });
    const marked = await ws.waitState((s) => !!s.seats[1]!.botLeaving, 10_000, 'the bot marked to leave');
    expect(live(marked)).toBe(true);

    const stop = autoplay([ws], careful(20));
    await ws.waitState((s) => botSeats(s).length === 0, 120_000, 'the bot to stand up');
    expect((await events(T, 'leave')).map((e) => e.code)).toEqual(['bots_off']);
    // Nothing sits down while they are off, though the member waits alone.
    await pause(3000);
    expect(botSeats(ws.state!)).toHaveLength(0);

    const again = await op.post('/api/admin/bots/stop', { reason: 'bots test emergency' });
    expect([again.status, again.body.error?.code]).toEqual([409, 'bot_already_off']);
    const p = await policy();
    const denied = await op.req('PUT', '/api/admin/bots/policy', { baseVersion: p.version, ...ON, reason: 'not mine to do' });
    expect(denied.status).toBe(403);
    expect((await policy()).enabled).toBe(false);
    expect((await d1<{ reason: string }>(`SELECT reason FROM bot_policies WHERE version = ${p.version}`))[0]!.reason).toBe('bots test emergency');

    await leave(ws);
    await ws.waitState(empty, 60_000, 'the table to empty');
    await stop();
    await setPolicy({ enabled: true }, 'bots test resumes');
    await balanced(T, [m.me.id], before);
  }, 300_000);

  it('when the fund cannot cover a buy-in no bot sits and the table backs off; raising the limit seats one at once, funded once', async () => {
    const T = 'it-bot-fund';
    // The fund has to issue for this table's 10 000 buy-in: no idle bot holds that much.
    const richest = await d1<{ b: number | null }>(`SELECT MAX(balance) AS b FROM users WHERE is_bot = 1`);
    expect(Number(richest[0]!.b ?? 0)).toBeLessThan(10_000);
    const issued = Number((await d1<{ i: number }>(`SELECT issued AS i FROM bot_fund WHERE id = 1`))[0]!.i);
    await setPolicy({ fundLimit: issued }, 'bots test: fund used up');

    const m = await newUser();
    const before = await books([m.me.id]);
    const ws = await watch(m.client, T);
    await sit(ws, 0, 10_000);
    const status = await until(
      async () => (await admin.get(`/api/admin/tables/${T}`)).body.live?.bots as { failures: number; retryAt: number | null } | undefined,
      (b) => (b?.failures ?? 0) >= 1,
      'the failed seating',
    );
    expect(status!.retryAt).toBeGreaterThan(Date.now() + 30_000);
    expect((await events(T)).map((e) => [e.kind, e.code])).toEqual([['fund_exhausted', 'fund_exhausted']]);
    expect(botSeats(ws.state!)).toHaveLength(0);
    expect(Number((await d1<{ i: number }>(`SELECT issued AS i FROM bot_fund WHERE id = 1`))[0]!.i)).toBe(issued);

    // A new limit reaches the table, which forgets its back-off.
    await setPolicy({ fundLimit: ON.fundLimit }, 'bots test: fund raised');
    const joined = await ws.waitState((s) => botSeats(s).length === 1, 15_000, 'a bot to sit down');
    const botId = botSeats(joined)[0]!.userId!;
    const sessions = await botSessions(T);
    expect(sessions.size).toBe(1);
    const [s] = [...sessions.values()];
    expect(s!.bot).toBe(botId);
    expect(s!.rows).toEqual({ bot_fund: 1, buy_in: 1 });
    expect(s!.amounts.buy_in).toBe(-10_000);
    expect(Number((await d1<{ i: number }>(`SELECT issued AS i FROM bot_fund WHERE id = 1`))[0]!.i)).toBe(issued + s!.amounts.bot_fund!);
    expect((await admin.get(`/api/admin/tables/${T}`)).body.live.bots).toMatchObject({ failures: 0, retryAt: null });

    const stop = autoplay([ws], careful(0));
    await leave(ws);
    await ws.waitState(empty, 90_000, 'the table to empty');
    await stop();
    await balanced(T, [m.me.id], before);
  }, 240_000);

  it('a bot account cannot sign in, and members and administrators cannot befriend, block, message or sanction it', async () => {
    const [bot] = await d1<{ id: string; email: string; nickname: string; balance: number }>(`SELECT id, email, nickname, balance FROM users WHERE is_bot = 1 LIMIT 1`);
    expect(bot).toBeDefined();
    for (const password of ['bot:no-sign-in', PASSWORD]) {
      const r = await new Client().post('/api/auth/login', { email: bot!.email, password });
      expect([r.status, r.body.error?.code]).toEqual([401, 'invalid_credentials']);
    }
    const r = await new Client(ADMIN_ORIGIN).post('/api/admin/auth/login', { email: bot!.email, password: 'bot:no-sign-in' });
    expect(r.status).toBe(401);

    const m = await newUser();
    for (const [method, path, body] of [
      ['POST', '/api/friends/requests', { userId: bot!.id }],
      ['POST', '/api/friends/requests', { nickname: bot!.nickname }],
      ['PUT', `/api/blocks/${bot!.id}`, {}],
      ['GET', `/api/dm/${bot!.id}`, undefined],
    ] as const) {
      const res = await m.client.req(method, path, body);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 409, 'bot_account']);
    }
    // Only friends are messaged, and a bot is never one.
    expect((await m.client.post(`/api/dm/${bot!.id}`, { text: 'hi' })).status).toBe(403);

    await reauth();
    for (const [path, body] of [
      ['suspend', { reason: 'bots test' }],
      ['unsuspend', { reason: 'bots test' }],
      ['role', { role: 'admin', reason: 'bots test' }],
      ['chips', { amount: 100, memo: 'bots test', idempotencyKey: `bt-${crypto.randomUUID()}` }],
      ['disconnect', { reason: 'bots test' }],
      ['reset-link', {}],
    ] as const) {
      const res = await admin.post(`/api/admin/users/${bot!.id}/${path}`, body);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 409, 'bot_account']);
    }
    const [after] = await d1<{ status: string; role: string; balance: number }>(`SELECT status, role, balance FROM users WHERE id = '${bot!.id}'`);
    expect(after).toEqual({ status: 'active', role: 'user', balance: bot!.balance });

    // Table settings: only official tables have bots, and the counts must fit the table.
    const room = await m.client.post('/api/rooms', { name: '봇 없는 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, isPrivate: false });
    expect(room.status, JSON.stringify(room.body)).toBe(201);
    const memberRoom = await admin.patch(`/api/admin/tables/${room.body.id}`, { botsEnabled: true });
    expect([memberRoom.status, memberRoom.body.error?.message]).toEqual([400, 'member rooms have no table bots']);
    for (const [patch, message] of [
      [{ botFillTo: 3 }, 'botFillTo must be <= maxSeats'],
      [{ botMax: 2 }, 'botMax must leave a seat for a member'],
      [{ botMinHumans: 2 }, 'botMinHumans must be < botFillTo'],
    ] as const) {
      const res = await admin.patch('/api/admin/tables/it-bot-hu-1', patch);
      expect([res.status, res.body.error?.message]).toEqual([400, message]);
    }
    expect((await d1(`SELECT bot_max, bot_fill_to, bot_min_humans FROM tables WHERE id = 'it-bot-hu-1'`))[0]).toEqual({ bot_max: 1, bot_fill_to: 2, bot_min_humans: 1 });
  }, 120_000);

  it('the policy: a preview writes nothing, a stale or unchanged edit is refused, and each change is audited with its reason', async () => {
    await reauth();
    const p = await policy();
    const preview = await admin.req('PUT', '/api/admin/bots/policy', { preview: true, baseVersion: p.version, enabled: true, fundLimit: p.fundLimit + 5000, maxBots: p.maxBots });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, from: { version: p.version }, to: { version: p.version + 1, fundLimit: p.fundLimit + 5000 }, appliesFrom: 'between_hands' });
    expect((await policy()).version).toBe(p.version);

    const stale = await admin.req('PUT', '/api/admin/bots/policy', { baseVersion: p.version - 1, ...ON, fundLimit: p.fundLimit + 5000, reason: 'stale edit' });
    expect([stale.status, stale.body.error?.code, stale.body.error?.details?.policy?.version]).toEqual([409, 'bot_policy_conflict', p.version]);
    const same = await admin.req('PUT', '/api/admin/bots/policy', { baseVersion: p.version, enabled: p.enabled, fundLimit: p.fundLimit, maxBots: p.maxBots, reason: 'no change' });
    expect([same.status, same.body.error?.code]).toEqual([400, 'bot_policy_no_change']);
    const noReason = await admin.req('PUT', '/api/admin/bots/policy', { baseVersion: p.version, ...ON, fundLimit: p.fundLimit + 5000 });
    expect(noReason.status).toBe(400);

    const reason = `bots audit ${Date.now()}`;
    const changed = await setPolicy({ fundLimit: p.fundLimit + 5000 }, reason);
    expect(changed).toEqual({ version: p.version + 1, enabled: true, fundLimit: p.fundLimit + 5000, maxBots: p.maxBots });
    const audits = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = 'bots.policy' ORDER BY created_at DESC LIMIT 1`);
    expect(JSON.parse(audits[0]!.detail)).toMatchObject({ reason, from: { version: p.version, fundLimit: p.fundLimit }, to: { version: p.version + 1, fundLimit: p.fundLimit + 5000 } });
    await setPolicy({ fundLimit: p.fundLimit }, 'bots test: limit back');

    // The operations log: newest first, narrowed by table and kind on the server.
    const joins = (await admin.get('/api/admin/bots/events?kind=join&limit=2')).body as { items: { kind: string }[]; hasMore: boolean };
    expect(joins.items.length).toBe(2);
    expect(joins.items.every((e) => e.kind === 'join')).toBe(true);
    expect(joins.hasMore).toBe(true);
    const atTable = (await admin.get('/api/admin/bots/events?table=it-bot-six')).body as { items: { tableId: string; kind: string }[] };
    expect(atTable.items.length).toBe(6);
    expect(atTable.items.every((e) => e.tableId === 'it-bot-six')).toBe(true);
    expect((await admin.get('/api/admin/bots/events?kind=nope')).status).toBe(400);
    const overview = (await admin.get('/api/admin/bots?days=7')).body;
    expect(overview.fund).toMatchObject({ limit: p.fundLimit });
    expect(overview.chips.seated).toBe(0);
    expect((await admin.get('/api/admin/bots?days=31')).status).toBe(400);
  }, 120_000);
});

describe('table bots across a server restart', () => {
  const state = resolve(root, 'tests/.state/bots-restart');
  const port = 8812;
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
  });

  it('a bot seated in a hand that a crash interrupts is still seated and playing after it, and nothing is paid twice', async () => {
    await prepareState(state, TABLES);
    // Bots on for this database (the migration seeds them off); no administrator is needed.
    await d1(`INSERT INTO bot_policies (version, enabled, fund_limit, max_bots, change) VALUES (2, 1, 1000000, 20, 'test')`, state);
    worker = await startWorker(port, state);
    const base = worker.url;
    const c = new Client(WEB_ORIGIN, base);
    const n = Date.now();
    expect((await c.post('/api/auth/register', await signupBody(c, { email: `bot-rs-${n}@restart.dev`, nickname: `brs${n % 100000}` }))).status).toBe(201);
    const T = 'it-bot-hu-1';

    let ws = await TableSocket.open(c, T, { base });
    await sit(ws, 0, 500);
    // The member's turn: the bot cannot move before the crash.
    const before = await ws.waitState((s) => isMyTurn(s) && s.seats[1]!.bot === 'normal' && s.seats[1]!.hasCards, 30_000, 'the member to act beside the bot');
    const botId = before.seats[1]!.userId!;
    ws.close();
    await worker.stop();
    worker = await startWorker(port, state);

    ws = await TableSocket.open(c, T, { base });
    const after = ws.state!;
    expect(after.hand!.id).toBe(before.hand!.id);
    expect(after.hand!.seq).toBe(before.hand!.seq);
    expect(after.seats[1]).toMatchObject({ userId: botId, bot: 'normal', hasCards: true, stack: before.seats[1]!.stack });
    expect(after.seats[0]!.holeCards).toEqual(before.seats[0]!.holeCards);

    // The bot keeps playing: it moves on a turn of its own after the restart.
    const stop = autoplay([ws], careful(30));
    await until(
      async () => states(ws),
      (xs) => xs.some((x, i) => x.hand?.actorSeat === 1 && xs.slice(i + 1).some((y) => y.hand?.id === x.hand!.id && y.hand!.seq > x.hand!.seq && y.seats[1]!.lastAction)),
      'the bot to act',
      90_000,
    );
    await leave(ws);
    await ws.waitState(empty, 90_000, 'the table to empty');
    await stop();
    ws.close();

    const sessions = await botSessions(T, state);
    expect(sessions.size).toBe(1);
    expect([...sessions.values()][0]!.rows).toEqual({ bot_fund: 1, buy_in: 1, cash_out: 1 });
    const member = await d1<{ id: string }>(`SELECT id FROM users WHERE is_bot = 0 AND email LIKE 'bot-rs-%'`, state);
    expect(await books([member[0]!.id], state)).toBe(10_000);
  }, 300_000);
});
