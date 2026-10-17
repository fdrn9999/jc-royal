// Service notices and maintenance. Notices are shown between their times in Korean and English (and can go to the board
// and every inbox). During maintenance no one new sits down and no new hand is dealt anywhere; a hand already running
// plays out, seated players keep their chips and can leave, and play resumes on its own when it ends. Nothing here
// deletes a hand or writes the chip ledger.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, signupBody, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, nextState, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
const N = '/api/admin/service/notices';
const M = '/api/admin/service/maintenance';
const HOUR = 3_600_000;
const admin = sharedAdmin();
const open: TableSocket[] = [];
const notices: string[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

// Maintenance and notices are global: whatever a failed test left running must not reach the files after this one.
afterAll(async () => {
  await reauth();
  for (const w of (await admin.get(`${M}?limit=50`)).body.items ?? []) {
    if (w.state === 'active' || w.state === 'scheduled') await admin.post(`${M}/${w.id}/stop`, { reason: 'test cleanup' });
  }
  for (const id of notices) await admin.req('DELETE', `${N}/${id}`);
});

/** Re-confirms the password unless the window is still open (re-confirmation is rate limited per account). */
async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function sock(c: Client, tableId: string) {
  const s = await TableSocket.open(c, tableId);
  open.push(s);
  return s;
}

async function notice(body: Record<string, unknown>) {
  const r = await admin.post(N, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  notices.push(r.body.id);
  return r.body as { id: string; postId: string | null; batchId: string | null; sent: number };
}

const status = async () => (await new Client().get('/api/service/status')).body;
const balance = async (userId: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${userId}'`))[0]!.balance;
const audits = (action: string, targetId: string) => d1<{ detail: string | null }>(`SELECT detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}'`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each member's wallet equals the sum of their ledger rows: nothing was paid twice or lost. */
async function ledgerMatches(ids: string[]) {
  const rows = await d1<{ id: string; balance: number; total: number }>(
    `SELECT u.id, u.balance, COALESCE((SELECT SUM(amount) FROM chip_ledger l WHERE l.user_id = u.id), 0) AS total FROM users u WHERE u.id IN (${ids.map((i) => `'${i}'`).join(', ')})`,
  );
  expect(rows).toHaveLength(ids.length);
  for (const r of rows) expect(r.total, r.id).toBe(r.balance);
}

/** Plays the current hand to its end (fold where possible, else check) from whichever socket is to act. */
async function foldOut(socks: TableSocket[]) {
  for (let i = 0; i < 40; i++) {
    const s = socks[0]!.state!;
    if (!s.hand || s.hand.stage === 'settled') return;
    const me = socks.find((w) => isMyTurn(w.state!));
    if (me) await me.act(me.state!.you.legal.some((l) => l.type === 'fold') ? 'fold' : 'check');
    else await nextState(socks);
  }
  throw new Error('the hand did not end');
}

describe('service notices', () => {
  it('shown between their times in both languages, on the board and in every inbox when asked; ended and deleted ones drop out', async () => {
    const en = await newUser(undefined, { locale: 'en' });
    const ko = await newUser();
    const rev0 = (await ko.client.get('/api/messages/unread-count')).body.serviceRev as number;
    expect(typeof rev0).toBe('number');

    // Members and signed-out visitors cannot reach the admin routes.
    expect((await new Client(ADMIN_ORIGIN).post(N, { kind: 'general', titleKo: '공지 제목', titleEn: 'Notice title' })).status).toBe(401);
    expect((await admin.post(N, { kind: 'general', titleKo: '공', titleEn: 'Notice title' })).status).toBe(400);
    expect((await admin.post(N, { kind: 'loud', titleKo: '공지 제목', titleEn: 'Notice title' })).status).toBe(400);
    const backwards = await admin.post(N, { kind: 'general', titleKo: '공지 제목', titleEn: 'Notice title', startsAt: Date.now() + 2 * HOUR, endsAt: Date.now() + HOUR });
    expect(backwards.body.error.message).toBe('the end must come after the start');

    const urgent = await notice({ kind: 'urgent', titleKo: '긴급 점검 안내', titleEn: 'Urgent maintenance notice', bodyKo: '잠시 후 점검합니다.', bodyEn: 'Maintenance shortly.', postToBoard: true, sendInbox: true });
    expect(urgent.postId).toBeTruthy();
    expect(urgent.sent).toBeGreaterThanOrEqual(2);
    const later = await notice({ kind: 'general', titleKo: '예약 공지', titleEn: 'Scheduled notice', startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR });

    // Public, without a session, and never cached.
    const res = await fetch(`${BASE()}/api/service/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const st = await res.json();
    const live = st.notices.find((n: { id: string }) => n.id === urgent.id);
    expect(live).toMatchObject({ kind: 'urgent', titleKo: '긴급 점검 안내', titleEn: 'Urgent maintenance notice', bodyKo: '잠시 후 점검합니다.', bodyEn: 'Maintenance shortly.', endsAt: null, postId: urgent.postId });
    expect(live.startsAt).toBeLessThanOrEqual(st.now);
    expect(st.notices.find((n: { id: string }) => n.id === later.id)?.startsAt).toBeGreaterThan(st.now);
    expect(st.rev).toBeGreaterThan(rev0);
    expect((await ko.client.get('/api/messages/unread-count')).body.serviceRev).toBe(st.rev);

    // Each member's inbox has it in their language; the board has it pinned, Korean first and English below.
    expect((await en.client.get('/api/messages')).body).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'notice', title: 'Urgent maintenance notice', body: 'Maintenance shortly.' })]));
    expect((await ko.client.get('/api/messages')).body).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'notice', title: '긴급 점검 안내', body: '잠시 후 점검합니다.' })]));
    const post = await ko.client.get(`/api/board/posts/${urgent.postId}`);
    expect(post.status).toBe(200);
    expect(JSON.stringify(post.body)).toContain('[English] Urgent maintenance notice');

    // An edit reaches the board post and changes the revision the inbox poll reports.
    expect((await admin.patch(`${N}/${urgent.id}`, { titleKo: '긴급 점검 안내(수정)' })).status).toBe(200);
    expect((await ko.client.get('/api/messages/unread-count')).body.serviceRev).toBeGreaterThan(st.rev);
    expect(JSON.stringify((await ko.client.get(`/api/board/posts/${urgent.postId}`)).body)).toContain('긴급 점검 안내(수정)');
    const past = await admin.patch(`${N}/${urgent.id}`, { endsAt: live.startsAt + 1 });
    expect(past.body.error.message).toBe('the end has already passed');

    // Ended now: gone from the banner, listed as ended; ending it again is refused.
    expect((await admin.post(`${N}/${urgent.id}/end`)).status).toBe(200);
    const again = await admin.post(`${N}/${urgent.id}/end`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('this notice has already ended');
    expect((await status()).notices.map((n: { id: string }) => n.id)).not.toContain(urgent.id);
    expect((await admin.get(`${N}?status=ended`)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: urgent.id, state: 'ended', author: expect.any(String) })]));
    expect((await admin.get(`${N}?status=scheduled`)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: later.id, state: 'scheduled' })]));

    // Deleted: out of every list but the deleted filter and the audit trail.
    expect((await admin.req('DELETE', `${N}/${later.id}`)).status).toBe(200);
    expect((await admin.req('DELETE', `${N}/${later.id}`)).status).toBe(404);
    expect((await status()).notices.map((n: { id: string }) => n.id)).not.toContain(later.id);
    expect((await admin.get(`${N}?status=deleted`)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: later.id, state: 'deleted' })]));
    expect((await admin.get(N)).body.items.map((n: { id: string }) => n.id)).not.toContain(later.id);

    expect(await audits('service.notice.create', urgent.id)).toHaveLength(1);
    expect(JSON.parse((await audits('service.notice.create', urgent.id))[0]!.detail!)).toMatchObject({ kind: 'urgent', postId: urgent.postId, sent: urgent.sent });
    expect(await audits('service.notice.update', urgent.id)).toHaveLength(1);
    expect(await audits('service.notice.end', urgent.id)).toHaveLength(1);
    expect(await audits('service.notice.delete', later.id)).toHaveLength(1);
  });

  it('a new urgent notice is never crowded out by older ones; when the list is cut, the page is told when to ask again', async () => {
    // Twenty general notices already showing (the first ends in an hour), then an urgent one.
    const endsAt = Date.now() + HOUR;
    const old: string[] = [];
    for (let i = 0; i < 20; i++) old.push((await notice({ kind: 'general', titleKo: `지난 공지 ${i}`, titleEn: `Older notice ${i}`, ...(i === 0 ? { endsAt } : {}) })).id);
    const urgent = await notice({ kind: 'urgent', titleKo: '새 긴급 공지', titleEn: 'New urgent notice' });

    const st = await status();
    const ids = st.notices.map((n: { id: string }) => n.id);
    expect(ids).toHaveLength(20);
    // Urgent first; then the newest general ones, so the one cut is the oldest.
    expect(ids[0]).toBe(urgent.id);
    expect(ids.slice(1, 4)).toEqual([old[19], old[18], old[17]]);
    expect(ids).not.toContain(old[0]);
    // The list changes when the oldest ends, with no admin edit to bump the revision: the page asks again by then.
    expect(st.refreshAt).toBeGreaterThan(st.now);
    expect(st.refreshAt).toBeLessThanOrEqual(endsAt);

    // Fewer than the limit: nothing cut, nothing to ask again for.
    for (const id of [urgent.id, ...old.slice(1)]) expect((await admin.req('DELETE', `${N}/${id}`)).status).toBe(200);
    const rest = await status();
    expect(rest.notices.map((n: { id: string }) => n.id)).toContain(old[0]);
    expect(rest.refreshAt).toBeNull();
  });
});

describe('maintenance', () => {
  it('changes need a fresh password check; one window at a time, at most 48 hours, planned at most 90 days ahead; a planned one blocks nothing', async () => {
    const now = Date.now();
    const plan = { startsAt: now + HOUR, endsAt: now + 2 * HOUR, blockLogin: true, reason: 'planned upgrade' };

    // An admin session that never re-confirmed its password (a new member made admin, so the shared one's sign-ins are not spent).
    const staff = await newUser();
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${staff.me.id}'`);
    const cold = new Client(ADMIN_ORIGIN);
    expect((await cold.post('/api/admin/auth/login', { email: staff.email, password: PASSWORD })).status).toBe(200);
    const refused = await cold.post(M, plan);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('reauth_required');

    await reauth();
    expect((await admin.post(M, { ...plan, reason: 'x' })).status).toBe(400);
    expect((await admin.post(M, { ...plan, endsAt: plan.startsAt + 48 * HOUR + 60_000 })).body.error?.message).toBe('maintenance lasts at most 48 hours');
    expect((await admin.post(M, { ...plan, startsAt: now + 91 * 24 * HOUR, endsAt: now + 91 * 24 * HOUR + HOUR })).body.error.message).toBe('maintenance can be planned at most 90 days ahead');
    expect((await admin.post(M, { ...plan, startsAt: now - 2 * HOUR, endsAt: now - HOUR })).body.error.message).toBe('the end must come after the start and after now');

    const made = await admin.post(M, { ...plan, messageKo: '서버 업그레이드', messageEn: 'Server upgrade' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    expect(made.body.rooms).toMatchObject({ tables: expect.any(Number), reached: expect.any(Number), truncated: expect.any(Boolean) });
    const second = await admin.post(M, { startsAt: now + 3 * HOUR, endsAt: now + 4 * HOUR, reason: 'another one' });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe('another maintenance window is planned or under way');
    expect((await status()).maintenance).toEqual({ id, startsAt: plan.startsAt, endsAt: plan.endsAt, blockLogin: true, messageKo: '서버 업그레이드', messageEn: 'Server upgrade', active: false });

    // Planned, not yet under way: member sign-in and seats work as usual.
    const a = await newUser();
    expect((await new Client().post('/api/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    const wa = await sock(a.client, 'it-mt-3');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(wa.state!.maintenance).toEqual({ startsAt: plan.startsAt, endsAt: plan.endsAt, active: false });

    // Moved later, then cancelled.
    const moved = await admin.patch(`${M}/${id}`, { startsAt: now + 2 * HOUR, endsAt: now + 3 * HOUR, reason: 'moved later' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await wa.waitState((s) => s.maintenance?.startsAt === now + 2 * HOUR, 10_000, 'moved window')).maintenance!.active).toBe(false);
    const stop = await admin.post(`${M}/${id}/stop`, { reason: 'not needed' });
    expect(stop.body).toMatchObject({ ok: true, ended: false });
    await wa.waitState((s) => s.maintenance === null, 10_000, 'cancelled window');
    expect((await admin.post(`${M}/${id}/stop`, { reason: 'again' })).status).toBe(409);
    expect((await admin.patch(`${M}/${id}`, { endsAt: now + 5 * HOUR, reason: 'too late' })).body.error.message).toBe('this maintenance is already over');
    expect((await status()).maintenance).toBeNull();
    expect((await admin.get(M)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, state: 'cancelled', author: expect.any(String) })]));
    expect(await wa.request({ t: 'leave' })).toMatchObject({ t: 'ack' });

    expect(await audits('maintenance.schedule', id)).toHaveLength(1);
    expect(JSON.parse((await audits('maintenance.schedule', id))[0]!.detail!)).toMatchObject({ reason: 'planned upgrade', blockLogin: true, rooms: { reached: expect.any(Number), unreached: expect.any(Number) } });
    expect(JSON.parse((await audits('maintenance.update', id))[0]!.detail!)).toMatchObject({ reason: 'moved later', after: { startsAt: now + 2 * HOUR } });
    expect(await audits('maintenance.cancel', id)).toHaveLength(1);
    await ledgerMatches([a.me.id]);
  });

  it('under way: the running hand plays out, nobody new sits or queues, members cannot sign in (staff can); the table close and pause still work; play resumes when it ends', async () => {
    // Before: a hand running at it-mt-0 with a spectator; a full heads-up table with a waitlist; a paused table; a lone player.
    const [a, b, c, e, f, g, h, p, q, v, d, staff] = await Promise.all(Array.from({ length: 12 }, () => newUser()));
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${staff!.me.id}'`);
    const wa = await sock(a!.client, 'it-mt-0');
    const wb = await sock(b!.client, 'it-mt-0');
    const wc = await sock(c!.client, 'it-mt-0');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const first = (await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand')).hand!.number;

    const we = await sock(e!.client, 'it-mt-wl');
    const wf = await sock(f!.client, 'it-mt-wl');
    const wg = await sock(g!.client, 'it-mt-wl');
    const wh = await sock(h!.client, 'it-mt-wl');
    expect(await we.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wf.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wg.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'ack' });
    await we.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'waitlist table hand');

    await reauth();
    expect((await admin.post('/api/admin/tables/it-mt-1/control', { action: 'pause', reason: 'checking the table' })).status).toBe(200);
    const wp = await sock(p!.client, 'it-mt-1');
    const wq = await sock(q!.client, 'it-mt-1');
    expect(await wp.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wq.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const wv = await sock(v!.client, 'it-mt-2');
    expect(await wv.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const register = new Client();
    const fresh = await signupBody(register, { email: `${uniq('e')}@test.dev`, nickname: uniq('n').slice(0, 14) });
    // A member's post and comment from before, to edit and delete during it.
    const post = (await d!.client.post('/api/board/posts', { title: '점검 전 글', body: '점검 전에 쓴 글' })).body.id as string;
    const comment = (await d!.client.post(`/api/board/posts/${post}/comments`, { body: '점검 전 댓글' })).body.id as string;
    const staffPost = (await staff!.client.post('/api/board/posts', { title: '운영 공지 초안', body: '점검 안내' })).body.id as string;

    // Maintenance from now, blocking member sign-in.
    const start = await admin.post(M, { startsAt: Date.now() - 1_000, endsAt: Date.now() + 10 * 60_000, blockLogin: true, messageKo: '정기 점검', messageEn: 'Scheduled maintenance', reason: 'database upgrade' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const id = start.body.id as string;
    const endsAt = (await status()).maintenance.endsAt as number;
    // (Tables other files left in use are asked too; the four here have connections, so they come first.)
    expect(start.body.rooms.reached).toBeGreaterThanOrEqual(4);
    for (const t of ['it-mt-0', 'it-mt-1', 'it-mt-2', 'it-mt-wl']) expect(start.body.rooms.unreached).not.toContain(t);
    try {
      // Shown at once on every table; the hand already running keeps going.
      expect((await wa.waitState((s) => s.maintenance?.active === true, 10_000, 'maintenance shown')).hand!.number).toBe(first);
      expect((await wc.waitState((s) => s.maintenance?.active === true)).you.canSit).toBe(false);
      expect(await wc.request({ t: 'sit', seatIndex: 2, buyIn: 300 })).toMatchObject({ t: 'error', code: 'maintenance' });
      expect(await wh.request({ t: 'waitlist', join: true })).toMatchObject({ t: 'error', code: 'maintenance' });
      expect((await admin.patch(`${M}/${id}`, { startsAt: Date.now() + HOUR, reason: 'move it' })).body.error.message).toBe('maintenance under way keeps its start');

      await foldOut([wa, wb]);
      await foldOut([we, wf]);
      expect((await wa.waitState((s) => s.hand === null, 15_000, 'no next hand')).nextHandAt).toBeNull();
      await we.waitState((s) => s.hand === null, 15_000, 'no next hand (waitlist table)');

      // A seated player can still leave and is paid out; the seat waits for the waitlist until maintenance ends.
      const fStack = wf.state!.seats[1]!.stack;
      expect(await wf.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
      expect(await balance(f!.me.id)).toBe(9_700 + fStack);
      const freed = await wg.waitState((s) => s.seats[1]!.state === 'empty', 10_000, 'seat freed');
      expect(freed.reservation).toBeNull();
      expect(freed.you.inWaitlist).toBe(true);
      expect(await wg.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'error', code: 'maintenance' });

      // New games, sign-up and member sign-in wait; signed-in sessions stay; staff and the console sign in.
      const quick = await a!.client.post('/api/tables/quick', { bigBlind: 10 });
      expect(quick.status).toBe(503);
      expect(quick.body.error).toMatchObject({ code: 'maintenance', details: { endsAt } });
      expect((await a!.client.post('/api/rooms', { name: '점검 중 방', maxSeats: 6, bigBlind: 10, minBuyIn: 100, maxBuyIn: 2000 })).body.error?.code).toBe('maintenance');
      expect((await register.post('/api/auth/register', fresh)).body.error?.code).toBe('maintenance');
      const login = await new Client().post('/api/auth/login', { email: d!.email, password: PASSWORD });
      expect(login.status).toBe(503);
      expect(login.body.error).toMatchObject({ code: 'maintenance', details: { endsAt } });
      expect((await new Client().post('/api/auth/login', { email: d!.email, password: 'Wrong123!pass' })).status).toBe(401);
      expect((await new Client().post('/api/auth/login', { email: staff!.email, password: PASSWORD })).status).toBe(200);
      expect((await new Client(ADMIN_ORIGIN).post('/api/admin/auth/login', { email: staff!.email, password: PASSWORD })).status).toBe(200);
      expect((await a!.client.get('/api/auth/me')).status).toBe(200);

      // Members can't post, comment or edit (the same refusal, with the end time); they can read and delete their own.
      // Staff can post, to answer questions about it.
      const posting = await d!.client.post('/api/board/posts', { title: '점검 중 글', body: '되나요?' });
      expect(posting.status).toBe(503);
      expect(posting.body.error).toMatchObject({ code: 'maintenance', details: { endsAt } });
      expect((await d!.client.post(`/api/board/posts/${post}/comments`, { body: '점검 중 댓글' })).body.error).toMatchObject({ code: 'maintenance', details: { endsAt } });
      expect((await d!.client.patch(`/api/board/posts/${post}`, { title: '고친 글', body: '고친 본문' })).body.error?.code).toBe('maintenance');
      expect((await d!.client.patch(`/api/board/comments/${comment}`, { body: '고친 댓글' })).body.error?.code).toBe('maintenance');
      expect((await d!.client.get(`/api/board/posts/${post}`)).body).toMatchObject({ title: '점검 전 글' });
      expect((await d!.client.req('DELETE', `/api/board/comments/${comment}`)).status).toBe(200);
      expect((await d!.client.req('DELETE', `/api/board/posts/${post}`)).status).toBe(200);
      expect((await staff!.client.post(`/api/board/posts/${staffPost}/comments`, { body: '점검은 30분 뒤 끝납니다' })).status).toBe(201);
      expect((await staff!.client.patch(`/api/board/posts/${staffPost}`, { title: '운영 공지', body: '점검 안내' })).status).toBe(200);

      // The console sees it per table, with no missing-hand warning; a table can still be closed (its player paid out).
      const detail = (await admin.get('/api/admin/tables/it-mt-0')).body;
      expect(detail.live.maintenance).toMatchObject({ active: true, endsAt });
      expect(detail.diagnosis.issues).toEqual([]);
      const close = await admin.post('/api/admin/tables/it-mt-2/close', {});
      expect(close.status, JSON.stringify(close.body)).toBe(200);
      expect(await wv.waitClose()).toBe(4002);
      expect(await balance(v!.me.id)).toBe(10_000);
      expect(wa.state!.hand).toBeNull();

      // Extended while under way.
      expect((await admin.patch(`${M}/${id}`, { endsAt: endsAt + 5 * 60_000, reason: 'needs longer' })).status).toBe(200);
      await wa.waitState((s) => s.maintenance?.endsAt === endsAt + 5 * 60_000, 10_000, 'extended');
    } finally {
      const stop = await admin.post(`${M}/${id}/stop`, { reason: 'upgrade done' });
      expect(stop.status, JSON.stringify(stop.body)).toBe(200);
      expect(stop.body).toMatchObject({ ok: true, ended: true });
    }

    // Ended early: dealing resumes, the freed seat is offered to the waitlist, the paused table stays paused.
    const next = await wa.waitState((s) => !s.maintenance && !!s.hand && s.hand.number > first, 20_000, 'hand after maintenance');
    expect(next.hand!.number).toBe(first + 1);
    expect((await wg.waitState((s) => s.reservation?.nickname === g!.me.nickname, 10_000, 'seat offered')).you.canSit).toBe(true);
    expect(await wg.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await wp.waitState((s) => !s.maintenance, 10_000, 'paused table told');
    await pause(3_500);
    expect(wp.state).toMatchObject({ paused: true, hand: null, nextHandAt: null });
    expect((await new Client().post('/api/auth/login', { email: d!.email, password: PASSWORD })).status).toBe(200);
    expect((await register.post('/api/auth/register', fresh)).status).toBe(201);
    expect((await a!.client.post('/api/tables/quick', { bigBlind: 999_998 })).status).not.toBe(503);
    expect((await status()).maintenance).toBeNull();
    expect((await admin.get(M)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, state: 'ended_early', blockLogin: true })]));
    expect((await admin.post('/api/admin/tables/it-mt-1/control', { action: 'resume', reason: 'checked' })).status).toBe(200);
    await wp.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'paused table resumed');

    // Chips: the two at it-mt-0 leave with exactly what they brought between them; every wallet matches its ledger.
    await foldOut([wa, wb]);
    expect(await wa.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect((await balance(a!.me.id)) + (await balance(b!.me.id))).toBe(20_000);
    await ledgerMatches([a, b, e, f, g, p, q, v].map((u) => u!.me.id));

    expect(JSON.parse((await audits('maintenance.schedule', id))[0]!.detail!)).toMatchObject({ blockLogin: true, reason: 'database upgrade' });
    expect(JSON.parse((await audits('maintenance.update', id))[0]!.detail!)).toMatchObject({ reason: 'needs longer' });
    expect(JSON.parse((await audits('maintenance.end', id))[0]!.detail!)).toMatchObject({ reason: 'upgrade done', rooms: { reached: expect.any(Number) } });
  });

  it('a planned window begins and ends on its own: the table shows it, finishes the hand, deals nothing during it and again after', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await sock(a.client, 'it-mt-3');
    const wb = await sock(b.client, 'it-mt-3');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const first = (await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand')).hand!.number;

    await reauth();
    const startsAt = Date.now() + 4_000;
    const endsAt = startsAt + 14_000;
    const made = await admin.post(M, { startsAt, endsAt, reason: 'short window' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await wa.waitState((s) => !!s.maintenance, 5_000, 'planned window shown')).maintenance).toEqual({ startsAt, endsAt, active: false });

    // Begins by the room's own alarm; the hand running keeps going and is finished; none follows.
    const shown = await wa.waitState((s) => s.maintenance?.active === true, 10_000, 'maintenance began');
    expect(Date.now()).toBeGreaterThanOrEqual(startsAt - 500);
    expect(shown.hand?.number).toBe(first);
    expect((await status()).maintenance).toMatchObject({ id: made.body.id, active: true });
    await foldOut([wa, wb]);
    await wa.waitState((s) => s.hand === null, 15_000, 'no hand during maintenance');
    expect(Date.now()).toBeLessThan(endsAt);

    // Ends by the alarm too: no admin call, the next hand is dealt.
    const after = await wa.waitState((s) => !s.maintenance && !!s.hand && s.hand.number === first + 1, endsAt - Date.now() + 15_000, 'hand after maintenance');
    expect(after.hand!.stage).toBe('preflop');
    expect(Date.now()).toBeGreaterThanOrEqual(endsAt - 500);
    expect((await admin.get(M)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: made.body.id, state: 'finished' })]));
    await ledgerMatches([a.me.id, b.me.id]);
  });

  it('a table the start was never sent to learns of it when it records its hand, and deals no more until it ends', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await sock(a.client, 'it-mt-4');
    const wb = await sock(b.client, 'it-mt-4');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    const first = (await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand')).hand!.number;

    // Under way, but no room was told: more tables in use than one change asks, or a room that did not answer.
    await reauth();
    const by = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    const id = uniq('mt');
    const [startsAt, endsAt] = [Date.now() - 1_000, Date.now() + 120_000];
    await d1(`INSERT INTO maintenance_windows (id, starts_at, ends_at, block_login, created_by) VALUES ('${id}', ${startsAt}, ${endsAt}, 0, '${by}')`);
    try {
      expect(wa.state!.maintenance).toBeNull();
      await foldOut([wa, wb]);
      expect((await wa.waitState((s) => s.maintenance?.active === true, 15_000, 'maintenance learned')).maintenance).toEqual({ startsAt, endsAt, active: true });
      await wa.waitState((s) => s.hand === null, 15_000, 'no hand during maintenance');
      await pause(3_500);
      expect(wa.state).toMatchObject({ hand: null, nextHandAt: null });
    } finally {
      const stop = await admin.post(`${M}/${id}/stop`, { reason: 'unreached table' });
      expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    }
    const next = await wa.waitState((s) => !s.maintenance && !!s.hand && s.hand.number > first, 20_000, 'hand after maintenance');
    expect(next.hand!.number).toBe(first + 1);
    await foldOut([wa, wb]);
    for (const w of [wa, wb]) expect(await w.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await ledgerMatches([a.me.id, b.me.id]);
  });
});
