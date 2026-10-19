// VIP members (packages/types/src/vip.ts, PATCH /api/admin/users/:id/vip): a name color and a mark an administrator
// gives an ordinary member, nothing more. Who may change it (a super admin; an administrator whose `vip` switch is on;
// never a member), with the password, a reason and the version the console showed; refused accounts (table bots, staff,
// deleted); the audit log; what other players see (friends, requests, blocks, messages, the board, the lobby, tournaments,
// the table and its chat, in real time without anyone reconnecting); and what it never changes (role, chips, the hand).
import type { ServerMessage, TableView } from '@jc/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { promoteSql } from '../support/grants';
import { isMyTurn, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
/** The bootstrapped super admin. */
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

async function signIn(email: string) {
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

/** A new member made a plain administrator with exactly these feature switches, signed in to the console. */
async function withGrants(grants: readonly string[]) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  return { ...u, c: await signIn(u.email) };
}

/** Changes a member's VIP state from the version the console shows now (or `expectedVersion`), with the password confirmed. */
async function setVip(id: string, body: { enabled: boolean; color?: string }, c: Client = admin, expectedVersion?: number) {
  await reauth(c);
  const version = expectedVersion ?? ((await c.get(`/api/admin/users/${id}/vip`)).body.version as number);
  return c.patch(`/api/admin/users/${id}/vip`, { ...body, reason: 'vip test', expectedVersion: version });
}
/** The same, expected to go through. */
async function makeVip(id: string, color?: string) {
  const r = await setVip(id, { enabled: true, ...(color ? { color } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { changed: boolean; vip: { color: string | null; version: number }; tables: number; reached: number };
}

const stored = async (id: string) =>
  (
    await d1<{ color: string | null; version: number; by: string | null; at: number | null; role: string; status: string; balance: number }>(
      `SELECT vip_color AS color, vip_version AS version, vip_changed_by AS by, vip_changed_at AS at, role, status, balance FROM users WHERE id = '${id}'`,
    )
  )[0]!;
const ledgerRows = async (id: string) => Number((await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM chip_ledger WHERE user_id = '${id}'`))[0]!.n);
type Row = { action: string; outcome: string; actor: string; target: string | null; detail: string | null };
const rows = (where: string) =>
  d1<Row>(`SELECT action, outcome, actor_id AS actor, target_id AS target, detail FROM admin_audit_log WHERE ${where} ORDER BY created_at, rowid`);
const adminId = async (c: Client = admin) => (await c.get('/api/admin/auth/me')).body.user.id as string;

describe('VIP management', () => {
  it('a super admin makes a member VIP (gold unless a color is chosen), recolors it and ends it: versioned, audited, nothing else changed', async () => {
    const m = await newUser();
    const before = await stored(m.me.id);
    expect(before).toMatchObject({ color: null, version: 0, by: null, role: 'user' });
    const ledger = await ledgerRows(m.me.id);
    expect((await admin.get(`/api/admin/users/${m.me.id}/vip`)).body).toMatchObject({ member: { id: m.me.id, role: 'user', isBot: false }, color: null, version: 0, changedBy: null, ineligible: null });

    // The confirmation step: what would change, written nowhere, no password needed yet.
    const preview = await admin.patch(`/api/admin/users/${m.me.id}/vip`, { enabled: true, expectedVersion: 0, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, from: null, to: 'gold', changed: true, version: 0, tables: 0 });
    expect((await stored(m.me.id)).version).toBe(0);

    const me = await adminId();
    const assigned = await makeVip(m.me.id);
    expect(assigned).toMatchObject({ changed: true, vip: { color: 'gold', version: 1, changedBy: { id: me } }, tables: 0, reached: 0 });
    expect((await m.client.get('/api/auth/me')).body).toMatchObject({ vip: 'gold', role: 'user', balance: before.balance });

    expect(await makeVip(m.me.id, 'sapphire')).toMatchObject({ changed: true, vip: { color: 'sapphire', version: 2 } });
    // "Enabled" without a color keeps the one there is: nothing to change, nothing raised, still answered (and recorded).
    expect(await makeVip(m.me.id)).toMatchObject({ changed: false, vip: { color: 'sapphire', version: 2 }, tables: 0, reached: 0 });

    // The console's list filters.
    const listed = async (vip: string) => ((await admin.get(`/api/admin/users?q=${m.me.nickname}&vip=${vip}`)).body as { id: string; vipColor: string | null }[]).map((u) => [u.id, u.vipColor]);
    expect(await listed('vip')).toEqual([[m.me.id, 'sapphire']]);
    expect(await listed('regular')).toEqual([]);

    const ended = await setVip(m.me.id, { enabled: false });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ changed: true, vip: { color: null, version: 3 } });
    const me2 = (await m.client.get('/api/auth/me')).body;
    expect('vip' in me2).toBe(false);
    expect(await listed('regular')).toEqual([[m.me.id, null]]);

    // Kept for the next change: when and by whom; the role, the wallet and the ledger never moved.
    const after = await stored(m.me.id);
    expect(after).toMatchObject({ color: null, version: 3, by: me, role: 'user', status: 'active', balance: before.balance });
    expect(after.at).toBeGreaterThan(0);
    expect(await ledgerRows(m.me.id)).toBe(ledger);

    const log = await rows(`action = 'user.vip' AND target_id = '${m.me.id}'`);
    expect(log.map((r) => [r.outcome, r.actor])).toEqual(Array(4).fill(['ok', me]));
    expect(log.map((r) => JSON.parse(r.detail!))).toEqual([
      { from: null, to: 'gold', reason: 'vip test', change: 'assign', version: 1 },
      { from: 'gold', to: 'sapphire', reason: 'vip test', change: 'color', version: 2 },
      { from: 'sapphire', to: 'sapphire', reason: 'vip test', changed: false, version: 2 },
      { from: 'sapphire', to: null, reason: 'vip test', change: 'remove', version: 3 },
    ]);
  });

  it('an administrator whose VIP switch is on gives and ends it; with the switch off, refused before the password and recorded', async () => {
    const m = await newUser();
    const granted = await withGrants(['members', 'vip']);
    // The password first, like every change.
    const noPassword = await granted.c.patch(`/api/admin/users/${m.me.id}/vip`, { enabled: true, reason: 'vip test', expectedVersion: 0 });
    expect(noPassword.status).toBe(401);
    expect(noPassword.body.error.code).toBe('reauth_required');
    const given = await setVip(m.me.id, { enabled: true, color: 'emerald' }, granted.c);
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    expect(given.body.vip).toMatchObject({ color: 'emerald', changedBy: { id: granted.me.id } });
    const ended = await setVip(m.me.id, { enabled: false }, granted.c);
    expect(ended.status).toBe(200);
    expect((await stored(m.me.id)).color).toBeNull();
    expect((await rows(`action = 'user.vip' AND actor_id = '${granted.me.id}'`)).map((r) => JSON.parse(r.detail!).change)).toEqual(['assign', 'remove']);

    // The members switch alone does not reach it: not the panel, not a change, not a preview.
    const off = await withGrants(['members']);
    for (const r of [
      await off.c.get(`/api/admin/users/${m.me.id}/vip`),
      await off.c.patch(`/api/admin/users/${m.me.id}/vip`, { enabled: true, reason: 'vip test', expectedVersion: 2 }),
      await off.c.patch(`/api/admin/users/${m.me.id}/vip`, { enabled: true, expectedVersion: 2, preview: true }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('permission_off');
    }
    expect((await stored(m.me.id)).color).toBeNull();
    const failed = await rows(`actor_id = '${off.me.id}' AND outcome = 'failed'`);
    expect(failed.map((r) => [r.action, r.target])).toEqual([
      ['user.vip_view.failed', m.me.id],
      ['user.vip.failed', m.me.id],
      ['user.vip.failed', m.me.id],
    ]);
    expect(JSON.parse(failed[1]!.detail!)).toMatchObject({ status: 403, code: 'permission_off', route: 'PATCH /users/:id/vip' });
    expect(failed[1]!.detail).not.toContain('vip test');
    expect(JSON.parse(failed[2]!.detail!)).toMatchObject({ preview: true });
  });

  it('a member can never change it: the console refuses their session, and their own profile does not take it', async () => {
    const m = await newUser();
    const atConsole = new Client(ADMIN_ORIGIN);
    atConsole.cookies = m.client.cookies;
    const body = { enabled: true, color: 'rose', reason: 'make me vip', expectedVersion: 0 };
    expect((await atConsole.patch(`/api/admin/users/${m.me.id}/vip`, body)).status).toBe(401);
    // From the player site the console's routes are closed whoever asks.
    expect((await m.client.patch(`/api/admin/users/${m.me.id}/vip`, body)).status).toBe(403);
    await m.client.patch('/api/auth/me', { vip: 'rose', vipColor: 'rose' });
    expect(await stored(m.me.id)).toMatchObject({ color: null, version: 0, role: 'user' });
    expect('vip' in (await m.client.get('/api/auth/me')).body).toBe(false);
    // Nor a seat's or a chat line's claim (below, the table reads only the server's).
  });

  it('refuses a color outside the palette and a request that does not say why or from which version', async () => {
    const m = await newUser();
    await reauth();
    for (const bad of [
      { enabled: true, color: 'red', reason: 'vip test', expectedVersion: 0 },
      { enabled: true, color: '#ff0000', reason: 'vip test', expectedVersion: 0 },
      { enabled: false, color: 'gold', reason: 'vip test', expectedVersion: 0 },
      { enabled: true, color: 'gold', expectedVersion: 0 },
      { enabled: true, color: 'gold', reason: 'x', expectedVersion: 0 },
      { enabled: true, color: 'gold', reason: 'vip test' },
      { enabled: 'yes', reason: 'vip test', expectedVersion: 0 },
      { enabled: true, reason: 'vip test', expectedVersion: 0, role: 'admin' },
    ]) {
      const r = await admin.patch(`/api/admin/users/${m.me.id}/vip`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await stored(m.me.id)).toMatchObject({ color: null, version: 0 });
    const failed = await rows(`target_id = '${m.me.id}' AND action = 'user.vip.failed'`);
    expect(failed).toHaveLength(8);
    expect(JSON.parse(failed[0]!.detail!)).toMatchObject({ status: 400, code: 'bad_request', route: 'PATCH /users/:id/vip' });
  });

  it('never makes a table bot, an administrator, a super admin or a deleted account VIP, and records each refusal', async () => {
    await reauth();
    // A table bot (an account marked as one for this test).
    const bot = await newUser();
    await d1(`UPDATE users SET is_bot = 1 WHERE id = '${bot.me.id}'`);
    try {
      expect((await admin.get(`/api/admin/users/${bot.me.id}/vip`)).body).toMatchObject({ ineligible: 'bot', member: { isBot: true } });
      const r = await setVip(bot.me.id, { enabled: true });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'bot_account', details: { vip: { color: null, ineligible: 'bot' } } });
    } finally {
      await d1(`UPDATE users SET is_bot = 0 WHERE id = '${bot.me.id}'`);
    }

    // Staff: a plain administrator, and the super admin (asked by an administrator with the switch, and by themself).
    const staff = await withGrants(['members', 'vip']);
    const plain = await setVip(staff.me.id, { enabled: true, color: 'rose' });
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe('vip_staff');
    const boss = await adminId();
    for (const c of [staff.c, admin]) {
      const r = await setVip(boss, { enabled: true }, c);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('vip_staff');
    }

    // A deleted account: a VIP member who leaves loses the color with the account, and it is not given back.
    const gone = await newUser();
    await makeVip(gone.me.id, 'amethyst');
    expect((await gone.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await stored(gone.me.id)).toMatchObject({ color: null, status: 'deleted' });
    expect((await admin.get(`/api/admin/users/${gone.me.id}/vip`)).body).toMatchObject({ color: null, ineligible: 'deleted' });
    const back = await setVip(gone.me.id, { enabled: true, color: 'amethyst' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('vip_deleted');

    for (const id of [bot.me.id, staff.me.id, boss, gone.me.id]) expect((await stored(id)).color).toBeNull();
    const refusals = await rows(`action = 'user.vip.failed' AND target_id IN ('${bot.me.id}', '${staff.me.id}', '${boss}', '${gone.me.id}')`);
    expect(refusals.map((r) => JSON.parse(r.detail!).code)).toEqual(['bot_account', 'vip_staff', 'vip_staff', 'vip_staff', 'vip_deleted']);
  });

  it('lets a color an account can no longer carry be ended (a member later marked as a bot)', async () => {
    const m = await newUser();
    await makeVip(m.me.id, 'cyan');
    await d1(`UPDATE users SET is_bot = 1 WHERE id = '${m.me.id}'`);
    try {
      expect((await setVip(m.me.id, { enabled: true, color: 'rose' })).body.error.code).toBe('bot_account');
      const ended = await setVip(m.me.id, { enabled: false });
      expect(ended.status, JSON.stringify(ended.body)).toBe(200);
      expect(ended.body.vip).toMatchObject({ color: null, ineligible: 'bot' });
    } finally {
      await d1(`UPDATE users SET is_bot = 0 WHERE id = '${m.me.id}'`);
    }
  });

  it('refuses a change made from a version another administrator has since changed, and answers with the state as it is now', async () => {
    const m = await newUser();
    const other = await withGrants(['members', 'vip']);
    await reauth(other.c);
    const opened = (await other.c.get(`/api/admin/users/${m.me.id}/vip`)).body.version as number;
    // The super admin saves first.
    await makeVip(m.me.id, 'gold');
    const late = await setVip(m.me.id, { enabled: true, color: 'rose' }, other.c, opened);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'vip_conflict', details: { vip: { color: 'gold', version: opened + 1 } } });
    expect((await setVip(m.me.id, { enabled: false }, other.c, opened)).body.error.code).toBe('vip_conflict');
    // The same request as the one that won is not a conflict: nothing to change.
    const same = await setVip(m.me.id, { enabled: true, color: 'gold' }, other.c, opened);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ changed: false, vip: { color: 'gold', version: opened + 1 } });
    // Reloaded, the change goes through.
    expect((await setVip(m.me.id, { enabled: true, color: 'rose' }, other.c)).body.vip).toMatchObject({ color: 'rose', version: opened + 2 });
    const failed = await rows(`actor_id = '${other.me.id}' AND action = 'user.vip.failed'`);
    expect(failed.map((r) => JSON.parse(r.detail!).code)).toEqual(['vip_conflict', 'vip_conflict']);
    expect(await stored(m.me.id)).toMatchObject({ color: 'rose', version: opened + 2 });
  });

  it('a suspension hides it from other players and keeps it; made staff, the member stops being VIP', async () => {
    const m = await newUser();
    const friend = await newUser();
    await makeVip(m.me.id, 'rose');
    expect((await friend.client.post('/api/friends/requests', { userId: m.me.id })).status).toBe(201);
    expect((await m.client.post(`/api/friends/${friend.me.id}/accept`)).status).toBe(200);
    const seen = async () => ((await friend.client.get('/api/friends')).body.friends as { id: string; vip?: string }[]).find((f) => f.id === m.me.id);
    expect((await seen())?.vip).toBe('rose');

    await reauth();
    expect((await admin.post(`/api/admin/users/${m.me.id}/suspend`, { reason: 'vip test hold' })).status).toBe(200);
    expect((await seen())?.vip).toBeUndefined();
    expect((await admin.get(`/api/admin/users/${m.me.id}/vip`)).body).toMatchObject({ color: 'rose' });
    expect((await admin.post(`/api/admin/users/${m.me.id}/unsuspend`, { reason: 'vip test done' })).status).toBe(200);
    expect((await seen())?.vip).toBe('rose');

    // Made an administrator: the console says the color ends, and it does (recorded as caused by the role).
    const preview = await admin.post(`/api/admin/users/${m.me.id}/role`, { role: 'admin', preview: true });
    expect(preview.body.vipCleared).toBe('rose');
    const version = (await stored(m.me.id)).version;
    expect((await admin.post(`/api/admin/users/${m.me.id}/role`, { role: 'admin', reason: 'vip test staff' })).status).toBe(200);
    expect(await stored(m.me.id)).toMatchObject({ color: null, version: version + 1, role: 'admin' });
    const last = (await rows(`action = 'user.vip' AND target_id = '${m.me.id}'`)).at(-1)!;
    expect(JSON.parse(last.detail!)).toMatchObject({ from: 'rose', to: null, cause: 'role', role: 'admin', version: version + 1 });
    // And back to member: no color comes back with the role.
    expect((await admin.post(`/api/admin/users/${m.me.id}/role`, { role: 'user', reason: 'vip test done' })).status).toBe(200);
    expect((await stored(m.me.id)).color).toBeNull();
    expect((await seen())?.vip).toBeUndefined();
  });

  it('every device of the member sees the change at its next request, without signing in again', async () => {
    const m = await newUser();
    const second = new Client();
    expect((await second.post('/api/auth/login', { email: m.email, password: PASSWORD })).status).toBe(200);
    await makeVip(m.me.id, 'amethyst');
    for (const c of [m.client, second]) expect((await c.get('/api/auth/me')).body.vip).toBe('amethyst');
    await makeVip(m.me.id, 'cyan');
    for (const c of [m.client, second]) expect((await c.get('/api/auth/me')).body.vip).toBe('cyan');
    expect((await setVip(m.me.id, { enabled: false })).status).toBe(200);
    for (const c of [m.client, second]) expect('vip' in (await c.get('/api/auth/me')).body).toBe(false);
  });

  it('gives a VIP member no console, no rights and no chips', async () => {
    const m = await newUser();
    const balance = (await stored(m.me.id)).balance;
    const ledger = await ledgerRows(m.me.id);
    await makeVip(m.me.id, 'gold');
    expect((await new Client(ADMIN_ORIGIN).post('/api/admin/auth/login', { email: m.email, password: PASSWORD })).status).not.toBe(200);
    const atConsole = new Client(ADMIN_ORIGIN);
    atConsole.cookies = m.client.cookies;
    expect((await atConsole.get('/api/admin/users')).status).toBe(401);
    expect(await stored(m.me.id)).toMatchObject({ role: 'user', balance, color: 'gold' });
    expect(await ledgerRows(m.me.id)).toBe(ledger);
    expect((await m.client.get('/api/auth/me')).body).toMatchObject({ role: 'user', balance, vip: 'gold' });
  });

  it('changes nothing about notifications: no push queued for giving or ending it, the settings as they were', async () => {
    const m = await newUser();
    const settings = (await m.client.get('/api/me/notifications/settings')).body;
    const queued = async () => Number((await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_events WHERE user_id = '${m.me.id}'`))[0]!.n);
    expect(await queued()).toBe(0);
    await makeVip(m.me.id, 'rose');
    await makeVip(m.me.id, 'cyan');
    expect((await setVip(m.me.id, { enabled: false })).status).toBe(200);
    expect(await queued()).toBe(0);
    expect((await m.client.get('/api/me/notifications/settings')).body).toEqual(settings);
  });
});

