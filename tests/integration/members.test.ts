// Member management: the list's filters, sort orders and pages; the last member sign-in; internal notes; the history
// of what administrators did to a member; and the member page's recent tables, reports and play activity.
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
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

/** A plain admin (not super): a new member made admin in D1, signed in once, with their member sign-in time before. */
let plain: Promise<{ c: Client; id: string; loginBefore: number | null }> | null = null;
function plainAdmin() {
  plain ??= (async () => {
    const u = await newUser();
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${u.me.id}'`);
    const loginBefore = (await d1<{ t: number | null }>(`SELECT last_login_at AS t FROM users WHERE id = '${u.me.id}'`))[0]!.t;
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return { c, id: u.me.id, loginBefore };
  })();
  return plain;
}

const lastLogin = async (id: string) => (await d1<{ t: number | null }>(`SELECT last_login_at AS t FROM users WHERE id = '${id}'`))[0]!.t;
const audits = (action: string, targetId: string) =>
  d1<{ detail: string | null }>(`SELECT detail FROM admin_audit_log WHERE action = '${action}' AND target_id = '${targetId}' ORDER BY created_at, rowid`);
const tag = () => `m${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

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

describe('member list', () => {
  it('filters by status and role, sorts by sign-in, nickname or balance, and pages with a total', async () => {
    const t = tag();
    const [a, b, c] = [await newUser(`${t}a`), await newUser(`${t}b`), await newUser(`${t}c`)];
    const now = Date.now();
    await d1(`UPDATE users SET last_login_at = ${now - 3000} WHERE id = '${a.me.id}'`);
    await d1(`UPDATE users SET last_login_at = NULL WHERE id = '${b.me.id}'`);
    await d1(`UPDATE users SET last_login_at = ${now - 1000} WHERE id = '${c.me.id}'`);
    const list = async (qs: string) => {
      const r = await admin.get(`/api/admin/users?q=${t}&paged=1&${qs}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { items: { id: string; nickname: string; lastLoginAt: number | null; balance: number }[]; total: number; limit: number; offset: number };
    };
    const names = (r: { items: { nickname: string }[] }) => r.items.map((u) => u.nickname);

    // Pages: a total for the page controls, the same order across pages.
    const p1 = await list('sort=nickname&dir=asc&limit=2');
    expect(p1).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(names(p1)).toEqual([`${t}a`, `${t}b`]);
    expect(names(await list('sort=nickname&dir=asc&limit=2&offset=2'))).toEqual([`${t}c`]);

    // Sign-in order: never signed in sorts last both ways.
    expect(names(await list('sort=login&dir=desc'))).toEqual([`${t}c`, `${t}a`, `${t}b`]);
    expect(names(await list('sort=login&dir=asc'))).toEqual([`${t}a`, `${t}c`, `${t}b`]);
    expect((await list('sort=login&dir=desc')).items[2]!.lastLoginAt).toBeNull();

    // Balance order follows a real adjustment (through the ledger).
    await reauth();
    const adj = await admin.post(`/api/admin/users/${b.me.id}/chips`, { amount: 500, memo: 'member list test', idempotencyKey: crypto.randomUUID().replace(/-/g, '').slice(0, 24) });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    expect(names(await list('sort=balance&dir=desc')).slice(0, 1)).toEqual([`${t}b`]);
    expect(names(await list('sort=balance&dir=asc')).slice(-1)).toEqual([`${t}b`]);

    // Status and role filters.
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${b.me.id}'`);
    await d1(`UPDATE users SET role = 'admin' WHERE id = '${c.me.id}'`);
    try {
      expect(names(await list('status=suspended'))).toEqual([`${t}b`]);
      expect((await list('status=active')).total).toBe(2);
      expect(names(await list('role=admin'))).toEqual([`${t}c`]);
      expect(names(await list('role=user&status=active'))).toEqual([`${t}a`]);
      // An unknown value is ignored rather than matching nothing.
      expect((await list('status=bogus&role=bogus&sort=bogus')).total).toBe(3);
    } finally {
      await d1(`UPDATE users SET status = 'active' WHERE id = '${b.me.id}'`);
      await d1(`UPDATE users SET role = 'user' WHERE id = '${c.me.id}'`);
    }

    // Without paged=1 the answer is the plain array older consoles read.
    const plainList = await admin.get(`/api/admin/users?q=${t}`);
    expect(Array.isArray(plainList.body)).toBe(true);
    expect(plainList.body).toHaveLength(3);

    // Every look at the list is recorded with what it asked for.
    const looks = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = 'user.list' AND detail LIKE '%${t}%' ORDER BY created_at, rowid`);
    expect(looks.map((l) => JSON.parse(l.detail))).toContainEqual(expect.objectContaining({ q: t, role: 'admin', sort: 'created' }));
    expect(looks.map((l) => JSON.parse(l.detail))).toContainEqual(expect.objectContaining({ q: t, sort: 'login', offset: 0, count: 3 }));
  });

  it('remembers the last member sign-in (kept after sign-out), not admin console sign-ins', async () => {
    const u = await newUser();
    const atSignup = await lastLogin(u.me.id);
    expect(atSignup).toBeGreaterThan(Date.now() - 60_000);
    await d1(`UPDATE users SET last_login_at = 1 WHERE id = '${u.me.id}'`);
    const c = new Client();
    expect((await c.post('/api/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    const signedIn = await lastLogin(u.me.id);
    expect(signedIn).toBeGreaterThan(Date.now() - 60_000);
    expect((await c.post('/api/auth/logout', {})).status).toBe(200);
    expect(await lastLogin(u.me.id)).toBe(signedIn);
    const detail = await admin.get(`/api/admin/users/${u.me.id}`);
    expect(detail.body.user.lastLoginAt).toBe(signedIn);

    // An admin console sign-in is not a member sign-in.
    const p = await plainAdmin();
    expect(await lastLogin(p.id)).toBe(p.loginBefore);
  });
});

describe('internal notes', () => {
  it('refuse personal data, are deleted only by their author or a super admin, and leave no text in the audit log', async () => {
    const target = await newUser();
    const p = await plainAdmin();
    const url = `/api/admin/users/${target.me.id}/notes`;

    // Personal data is refused; ordinary handover text (dates, amounts, table ids) is not.
    for (const body of ['call him on 010-1234-5678', 'his mail is someone@example.com', 'ID 900101-1234567', 'card 4111 1111 1111 1111', 'intl +82 10 1234 5678']) {
      const r = await admin.post(url, { body });
      expect(r.status, body).toBe(400);
      expect(r.body.error.code, body).toBe('note_pii');
    }
    expect((await admin.post(url, { body: 'x' })).status).toBe(400);
    expect((await admin.post(url, { body: 'y'.repeat(501) })).status).toBe(400);
    const text = 'Lost 12,000 at it-member-0 on 2026-10-15; watch for chip dumping to the same opponent.';
    const mine = await admin.post(url, { body: text });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const theirs = await p.c.post(url, { body: 'Second opinion: looked like ordinary bad luck.' });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);

    // Members cannot reach notes; the console shows them in the member's history.
    expect([401, 403]).toContain((await target.client.post(url, { body: 'from the member' })).status);
    const notes = (await admin.get(`/api/admin/users/${target.me.id}/timeline?kind=note`)).body.items as { id: string; action: string; body: string; actor: { id: string } }[];
    expect(notes.map((n) => n.body)).toEqual(['Second opinion: looked like ordinary bad luck.', text]);
    expect(notes[0]!.actor.id).toBe(p.id);

    // A plain admin cannot delete someone else's note; the author can delete their own, a super admin any.
    const other = await p.c.req('DELETE', `${url}/${mine.body.id}`);
    expect(other.status).toBe(403);
    expect(other.body.error.message).toBe('only the author or a super admin can delete a note');
    expect((await admin.req('DELETE', `${url}/${theirs.body.id}`)).status).toBe(200);
    expect((await admin.req('DELETE', `${url}/${theirs.body.id}`)).status).toBe(404);
    expect((await admin.req('DELETE', `/api/admin/users/${p.id}/notes/${mine.body.id}`)).status).toBe(404);
    const again = await p.c.post(url, { body: 'Own note, then removed.' });
    expect((await p.c.req('DELETE', `${url}/${again.body.id}`)).status).toBe(200);
    expect(await d1(`SELECT body FROM admin_notes WHERE user_id = '${target.me.id}'`)).toEqual([{ body: text }]);

    // The audit log says who wrote or removed which note, never what it said.
    const created = await audits('note.create', target.me.id);
    expect(created).toHaveLength(3);
    for (const a of created) {
      expect(Object.keys(JSON.parse(a.detail!)).sort()).toEqual(['length', 'noteId']);
      expect(a.detail).not.toContain('chip dumping');
    }
    const removed = (await audits('note.delete', target.me.id)).map((a) => JSON.parse(a.detail!));
    expect(removed).toEqual([
      expect.objectContaining({ noteId: theirs.body.id, authorId: p.id }),
      expect.objectContaining({ noteId: again.body.id, authorId: p.id }),
    ]);
    // A removed note shows up in the history only as its removal.
    const history = (await admin.get(`/api/admin/users/${target.me.id}/timeline?kind=note`)).body.items as { action: string }[];
    expect(history.map((h) => h.action).sort()).toEqual(['note', 'note.delete', 'note.delete']);
  });

  it('go with the account at withdrawal, as does the last sign-in; the audit trail stays', async () => {
    const u = await newUser();
    expect((await admin.post(`/api/admin/users/${u.me.id}/notes`, { body: 'Asked about withdrawal timing.' })).status).toBe(200);
    expect((await u.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await d1(`SELECT id FROM admin_notes WHERE user_id = '${u.me.id}'`)).toEqual([]);
    expect(await lastLogin(u.me.id)).toBeNull();
    expect(await audits('note.create', u.me.id)).toHaveLength(1);
    const late = await admin.post(`/api/admin/users/${u.me.id}/notes`, { body: 'After withdrawal.' });
    expect(late.status).toBe(404);
  });
});

describe('member history', () => {
  it('records each sanction with before, after and the reason; filters by kind; pages without skipping ties', async () => {
    const target = await newUser();
    const reporter = await newUser();
    const id = target.me.id;
    await reauth();

    // A report about the member, resolved.
    const post = await target.client.post('/api/board/posts', { title: `history ${tag()}`, body: 'spam body' });
    expect(post.status).toBe(201);
    const rep = await reporter.client.post('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'spam', detail: 'history test' });
    expect(rep.status).toBe(201);
    expect((await admin.post(`/api/admin/reports/${rep.body.id}`, { status: 'resolved', note: 'warned' })).status).toBe(200);

    // Suspend, then lift and change roles: lifting and role changes need a reason.
    expect((await admin.post(`/api/admin/users/${id}/suspend`, { reason: 'abusive chat' })).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${id}/unsuspend`, {})).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${id}/unsuspend`, { reason: 'x' })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${id}/unsuspend`, { reason: 'appeal accepted' })).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${id}/role`, { role: 'admin' })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${id}/role`, { role: 'admin', reason: 'joined the staff' })).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${id}/role`, { role: 'user', reason: 'left the staff' })).status).toBe(200);
    const adj = await admin.post(`/api/admin/users/${id}/chips`, { amount: 250, memo: 'history test', idempotencyKey: crypto.randomUUID().replace(/-/g, '').slice(0, 24) });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    expect((await admin.post(`/api/admin/users/${id}/notes`, { body: 'Watch the next week.' })).status).toBe(200);

    expect(JSON.parse((await audits('user.suspend', id))[0]!.detail!)).toMatchObject({ reason: 'abusive chat', from: 'active', to: 'suspended', previousReason: null });
    expect(JSON.parse((await audits('user.unsuspend', id))[0]!.detail!)).toEqual({ reason: 'appeal accepted', from: 'suspended', to: 'active', suspendedReason: 'abusive chat' });
    expect((await audits('user.role', id)).map((a) => JSON.parse(a.detail!))).toEqual([
      { from: 'user', to: 'admin', reason: 'joined the staff' },
      { from: 'admin', to: 'user', reason: 'left the staff' },
    ]);
    // Lifting a suspension that is not in force changes nothing and says so.
    expect((await admin.post(`/api/admin/users/${id}/unsuspend`, { reason: 'double click' })).status).toBe(200);
    expect(JSON.parse((await audits('user.unsuspend', id))[1]!.detail!)).toMatchObject({ from: 'active', to: 'active' });

    type Item = { id: string; action: string; createdAt: number; actor: { id: string; nickname: string | null }; detail: Record<string, unknown> | null; body: string | null };
    const timeline = async (qs: string) => {
      const r = await admin.get(`/api/admin/users/${id}/timeline?${qs}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { items: Item[]; nextBefore: number | null; nextBeforeId: string | null };
    };
    const all = await timeline('kind=all');
    const actions = all.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['report.resolved', 'user.suspend', 'user.unsuspend', 'user.role', 'user.chips', 'note']));
    expect(actions).not.toContain('user.view');
    expect(all.items.map((i) => i.createdAt)).toEqual([...all.items.map((i) => i.createdAt)].sort((x, y) => y - x));
    expect(all.items.find((i) => i.action === 'user.suspend')!.actor.nickname).toBeTruthy();
    expect(all.items.find((i) => i.action === 'note')!.body).toBe('Watch the next week.');
    expect(all.nextBefore).toBeNull();

    const kinds = async (kind: string) => new Set((await timeline(`kind=${kind}`)).items.map((i) => i.action));
    expect(await kinds('sanction')).toEqual(new Set(['report.resolved', 'user.suspend', 'user.unsuspend']));
    expect(await kinds('chips')).toEqual(new Set(['user.chips']));
    expect(await kinds('note')).toEqual(new Set(['note']));

    // Three entries in the same millisecond, read two at a time: every entry exactly once.
    const at = Date.now() - 5;
    const ties = ['a', 'b', 'c'].map((s) => `tie-${s}-${id}`.slice(0, 60));
    for (const tid of ties) {
      await d1(`INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, created_at) VALUES ('${tid}', '${all.items[0]!.actor.id}', 'user.chips', 'user', '${id}', '{"amount":1}', ${at})`);
    }
    const full = (await timeline('kind=all&limit=100')).items.map((i) => i.id);
    const seen: string[] = [];
    let cursor = '';
    for (let n = 0; n < 50; n++) {
      const page = await timeline(`kind=all&limit=2${cursor}`);
      seen.push(...page.items.map((i) => i.id));
      if (page.nextBefore === null) break;
      cursor = `&before=${page.nextBefore}&beforeId=${page.nextBeforeId}`;
    }
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(seen.length);
    expect(full).toEqual(expect.arrayContaining(ties));
  });
});

