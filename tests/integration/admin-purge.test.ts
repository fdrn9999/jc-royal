// Permanent removal (영구 삭제; apps/api/src/lib/purge.ts, docs/ADMIN_SECURITY.md): who may, what it asks for, what it
// removes and keeps, what stops it, a target that changed or went meanwhile, two at once, a batch that fails part way,
// the audit row, and the ordinary delete beside it. Against the local test database only (tests/support/d1.ts).
import { createHash } from 'node:crypto';
import type { TournamentStructure, TournamentTemplateDto } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
type Kind = 'post' | 'table' | 'tournament_template';
const PATH: Record<Kind, string> = { post: 'board/posts', table: 'tables', tournament_template: 'tournament-templates' };
const purgePath = (kind: Kind, id: string) => `/api/admin/${PATH[kind]}/${id}/purge`;
const code = (r: { body: any }) => r.body?.error?.code as string | undefined;

/** Two players at 10/20, as the tournament tests open them; nothing here starts one. */
const STRUCTURE: TournamentStructure = {
  name: 'purge',
  capacity: 2,
  minPlayers: 2,
  startStack: 200,
  levels: [{ sb: 10, bb: 20 }],
  levelMinutes: 1,
  turnSeconds: 10,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: false,
};

const opened: { id: string }[] = [];
afterAll(async () => {
  // A tournament opened to block a template is cancelled, so the suite's next run does not find it waiting.
  for (const { id } of opened) {
    const t = (await admin.get(`/api/admin/tournaments/${id}`)).body?.tournament;
    if (!t || (t.status !== 'registering' && t.status !== 'closed')) continue;
    await reauth();
    await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'purge test done' });
  }
});

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

/** A new member made a super admin (or a plain administrator) in D1, signed in to the console. */
async function staff(role: 'super_admin' | 'admin') {
  const u = await newUser();
  await d1(role === 'admin' ? promoteSql(`id = '${u.me.id}'`) : `UPDATE users SET role = 'super_admin' WHERE id = '${u.me.id}'`);
  return { ...u, c: await signIn(u.email) };
}