describe('what other players see', () => {
  const opened: string[] = [];
  afterAll(async () => {
    for (const id of opened) {
      await d1(`UPDATE tournaments SET winner_id = NULL WHERE id = '${id}'`);
      const t = (await admin.get(`/api/admin/tournaments/${id}`)).body.tournament as { status: string; version: number } | undefined;
      await reauth();
      if (t && (t.status === 'registering' || t.status === 'closed')) await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'vip test done' });
    }
  });

  it('friends, requests, blocks, messages, the board and the lobby carry the color, read with the name', async () => {
    const vip = await newUser();
    const member = await newUser();
    const other = await newUser();
    await makeVip(vip.me.id, 'rose');

    // A request each way round, then the friendship.
    expect((await member.client.post('/api/friends/requests', { userId: vip.me.id })).status).toBe(201);
    expect((await member.client.get('/api/friends')).body.outgoing[0]).toMatchObject({ id: vip.me.id, vip: 'rose' });
    const incoming = (await vip.client.get('/api/friends')).body.incoming[0];
    expect(incoming.id).toBe(member.me.id);
    expect('vip' in incoming).toBe(false);
    expect((await vip.client.post(`/api/friends/${member.me.id}/accept`)).status).toBe(200);
    expect((await member.client.get('/api/friends')).body.friends[0]).toMatchObject({ id: vip.me.id, vip: 'rose' });

    // The conversation header.
    expect((await member.client.get(`/api/dm/${vip.me.id}`)).body.user).toMatchObject({ id: vip.me.id, vip: 'rose' });
    expect('vip' in (await vip.client.get(`/api/dm/${member.me.id}`)).body.user).toBe(false);

    // The block list: a VIP member is a member, and can be blocked like one.
    expect((await other.client.req('PUT', `/api/blocks/${vip.me.id}`)).status).toBe(200);
    expect((await other.client.get('/api/blocks')).body).toEqual([expect.objectContaining({ id: vip.me.id, vip: 'rose' })]);

    // The board: a post, a comment and a reply.
    const post = await vip.client.post('/api/board/posts', { title: 'VIP 인사', body: '안녕하세요' });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const comment = await member.client.post(`/api/board/posts/${post.body.id}/comments`, { body: '반갑습니다' });
    expect(comment.status).toBe(201);
    expect((await vip.client.post(`/api/board/posts/${post.body.id}/comments`, { body: '감사합니다', parentId: comment.body.id })).status).toBe(201);
    const listed = (await member.client.get('/api/board/posts')).body.posts.find((p: { id: string }) => p.id === post.body.id);
    expect(listed.author).toMatchObject({ id: vip.me.id, vip: 'rose', isAdmin: false });
    expect('role' in listed.author).toBe(false);
    const detail = (await member.client.get(`/api/board/posts/${post.body.id}`)).body as { author: { vip?: string }; comments: { parentId: string | null; author: { id: string; vip?: string } }[] };
    expect(detail.author.vip).toBe('rose');
    expect(detail.comments.map((c) => [c.author.id, c.author.vip ?? null, c.parentId])).toEqual([
      [member.me.id, null, null],
      [vip.me.id, 'rose', comment.body.id],
    ]);

    // The lobby's host line, then the color ended: the plain name everywhere, from the next read.
    const room = await vip.client.post('/api/rooms', { name: 'VIP 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 });
    expect(room.status, JSON.stringify(room.body)).toBe(201);
    try {
      const host = async () => ((await member.client.get('/api/tables')).body as { id: string; host: { id: string; vip?: string } | null }[]).find((t) => t.id === room.body.id)!.host!;
      expect(await host()).toMatchObject({ id: vip.me.id, vip: 'rose' });
      expect((await setVip(vip.me.id, { enabled: false })).status).toBe(200);
      expect('vip' in (await host())).toBe(false);
      expect('vip' in (await member.client.get('/api/friends')).body.friends[0]).toBe(false);
      expect('vip' in (await member.client.get(`/api/dm/${vip.me.id}`)).body.user).toBe(false);
      expect('vip' in (await member.client.get(`/api/board/posts/${post.body.id}`)).body.author).toBe(false);
    } finally {
      expect((await vip.client.post(`/api/rooms/${room.body.id}/close`)).status).toBe(200);
    }
  });

  it('tournament players and the winner carry the color', async () => {
    const vip = await newUser();
    const member = await newUser();
    await makeVip(vip.me.id, 'sapphire');
    await reauth();
    const tpl = await admin.post('/api/admin/tournament-templates', {
      name: uniq('tpl'),
      capacity: 3,
      minPlayers: 2,
      startStack: 200,
      levels: [{ sb: 10, bb: 20 }],
      levelMinutes: 1,
      turnSeconds: 10,
      timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
      minHands: 0,
      requireVerified: false,
      autoStart: false,
      reason: 'vip test',
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const t = await admin.post('/api/admin/tournaments', { templateId: tpl.body.template.id, templateVersion: tpl.body.template.version, name: uniq('T') });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const id = t.body.tournament.id as string;
    opened.push(id);
    for (const u of [vip, member]) expect((await u.client.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ ok: true, started: false });

    const entries = (await member.client.get(`/api/tournaments/${id}`)).body.entries as { nickname: string; vip?: string; me?: boolean }[];
    expect(entries.find((e) => e.nickname === vip.me.nickname)).toMatchObject({ vip: 'sapphire' });
    expect('vip' in entries.find((e) => e.me)!).toBe(false);

    // The winner's line reads the color with the winner's name (the result is set in D1 here; playing one out is
    // tournaments.test.ts's work).
    await d1(`UPDATE tournaments SET winner_id = '${vip.me.id}' WHERE id = '${id}'`);
    expect((await member.client.get(`/api/tournaments/${id}`)).body).toMatchObject({ winner: vip.me.nickname, winnerVip: 'sapphire' });
    const listed = ((await member.client.get('/api/tournaments')).body.tournaments as { id: string; winnerVip?: string }[]).find((x) => x.id === id);
    expect(listed?.winnerVip).toBe('sapphire');
    await d1(`UPDATE tournaments SET winner_id = '${member.me.id}' WHERE id = '${id}'`);
    expect('winnerVip' in (await member.client.get(`/api/tournaments/${id}`)).body).toBe(false);
  });
});

async function socket(client: Parameters<typeof TableSocket.open>[0]) {
  const ws = await TableSocket.open(client, 'it-vip-0');
  open.push(ws);
  return ws;
}

const lastChat = new WeakMap<TableSocket, number>();
/** Sends a chat line from `from` and resolves with the line as `to` received it. A connection may chat once a second. */
async function chat(from: TableSocket, to: TableSocket, text: string, extra: Record<string, unknown> = {}) {
  const wait = (lastChat.get(from) ?? 0) + 1_100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastChat.set(from, Date.now());
  const got = to.waitNext((m) => m.t === 'chat' && m.message.text === text, 5_000, `chat ${text}`);
  const ack = await from.request({ t: 'chat', text, ...extra });
  expect(ack, JSON.stringify(ack)).toMatchObject({ t: 'ack' });
  return (got as Promise<Extract<ServerMessage, { t: 'chat' }>>).then((m) => m.message);
}

describe('at the table', () => {
  it('a change in the console reaches the seat and the chat at once, mid-hand, with no one disconnected and the hand played on', async () => {
    const a = await newUser();
    const b = await newUser();
    const watcher = await newUser();
    // Made VIP before sitting down: the seat has it from the start.
    await makeVip(b.me.id, 'emerald');

    const [wa, wb, ws] = [await socket(a.client), await socket(b.client), await socket(watcher.client)];
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    // A seat's own claim is not read.
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 1000, vip: 'gold' })).toMatchObject({ t: 'ack' });
    const seated = (s: TableView) => s.seats[0]!.state !== 'empty' && s.seats[1]!.state !== 'empty';
    for (const w of [wa, wb, ws]) {
      const v = await w.waitState(seated);
      expect('vip' in v.seats[0]!).toBe(false);
      expect(v.seats[1]!.vip).toBe('emerald');
    }
    expect('vip' in (await chat(wa, ws, 'plain line', { vip: 'gold' }))).toBe(false);
    expect((await chat(wb, ws, 'emerald line')).vip).toBe('emerald');

    // A hand under way: whoever acts first is thinking when the console saves.
    const hand = await wa.waitState((s) => s.hand?.stage === 'preflop' && s.hand.actorSeat !== null, 20_000, 'hand start');
    const handId = hand.hand!.id;
    const actor = isMyTurn(wa.state!) ? wa : wb;
    await actor.waitState((s) => isMyTurn(s) && s.hand?.id === handId);
    const deadline = actor.state!.hand!.deadline;
    const before = ws.state!.version;

    expect(await makeVip(a.me.id)).toMatchObject({ changed: true, vip: { color: 'gold' }, tables: 1, reached: 1 });
    for (const w of [wa, wb, ws]) expect((await w.waitState((s) => s.seats[0]!.vip === 'gold', 3_000, 'vip seat')).seats[0]!.vip).toBe('gold');
    expect(ws.state!.version).toBeGreaterThan(before);
    // The same hand, the same turn, the same clock.
    for (const w of [wa, wb, ws]) expect(w.state!.hand).toMatchObject({ id: handId, stage: 'preflop' });
    expect(actor.state!.hand!.deadline).toBe(deadline);
    expect(isMyTurn(actor.state!)).toBe(true);
    expect((await chat(wa, wb, 'gold line')).vip).toBe('gold');

    // Recolored, still mid-hand.
    expect(await makeVip(a.me.id, 'cyan')).toMatchObject({ tables: 1, reached: 1 });
    await ws.waitState((s) => s.seats[0]!.vip === 'cyan', 3_000, 'recolored');
    // Lines already sent keep the color they had.
    expect(ws.messages.find((m) => m.t === 'chat' && m.message.text === 'gold line')).toMatchObject({ message: { vip: 'gold' } });

    // The hand finishes as it would have.
    await actor.act('fold');
    await wb.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 15_000, 'settled');

    // Ended: the plain name at the seat and in new lines.
    expect((await setVip(a.me.id, { enabled: false })).body).toMatchObject({ changed: true, tables: 1, reached: 1 });
    const plain = await ws.waitState((s) => !('vip' in s.seats[0]!), 3_000, 'ended');
    expect(plain.seats[0]!.nickname).toBe(a.me.nickname);
    expect('vip' in (await chat(wa, wb, 'plain again'))).toBe(false);
    // Nobody was disconnected along the way.
    for (const w of [wa, wb, ws]) expect(w.closed).toBeNull();
    expect((await stored(a.me.id)).role).toBe('user');
  });
});
