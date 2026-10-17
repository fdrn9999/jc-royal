// Emergency controls. Suspending or disconnecting a member ends the table sockets they already have open, and an admin
// can stop new hands or new players at a table. Nothing decides cards or results: a removed player is folded on their
// turn and cashed out once, the way a player who leaves is.
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1, holdD1WriteLock } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** Re-confirms the password unless the window is still open (re-confirmation is rate limited per account). */
async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/**
 * An admin session that never re-confirmed its password: a new member made admin directly in D1, so the shared
 * admin's sign-ins (5 per 15 minutes) are not spent.
 */
let cold: Promise<Client> | null = null;
function coldAdmin() {
  cold ??= (async () => {
    const u = await newUser();
    await d1(promoteSql(`id = '${u.me.id}'`));
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return c;
  })();
  return cold;
}

async function sock(c: Client, tableId: string) {
  const s = await TableSocket.open(c, tableId);
  open.push(s);
  return s;
}

const ledger = (userId: string) => d1<{ type: string; amount: number }>(`SELECT type, amount FROM chip_ledger WHERE user_id = '${userId}' ORDER BY created_at, rowid`);
const balance = async (userId: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${userId}'`))[0]!.balance;
const audits = (action: string, targetId: string) => d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}'`);

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

describe('suspending or disconnecting a member', () => {
  it('a suspension ends the open socket; the other player finishes the hand and the seat is paid out once', async () => {
    await reauth();
    const a = await newUser();
    const b = await newUser();
    const wa = await sock(a.client, 'it-emg-0');
    const wb = await sock(b.client, 'it-emg-0');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await wb.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand');

    const r = await admin.post(`/api/admin/users/${a.me.id}/suspend`, { reason: 'emergency test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kick).toMatchObject({ unreached: [], truncated: false, sockets: 1 });
    expect(r.body.kick.reached).toBe(r.body.kick.tables);
    // In a hand: folded on their turn (now, if it was theirs, which ends a heads-up hand at once).
    expect(r.body.kick.seats).toEqual([{ tableId: 'it-emg-0', seat: expect.stringMatching(/^(after_hand|left)$/) }]);

    // The open socket is told why and closed; it cannot come back.
    expect(await wa.wait((m) => m.t === 'error' && m.code === 'suspended' && !('reqId' in m && m.reqId))).toBeTruthy();
    expect(await wa.waitClose()).toBe(4004);
    await expect(TableSocket.open(a.client, 'it-emg-0')).rejects.toThrow();

    // The other player plays the hand out; then the seat is empty and paid out exactly once.
    await playOut(wb);
    const after = await wb.waitState((s) => !s.seats[0]?.userId, 20_000, 'seat 0 freed');
    const outs = (await ledger(a.me.id)).filter((l) => l.type !== 'signup_grant');
    expect(outs.map((l) => l.type)).toEqual(['buy_in', 'cash_out']);
    expect(outs[0]!.amount).toBe(-300);
    expect(await d1(`SELECT status FROM table_sessions WHERE user_id = '${a.me.id}'`)).toEqual([{ status: 'closed' }]);
    // Chips are conserved: both wallets plus what B still has on the table.
    const bStack = after.seats[1]!.stack;
    expect((await balance(a.me.id)) + (await balance(b.me.id)) + bStack).toBe(20_000);
    expect(await balance(a.me.id)).toBe(10_000 - 300 + outs[1]!.amount);
    // B saw no chat or action from the removed player after the close.
    expect(wb.messages.some((m) => m.t === 'chat' && m.message.userId === a.me.id)).toBe(false);
    const audit = await audits('user.suspend', a.me.id);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ reason: 'emergency test', kick: { sockets: 1 } });
  });

  it('the wallet refuses a buy-in or top-up for a suspended account, even from a socket opened before', async () => {
    // The window between the suspension being saved and the room ending the socket: only the ledger guard is left.
    const c = await newUser();
    const d = await newUser();
    const wc = await sock(c.client, 'it-emg-1');
    const wd = await sock(d.client, 'it-emg-1');
    expect(await wc.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await d1(`UPDATE users SET status = 'suspended' WHERE id IN ('${c.me.id}', '${d.me.id}')`);
    try {
      expect(await wc.request({ t: 'topUp', amount: 100 })).toMatchObject({ t: 'error', code: 'suspended' });
      expect(await wd.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'error', code: 'suspended' });
      expect(await balance(c.me.id)).toBe(9_700);
      expect(await balance(d.me.id)).toBe(10_000);
      expect((await ledger(d.me.id)).map((l) => l.type)).toEqual(['signup_grant']);
      expect((await ledger(c.me.id)).map((l) => l.type)).toEqual(['signup_grant', 'buy_in']);
      expect(wc.state!.seats[0]!.stack).toBe(300);
    } finally {
      await d1(`UPDATE users SET status = 'active' WHERE id IN ('${c.me.id}', '${d.me.id}')`);
    }
  });

  it('leaving a seat whose buy-in never reached D1 pays nothing out', async () => {
    const a = await newUser();
    const wa = await sock(a.client, 'it-emg-5');
    const release = holdD1WriteLock();
    let sit;
    try {
      sit = await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 });
    } finally {
      release();
    }
    expect(sit).toMatchObject({ t: 'error' });
    expect(await wa.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.you.seatIndex === null, 15_000, 'seat released');
    expect(await balance(a.me.id)).toBe(10_000);
    expect((await ledger(a.me.id)).map((l) => l.type)).toEqual(['signup_grant']);
    expect(await d1(`SELECT id FROM table_sessions WHERE user_id = '${a.me.id}'`)).toEqual([]);
  });

  it('ending connections without a suspension: re-confirmation, the member signs in again and still has the seat', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await sock(a.client, 'it-emg-4');
    const wb = await sock(b.client, 'it-emg-4');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });

    const cold = await coldAdmin();
    const refused = await cold.post(`/api/admin/users/${a.me.id}/disconnect`, { reason: 'connection check' });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('reauth_required');
    expect(wa.closed).toBeNull();

    await reauth();
    // Who is on: the member's sign-in shows on the detail page (kind and times only) and in the online filter.
    const onlineQuery = `/api/admin/users?online=1&q=${encodeURIComponent(a.email)}`;
    const detail = (await admin.get(`/api/admin/users/${a.me.id}`)).body;
    expect(detail.online).toBe(true);
    expect(detail.sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of detail.sessions) expect(Object.keys(s).sort()).toEqual(['createdAt', 'expiresAt', 'kind', 'lastSeenAt']);
    expect((await admin.get(onlineQuery)).body).toEqual([expect.objectContaining({ id: a.me.id, online: true })]);
    const myId = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    expect((await admin.post(`/api/admin/users/${myId}/disconnect`, { reason: 'self' })).body.error.message).toBe('cannot disconnect yourself');
    expect((await admin.post(`/api/admin/users/${a.me.id}/disconnect`, { reason: 'x' })).status).toBe(400);

    const r = await admin.post(`/api/admin/users/${a.me.id}/disconnect`, { reason: 'connection check' });
    const kickedAt = Date.now();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sessions).toBeGreaterThanOrEqual(1);
    expect(r.body.kick).toMatchObject({ unreached: [], sockets: 1, seats: [{ tableId: 'it-emg-4', seat: 'kept' }] });
    expect(await wa.wait((m) => m.t === 'error' && m.code === 'disconnected')).toBeTruthy();
    expect(await wa.waitClose()).toBe(4004);
    expect((await a.client.get('/api/auth/me')).status).toBe(401);
    await expect(TableSocket.open(a.client, 'it-emg-4')).rejects.toThrow();
    const [gone, listed] = await Promise.all([admin.get(`/api/admin/users/${a.me.id}`), admin.get(onlineQuery)]);
    expect(gone.body).toMatchObject({ online: false, sessions: [] });
    expect(listed.body).toEqual([]);
    expect((await b.client.get('/api/auth/me')).status).toBe(200);
    expect(wb.closed).toBeNull();

    // Not suspended: a new sign-in reconnects to the same seat and stack. The room turns away handshakes the api
    // authorised up to 2 s (allowed clock difference) after the disconnect, the race an old session could win.
    expect((await a.client.post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    if (Date.now() - kickedAt < 1_000) {
      const early = await TableSocket.open(a.client, 'it-emg-4', { noState: true });
      expect(await early.waitClose()).toBe(4004);
      expect(early.messages).toEqual([expect.objectContaining({ t: 'error', code: 'disconnected' })]);
    }
    await new Promise((res) => setTimeout(res, Math.max(0, kickedAt + 2_100 - Date.now())));
    const again = await sock(a.client, 'it-emg-4');
    expect(again.state!.you.seatIndex).toBe(0);
    expect(await balance(a.me.id)).toBe(9_700);
    expect(await again.request({ t: 'chat', text: 'back again' })).toMatchObject({ t: 'ack' });
    const audit = await audits('user.disconnect', a.me.id);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ reason: 'connection check', removeFromTable: false });
  });
});

