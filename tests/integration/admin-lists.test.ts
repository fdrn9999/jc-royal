// The console's long lists read page by page: the chip ledger and finished hands by cursor (with each look at the
// ledger, and each look at a member's hands, in the audit log), tables, board posts and sent messages by offset, the
// plain arrays of before still answered without `paged=1`, and the confirmation of a report decision that writes nothing.
import { describe, expect, it } from 'vitest';
import { newUser, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';

/** The bootstrapped super admin. */
const admin = sharedAdmin();
const DAY = 86_400_000;

type Page<T> = { items: T[]; next: string | null; member: { id: string; nickname: string } | null };
type LedgerRow = { seq: number; id: string; userId: string; type: string; amount: number; createdAt: number };
type HandRow = { seq: number; id: string; tableId: string; tableName: string | null; board: string[]; endedAt: number };
const get = async <T>(path: string) => {
  const r = await admin.get(path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as T;
};
/** Every page of a keyset list, following `next` until it ends. */
async function allPages<T>(path: string) {
  const pages: T[][] = [];
  let cursor: string | null = null;
  do {
    const p: Page<T> = await get<Page<T>>(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    pages.push(p.items);
    cursor = p.next;
  } while (cursor && pages.length < 20);
  return pages;
}
const audits = async (action: string, where: string) =>
  (await d1<{ detail: string | null; target: string | null }>(`SELECT detail, target_id AS target FROM admin_audit_log WHERE action = '${action}' AND ${where} ORDER BY created_at, rowid`)).map((r) => ({
    target: r.target,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));

describe('chip ledger, page by page', () => {
  it('narrows to a member by id, email or nickname, by type and period, pages without overlap, and records every look', async () => {
    const u = await newUser();
    const base = Date.now() - 3 * DAY;
    // Six entries before the sign-up grant that cancel out (top-up −100, cash-out +100): the wallet still matches.
    await d1(
      `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, created_at) VALUES ` +
        [1, 2, 3, 4, 5, 6].map((i) => `('it-list-${u.me.id}-${i}', '${u.me.id}', '${i % 2 ? 'top_up' : 'cash_out'}', ${i % 2 ? -100 : 100}, ${u.me.balance - (i % 2) * 100}, 'it-list-${u.me.id}-${i}', ${base + i * 1000})`).join(', '),
    );

    // By nickname (any case), three a page: the grant, then the six newest first, and the pages never overlap.
    const pages = await allPages<LedgerRow>(`/api/admin/ledger?paged=1&member=${encodeURIComponent(u.me.nickname.toUpperCase())}&limit=3`);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const rows = pages.flat();
    expect(new Set(rows.map((r) => r.id)).size).toBe(7);
    expect(rows.every((r) => r.userId === u.me.id)).toBe(true);
    expect(rows[0]!.type).toBe('signup_grant');
    expect(rows.slice(1).map((r) => r.id)).toEqual([6, 5, 4, 3, 2, 1].map((i) => `it-list-${u.me.id}-${i}`));
    const first = await get<Page<LedgerRow>>(`/api/admin/ledger?paged=1&member=${encodeURIComponent(u.email)}&limit=3`);
    expect(first.member).toEqual({ id: u.me.id, nickname: u.me.nickname });
    expect(first.next).toMatch(/^\d+\.\d+$/);
    expect((await get<Page<LedgerRow>>(`/api/admin/ledger?paged=1&userId=${u.me.id}&limit=3`)).items.map((r) => r.id)).toEqual(first.items.map((r) => r.id));

    // Type and period (to is exclusive).
    const cashOuts = (await allPages<LedgerRow>(`/api/admin/ledger?paged=1&member=${u.me.id}&type=cash_out&limit=2`)).flat();
    expect(cashOuts.map((r) => r.id)).toEqual([6, 4, 2].map((i) => `it-list-${u.me.id}-${i}`));
    const period = await get<Page<LedgerRow>>(`/api/admin/ledger?paged=1&member=${u.me.id}&from=${base + 1000}&to=${base + 4000}`);
    expect(period.items.map((r) => r.id)).toEqual([3, 2, 1].map((i) => `it-list-${u.me.id}-${i}`));
    expect(period.next).toBeNull();

    // Without a member, pages follow the order rows were written: each page older than the last, no row twice.
    const p1 = await get<Page<LedgerRow>>('/api/admin/ledger?paged=1&limit=4');
    const p2 = await get<Page<LedgerRow>>(`/api/admin/ledger?paged=1&limit=4&cursor=${p1.next}`);
    expect(p1.next).toMatch(/^\d+$/);
    expect(p1.member).toBeNull();
    expect(Math.max(...p2.items.map((r) => r.seq))).toBeLessThan(Math.min(...p1.items.map((r) => r.seq)));

    // Nobody by that name: an empty page saying so, not the whole ledger.
    const nobody = uniq('nobody');
    expect(await get<Page<LedgerRow>>(`/api/admin/ledger?paged=1&member=${nobody}`)).toEqual({ items: [], next: null, member: null });

    // Refused rather than read as a first page: an unknown type, a cursor that is not one, a cursor of the other kind.
    for (const q of ['type=jackpot', 'cursor=abc', `member=${u.me.id}&cursor=123`, 'cursor=1.2', 'cursor=-5']) {
      const r = await admin.get(`/api/admin/ledger?paged=1&${q}`);
      expect(r.status, q).toBe(400);
    }

    // Every look is in the audit log, with what was searched, whether someone was found, the filters and the page
    // (three pages by nickname, email, id, two pages of cash-outs, the period; a refused look reads nothing).
    const looks = await audits('ledger.view', `target_id = '${u.me.id}'`);
    expect(looks).toHaveLength(8);
    expect(looks[0]).toMatchObject({ target: u.me.id, detail: { q: u.me.nickname.toUpperCase(), found: true, type: null, page: 'first', count: 3 } });
    expect(looks[1]!.detail).toMatchObject({ page: 'next', count: 3 });
    expect(looks.some((l) => l.detail?.type === 'cash_out')).toBe(true);
    expect(looks.some((l) => l.detail?.from === base + 1000 && l.detail?.to === base + 4000)).toBe(true);
    expect(await audits('ledger.view', `detail LIKE '%${nobody}%'`)).toEqual([{ target: null, detail: { q: nobody, found: false, type: null, from: null, to: null, page: 'first', count: 0 } }]);

    // The plain array of before still answers, and is recorded too.
    const plain = await admin.get(`/api/admin/ledger?userId=${u.me.id}&limit=200`);
    expect(Array.isArray(plain.body)).toBe(true);
    expect((plain.body as LedgerRow[]).length).toBe(7);
    expect((await audits('ledger.view', `target_id = '${u.me.id}' AND detail LIKE '%"offset"%'`)).length).toBe(1);
  });
});

describe('finished hands, page by page', () => {
  it('by table and by member without overlap; only a look at a member’s hands is recorded', async () => {
    const u = await newUser();
    const tableId = uniq('it-hands-');
    const end = Date.now() - DAY;
    await d1(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('${tableId}', 'IT 기록 테이블', 6, 10, 20, 400, 2000, 'closed')`);
    await d1(
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ` +
        [1, 2, 3, 4, 5].map((i) => `('${tableId}-h${i}', '${tableId}', ${i}, ${end + i * 1000 - 500}, ${end + i * 1000}, '["As","Kd","2c"]', ${i * 100}, '1', '{}')`).join(', '),
    );
    await d1(
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES ` +
        [1, 2, 3, 4].map((i) => `('${tableId}-h${i}', '${u.me.id}', 0, '[]', 1000, 1000, 0, 0, 0, ${end + i * 1000})`).join(', '),
    );

    const byTable = await allPages<HandRow>(`/api/admin/hands?paged=1&tableId=${tableId}&limit=2`);
    expect(byTable.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(byTable.flat().map((h) => h.id)).toEqual([5, 4, 3, 2, 1].map((i) => `${tableId}-h${i}`));
    expect(byTable[0]![0]).toMatchObject({ tableId, tableName: 'IT 기록 테이블', board: ['As', 'Kd', '2c'] });
    expect(byTable[0]![0]).not.toHaveProperty('holeCards');
    expect(await audits('hand.list', `detail LIKE '%${tableId}%'`)).toEqual([]);

    const byMember = await allPages<HandRow>(`/api/admin/hands?paged=1&member=${encodeURIComponent(u.email)}&limit=3`);
    expect(byMember.map((p) => p.length)).toEqual([3, 1]);
    expect(byMember.flat().map((h) => h.id)).toEqual([4, 3, 2, 1].map((i) => `${tableId}-h${i}`));
    const both = await get<Page<HandRow>>(`/api/admin/hands?paged=1&member=${u.me.nickname}&tableId=${tableId}`);
    expect(both.items).toHaveLength(4);
    expect(both.member).toEqual({ id: u.me.id, nickname: u.me.nickname });
    expect((await get<Page<HandRow>>(`/api/admin/hands?paged=1&member=${u.me.id}&tableId=no-such-table`)).items).toEqual([]);

    const looks = await audits('hand.list', `target_id = '${u.me.id}'`);
    expect(looks.map((l) => l.detail?.page)).toEqual(['first', 'next', 'first', 'first']);
    expect(looks[0]!.detail).toMatchObject({ q: u.email, found: true, tableId: null, count: 3 });
    expect(looks[2]!.detail).toMatchObject({ tableId, count: 4 });

    // All hands: written order, pages never overlap; a cursor of the wrong kind is refused.
    const p1 = await get<Page<HandRow>>('/api/admin/hands?paged=1&limit=2');
    const p2 = await get<Page<HandRow>>(`/api/admin/hands?paged=1&limit=2&cursor=${p1.next}`);
    expect(Math.max(...p2.items.map((h) => h.seq))).toBeLessThan(Math.min(...p1.items.map((h) => h.seq)));
    expect((await admin.get(`/api/admin/hands?paged=1&tableId=${tableId}&cursor=7`)).status).toBe(400);
    expect((await admin.get('/api/admin/hands?paged=1&cursor=1.2')).status).toBe(400);
    // The plain array of before.
    const plain = await admin.get(`/api/admin/hands?tableId=${tableId}`);
    expect((plain.body as HandRow[]).map((h) => h.id)).toEqual([5, 4, 3, 2, 1].map((i) => `${tableId}-h${i}`));
  });
});

describe('tables, board posts and sent messages, by offset', () => {
  it('tables: name or id, state, kind and issue, with the number that match', async () => {
    const tag = uniq('IT목록');
    const open = uniq('it-tl-');
    const closed = uniq('it-tl-');
    await d1(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, last_issue, join_code_hash) VALUES ` +
        `('${open}', '${tag} 열림', 6, 10, 20, 400, 2000, 'open', 'room_unreachable', 'hash'), ('${closed}', '${tag} 닫힘', 6, 10, 20, 400, 2000, 'closed', NULL, NULL)`,
    );
    type T = { items: { id: string; hasJoinCode: boolean }[]; total: number; limit: number; offset: number };
    const ids = (r: T) => r.items.map((t) => t.id).sort();
    const all = await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}`);
    expect(all.total).toBe(2);
    expect(ids(all)).toEqual([open, closed].sort());
    expect(JSON.stringify(all)).not.toContain('joinCodeHash');
    expect(all.items.find((t) => t.id === open)!.hasJoinCode).toBe(true);
    expect(ids(await get<T>(`/api/admin/tables?paged=1&q=${closed}`))).toEqual([closed]);
    expect(ids(await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}&status=active`))).toEqual([open]);
    expect(ids(await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}&status=closed`))).toEqual([closed]);
    expect(ids(await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}&issue=1`))).toEqual([open]);
    expect((await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}&roomType=member`)).total).toBe(0);
    const second = await get<T>(`/api/admin/tables?paged=1&q=${encodeURIComponent(tag)}&limit=1&offset=1`);
    expect(second).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(second.items).toHaveLength(1);
    // Without `paged=1`: every table, as before (the filters are not applied).
    const plain = await admin.get(`/api/admin/tables?q=${encodeURIComponent(tag)}`);
    expect(Array.isArray(plain.body)).toBe(true);
    expect((plain.body as unknown[]).length).toBeGreaterThan(2);
  });

  it('board posts by title and state, and sent messages, say whether more follow', async () => {
    const tag = uniq('IT게시');
    for (const n of [1, 2, 3]) expect((await admin.post('/api/admin/board/notices', { title: `${tag} ${n}`, body: 'IT' })).status).toBe(201);
    type P = { items: { title: string; status: string }[]; limit: number; offset: number; more: boolean };
    const p1 = await get<P>(`/api/admin/board/posts?paged=1&q=${encodeURIComponent(tag)}&limit=2`);
    expect(p1.items).toHaveLength(2);
    expect(p1.more).toBe(true);
    const p2 = await get<P>(`/api/admin/board/posts?paged=1&q=${encodeURIComponent(tag)}&limit=2&offset=2`);
    expect(p2).toMatchObject({ offset: 2, more: false });
    expect([...p1.items, ...p2.items].map((p) => p.title).sort()).toEqual([1, 2, 3].map((n) => `${tag} ${n}`));
    expect((await get<P>(`/api/admin/board/posts?paged=1&q=${encodeURIComponent(tag)}&status=hidden`)).items).toEqual([]);
    expect(Array.isArray((await admin.get('/api/admin/board/posts')).body)).toBe(true);

    const u = await newUser();
    for (const n of [1, 2]) expect((await admin.post('/api/admin/messages', { userIds: [u.me.id], category: 'notice', title: `${tag} 쪽지 ${n}`, body: 'IT' })).status).toBe(201);
    type M = { items: { title: string; recipients: number }[]; limit: number; offset: number; more: boolean };
    const m1 = await get<M>('/api/admin/messages?paged=1&limit=1');
    expect(m1).toMatchObject({ limit: 1, offset: 0, more: true });
    expect(m1.items).toHaveLength(1);
    const m2 = await get<M>('/api/admin/messages?paged=1&limit=1&offset=1');
    expect(m2.items[0]!.title).not.toBe(m1.items[0]!.title);
    expect(Array.isArray((await admin.get('/api/admin/messages')).body)).toBe(true);
  });
});

describe('the confirmation of a report decision', () => {
  it('says what the decision would do and writes nothing', async () => {
    const author = await newUser();
    const r1 = await newUser();
    const r2 = await newUser();
    const created = await author.client.post('/api/board/posts', { title: `IT preview ${Date.now()}`, body: 'buy chips here' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const post = created.body as { id: string };
    const ids: string[] = [];
    for (const r of [r1, r2]) {
      const res = await r.client.post('/api/reports', { targetType: 'post', targetId: post.id, reason: 'spam' });
      expect(res.status).toBe(201);
      ids.push(res.body.id as string);
    }
    const id = ids[0]!;
    const counts = async () =>
      (
        await d1<Record<string, number>>(
          `SELECT (SELECT COUNT(*) FROM reports WHERE target_id = '${post.id}' AND status = 'open') AS open,
                  (SELECT COUNT(*) FROM report_events WHERE report_id IN ('${ids.join("','")}')) AS events,
                  (SELECT COUNT(*) FROM messages WHERE user_id IN ('${author.me.id}', '${r1.me.id}', '${r2.me.id}')) AS messages,
                  (SELECT COUNT(*) FROM admin_audit_log WHERE target_id = '${id}' AND outcome = 'ok') AS audits,
                  (SELECT status = 'visible' FROM posts WHERE id = '${post.id}') AS visible`,
        )
      )[0];
    const before = await counts();

    const full = await admin.post(`/api/admin/reports/${id}`, { status: 'resolved', hideContent: true, notifyReporter: true, notifyTarget: true, note: 'IT', preview: true });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body).toEqual({ preview: true, status: 'resolved', closes: 2, notify: { reporters: 2, target: 1 }, hides: true });
    const quiet = await admin.post(`/api/admin/reports/${id}`, { status: 'dismissed', preview: true });
    expect(quiet.body).toEqual({ preview: true, status: 'dismissed', closes: 2, notify: { reporters: 0, target: 0 }, hides: false });
    // The same checks as the decision itself: the target is told only of an upheld report.
    expect((await admin.post(`/api/admin/reports/${id}`, { status: 'dismissed', notifyTarget: true, preview: true })).status).toBe(400);
    expect(await counts()).toEqual(before);
    // Only the refusal is recorded, as a failed attempt marked as a preview.
    const failed = await audits('report.resolve.failed', `target_id = '${id}'`);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toMatchObject({ status: 400, preview: true });

    // The decision then does what the confirmation said.
    const done = await admin.post(`/api/admin/reports/${id}`, { status: 'resolved', hideContent: true, notifyReporter: true, notifyTarget: true, note: 'IT' });
    expect(done.body).toEqual({ ok: true, closed: 2, notified: { reporters: 2, target: 1 } });
    const after = (await counts())!;
    expect(after).toMatchObject({ open: 0, visible: 0, messages: before!.messages! + 3 });
    // Once decided, a preview is refused like the decision.
    expect((await admin.post(`/api/admin/reports/${id}`, { status: 'resolved', preview: true })).status).toBe(409);
  });
});
