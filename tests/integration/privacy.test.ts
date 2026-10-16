import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';

let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

/** One row of named counts, e.g. `SELECT (SELECT COUNT(*) …) AS dms, …`. */
const counts = async (sql: string) => (await d1<Record<string, number>>(sql))[0]!;

type User = Awaited<ReturnType<typeof newUser>>;
async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

describe('account deletion', () => {
  it('deletes 1:1 messages both ways, inbox, Academy records, hand notes and reset links; keeps ledger and reports', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'from a' });
    await b.client.post(`/api/dm/${a.me.id}`, { text: 'from b' });
    const fromA = (await b.client.get(`/api/dm/${a.me.id}`)).body.messages.find((m: { body: string }) => m.body === 'from a');
    // Reports in both directions: A as reporter and as the reported member.
    const post = (await b.client.post('/api/board/posts', { title: 'B post', body: 'spam' })).body;
    expect((await a.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).status).toBe(201);
    expect((await b.client.post('/api/reports', { targetType: 'dm', targetId: fromA.id, reason: 'abuse' })).status).toBe(201);
    const now = Date.now();
    const id = a.me.id;
    await d1(
      `INSERT INTO academy_progress (user_id, data, version, updated_at) VALUES ('${id}', '{}', 1, ${now});` +
        `INSERT INTO user_badges (user_id, badge, awarded_at) VALUES ('${id}', 'first-lesson', ${now});` +
        `INSERT INTO hand_notes (user_id, hand_id, ended_at, bookmarked, tags, memo, rev, created_at, updated_at) VALUES ('${id}', 'del-${id}', ${now}, 1, 1, 'memo', 1, ${now}, ${now});` +
        `INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES ('del-${id}', '${id}', ${now + 1_800_000}, ${now});`,
    );
    const state = () =>
      counts(
        `SELECT (SELECT COUNT(*) FROM direct_messages WHERE sender_id = '${id}' OR recipient_id = '${id}') AS dms, ` +
          ['messages', 'academy_progress', 'user_badges', 'hand_notes', 'password_resets', 'sessions', 'chip_ledger'].map((t) => `(SELECT COUNT(*) FROM ${t} WHERE user_id = '${id}') AS ${t}`).join(', ') +
          `, (SELECT COUNT(*) FROM friendships WHERE user_a = '${id}' OR user_b = '${id}') AS friendships` +
          `, (SELECT COUNT(*) FROM reports WHERE reporter_id = '${id}' OR target_user_id = '${id}') AS reports`,
      );
    const before = await state();
    expect(before).toMatchObject({ dms: 2, academy_progress: 1, user_badges: 1, hand_notes: 1, password_resets: 1, friendships: 1, reports: 2 });
    expect(before.messages).toBeGreaterThan(0); // the welcome message
    expect(before.sessions).toBeGreaterThan(0);
    expect(before.chip_ledger).toBeGreaterThan(0);

    expect((await a.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);

    // Gone: 1:1 messages both ways, inbox, Academy records, hand notes, reset links, sessions and friendships.
    // Kept under the member id: the ledger (chip integrity) and both reports, with the evidence copied at report time.
    expect(await state()).toEqual({ dms: 0, messages: 0, academy_progress: 0, user_badges: 0, hand_notes: 0, password_resets: 0, sessions: 0, friendships: 0, chip_ledger: before.chip_ledger, reports: 2 });
    const reported = (await admin.get(`/api/admin/reports?userId=${id}`)).body.items as { targetId: string; context: { body: string } }[];
    expect(reported.find((r) => r.targetId === fromA.id)?.context.body).toBe('from a');
    const [u] = await d1<{ email: string; birth_date: string | null; status: string }>(`SELECT email, birth_date, status FROM users WHERE id = '${id}'`);
    expect(u).toEqual({ email: `deleted-${a.me.id}@deleted.invalid`, birth_date: null, status: 'deleted' });
  });

  it('board shows a withdrawn author without the tombstone nickname, and drops reply mentions of them', async () => {
    const a = await newUser();
    const b = await newUser();
    const post = (await a.client.post('/api/board/posts', { title: 'Leaving soon', body: 'hello' })).body;
    const top = (await b.client.post(`/api/board/posts/${post.id}/comments`, { body: 'top' })).body;
    const mid = (await a.client.post(`/api/board/posts/${post.id}/comments`, { body: 'reply by a', parentId: top.id })).body;
    const last = (await b.client.post(`/api/board/posts/${post.id}/comments`, { body: 'reply to a', parentId: mid.id })).body;
    const before = (await b.client.get(`/api/board/posts/${post.id}`)).body;
    expect(before.comments.find((x: { id: string }) => x.id === last.id).replyTo).toBe(a.me.nickname);

    expect((await a.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);

    const after = (await b.client.get(`/api/board/posts/${post.id}`)).body;
    const withdrawn = { id: a.me.id, nickname: '', avatarUrl: null, isAdmin: false, withdrawn: true };
    expect(after.author).toEqual(withdrawn);
    expect(after.comments.find((x: { id: string }) => x.id === mid.id)).toMatchObject({ author: withdrawn, body: 'reply by a' });
    expect(after.comments.find((x: { id: string }) => x.id === last.id).replyTo).toBeNull();
    expect(after.comments.find((x: { id: string }) => x.id === top.id).author).toMatchObject({ id: b.me.id, nickname: b.me.nickname });
    const listed = (await b.client.get('/api/board/posts')).body.posts.find((p: { id: string }) => p.id === post.id);
    expect(listed.author).toEqual(withdrawn);
    expect(JSON.stringify(after)).not.toContain('deleted-');
  });
});

