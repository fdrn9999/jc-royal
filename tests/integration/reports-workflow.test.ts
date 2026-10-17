// Report handling: severity, the person handling it, internal notes and the record of every change, telling the
// members involved how it ended, the queue's filters and statistics, members reported again and again, and the link
// between a report and the suspension it led to.
import { describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
/** The bootstrapped super admin. */
const admin = sharedAdmin();

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** A second, plain admin signed in to the console. */
let second: Promise<{ c: Client; id: string }> | null = null;
function plainAdmin() {
  second ??= (async () => {
    const u = await newUser();
    await d1(promoteSql(`id = '${u.me.id}'`));
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return { c, id: u.me.id };
  })();
  return second;
}

type User = Awaited<ReturnType<typeof newUser>>;
/** `author` writes a post; each reporter reports it. Returns the post id and the report ids, in order. */
async function reportedPost(author: User, reporters: User[], reason = 'spam') {
  const post = (await author.client.post('/api/board/posts', { title: `Reported ${Date.now()}`, body: 'buy chips here' })).body as { id: string };
  const ids: string[] = [];
  for (const r of reporters) {
    const res = await r.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ids.push(res.body.id as string);
  }
  return { postId: post.id, ids };
}
const one = async (id: string, userId: string) => ((await admin.get(`/api/admin/reports?status=all&userId=${userId}&limit=100`)).body.items as { id: string }[]).find((r) => r.id === id) as Record<string, any>;
const events = async (id: string, c: Client = admin) => (await c.get(`/api/admin/reports/${id}/events`)).body.items as { kind: string; from: string | null; to: string | null; body: string | null; actor: { id: string } }[];
const audits = (action: string, targetId: string) =>
  d1<{ detail: string | null; actor: string }>(`SELECT detail, actor_id AS actor FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}' ORDER BY created_at, rowid`);

describe('working a report', () => {
  it('severity, the person handling it, notes and every change are recorded; two admins cannot both take it', async () => {
    const author = await newUser();
    const reporter = await newUser();
    const { ids } = await reportedPost(author, [reporter]);
    const id = ids[0]!;
    const other = await plainAdmin();
    const me = (await admin.get('/api/admin/auth/me')).body.user.id as string;

    // New reports have no severity and nobody on them.
    expect(await one(id, author.me.id)).toMatchObject({ severity: null, assignee: null, assignedAt: null, notice: null });

    // Severity: only the four levels; set, changed and cleared, each change recorded with what it was before.
    expect((await admin.patch(`/api/admin/reports/${id}`, { severity: 'urgent' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/reports/${id}`, {})).status).toBe(400);
    expect((await admin.patch(`/api/admin/reports/${id}`, { severity: 'high' })).body).toEqual({ ok: true, changed: true });
    expect((await admin.patch(`/api/admin/reports/${id}`, { severity: 'high' })).body).toEqual({ ok: true, changed: false });
    expect((await admin.patch(`/api/admin/reports/${id}`, { severity: 'critical' })).status).toBe(200);
    expect((await one(id, author.me.id)).severity).toBe('critical');

    // Taking it: two admins at once, exactly one gets it; the other is told someone else has it.
    const both = await Promise.all([admin.patch(`/api/admin/reports/${id}`, { take: true }), other.c.patch(`/api/admin/reports/${id}`, { take: true })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.body.error.code).toBe('report_taken');
    const winner = both[0]!.status === 200 ? me : other.id;
    const taken = await one(id, author.me.id);
    expect(taken.assignee.id).toBe(winner);
    expect(taken.assignedAt).toEqual(expect.any(Number));

    // Assigning to a member who is not an administrator is refused; handing it over and letting it go are recorded.
    expect((await admin.patch(`/api/admin/reports/${id}`, { assigneeId: reporter.me.id })).body.error.code).toBe('bad_request');
    const handTo = winner === me ? other.id : me;
    expect((await admin.patch(`/api/admin/reports/${id}`, { assigneeId: handTo })).body.changed).toBe(true);
    expect((await admin.patch(`/api/admin/reports/${id}`, { assigneeId: null })).body.changed).toBe(true);
    expect((await one(id, author.me.id)).assignee).toBeNull();

    // The assignee list offers administrators only.
    const staff = (await admin.get('/api/admin/reports/assignees')).body.items as { id: string; role: string }[];
    expect(staff.map((s) => s.id)).toEqual(expect.arrayContaining([me, other.id]));
    expect(staff.every((s) => s.role === 'admin' || s.role === 'super_admin')).toBe(true);
    expect(staff.some((s) => s.id === reporter.me.id)).toBe(false);
    // Members have no access to any of it.
    expect((await reporter.client.get('/api/admin/reports/assignees')).status).toBe(403);
    expect((await reporter.client.patch(`/api/admin/reports/${id}`, { severity: 'low' })).status).toBe(403);

    // Internal notes: no personal data; kept with the report, written by either admin.
    expect((await admin.post(`/api/admin/reports/${id}/notes`, { body: 'x' })).status).toBe(400);
    expect((await admin.post(`/api/admin/reports/${id}/notes`, { body: '연락처 010-1234-5678' })).body.error.code).toBe('note_pii');
    expect((await admin.post(`/api/admin/reports/${id}/notes`, { body: 'checked the post history: three ads this week' })).status).toBe(201);
    expect((await other.c.post(`/api/admin/reports/${id}/notes`, { body: 'agree, ad spam' })).status).toBe(201);

    // Every change in order, with before and after; the audit log has one row per change (notes without their text).
    const log = await events(id, other.c);
    expect(log.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['severity', null, 'high'],
      ['severity', 'high', 'critical'],
      ['assign', null, winner],
      ['assign', winner, handTo],
      ['assign', handTo, null],
      ['note', null, null],
      ['note', null, null],
    ]);
    expect(log.slice(-2).map((e) => [e.body, e.actor.id])).toEqual([
      ['checked the post history: three ads this week', me],
      ['agree, ad spam', other.id],
    ]);
    expect(await audits('report.severity', id)).toHaveLength(2);
    expect(await audits('report.assign', id)).toHaveLength(3);
    const noteAudits = await audits('report.note', id);
    expect(noteAudits).toHaveLength(2);
    expect(noteAudits.map((a) => a.detail).join()).not.toContain('three ads');

    // Once closed, severity and assignment stay as they were, but notes can still be added.
    expect((await admin.post(`/api/admin/reports/${id}`, { status: 'dismissed', note: 'not spam' })).status).toBe(200);
    expect((await admin.patch(`/api/admin/reports/${id}`, { severity: 'low' })).body.error.code).toBe('report_closed');
    expect((await admin.patch(`/api/admin/reports/${id}`, { take: true })).body.error.code).toBe('report_closed');
    expect((await admin.post(`/api/admin/reports/${id}`, { status: 'resolved' })).body.error.code).toBe('report_closed');
    // Every refused change is in the audit log as a failed attempt: its status and code, never the request body.
    const refused = await d1<{ action: string; detail: string; outcome: string }>(
      `SELECT action, detail, outcome FROM admin_audit_log WHERE action IN ('report.update.failed', 'report.resolve.failed') AND target_id = '${id}' ORDER BY created_at, rowid`,
    );
    expect(refused.map((r) => [r.action, JSON.parse(r.detail).status])).toEqual([
      ['report.update.failed', 400],
      ['report.update.failed', 400],
      ['report.update.failed', 409],
      ['report.update.failed', 400],
      ['report.update.failed', 409],
      ['report.update.failed', 409],
      ['report.resolve.failed', 409],
    ]);
    expect(refused.map((r) => JSON.parse(r.detail).code).filter((code: string) => code.startsWith('report_'))).toEqual(['report_taken', 'report_closed', 'report_closed', 'report_closed']);
    expect(refused.every((r) => r.outcome === 'failed' && !r.detail.includes('urgent'))).toBe(true);
    expect((await admin.post(`/api/admin/reports/${id}/notes`, { body: 'reopened by a new report later?' })).status).toBe(201);
    const after = await events(id);
    expect(after.filter((e) => e.kind === 'status').map((e) => [e.from, e.to])).toEqual([['open', 'dismissed']]);
    expect((await admin.get('/api/admin/reports/nope/events')).status).toBe(404);
  });

  it('tells the members how it ended only when asked: each reporter and the reported member in their own language, once', async () => {
    const author = await newUser(undefined, { locale: 'en' });
    const ko = await newUser();
    const en = await newUser(undefined, { locale: 'en' });
    const quiet = await newUser();
    const { ids } = await reportedPost(author, [ko, en]);
    const inbox = async (u: User) => (await u.client.get('/api/messages')).body as { category: string; title: string; body: string }[];
    const before = { ko: (await inbox(ko)).length, en: (await inbox(en)).length, author: (await inbox(author)).length };

    // A dismissed report cannot send the reported member a result (they were never told of it).
    expect((await admin.post(`/api/admin/reports/${ids[0]}`, { status: 'dismissed', notifyTarget: true })).status).toBe(400);

    // Three admins at once: one decision, and one message per member.
    const admins = [sharedAdmin(), sharedAdmin(), sharedAdmin()];
    const results = await Promise.all(admins.map((x) => x.post(`/api/admin/reports/${ids[0]}`, { status: 'resolved', hideContent: true, notifyReporter: true, notifyTarget: true })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.body).toMatchObject({ ok: true, closed: 2, notified: { reporters: 2, target: 1 } });

    const koBox = await inbox(ko);
    const enBox = await inbox(en);
    const authorBox = await inbox(author);
    expect(koBox.length - before.ko).toBe(1);
    expect(enBox.length - before.en).toBe(1);
    expect(authorBox.length - before.author).toBe(1);
    expect(koBox[0]).toMatchObject({ category: 'notice', title: '신고 처리 결과 안내' });
    expect(koBox[0]!.body).toContain('게시글');
    expect(enBox[0]).toMatchObject({ category: 'notice', title: 'Your report has been reviewed' });
    expect(authorBox[0]).toMatchObject({ category: 'sanction', title: 'Operating policy notice' });
    // The reported member is never told who reported them.
    expect(authorBox[0]!.body).not.toContain(ko.me.nickname);
    expect(authorBox[0]!.body).not.toContain(en.me.nickname);

    // Both reports remember what was sent; the status change is on each of them.
    for (const id of ids) {
      expect(await one(id, author.me.id)).toMatchObject({ status: 'resolved', notice: { reporter: true, target: true } });
      expect((await events(id)).filter((e) => e.kind === 'status').map((e) => e.to)).toEqual(['resolved']);
    }
    const detail = JSON.parse((await audits('report.resolved', ids[0]!))[0]!.detail!);
    expect(detail).toMatchObject({ closed: 2, notify: { reporter: true, target: true } });

    // Without the options nobody hears anything (the earlier behaviour).
    const { ids: quietIds } = await reportedPost(author, [quiet]);
    const q0 = (await inbox(quiet)).length;
    const a0 = (await inbox(author)).length;
    expect((await admin.post(`/api/admin/reports/${quietIds[0]}`, { status: 'dismissed' })).body).toMatchObject({ closed: 1, notified: { reporters: 0, target: 0 } });
    expect((await inbox(quiet)).length).toBe(q0);
    expect((await inbox(author)).length).toBe(a0);
    expect(await one(quietIds[0]!, author.me.id)).toMatchObject({ notice: { reporter: false, target: false } });
  });
});

describe('the queue', () => {
  it('filters, sorts and pages; shows how long open reports have waited; statistics by reason and target', async () => {
    const author = await newUser();
    const rs = await Promise.all([newUser(), newUser(), newUser()]);
    const stats0 = (await admin.get('/api/admin/reports/stats?days=30')).body;
    const a = await reportedPost(author, [rs[0]!], 'spam');
    const b = await reportedPost(author, [rs[1]!], 'abuse');
    const c = await reportedPost(author, [rs[2]!], 'cheating');
    // One more report, filed 30 hours ago (written straight into D1, the way an old report sits in the queue).
    const oldId = `it-old-${Date.now().toString(36)}`;
    const filed = Date.now() - 30 * 3_600_000;
    await d1(`INSERT INTO reports (id, reporter_id, target_type, target_id, target_user_id, reason, status, created_at) VALUES ('${oldId}', '${rs[0]!.me.id}', 'player', '${author.me.id}', '${author.me.id}', 'abuse', 'open', ${filed})`);
    await admin.patch(`/api/admin/reports/${b.ids[0]}`, { severity: 'high' });
    await admin.patch(`/api/admin/reports/${c.ids[0]}`, { severity: 'critical' });
    await admin.patch(`/api/admin/reports/${a.ids[0]}`, { take: true });

    const list = (q: string) => admin.get(`/api/admin/reports?userId=${author.me.id}&${q}`).then((r) => r.body as { items: { id: string }[]; total: number; page: number; limit: number; openCount: number });
    const idsOf = (l: { items: { id: string }[] }) => l.items.map((r) => r.id);
    expect(idsOf(await list('sort=oldest'))).toEqual([oldId, a.ids[0], b.ids[0], c.ids[0]]);
    expect(idsOf(await list('sort=newest'))).toEqual([c.ids[0], b.ids[0], a.ids[0], oldId]);
    // Most severe first; reports without a severity last, oldest first among equals.
    expect(idsOf(await list('sort=severity'))).toEqual([c.ids[0], b.ids[0], oldId, a.ids[0]]);
    expect(idsOf(await list('severity=critical'))).toEqual([c.ids[0]]);
    expect(idsOf(await list('severity=none&sort=oldest'))).toEqual([oldId, a.ids[0]]);
    expect(idsOf(await list('reason=abuse&sort=oldest'))).toEqual([oldId, b.ids[0]]);
    expect(idsOf(await list('targetType=player'))).toEqual([oldId]);
    expect(idsOf(await list('assignee=me'))).toEqual([a.ids[0]]);
    expect(idsOf(await list('assignee=none&sort=oldest'))).toEqual([oldId, b.ids[0], c.ids[0]]);
    expect((await admin.get(`/api/admin/reports?severity=urgent`)).status).toBe(400);
    expect((await admin.get(`/api/admin/reports?sort=random`)).status).toBe(400);
    // Pages of two: the total, then the rest.
    const p1 = await list('sort=oldest&limit=2&page=1');
    const p2 = await list('sort=oldest&limit=2&page=2');
    expect([p1.total, p1.page, p1.limit, idsOf(p1)]).toEqual([4, 1, 2, [oldId, a.ids[0]]]);
    expect(idsOf(p2)).toEqual([b.ids[0], c.ids[0]]);

    // Statistics: the new reports, the one past 24 hours, and the oldest wait.
    const stats = (await admin.get('/api/admin/reports/stats?days=30')).body;
    expect(stats.days).toBe(30);
    expect(stats.backlog.open - stats0.backlog.open).toBe(4);
    expect(stats.backlog.over24h - stats0.backlog.over24h).toBe(1);
    expect(stats.backlog.over72h - stats0.backlog.over72h).toBe(0);
    expect(stats.backlog.oldestOpenAt).toBeLessThanOrEqual(filed);
    expect(stats.backlog.unassigned - stats0.backlog.unassigned).toBe(3);
    expect(stats.backlog.bySeverity.critical - stats0.backlog.bySeverity.critical).toBe(1);
    const reason = (s: typeof stats, r: string) => (s.byReason as { reason: string; total: number; open: number }[]).find((x) => x.reason === r) ?? { total: 0, open: 0 };
    expect(reason(stats, 'abuse').total - reason(stats0, 'abuse').total).toBe(2);
    expect(reason(stats, 'cheating').open - reason(stats0, 'cheating').open).toBe(1);
    const target = (s: typeof stats, k: string) => (s.byTarget as { targetType: string; total: number }[]).find((x) => x.targetType === k) ?? { total: 0 };
    expect(target(stats, 'player').total - target(stats0, 'player').total).toBe(1);
    expect((await admin.get('/api/admin/reports/stats?days=13')).status).toBe(400);

    // Handling times count once a report is closed.
    expect((await admin.post(`/api/admin/reports/${oldId}`, { status: 'dismissed', note: 'old' })).status).toBe(200);
    const closed = (await admin.get('/api/admin/reports/stats?days=30')).body;
    expect(closed.handled.count - stats.handled.count).toBe(1);
    expect(closed.handled.maxMs).toBeGreaterThanOrEqual(30 * 3_600_000 - 60_000);
    expect(closed.backlog.over24h - stats.backlog.over24h).toBe(-1);
    for (const r of [a, b, c]) await admin.post(`/api/admin/reports/${r.ids[0]}`, { status: 'dismissed' });
  });

  it('members reported again and again are listed for review only: many reports never suspend anyone by themselves', async () => {
    const author = await newUser();
    const reporters = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    await reportedPost(author, reporters.slice(0, 3));
    // The same member reporting a second post adds a report but not a reporter.
    await reportedPost(author, [reporters[0]!], 'abuse');
    const stats = (await admin.get('/api/admin/reports/stats?days=7')).body;
    const row = (stats.repeated as { user: { id: string; status: string }; reports: number; reporters: number; open: number; resolved: number; suspensions: number }[]).find((r) => r.user.id === author.me.id);
    expect(row).toMatchObject({ user: { status: 'active' }, reports: 4, reporters: 3, open: 4, resolved: 0, suspensions: 0 });
    // Still active and still able to sign in: the count is information, not a decision.
    expect((await d1<{ status: string }>(`SELECT status FROM users WHERE id = '${author.me.id}'`))[0]!.status).toBe('active');
    expect((await author.client.get('/api/auth/me')).status).toBe(200);
    // Every report on the member shows how many different members reported them.
    const items = (await admin.get(`/api/admin/reports?userId=${author.me.id}`)).body.items as { priorReports: { total: number; reporters: number } }[];
    expect(items[0]!.priorReports).toMatchObject({ total: 3, reporters: 3 });
  });

  it('a suspension given from a report is linked both ways; the report shows the member\'s earlier sanctions', async () => {
    const author = await newUser();
    const other = await newUser();
    const reporter = await newUser();
    const { ids } = await reportedPost(author, [reporter]);
    const id = ids[0]!;
    const unrelated = (await reportedPost(other, [reporter])).ids[0]!;
    await reauth();
    // The report has to be about that member.
    expect((await admin.post(`/api/admin/users/${author.me.id}/suspend`, { reason: 'ad spam', reportId: unrelated })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${author.me.id}/suspend`, { reason: 'ad spam', reportId: 'nope' })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${author.me.id}/suspend`, { reason: 'ad spam', reportId: id })).status).toBe(200);

    const detail = JSON.parse((await audits('user.suspend', author.me.id))[0]!.detail!);
    expect(detail).toMatchObject({ reason: 'ad spam', reportId: id });
    const sanction = (await events(id)).find((e) => e.kind === 'sanction');
    expect(sanction).toMatchObject({ to: 'user.suspend', body: 'ad spam' });
    const r = await one(id, author.me.id);
    expect(r.target.status).toBe('suspended');
    expect(r.sanctions).toEqual([expect.objectContaining({ action: 'user.suspend', reason: 'ad spam', reportId: id })]);

    // Lifting it shows up as well (not linked to the report).
    expect((await admin.post(`/api/admin/users/${author.me.id}/unsuspend`, { reason: 'appeal accepted' })).status).toBe(200);
    const again = await one(id, author.me.id);
    expect(again.sanctions.map((s: { action: string; reportId: string | null }) => [s.action, s.reportId])).toEqual([
      ['user.unsuspend', null],
      ['user.suspend', id],
    ]);
    // The member's history lists the report decision only, not each severity or assignment change.
    await admin.patch(`/api/admin/reports/${id}`, { severity: 'low' });
    await admin.post(`/api/admin/reports/${id}`, { status: 'resolved' });
    const timeline = (await admin.get(`/api/admin/users/${author.me.id}/timeline`)).body.items as { action: string }[];
    expect(timeline.map((x) => x.action)).toEqual(['report.resolved', 'user.unsuspend', 'user.suspend']);
    await admin.post(`/api/admin/reports/${unrelated}`, { status: 'dismissed' });
  });
});
