// Time bank: what one use adds and costs, a request sent again or a second tap from a screen that was behind adding
// nothing, who may use it, an empty bank, the bank kept through a reconnect, a second tab and a new seat, a policy change
// that leaves the running hand and turn alone (and the refill and cut to a lower maximum it brings from the next hand), a
// closing table, a turn that still runs out, the counters written once with the hand, and the administrators' side: who
// may change what, conflicts, unchanged and invalid policies, audits, and timer recovery that changes no one's time.
import type { ServerMessage } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
/** The policy migration 0025 seeds, put back after this file. */
const SEED = { enabled: true, memberRooms: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 };
type Settings = typeof SEED;
type Policy = Settings & { version: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await sleep(250);
  }
}

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const policy = async () => (await admin.get('/api/admin/time-bank?days=7')).body.policy as Policy;
const settingsOf = (p: Policy): Settings => ({ enabled: p.enabled, memberRooms: p.memberRooms, initialMs: p.initialMs, maxMs: p.maxMs, unitMs: p.unitMs, refillHands: p.refillHands, refillMs: p.refillMs });
async function putPolicy(change: Partial<Settings>, reason = 'time bank test') {
  await reauth();
  const p = await policy();
  const r = await admin.req('PUT', '/api/admin/time-bank/policy', { baseVersion: p.version, ...settingsOf(p), ...change, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.policy as Policy;
}
async function restore() {
  const p = await policy();
  if (JSON.stringify(settingsOf(p)) !== JSON.stringify(SEED)) await putPolicy(SEED, 'time bank test done');
}

const sockets: TableSocket[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  await restore();
});

/** The service's time bank counters, all days together. */
async function tbStats() {
  const rows = await d1<{ metric: string; n: number }>(`SELECT metric, SUM(n) AS n FROM daily_stats WHERE metric GLOB 'tb_*' GROUP BY metric`);
  const out = { tb_use: 0, tb_sec: 0, tb_empty: 0, tb_expired: 0, tb_late: 0, tb_recover: 0, tb_timeout: 0 };
  for (const r of rows) if (r.metric in out) out[r.metric as keyof typeof out] = Number(r.n);
  return out;
}
const delta = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]));

