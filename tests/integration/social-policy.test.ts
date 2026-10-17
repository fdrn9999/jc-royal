// Social policy (apps/api/src/routes/admin-social.ts) and brand status (routes/admin-brand.ts): who may change the
// policy and how (super admin, fresh password, reason, preview, conflicts, audit); a table refusing reactions when they
// are off and holding players to the new limits without anyone reconnecting; a hidden staff badge left out of seats,
// chat (lines already on screen too), the board, friends and replays while the role itself and the console stay as they
// are; and the brand check reading what this deployment serves to crawlers and installers.
import type { HandDetailDto, ServerMessage, TableView } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { ALL_GRANTS, promoteSql } from '../support/grants';
import { isMyTurn, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
/** The policy migration 0028 seeds (what the service did before), put back after this file. */
const SEED = { reactionsEnabled: true, cooldownMs: 2_000, burstMax: 5, burstWindowMs: 30_000, showSuperAdmin: true, showAdmin: true };
type Settings = typeof SEED;
type Policy = Settings & { version: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const policy = async () => (await admin.get('/api/admin/social')).body.policy as Policy;
const settingsOf = (p: Policy): Settings => ({ reactionsEnabled: p.reactionsEnabled, cooldownMs: p.cooldownMs, burstMax: p.burstMax, burstWindowMs: p.burstWindowMs, showSuperAdmin: p.showSuperAdmin, showAdmin: p.showAdmin });
async function putPolicy(change: Partial<Settings>, reason = 'social test') {
  await reauth();
  const p = await policy();
  const r = await admin.req('PUT', '/api/admin/social/policy', { baseVersion: p.version, ...settingsOf(p), ...change, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { policy: Policy; rooms: { tables: number; reached: number; unreached: string[]; more: boolean } };
}
async function restore() {
  const p = await policy();
  if (JSON.stringify(settingsOf(p)) !== JSON.stringify(SEED)) await putPolicy(SEED, 'social test done');
}
async function plainAdmin(grants: readonly string[] = ALL_GRANTS) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  return { ...u, admin: c };
}

const sockets: TableSocket[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  await restore();
});
async function socket(client: Parameters<typeof TableSocket.open>[0], tableId: string) {
  const ws = await TableSocket.open(client, tableId);
  sockets.push(ws);
  return ws;
}

describe('social policy', () => {
  it('only the super admin changes it, with a fresh password and a reason; previews, conflicts and unchanged policies are refused or change nothing, and all is audited', async () => {
    const plain = await plainAdmin();
    const view = await plain.admin.get('/api/admin/social');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ appliesFrom: 'next_request', limits: { cooldownMs: { min: 500, max: 30_000 } }, defaults: SEED, tables: { reloadMax: 100 } });
    const p = view.body.policy as Policy;
    expect(p.version).toBeGreaterThanOrEqual(1);
    const body = { baseVersion: p.version, ...settingsOf(p), cooldownMs: p.cooldownMs === 3_000 ? 4_000 : 3_000, reason: 'calmer tables' };
    await reauth(plain.admin);
    expect((await plain.admin.req('PUT', '/api/admin/social/policy', body)).status).toBe(403);
    // Without the tables switch, not even the page.
    const noTables = await plainAdmin(ALL_GRANTS.filter((g) => g !== 'tables'));
    expect((await noTables.admin.get('/api/admin/social')).body.error.code).toBe('permission_off');
    // A member, or no one signed in, reaches neither.
    const member = await newUser();
    for (const c of [member.client, new Client(ADMIN_ORIGIN)]) {
      expect((await c.get('/api/admin/social')).status).toBeGreaterThanOrEqual(401);
      expect((await c.req('PUT', '/api/admin/social/policy', body)).status).toBeGreaterThanOrEqual(401);
    }

    // The super admin: a session without a fresh password confirmation is asked for one, except for the preview.
    // (A second super admin, so the shared one's sign-in limit is left to admin.test.ts.)
    const boss = await newUser();
    await d1(`UPDATE users SET role = 'super_admin' WHERE id = '${boss.me.id}'`);
    const fresh = new Client(ADMIN_ORIGIN);
    expect((await fresh.post('/api/admin/auth/login', { email: boss.email, password: PASSWORD })).status).toBe(200);
    const pv = await fresh.req('PUT', '/api/admin/social/policy', { ...body, reason: undefined, preview: true });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ preview: true, from: { version: p.version }, to: { version: p.version + 1, cooldownMs: body.cooldownMs }, effects: { reactions: 'same', limits: true, badgesShown: [], badgesHidden: [] } });
    expect((await policy()).version).toBe(p.version);
    expect((await fresh.req('PUT', '/api/admin/social/policy', body)).body.error.code).toBe('reauth_required');

    try {
      await reauth();
      const put = (b: Record<string, unknown>) => admin.req('PUT', '/api/admin/social/policy', b);
      expect((await put({ ...body, reason: undefined })).status).toBe(400);
      expect((await put({ ...body, cooldownMs: 100 })).body.error.code).toBe('bad_request');
      expect((await put({ ...body, burstMax: 1.5 })).body.error.code).toBe('bad_request');
      expect((await put({ ...body, cooldownMs: p.cooldownMs })).body.error.code).toBe('social_no_change');
      const stale = await put({ ...body, baseVersion: p.version - 1 });
      expect([stale.status, stale.body.error.code, stale.body.error.details.policy.version]).toEqual([409, 'social_policy_conflict', p.version]);
      expect((await policy()).version).toBe(p.version);

      // Two administrators saving from the same version: one is saved, the other told it changed.
      const both = await Promise.all([put({ ...body, reason: 'first edit' }), put({ ...body, showAdmin: !p.showAdmin, reason: 'second edit' })]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const saved = both.find((r) => r.status === 200)!.body;
      expect(saved).toMatchObject({ ok: true, appliesFrom: 'next_request', policy: { version: p.version + 1 }, rooms: { tables: expect.any(Number), reached: expect.any(Number), more: false } });
      expect((await policy()).version).toBe(p.version + 1);

      const audits = await d1<{ action: string; outcome: string; actor_id: string; detail: string }>(
        `SELECT action, outcome, actor_id, detail FROM admin_audit_log WHERE action LIKE 'social.policy%' ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      );
      const ok = audits.find((r) => r.action === 'social.policy' && JSON.parse(r.detail).to?.version === p.version + 1)!;
      expect(ok.outcome).toBe('ok');
      expect(JSON.parse(ok.detail)).toMatchObject({ from: { version: p.version, cooldownMs: p.cooldownMs }, to: { version: p.version + 1 }, appliesFrom: 'next_request', effects: { limits: expect.any(Boolean) } });
      expect(['first edit', 'second edit']).toContain(JSON.parse(ok.detail).reason);
      const failed = audits.filter((r) => r.action === 'social.policy.failed');
      // (Asked for the password is not a failure: lib/audit.ts auditFailures leaves 401 out.)
      const codes = failed.map((r) => JSON.parse(r.detail).code);
      expect(codes).toEqual(expect.arrayContaining(['social_policy_conflict', 'social_no_change', 'bad_request', 'forbidden']));
      expect(codes).not.toContain('reauth_required');
      expect(JSON.parse(failed.find((r) => r.actor_id === plain.me.id)!.detail)).toMatchObject({ status: 403, code: 'forbidden', route: 'PUT /social/policy' });

      // Nothing here sets one member's badge: no such route.
      for (const [m, path] of [['PUT', `/api/admin/users/${plain.me.id}/badge`], ['POST', `/api/admin/social/members/${plain.me.id}`]] as const) {
        expect([403, 404]).toContain((await admin.req(m, path, { show: false, reason: 'hide them' })).status);
      }
    } finally {
      await restore();
    }
  }, 60_000);

  it('a table refuses reactions once they are off and holds players to new limits, without anyone reconnecting', async () => {
    try {
      const a = await newUser();
      const watcher = await newUser();
      const wa = await socket(a.client, 'it-social-0');
      const ww = await socket(watcher.client, 'it-social-0');
      expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
      expect((await ww.waitState((s) => s.seats[0]?.userId === a.me.id)).reactions).toEqual({ cooldownMs: 2_000, burstMax: 5, burstWindowMs: 30_000 });

      // Off: the open connections are told (the room reloads) and the table refuses the next one.
      const off = await putPolicy({ reactionsEnabled: false }, 'quiet tables');
      expect(off.rooms.unreached).not.toContain('it-social-0');
      for (const w of [wa, ww]) await w.waitState((s) => s.reactions === null, 5_000, 'reactions off');
      expect(await wa.request({ t: 'react', reaction: 'fire' })).toMatchObject({ t: 'error', code: 'reactions_off' });
      // The admin's view of the table says the same.
      const live = (await admin.get('/api/admin/tables/it-social-0')).body.live as { social: { policyVersion: number; reactions: boolean } };
      expect(live.social).toEqual({ policyVersion: off.policy.version, reactions: false });

      // On again with tighter limits: half a second apart, at most two in ten seconds.
      await putPolicy({ reactionsEnabled: true, cooldownMs: 500, burstMax: 2, burstWindowMs: 10_000 }, 'faster but fewer');
      await wa.waitState((s) => s.reactions?.cooldownMs === 500, 5_000, 'new limits');
      expect(wa.state!.reactions).toEqual({ cooldownMs: 500, burstMax: 2, burstWindowMs: 10_000 });
      expect(await wa.request({ t: 'react', reaction: 'clap' })).toMatchObject({ t: 'ack' });
      await sleep(900);
      expect(await wa.request({ t: 'react', reaction: 'clap' })).toMatchObject({ t: 'ack' });
      await sleep(900);
      // Past the cooldown, but the third inside the window.
      expect(await wa.request({ t: 'react', reaction: 'wow' })).toMatchObject({ t: 'error', code: 'rate_limited' });
      await sleep(300);
      expect(ww.messages.filter((m) => m.t === 'react')).toHaveLength(2);
    } finally {
      await restore();
    }
  }, 60_000);

  it('a hidden staff badge leaves seats, chat, the board, friends and replays, while the role and the console keep it; shown again, it is back', async () => {
    try {
      const staff = await newUser();
      const member = await newUser();
      const watcher = await newUser();
      await d1(promoteSql(`id = '${staff.me.id}'`));
      const post = await staff.client.post('/api/board/posts', { title: '운영 공지', body: '표시 정책 확인' });
      expect(post.status).toBe(201);
      expect((await member.client.post('/api/friends/requests', { userId: staff.me.id })).status).toBe(201);

      const [ws, wm, ww] = [await socket(staff.client, 'it-social-1'), await socket(member.client, 'it-social-1'), await socket(watcher.client, 'it-social-1')];
      expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
      expect(await wm.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
      const seated = (s: TableView) => s.seats[0]!.state !== 'empty' && s.seats[1]!.state !== 'empty';
      expect((await ww.waitState(seated)).seats[0]!.role).toBe('admin');
      const line = ww.waitNext((m) => m.t === 'chat' && m.message.text === 'staff here', 5_000, 'chat');
      expect(await ws.request({ t: 'chat', text: 'staff here' })).toMatchObject({ t: 'ack' });
      expect(((await line) as Extract<ServerMessage, { t: 'chat' }>).message.role).toBe('admin');

      // One hand for the history: whoever acts first folds.
      const hand = await ws.waitState((s) => s.hand?.stage === 'preflop' && s.hand.actorSeat !== null, 20_000, 'hand start');
      const handId = hand.hand!.id;
      const actor = isMyTurn(ws.state!) ? ws : wm;
      await actor.waitState((s) => isMyTurn(s) && s.hand?.id === handId);
      await actor.act('fold');
      await wm.waitState((s) => s.hand?.id === handId && s.hand.stage === 'settled', 15_000, 'settled');
      let detail: HandDetailDto | null = null;
      for (let i = 0; i < 50 && !detail; i++) {
        const r = await member.client.get(`/api/me/hands/${handId}`);
        if (r.status === 200) detail = r.body as HandDetailDto;
        else await sleep(200);
      }
      expect(detail!.players.find((p) => p.userId === staff.me.id)!.role).toBe('admin');

      // Hidden: the seat at once, the line already on screen sent again without it, and the next requests elsewhere.
      const history = ww.waitNext((m) => m.t === 'chatHistory' && m.messages.some((l) => l.text === 'staff here' && !l.role), 5_000, 'chat again');
      const hidden = await putPolicy({ showAdmin: false }, 'no staff badges');
      expect(hidden.rooms.unreached).not.toContain('it-social-1');
      for (const w of [ww, wm]) expect('role' in (await w.waitState((s) => !('role' in s.seats[0]!), 5_000, 'badge hidden')).seats[0]!).toBe(false);
      await history;
      const next = ww.waitNext((m) => m.t === 'chat' && m.message.text === 'still staff', 5_000, 'chat');
      await sleep(1_100);
      expect(await ws.request({ t: 'chat', text: 'still staff' })).toMatchObject({ t: 'ack' });
      expect('role' in ((await next) as Extract<ServerMessage, { t: 'chat' }>).message).toBe(false);
      const author = (await member.client.get(`/api/board/posts/${post.body.id}`)).body.author as { role?: string; isAdmin: boolean };
      expect(['role' in author, author.isAdmin]).toEqual([false, false]);
      expect('role' in (await member.client.get('/api/friends')).body.outgoing[0]).toBe(false);
      expect('role' in (await member.client.get(`/api/me/hands/${handId}`)).body.players.find((p: { userId: string }) => p.userId === staff.me.id)).toBe(false);
      // Nothing stored changed, and the console still shows the real role.
      expect((await d1<{ role: string }>(`SELECT role FROM users WHERE id = '${staff.me.id}'`))[0]!.role).toBe('admin');
      expect((await admin.get(`/api/admin/users/${staff.me.id}`)).body.user.role).toBe('admin');
      // A super admin's badge is a separate switch: still shown.
      expect((await policy()).showSuperAdmin).toBe(true);

      // Shown again: back on the seat and the board.
      await putPolicy({ showAdmin: true }, 'badges back');
      expect((await ww.waitState((s) => s.seats[0]!.role === 'admin', 5_000, 'badge back')).seats[0]!.role).toBe('admin');
      expect((await member.client.get(`/api/board/posts/${post.body.id}`)).body.author).toMatchObject({ role: 'admin', isAdmin: true });
    } finally {
      await restore();
    }
  }, 90_000);
});

describe('brand status', () => {
  it('checks the shareable pages, the image and the install details this deployment serves, a private table showing nothing of its own', async () => {
    // The newest private table, so the one sampled: named unlike its id (the seeded ones are named by theirs).
    const host = await newUser();
    const name = '브랜드 점검 비밀방';
    const room = await host.client.post('/api/rooms', { name, maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, isPrivate: true, joinCode: 'brand-secret' });
    expect(room.status, JSON.stringify(room.body)).toBe(201);
    const r = await admin.get('/api/admin/brand');
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const b = r.body;
    expect(b).toMatchObject({ assets: true, site: 'https://jc-royal.site', tools: [{ id: 'kakao' }, { id: 'facebook' }] });
    const failed = [...b.index.checks, ...b.image.checks, ...b.pwa.checks, ...b.pages.flatMap((p: { checks: unknown[] }) => p.checks)].filter((c: { status: string }) => c.status === 'fail');
    expect(failed).toEqual([]);
    expect(b.summary.fail).toBe(0);
    const kinds = b.pages.map((p: { kind: string }) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(['home', 'homeEn', 'register', 'table', 'privateTable']));
    expect(b.image).toMatchObject({ url: 'https://jc-royal.site/og-image.png', status: 200, contentType: 'image/png', width: 1200, height: 630, bytes: 1_054_620 });
    expect(b.pwa.manifest).toMatchObject({ name: expect.any(String), display: expect.any(String) });
    expect(b.pwa.checks.find((c: { id: string }) => c.id === 'serviceWorker')).toMatchObject({ status: 'info', value: false });

    // The private table sampled: the default preview only, never its name.
    const priv = b.pages.find((p: { kind: string }) => p.kind === 'privateTable');
    expect(priv.path).toBe(`/table/${room.body.id}`);
    expect(priv.checks.find((c: { id: string }) => c.id === 'private').status).toBe('ok');
    expect(JSON.stringify(priv)).not.toContain(name);
    expect((await host.client.post(`/api/rooms/${room.body.id}/close`)).status).toBe(200);
  });

  it('hands the console the preview image itself, to administrators with the maintenance switch only', async () => {
    const res = await fetch(`${BASE()}/api/admin/brand/og-image`, { headers: { Cookie: admin.cookieHeader() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.arrayBuffer()).byteLength).toBe(1_054_620);

    const withMaint = await plainAdmin(['maintenance']);
    expect((await withMaint.admin.get('/api/admin/brand')).status).toBe(200);
    const without = await plainAdmin(ALL_GRANTS.filter((g) => g !== 'maintenance'));
    expect((await without.admin.get('/api/admin/brand')).body.error.code).toBe('permission_off');
    expect((await without.admin.get('/api/admin/brand/og-image')).status).toBe(403);
    const member = await newUser();
    expect((await member.client.get('/api/admin/brand')).status).toBeGreaterThanOrEqual(401);
    expect((await fetch(`${BASE()}/api/admin/brand/og-image`)).status).toBeGreaterThanOrEqual(401);
  });
});