describe('table emergency controls', () => {
  it('pause lets the running hand finish and deals no other until resumed; block keeps out new players only', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const wa = await sock(a.client, 'it-emg-2');
    const wb = await sock(b.client, 'it-emg-2');
    const wc = await sock(c.client, 'it-emg-2');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const first = (await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand')).hand!.number;

    const cold = await coldAdmin();
    const refused = await cold.post('/api/admin/tables/it-emg-2/control', { action: 'pause', reason: 'investigating' });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('reauth_required');
    await reauth();
    expect((await admin.post('/api/admin/tables/it-emg-2/control', { action: 'pause', reason: 'x' })).status).toBe(400);
    const pause = await admin.post('/api/admin/tables/it-emg-2/control', { action: 'pause', reason: 'investigating' });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    expect(pause.body).toMatchObject({ ok: true, paused: true, handInProgress: true });
    expect((await wa.waitState((s) => s.paused === true)).hand?.number).toBe(first);

    // The running hand plays out normally; the next one is never dealt.
    const actor = isMyTurn(wa.state!) ? wa : wb;
    await actor.act('fold');
    await wa.waitState((s) => s.hand === null, 15_000, 'no next hand');
    expect(wa.state!.nextHandAt).toBeNull();
    const paused = (await admin.get('/api/admin/tables/it-emg-2')).body;
    expect(paused.table.handsPaused).toBe(true);
    expect(paused.live).toMatchObject({ paused: true, handNumber: first, handInProgress: false });
    expect(paused.diagnosis.issues).toEqual([]);

    // Block: seated players stay, a new player cannot sit.
    expect((await admin.post('/api/admin/tables/it-emg-2/control', { action: 'block', reason: 'investigating' })).status).toBe(200);
    expect(await wc.request({ t: 'sit', seatIndex: 2, buyIn: 300 })).toMatchObject({ t: 'error', code: 'entry_blocked' });
    expect(wa.state!.you.seatIndex).toBe(0);
    expect((await admin.post('/api/admin/tables/it-emg-2/control', { action: 'unblock', reason: 'resolved' })).status).toBe(200);
    expect(await wc.request({ t: 'sit', seatIndex: 2, buyIn: 300 })).toMatchObject({ t: 'ack' });

    const resume = await admin.post('/api/admin/tables/it-emg-2/control', { action: 'resume', reason: 'resolved' });
    expect(resume.body).toMatchObject({ ok: true, paused: false });
    const next = await wa.waitState((s) => !!s.hand && s.hand.number > first, 20_000, 'hand after resume');
    expect(next.paused).toBe(false);
    expect(next.hand!.number).toBe(first + 1);
    const logged = await audits('table.control', 'it-emg-2');
    expect(logged.map((x) => JSON.parse(x.detail).action).sort()).toEqual(['block', 'pause', 'resume', 'unblock']);
    expect(logged.every((x) => JSON.parse(x.detail).roomConfirmed === true)).toBe(true);
  });

  it('the diagnosis compares D1 with the room and never carries cards', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await sock(a.client, 'it-emg-3');
    const wb = await sock(b.client, 'it-emg-3');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand');

    const clean = (await admin.get('/api/admin/tables/it-emg-3')).body;
    expect(clean.diagnosis).toEqual({ issues: [], sessionsOnlyInD1: [], seatsOnlyInRoom: [] });
    expect(clean.live.hand).toMatchObject({ stage: 'preflop', stalled: false });
    expect(clean.live.seats.filter(Boolean)).toEqual([
      expect.objectContaining({ userId: a.me.id, phase: 'seated', inHand: true }),
      expect.objectContaining({ userId: b.me.id, phase: 'seated', inHand: true }),
    ]);
    expect(JSON.stringify(clean)).not.toMatch(/holeCards|remainingDeck|"deck"|"cards"/);

    // A seat D1 thinks is taken that the room does not have, and a setting written past the room.
    const ghost = await newUser();
    await d1(
      `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status, created_at) VALUES ('emg-ghost-${ghost.me.id}', 'it-emg-3', '${ghost.me.id}', 4, 200, 'seated', ${Date.now()}); UPDATE tables SET entry_blocked = 1 WHERE id = 'it-emg-3';`,
    );
    try {
      const odd = (await admin.get('/api/admin/tables/it-emg-3')).body;
      expect(odd.diagnosis.issues).toEqual(expect.arrayContaining(['session_without_seat', 'settings_not_applied']));
      expect(odd.diagnosis.sessionsOnlyInD1).toEqual([expect.objectContaining({ userId: ghost.me.id, seatIndex: 4, buyIn: 200, nickname: ghost.me.nickname })]);
      expect(odd.diagnosis.seatsOnlyInRoom).toEqual([]);
    } finally {
      await d1(`DELETE FROM table_sessions WHERE id = 'emg-ghost-${ghost.me.id}'; UPDATE tables SET entry_blocked = 0 WHERE id = 'it-emg-3';`);
    }
    expect((await admin.get('/api/admin/tables/it-emg-3')).body.diagnosis.issues).toEqual([]);
  });
});