/** A member's post with `comments` comments under it. */
async function post(comments = 0) {
  const author = await newUser();
  const title = uniq('영구 삭제 글');
  const body = `본문 ${uniq('secret')}`;
  const r = await author.client.post('/api/board/posts', { title, body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as string;
  for (let i = 0; i < comments; i++) expect((await author.client.post(`/api/board/posts/${id}/comments`, { body: `댓글 ${i}` })).status).toBe(201);
  return { author, id, title, body };
}

async function table() {
  const r = await admin.post('/api/admin/tables', { name: uniq('영구 삭제 테이블').slice(0, 20), maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function closeTable(id: string) {
  await reauth();
  const r = await admin.post(`/api/admin/tables/${id}/close`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function template(archived: boolean): Promise<TournamentTemplateDto> {
  await reauth();
  const r = await admin.post('/api/admin/tournament-templates', { ...STRUCTURE, name: uniq('purge tpl'), reason: 'purge test' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  let tpl = r.body.template as TournamentTemplateDto;
  if (archived) {
    const a = await admin.post(`/api/admin/tournament-templates/${tpl.id}/status`, { status: 'archived', baseVersion: tpl.version, reason: 'purge test' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    tpl = a.body.template;
  }
  return tpl;
}

async function preview(kind: Kind, id: string, c: Client = admin) {
  const r = await c.post(purgePath(kind, id), { preview: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { deletable: boolean; blockers: { code: string; count: number }[]; removes: Record<string, number>; keeps: Record<string, number>; fingerprint: string; confirmText: string; label: string };
}

const purge = (kind: Kind, id: string, plan: { fingerprint: string; confirmText: string }, c: Client = admin, over: Record<string, unknown> = {}) =>
  c.post(purgePath(kind, id), { reason: '테스트 정리', confirm: plan.confirmText, fingerprint: plan.fingerprint, ...over });

const n = async (sql: string) => (await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`))[0]!.n;
type Row = { action: string; outcome: string; actor: string; detail: string | null };
const audits = (targetId: string) => d1<Row>(`SELECT action, outcome, actor_id AS actor, detail FROM admin_audit_log WHERE target_id = '${targetId}' ORDER BY created_at, rowid`);

describe('permanent removal', () => {
  it('a super admin removes a post with its comments; closed reports and the audit log stay, and the audit row keeps no text', async () => {
    const p = await post(2);
    const reporter = await newUser();
    const rep = await reporter.client.post('/api/reports', { targetType: 'post', targetId: p.id, reason: 'spam' });
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    await d1(`UPDATE reports SET status = 'dismissed' WHERE target_type = 'post' AND target_id = '${p.id}'`);
    await reauth();
    const plan = await preview('post', p.id);
    expect(plan).toMatchObject({ deletable: true, blockers: [], removes: { comments: 2, post_hands: 0, posts: 1 }, keeps: { reports: 1 }, confirmText: p.id.slice(0, 8), label: p.title });
    // The preview writes nothing.
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);

    const r = await purge('post', p.id, plan);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, removed: { comments: 2, posts: 1 } });
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(0);
    expect(await n(`comments WHERE post_id = '${p.id}'`)).toBe(0);
    expect(await n(`reports WHERE target_id = '${p.id}'`)).toBe(1);

    const done = (await audits(p.id)).filter((a) => a.action === 'board.post.purge');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outcome: 'ok', actor: (await admin.get('/api/admin/auth/me')).body.user.id });
    const detail = JSON.parse(done[0]!.detail!);
    expect(detail).toMatchObject({ reason: '테스트 정리', class: 'B', removed: { comments: 2, posts: 1 }, kept: { reports: 1 }, approval: { mode: 'single', role: 'super_admin', reauth: true }, titleLength: p.title.length, bodyLength: p.body.length, isNotice: false });
    // The SHA-256 of the title and body (base64url, as lib/crypto.ts), to match a post against without keeping it.
    expect(detail.contentHash).toBe(createHash('sha256').update(`${p.title}\n${p.body}`).digest('base64url'));
    expect(detail.authorId).toBe(p.author.me.id);
    // Neither the title nor the body is copied into the record.
    expect(done[0]!.detail).not.toContain(p.title);
    expect(done[0]!.detail).not.toContain(p.body);

    // Afterwards: gone from the site and from the console.
    expect((await p.author.client.get(`/api/board/posts/${p.id}`)).status).toBe(404);
    expect((await admin.post(purgePath('post', p.id), { preview: true })).status).toBe(404);
    const listed = (await admin.get(`/api/admin/board/posts?q=${encodeURIComponent(p.title)}`)).body;
    expect(JSON.stringify(listed)).not.toContain(p.id);
  });

  it('removes a closed table nobody sat at and an archived template nothing was opened from', async () => {
    const id = await table();
    await closeTable(id);
    const plan = await preview('table', id);
    expect(plan).toMatchObject({ deletable: true, blockers: [], removes: { tables: 1 } });
    const r = await purge('table', id, plan);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await n(`tables WHERE id = '${id}'`)).toBe(0);
    expect((await admin.get(`/api/admin/tables/${id}`)).status).toBe(404);
    expect((await audits(id)).map((a) => `${a.action} ${a.outcome}`)).toEqual(['table.create ok', 'table.close ok', 'table.purge ok']);

    const tpl = await template(true);
    const tplPlan = await preview('tournament_template', tpl.id);
    expect(tplPlan).toMatchObject({ deletable: true, removes: { tournament_templates: 1 } });
    expect((await purge('tournament_template', tpl.id, tplPlan)).status).toBe(200);
    expect(await n(`tournament_templates WHERE id = '${tpl.id}'`)).toBe(0);
    expect(JSON.stringify((await admin.get('/api/admin/tournament-templates?status=archived&limit=100')).body)).not.toContain(tpl.id);
  });

  it('refuses a plain administrator, and an administrator demoted after the preview', async () => {
    const p = await post(1);
    const plain = await staff('admin');
    await reauth(plain.c);
    const pv = await plain.c.post(purgePath('post', p.id), { preview: true });
    expect(pv.status).toBe(403);
    expect(pv.body.error.message).toBe('super admin only');
    expect((await plain.c.post(purgePath('post', p.id), { reason: '테스트 정리', confirm: p.id.slice(0, 8), fingerprint: 'x' })).status).toBe(403);
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);
    expect((await audits(p.id)).filter((a) => a.actor === plain.me.id).map((a) => `${a.action} ${a.outcome}`)).toEqual(['board.post.purge.failed failed', 'board.post.purge.failed failed']);

    // The role is read again on each request: a preview made as a super admin does not carry over.
    const boss = await staff('super_admin');
    await reauth(boss.c);
    const plan = await preview('post', p.id, boss.c);
    await d1(promoteSql(`id = '${boss.me.id}'`));
    const r = await purge('post', p.id, plan, boss.c);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('super admin only');
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);
    expect(await n(`comments WHERE post_id = '${p.id}'`)).toBe(1);
  });

  it('asks for the password again, and refuses a wrong password, a wrong confirmation and no reason', async () => {
    const p = await post();
    const boss = await staff('super_admin');
    // The preview does not need the password; the removal does.
    const plan = await preview('post', p.id, boss.c);
    const r = await purge('post', p.id, plan, boss.c);
    expect(r.status).toBe(401);
    expect(code(r)).toBe('reauth_required');
    expect((await boss.c.post('/api/admin/auth/reauth', { password: 'not-the-password' })).status).not.toBe(200);
    expect(code(await purge('post', p.id, plan, boss.c))).toBe('reauth_required');
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);

    await reauth(boss.c);
    const typo = await purge('post', p.id, plan, boss.c, { confirm: 'zzzzzzzz' });
    expect(typo.status).toBe(400);
    expect(code(typo)).toBe('purge_confirm');
    expect((await purge('post', p.id, plan, boss.c, { reason: ' ' })).status).toBe(400);
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);
    expect((await audits(p.id)).filter((a) => a.action === 'board.post.purge')).toEqual([]);
  });

  it('shows the plan again when the target changed since the preview, and removes nothing', async () => {
    const p = await post(1);
    await reauth();
    const plan = await preview('post', p.id);
    expect((await p.author.client.post(`/api/board/posts/${p.id}/comments`, { body: '미리보기 뒤의 댓글' })).status).toBe(201);
    const r = await purge('post', p.id, plan);
    expect(r.status).toBe(409);
    expect(code(r)).toBe('purge_changed');
    expect(r.body.error.details.plan).toMatchObject({ removes: { comments: 2 } });
    expect(r.body.error.details.plan.fingerprint).not.toBe(plan.fingerprint);
    expect(await n(`comments WHERE post_id = '${p.id}'`)).toBe(2);
    // Sent again on what is now shown, it goes, with the new comment.
    const again = await purge('post', p.id, r.body.error.details.plan);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.removed).toMatchObject({ comments: 2 });
  });

  it('names what keeps a record and removes nothing: an open report, a table still open, a table with sessions, a template in use', async () => {
    await reauth();
    const p = await post();
    const reporter = await newUser();
    expect((await reporter.client.post('/api/reports', { targetType: 'post', targetId: p.id, reason: 'spam' })).status).toBe(201);
    const plan = await preview('post', p.id);
    expect(plan).toMatchObject({ deletable: false, blockers: [{ code: 'open_reports', count: 1 }] });
    const r = await purge('post', p.id, plan);
    expect(r.status).toBe(409);
    expect(code(r)).toBe('purge_blocked');
    expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);

    // A table still open (in play or waiting for players) is not offered.
    const live = await table();
    const livePlan = await preview('table', live);
    expect(livePlan.blockers).toContainEqual({ code: 'not_closed', count: 1 });
    expect(code(await purge('table', live, livePlan))).toBe('purge_blocked');
    await closeTable(live);

    // A closed table someone sat at: their session (a foreign key to the table) keeps it.
    const used = await table();
    await closeTable(used);
    const sat = await newUser();
    await d1(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, cash_out, status, created_at, closed_at) VALUES ('${uniq('ps')}', '${used}', '${sat.me.id}', 0, 200, 200, 'closed', ${Date.now()}, ${Date.now()})`);
    const usedPlan = await preview('table', used);
    expect(usedPlan).toMatchObject({ deletable: false, blockers: [{ code: 'sessions', count: 1 }] });
    expect(code(await purge('table', used, usedPlan))).toBe('purge_blocked');
    expect(await n(`tables WHERE id = '${used}'`)).toBe(1);

    // A template still in use, then one a tournament was opened from.
    const active = await template(false);
    expect((await preview('tournament_template', active.id)).blockers).toEqual([{ code: 'not_archived', count: 1 }]);
    const t = await admin.post('/api/admin/tournaments', { templateId: active.id, templateVersion: active.version, name: uniq('T') });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    opened.push({ id: t.body.tournament.id });
    const a = await admin.post(`/api/admin/tournament-templates/${active.id}/status`, { status: 'archived', baseVersion: active.version, reason: 'purge test' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const tplPlan = await preview('tournament_template', active.id);
    expect(tplPlan).toMatchObject({ deletable: false, blockers: [{ code: 'tournaments', count: 1 }] });
    expect(code(await purge('tournament_template', active.id, tplPlan))).toBe('purge_blocked');
    expect(await n(`tournament_templates WHERE id = '${active.id}'`)).toBe(1);
  });

  it('two removals at once remove it once, and a later one finds nothing', async () => {
    const p = await post(1);
    await reauth();
    const plan = await preview('post', p.id);
    const rs = await Promise.all([purge('post', p.id, plan), purge('post', p.id, plan)]);
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    // The second read the post before the first removed it (the guard found it gone), or after (not found).
    expect([404, 409]).toContain(statuses[1]);
    expect((await audits(p.id)).filter((a) => a.action === 'board.post.purge')).toHaveLength(1);
    const later = await purge('post', p.id, plan);
    expect(later.status).toBe(404);
    expect((await audits(p.id)).filter((a) => a.action === 'board.post.purge')).toHaveLength(1);
  });

  it('a removal that fails part way leaves everything as it was', async () => {
    const p = await post(2);
    await reauth();
    const plan = await preview('post', p.id);
    // The post's own DELETE fails after its comments' (a trigger only this test makes, on the local database).
    const trigger = `purge_test_${p.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    await d1(`CREATE TRIGGER ${trigger} BEFORE DELETE ON posts WHEN OLD.id = '${p.id}' BEGIN SELECT RAISE(ABORT, 'purge test'); END`);
    try {
      const r = await purge('post', p.id, plan);
      expect(r.status).toBe(500);
      expect(code(r)).toBe('purge_failed');
      expect(await n(`posts WHERE id = '${p.id}'`)).toBe(1);
      expect(await n(`comments WHERE post_id = '${p.id}'`)).toBe(2);
      const rows = await audits(p.id);
      expect(rows.filter((a) => a.action === 'board.post.purge')).toEqual([]);
      expect(rows.filter((a) => a.action === 'board.post.purge.failed').map((a) => JSON.parse(a.detail!))).toEqual([expect.objectContaining({ status: 500, code: 'purge_failed' })]);
    } finally {
      await d1(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    expect((await purge('post', p.id, plan)).status).toBe(200);
  });

  it('keeps the ordinary delete as it was, and offers no removal of the audit log, the ledger or members', async () => {
    const p = await post(1);
    // The ordinary delete marks it deleted; it stays and comes back.
    expect((await admin.post(`/api/admin/board/posts/${p.id}/status`, { status: 'deleted' })).status).toBe(200);
    expect(await d1(`SELECT status FROM posts WHERE id = '${p.id}'`)).toEqual([{ status: 'deleted' }]);
    expect(await n(`comments WHERE post_id = '${p.id}'`)).toBe(1);
    expect((await admin.post(`/api/admin/board/posts/${p.id}/status`, { status: 'visible' })).status).toBe(200);
    expect(await d1(`SELECT status FROM posts WHERE id = '${p.id}'`)).toEqual([{ status: 'visible' }]);
    // A deleted post can be removed for good afterwards, as a step of its own.
    expect((await admin.post(`/api/admin/board/posts/${p.id}/status`, { status: 'deleted' })).status).toBe(200);
    await reauth();
    expect((await preview('post', p.id)).deletable).toBe(true);

    const [logged] = await d1<{ id: string }>(`SELECT id FROM admin_audit_log WHERE target_id = '${p.id}' LIMIT 1`);
    const member = await newUser();
    for (const path of [`/api/admin/audit/${logged!.id}/purge`, `/api/admin/ledger/${member.me.id}/purge`, `/api/admin/users/${member.me.id}/purge`]) {
      const r = await admin.post(path, { reason: '테스트 정리', confirm: 'x', fingerprint: 'x' });
      expect([403, 404], `${path}: ${r.status}`).toContain(r.status);
    }
    expect(await n(`admin_audit_log WHERE id = '${logged!.id}'`)).toBe(1);
    expect(await n(`users WHERE id = '${member.me.id}'`)).toBe(1);
  });
});