describe('member page', () => {
  it('shows recent tables, reports by and about the member, and play activity by day', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await TableSocket.open(a.client, 'it-member-0');
    const wb = await TableSocket.open(b.client, 'it-member-0');
    open.push(wa, wb);
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 300 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 300 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.hand?.stage === 'preflop', 20_000, 'first hand');
    await Promise.all([playOut(wa), playOut(wb)]);
    // A next hand may already be dealt: leaving then folds it and stands up when it settles.
    expect(await wa.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.you.seatIndex === null, 20_000, 'A stood up');
    await wb.waitState((s) => s.you.seatIndex === null, 20_000, 'B stood up');
    for (let i = 0; i < 40; i++) {
      const left = await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM table_sessions WHERE user_id IN ('${a.me.id}', '${b.me.id}') AND status = 'closed'`);
      if (left[0]!.n === 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // B wrote a post that A reported.
    const post = await b.client.post('/api/board/posts', { title: `member page ${tag()}`, body: 'spam body' });
    const rep = await a.client.post('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'abuse', detail: 'private detail text' });
    expect(rep.status).toBe(201);

    const da = (await admin.get(`/api/admin/users/${a.me.id}`)).body;
    expect(da.recentTables[0]).toMatchObject({ tableId: 'it-member-0', tableName: 'it-member-0', roomType: 'official', seatIndex: 0, buyIn: 300, status: 'closed' });
    expect(typeof da.recentTables[0].cashOut).toBe('number');
    expect(da.reports.filed).toEqual({ open: 1, resolved: 0, dismissed: 0, total: 1 });
    expect(da.reports.against.total).toBe(0);
    expect(da.reports.recentFiled[0]).toMatchObject({ id: rep.body.id, reason: 'abuse', status: 'open', otherNickname: b.me.nickname });
    // Only what the summary needs: the evidence and free text stay on the reports page, which records the look.
    expect(JSON.stringify(da.reports)).not.toContain('private detail text');
    const db = (await admin.get(`/api/admin/users/${b.me.id}`)).body;
    expect(db.reports.against).toEqual({ open: 1, resolved: 0, dismissed: 0, total: 1 });
    expect(db.reports.recentAgainst[0]).toMatchObject({ id: rep.body.id, otherNickname: a.me.nickname });

    // The reports page can list what one member filed.
    const filed = (await admin.get(`/api/admin/reports?status=all&reporterId=${a.me.id}`)).body.items as { id: string; reporter: { id: string } }[];
    expect(filed.map((r) => r.id)).toEqual([rep.body.id]);

    // Activity: days cut at the viewer's midnight; days without hands listed as zeros; totals match the series.
    const hands = (await d1<{ n: number; net: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM hand_players WHERE user_id = '${a.me.id}'`))[0]!;
    expect(hands.n).toBeGreaterThan(0);
    const act = (await admin.get(`/api/admin/users/${a.me.id}/activity?days=7&tz=540`)).body;
    expect(act.days).toBe(7);
    expect(act.series).toHaveLength(7);
    expect(act.series[6].date).toBe(new Date(Date.now() + 540 * 60_000).toISOString().slice(0, 10));
    expect(act.series[6].hands).toBe(hands.n);
    expect(act.totals).toMatchObject({ hands: hands.n, net: hands.net, activeDays: 1, seatings: 1, tables: 1, buyIn: 300 });
    expect(act.series.reduce((s: number, d: { hands: number }) => s + d.hands, 0)).toBe(act.totals.hands);
    expect((await admin.get(`/api/admin/users/${a.me.id}/activity?days=30&tz=540`)).body.series).toHaveLength(30);
    expect((await admin.get(`/api/admin/users/${a.me.id}/activity?days=5`)).body.days).toBe(7);
    for (const tz of [-600, 0, 840]) {
      const r = (await admin.get(`/api/admin/users/${a.me.id}/activity?days=7&tz=${tz}`)).body;
      expect(r.series[6].date).toBe(new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10));
      expect(r.totals.hands).toBe(hands.n);
    }
    // A member with no play: zeros, not an error.
    const idle = (await admin.get(`/api/admin/users/${(await newUser()).me.id}/activity?days=90&tz=540`)).body;
    expect(idle.series).toHaveLength(90);
    expect(idle.totals).toEqual({ hands: 0, net: 0, wins: 0, showdowns: 0, activeDays: 0, seatings: 0, tables: 0, buyIn: 0 });
  });
});