describe('operator access is recorded', () => {
  it('member list, member detail and report list each leave an audit row', async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    await a.client.post(`/api/dm/${b.me.id}`, { text: 'rude' });
    const msg = (await b.client.get(`/api/dm/${a.me.id}`)).body.messages[0];
    const rep = (await b.client.post('/api/reports', { targetType: 'dm', targetId: msg.id, reason: 'abuse' })).body;

    expect((await admin.get(`/api/admin/users?q=${encodeURIComponent(a.email)}`)).body).toHaveLength(1);
    expect((await admin.get(`/api/admin/users/${a.me.id}`)).status).toBe(200);
    expect((await admin.get(`/api/admin/reports?userId=${a.me.id}`)).body.items).toHaveLength(1);

    const log = (await admin.get('/api/admin/audit?limit=10')).body as { action: string; targetId: string | null; detail: Record<string, unknown> }[];
    expect(log.find((x) => x.action === 'user.list')?.detail).toMatchObject({ q: a.email, count: 1 });
    expect(log.find((x) => x.action === 'user.view')?.targetId).toBe(a.me.id);
    expect(log.find((x) => x.action === 'report.view')?.detail).toMatchObject({ userId: a.me.id, count: 1, dm: [rep.id] });
    // Members cannot reach any of it.
    for (const p of ['/api/admin/users', `/api/admin/users/${a.me.id}`, '/api/admin/reports', '/api/admin/audit']) {
      expect((await a.client.get(p)).status, p).toBeGreaterThanOrEqual(401);
    }
  });
});

describe('daily clean-up (cron)', () => {
  it('deletes rows expired for more than a day and leaves live or recently expired ones', async () => {
    const u = await newUser();
    const now = Date.now();
    const day = 86_400_000;
    const old = now - 3 * day;
    const id = u.me.id;
    await d1(
      `INSERT INTO sessions (id, user_id, token_hash, kind, created_at, last_seen_at, expires_at) VALUES ('hk-s-old-${id}', '${id}', 'hk-s-old-${id}', 'user', ${old}, ${old}, ${old}), ('hk-s-recent-${id}', '${id}', 'hk-s-recent-${id}', 'user', ${now - day}, ${now - day}, ${now - 3_600_000});` +
        `INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES ('hk-r-old-${id}', '${id}', ${old}, ${old}), ('hk-r-new-${id}', '${id}', ${now + 1_800_000}, ${now});` +
        `INSERT INTO email_verifications (email, code_hash, attempts, expires_at, created_at) VALUES ('hk-old-${id}@test.dev', 'x', 0, ${old}, ${old}), ('hk-new-${id}@test.dev', 'x', 0, ${now + 600_000}, ${now});` +
        `INSERT INTO rate_limits (key, window_start, count) VALUES ('hk-old:${id}', ${old}, 1), ('hk-new:${id}', ${now - 600_000}, 1);`,
    );
    const left = async () =>
      (
        await d1<{ id: string }>(
          `SELECT id FROM sessions WHERE id LIKE 'hk-s-%-${id}' UNION ALL SELECT token_hash FROM password_resets WHERE token_hash LIKE 'hk-r-%-${id}' ` +
            `UNION ALL SELECT email FROM email_verifications WHERE email LIKE 'hk-%-${id}@test.dev' UNION ALL SELECT key FROM rate_limits WHERE key LIKE 'hk-%:${id}'`,
        )
      )
        .map((r) => r.id)
        .sort();
    expect(await left()).toHaveLength(8);

    // Local wrangler dev runs cron handlers only on request; this is the primary (API) worker's scheduled handler.
    const res = await fetch(`${BASE()}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('30 18 * * *')}`);
    expect(res.status, await res.text()).toBe(200);

    expect(await left()).toEqual([`hk-new-${id}@test.dev`, `hk-new:${id}`, `hk-r-new-${id}`, `hk-s-recent-${id}`].sort());
    // The member's own live session is untouched.
    expect((await u.client.get('/api/auth/me')).status).toBe(200);
  });
});