type Member = Awaited<ReturnType<typeof newUser>>;
async function pair(tableId: string) {
  const [x, y] = await Promise.all([newUser(), newUser()]);
  const a = await TableSocket.open(x.client, tableId);
  const b = await TableSocket.open(y.client, tableId);
  sockets.push(a, b);
  expect(await a.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
  expect(await b.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
  return { a, b, who: new Map<TableSocket, Member>([[a, x], [b, y]]) };
}

/** The player to act in a hand (numbered over `after`) both players see the same, and the other one. */
async function turn(a: TableSocket, b: TableSocket, after = 0): Promise<[TableSocket, TableSocket]> {
  const end = Date.now() + 25_000;
  for (;;) {
    const sa = a.state;
    const sb = b.state;
    if (sa?.hand && sb?.hand && sa.hand.id === sb.hand.id && sa.hand.seq === sb.hand.seq && sa.hand.number > after && sa.hand.stage !== 'settled') {
      if (isMyTurn(sa)) return [a, b];
      if (isMyTurn(sb)) return [b, a];
    }
    if (Date.now() > end) throw new Error(`no turn; a: ${JSON.stringify(sa?.hand)?.slice(0, 300)}`);
    await sleep(50);
  }
}

/** Asks for time with what `ws` shows now (or `seen` as given), with `reqId` when given. */
function use(ws: TableSocket, opts: { seen?: number; reqId?: string; handId?: string } = {}): Promise<ServerMessage> {
  const h = ws.state!.hand!;
  const msg = { t: 'timeBank', handId: opts.handId ?? h.id, seq: h.seq, seen: opts.seen ?? h.extraMs ?? 0 };
  if (!opts.reqId) return ws.request(msg);
  const reqId = opts.reqId;
  const p = ws.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === reqId, 15_000, 'time bank answer');
  ws.send({ ...msg, reqId });
  return p;
}
const code = (m: ServerMessage) => (m.t === 'error' ? m.code : m.t);
const bank = (ws: TableSocket) => ws.state!.you.timeBank;
/** Folds and waits for the hand to be over; returns its number. */
async function foldOut(ws: TableSocket) {
  const n = ws.state!.hand!.number;
  await ws.act('fold');
  await ws.waitState((s) => s.hand?.stage === 'settled' || (s.hand?.number ?? 0) > n, 15_000, 'hand over');
  return n;
}
/** Leaves the table: at once between hands, else after a hand both players fold out of whenever it is their turn. */
async function standUp(ws: TableSocket, others: TableSocket[]) {
  expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
  const end = Date.now() + 30_000;
  while (ws.state!.you.seatIndex !== null) {
    if (Date.now() > end) throw new Error('did not stand up');
    for (const p of [ws, ...others]) if (p.state && isMyTurn(p.state)) await p.act('fold').catch(() => undefined);
    await sleep(100);
  }
}

describe('time bank', () => {
  it('one use adds the unit to this turn only and is paid once, however often it is sent; stale or misplaced requests add nothing', async () => {
    const before = await tbStats();
    const { a, b } = await pair('it-tb-0');
    const [me, other] = await turn(a, b);
    const s0 = me.state!;
    expect(s0.timeBank).toEqual({ initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 });
    expect(bank(me)).toEqual({ ms: 30_000, hands: 0 });
    expect(bank(other)).toEqual({ ms: 30_000, hands: 0 });
    // No one is ever shown another player's bank.
    expect(JSON.stringify(other.state!.seats)).not.toMatch(/bank/i);
    expect(s0.hand!.extraMs).toBeUndefined();
    const d0 = s0.hand!.deadline!;

    // Not the actor, not seated, not this hand.
    expect(code(await use(other))).toBe('not_your_turn');
    const viewer = await newUser();
    const vs = await TableSocket.open(viewer.client, 'it-tb-0');
    sockets.push(vs);
    expect(code(await vs.request({ t: 'timeBank', handId: s0.hand!.id, seq: s0.hand!.seq, seen: 0 }))).toBe('forbidden');
    expect(code(await use(me, { handId: 'no-such-hand' }))).toBe('conflict');
    expect(bank(me)).toEqual({ ms: 30_000, hands: 0 });

    // One use, sent again with the same id (as after a lost answer): answered both times, paid once.
    const reqId = `tb-${crypto.randomUUID()}`;
    expect(code(await use(me, { reqId }))).toBe('ack');
    expect(me.state!.hand).toMatchObject({ deadline: d0 + 10_000, extraMs: 10_000 });
    expect(bank(me)).toEqual({ ms: 20_000, hands: 0 });
    expect(code(await use(me, { reqId, seen: 0 }))).toBe('ack');
    // A second tap from a screen that had not shown the first one yet: refused, nothing added.
    expect(code(await use(me, { seen: 0 }))).toBe('stale_version');
    await sleep(300);
    expect(me.state!.hand).toMatchObject({ deadline: d0 + 10_000, extraMs: 10_000 });
    expect(bank(me)).toEqual({ ms: 20_000, hands: 0 });
    // Everyone sees the moved deadline; the other player's bank is untouched.
    expect(other.state!.hand!.deadline).toBe(d0 + 10_000);
    expect(bank(other)).toEqual({ ms: 30_000, hands: 0 });

    // Two more uses empty it; then it is refused.
    expect(code(await use(me))).toBe('ack');
    expect(code(await use(me))).toBe('ack');
    expect(me.state!.hand).toMatchObject({ deadline: d0 + 30_000, extraMs: 30_000 });
    expect(bank(me)).toEqual({ ms: 0, hands: 0 });
    expect(code(await use(me))).toBe('time_bank_empty');
    expect(me.state!.hand!.deadline).toBe(d0 + 30_000);

    // After the hand each member has one more hand towards the refill; an empty bank stays empty until then.
    await foldOut(me);
    await me.waitState((s) => s.you.timeBank?.hands === 1, 15_000, 'hand counted');
    expect(bank(me)).toEqual({ ms: 0, hands: 1 });
    await other.waitState((s) => s.you.timeBank?.hands === 1, 15_000, 'hand counted');
    expect(bank(other)).toEqual({ ms: 30_000, hands: 1 });

    // Counted once, with the hand record (the refused use too).
    const counted = await until(tbStats, (s) => s.tb_use - before.tb_use >= 3 && s.tb_empty - before.tb_empty >= 1, 'counters');
    await sleep(1_000);
    // (Not `tb_timeout`: every table's timed-out turns count there, and other files' tables still play.)
    expect(delta(before, await tbStats())).toMatchObject({ tb_use: 3, tb_sec: 30, tb_empty: 1, tb_expired: 0 });
    expect(delta(before, counted)).toMatchObject({ tb_use: 3, tb_sec: 30, tb_empty: 1 });
  }, 90_000);

  it('the bank stays through a reconnect, a second tab and a new seat: standing up and sitting down again never brings a fresh one', async () => {
    const { a, b, who } = await pair('it-tb-1');
    const [me, other] = await turn(a, b);
    const member = who.get(me)!;
    expect(code(await use(me))).toBe('ack');
    const d = me.state!.hand!.deadline!;
    const handId = me.state!.hand!.id;

    me.close();
    const back = await TableSocket.open(member.client, 'it-tb-1');
    sockets.push(back);
    expect(bank(back)).toEqual({ ms: 20_000, hands: 0 });
    expect(back.state!.hand).toMatchObject({ id: handId, deadline: d, extraMs: 10_000 });
    // Another tab takes the connection over (the first is closed) and finds the same bank and deadline.
    const again = await TableSocket.open(member.client, 'it-tb-1');
    sockets.push(again);
    expect(await back.waitClose()).toBe(4001);
    expect(bank(again)).toEqual({ ms: 20_000, hands: 0 });
    expect(again.state!.hand).toMatchObject({ id: handId, deadline: d, extraMs: 10_000 });

    // The table page shows the clock and the rules, read only.
    const live = (await admin.get('/api/admin/tables/it-tb-1')).body.live;
    expect(live.timer).toMatchObject({ baseMs: 60_000, extraMs: 10_000, deadline: d, lateMs: 0 });
    expect(live.timeBank).toMatchObject({ hand: { unitMs: 10_000 }, handUses: 1 });
    expect(live.seats.find((s: { userId: string } | null) => s?.userId === member.me.id).timeBank).toEqual({ ms: 20_000, hands: 0 });

    await foldOut(again);
    await again.waitState((s) => s.you.timeBank?.hands === 1, 15_000, 'hand counted');
    await standUp(again, [other]);
    expect(bank(again)).toBeNull();
    expect((await admin.get('/api/admin/tables/it-tb-1')).body.live.timeBank.kept).toBeGreaterThanOrEqual(1);

    const seat = other.state!.you.seatIndex === 0 ? 1 : 0;
    const last = again.state!.hand?.number ?? 0;
    expect(await again.request({ t: 'sit', seatIndex: seat, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await again.waitState((s) => s.you.seatIndex === seat);
    expect(bank(again)).toEqual({ ms: 20_000, hands: 1 });
    const dealt = await again.waitState((s) => !!s.hand && s.hand.stage !== 'settled' && s.hand.number > last, 20_000, 'next hand');
    expect(dealt.you.timeBank!.ms).toBe(20_000);
  }, 90_000);

  it('a policy change leaves the running hand and its deadline alone and applies from the next hand: new unit, refill, cut to a lower maximum', async () => {
    try {
      await policyBoundary();
    } finally {
      await restore();
    }
  }, 120_000);

  async function policyBoundary() {
    const { a, b } = await pair('it-tb-2');
    const [me, other] = await turn(a, b);
    expect(code(await use(me))).toBe('ack');
    const d1st = me.state!.hand!.deadline!;
    const handId = me.state!.hand!.id;
    const p = await policy();
    const next = { initialMs: 10_000, maxMs: 15_000, unitMs: 5_000, refillHands: 1, refillMs: 5_000 };

    await reauth();
    const preview = await admin.req('PUT', '/api/admin/time-bank/policy', { baseVersion: p.version, ...settingsOf(p), ...next, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, from: { version: p.version }, to: { version: p.version + 1, ...next }, appliesFrom: 'next_hand', cutToMax: true });
    expect(preview.body.tables).toBeGreaterThanOrEqual(1);
    expect((await policy()).version).toBe(p.version);

    const changed = await putPolicy(next, 'shorter time bank');
    expect(changed).toMatchObject({ version: p.version + 1, ...next });
    // The room learns the next rules; the hand keeps its own.
    await until(async () => (await admin.get('/api/admin/tables/it-tb-2')).body.live.timeBank, (t) => t?.next?.version === p.version + 1, 'room told');
    const live = (await admin.get('/api/admin/tables/it-tb-2')).body.live;
    expect(live.timeBank.hand).toMatchObject({ version: p.version, unitMs: 10_000 });
    expect(live.timer).toMatchObject({ deadline: d1st, extraMs: 10_000 });
    await sleep(300);
    expect(me.state!.hand).toMatchObject({ id: handId, deadline: d1st, extraMs: 10_000 });
    expect(me.state!.timeBank).toMatchObject({ unitMs: 10_000, maxMs: 60_000 });

    // Used again in the same hand: the hand's unit, not the new one.
    expect(code(await use(me))).toBe('ack');
    expect(me.state!.hand).toMatchObject({ deadline: d1st + 10_000, extraMs: 20_000 });
    expect(bank(me)).toEqual({ ms: 10_000, hands: 0 });

    // The next hand: the new rules, and a bank over the new maximum cut to it.
    const [x, y] = await turn(a, b, await foldOut(me));
    expect(x.state!.timeBank).toEqual({ initialMs: 10_000, maxMs: 15_000, unitMs: 5_000, refillHands: 1, refillMs: 5_000 });
    expect(bank(me)).toEqual({ ms: 10_000, hands: 0 });
    expect(bank(other)).toEqual({ ms: 15_000, hands: 0 });
    const xBefore = bank(x)!.ms;
    const yBefore = bank(y)!.ms;
    expect(code(await use(x))).toBe('ack');
    expect(x.state!.hand!.extraMs).toBe(5_000);
    expect(bank(x)!.ms).toBe(xBefore - 5_000);
    // A refill every hand, never past the maximum.
    await foldOut(x);
    await x.waitState((s) => s.you.timeBank?.ms === Math.min(15_000, xBefore), 15_000, 'refill');
    await y.waitState((s) => s.you.timeBank?.ms === Math.min(15_000, yBefore + 5_000), 15_000, 'refill');
  }

  it('a closing table refuses it without dropping the connection; a turn given time still runs out at its new deadline', async () => {
    const before = await tbStats();
    {
      const { a, b } = await pair('it-tb-3');
      const [me] = await turn(a, b);
      await reauth();
      const close = await admin.post('/api/admin/tables/it-tb-3/close', {});
      expect(close.status, JSON.stringify(close.body)).toBe(200);
      await me.waitState((s) => s.status === 'closing', 10_000, 'closing');
      expect(code(await use(me))).toBe('time_bank_off');
      expect(me.closed).toBeNull();
      expect(bank(me)).toEqual({ ms: 30_000, hands: 0 });
      await me.act('fold');
      await me.waitClose(30_000);
    }

    const { a, b } = await pair('it-tb-fast');
    const [me] = await turn(a, b);
    const seq = me.state!.hand!.seq;
    expect(code(await use(me))).toBe('ack');
    const used = Date.now();
    const deadline = me.state!.hand!.deadline!;
    // The 3 second turn now ends at its new deadline, not before.
    await me.waitState((s) => s.hand?.seq !== seq || s.hand?.stage === 'settled', 30_000, 'timed out');
    const waited = Date.now() - used;
    expect(waited).toBeGreaterThanOrEqual(deadline - used - 250);
    expect(waited).toBeGreaterThan(6_000);
    // Counted as a turn that timed out too (one that was given time is part of them).
    const counted = await until(tbStats, (s) => s.tb_expired - before.tb_expired >= 1, 'expired counted', 40_000);
    expect(counted.tb_timeout - before.tb_timeout).toBeGreaterThanOrEqual(counted.tb_expired - before.tb_expired);
  }, 120_000);

  it('only the super admin changes the policy, with a fresh password and a reason; conflicts, unchanged and invalid policies are refused and audited', async () => {
    const plainUser = await newUser();
    await d1(promoteSql(`id = '${plainUser.me.id}'`));
    const plain = new Client(ADMIN_ORIGIN);
    expect((await plain.post('/api/admin/auth/login', { email: plainUser.email, password: PASSWORD })).status).toBe(200);
    await reauth(plain);

    const view = await plain.get('/api/admin/time-bank?days=7');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ appliesFrom: 'next_hand', minUseMs: 1_000, days: 7 });
    expect(view.body.series).toHaveLength(7);
    expect((await plain.get('/api/admin/time-bank?days=31')).body.error.code).toBe('invalid_input');
    expect(view.body.usage).toMatchObject({ tb_use: expect.any(Number), tb_late: expect.any(Number) });
    const p = view.body.policy as Policy;
    const body = { baseVersion: p.version, ...settingsOf(p), unitMs: 20_000, reason: 'longer uses' };
    const refused = await plain.req('PUT', '/api/admin/time-bank/policy', body);
    expect(refused.status).toBe(403);
    // A member reaches neither the page nor the change, nor does anyone signed out.
    const member = await newUser();
    const memberAdmin = new Client(ADMIN_ORIGIN);
    expect((await memberAdmin.post('/api/admin/auth/login', { email: member.email, password: PASSWORD })).status).not.toBe(200);
    for (const c of [member.client, memberAdmin, new Client(ADMIN_ORIGIN)]) {
      expect((await c.get('/api/admin/time-bank')).status).toBeGreaterThanOrEqual(401);
      expect((await c.req('PUT', '/api/admin/time-bank/policy', body)).status).toBeGreaterThanOrEqual(401);
    }

    try {
      await policyAdmin(p, body, plainUser.me.id);
    } finally {
      await restore();
    }
  }, 60_000);

  async function policyAdmin(p: Policy, body: Record<string, unknown>, userId: string) {
    await reauth();
    const put = (b: Record<string, unknown>) => admin.req('PUT', '/api/admin/time-bank/policy', b);
    expect((await put({ ...body, reason: undefined })).status).toBe(400);
    const invalid = await put({ ...body, initialMs: 70_000, maxMs: 60_000 });
    expect([invalid.status, invalid.body.error.code, invalid.body.error.details?.problem]).toEqual([400, 'time_bank_invalid', 'initial_over_max']);
    expect((await put({ ...body, unitMs: 5_500 })).body.error).toMatchObject({ code: 'time_bank_invalid', details: { problem: 'whole_seconds' } });
    expect((await put({ ...body, maxMs: 1_000 })).body.error.code).toBe('bad_request');
    expect((await put({ ...body, unitMs: p.unitMs })).body.error.code).toBe('time_bank_no_change');
    const stale = await put({ ...body, baseVersion: p.version - 1 });
    expect([stale.status, stale.body.error.code, stale.body.error.details.policy.version]).toEqual([409, 'time_bank_policy_conflict', p.version]);

    // Two administrators saving from the same version: one is saved, the other told it changed.
    const both = await Promise.all([put({ ...body, unitMs: 15_000, reason: 'first edit' }), put({ ...body, unitMs: 20_000, reason: 'second edit' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const saved = both.find((r) => r.status === 200)!.body;
    expect(saved).toMatchObject({ ok: true, appliesFrom: 'next_hand', policy: { version: p.version + 1 } });
    expect(saved.rooms).toMatchObject({ tables: expect.any(Number), reached: expect.any(Number), more: false });

    const audits = await d1<{ action: string; outcome: string; actor_id: string; detail: string }>(
      `SELECT action, outcome, actor_id, detail FROM admin_audit_log WHERE action LIKE 'timebank.policy%' ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    );
    const ok = audits.find((r) => r.action === 'timebank.policy' && JSON.parse(r.detail).to?.version === p.version + 1)!;
    expect(ok.outcome).toBe('ok');
    expect(JSON.parse(ok.detail)).toMatchObject({ from: { version: p.version, unitMs: p.unitMs }, to: { version: p.version + 1 }, appliesFrom: 'next_hand' });
    expect(['first edit', 'second edit']).toContain(JSON.parse(ok.detail).reason);
    const failed = audits.filter((r) => r.action === 'timebank.policy.failed');
    expect(failed.map((r) => JSON.parse(r.detail).code)).toEqual(expect.arrayContaining(['time_bank_policy_conflict', 'time_bank_no_change', 'time_bank_invalid', 'bad_request']));
    // The plain administrator's refused change is on the log as theirs.
    expect(JSON.parse(failed.find((r) => r.actor_id === userId)!.detail)).toMatchObject({ status: 403, route: 'PUT /time-bank/policy' });

    // There is no way to set a member's time: no route takes one.
    await reauth();
    for (const [m, path] of [
      ['PUT', `/api/admin/users/${userId}/time-bank`],
      ['POST', '/api/admin/tables/it-tb-0/time-bank'],
    ] as const) {
      expect([403, 404]).toContain((await admin.req(m, path, { ms: 600_000, reason: 'more time' })).status);
    }
  }

  it('timer recovery on a healthy turn only sets its alarm again: no deadline or bank moves, and it is audited with the result', async () => {
    const before = await tbStats();
    const { a, b } = await pair('it-tb-4');
    const [me, other] = await turn(a, b);
    expect(code(await use(me))).toBe('ack');
    const h = me.state!.hand!;

    const member = new Client(ADMIN_ORIGIN);
    expect((await member.post('/api/admin/tables/it-tb-4/timer-recover', { reason: 'not mine' })).status).toBeGreaterThanOrEqual(401);
    await reauth();
    expect((await admin.post('/api/admin/tables/it-tb-4/timer-recover', {})).status).toBe(400);
    const rec = await admin.post('/api/admin/tables/it-tb-4/timer-recover', { reason: 'timer check' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body).toMatchObject({ ok: true, result: 'rearmed', handId: h.id, deadline: h.deadline, lateMs: 0 });
    expect(rec.body.alarmAfter).toBeLessThanOrEqual(h.deadline!);
    await sleep(300);
    expect(me.state!.hand).toMatchObject({ id: h.id, seq: h.seq, deadline: h.deadline, extraMs: 10_000 });
    expect(bank(me)).toEqual({ ms: 20_000, hands: 0 });
    expect(bank(other)).toEqual({ ms: 30_000, hands: 0 });

    const [row] = await d1<{ outcome: string; target_id: string; detail: string }>(
      `SELECT outcome, target_id, detail FROM admin_audit_log WHERE action = 'table.timer_recover' AND target_id = 'it-tb-4' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row!.outcome).toBe('ok');
    expect(JSON.parse(row!.detail)).toMatchObject({ reason: 'timer check', roomConfirmed: true, result: 'rearmed', handId: h.id, deadline: h.deadline });
    expect(delta(before, await tbStats()).tb_recover).toBe(1);
    expect((await admin.post('/api/admin/tables/no-such-table/timer-recover', { reason: 'nothing here' })).status).toBe(404);
  }, 60_000);
});
