// The console's member, ledger and audit lists over thousands of rows: every page is walked to the end, and the pages
// together hold each matching row exactly once, in order, with the totals the first page announced. Its own worker and
// state, so the rows seeded here do not change what other files count (new members per day, ledger checks).
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupBody, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';

const MEMBERS = 5_000;
/** One member with a long history; their rows share a millisecond seven at a time. */
const HEAVY_ROWS = 3_000;
const AUDIT_ROWS = 25_000;

/**
 * Written straight into the local D1 file before the worker starts. Every wallet equals its ledger (10,005 chips).
 * Members: every 10th suspended, every 3rd English. Ledger: a grant then +5 / −5 rows; every 100th member also has an
 * admin_adjust pair (a rare type spread through the table). Audit: one seeded administrator's 25,000 entries, five per
 * millisecond, four actions in turn, every 20th failed, every 1,000th with a word to search for.
 */
function seed(state: string, at: number) {
  const dir = resolve(state, 'v3/d1/miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`expected one local D1 file, found ${files.join(', ') || 'none'}`);
  const db = new DatabaseSync(resolve(dir, files[0]!));
  const users = at - 30 * 86_400_000;
  const audit = at - 3 * 86_400_000;
  db.exec('BEGIN');
  db.exec(`INSERT INTO users (id, email, nickname, password_hash, role, status, balance, locale, created_at, updated_at)
           VALUES ('bulk-admin', 'bulk-admin@ops.dev', 'bulkadmin', 'x', 'admin', 'active', 0, 'ko', ${users}, ${users})`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEMBERS})
           INSERT INTO users (id, email, nickname, password_hash, role, status, balance, locale, suspended_reason, created_at, updated_at)
           SELECT printf('bulk-u-%05d', i), printf('member%05d@bulk.dev', i), printf('bulk%05d', i), 'x', 'user',
                  CASE WHEN i % 10 = 0 THEN 'suspended' ELSE 'active' END, 10005, CASE WHEN i % 3 = 0 THEN 'en' ELSE 'ko' END,
                  CASE WHEN i % 10 = 0 THEN 'bulk seed' END, ${users} + i * 1000, ${users} + i * 1000
             FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEMBERS}),
                          r(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM r WHERE j < ${HEAVY_ROWS - 1})
           INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, created_at)
           SELECT printf('bulk-l-%05d-%04d', i, j), printf('bulk-u-%05d', i),
                  CASE WHEN j = 0 THEN 'signup_grant' WHEN i != 1 AND j >= 10 THEN 'admin_adjust' WHEN j % 2 = 1 THEN 'cash_out' ELSE 'buy_in' END,
                  CASE WHEN j = 0 THEN 10000 WHEN i != 1 AND j = 10 THEN 5 WHEN i != 1 AND j = 11 THEN -5 WHEN j % 2 = 1 THEN 5 ELSE -5 END,
                  CASE WHEN i != 1 AND j = 10 THEN 10010 WHEN i != 1 AND j = 11 THEN 10005 WHEN j % 2 = 1 THEN 10005 ELSE 10000 END,
                  printf('bulk:%05d:%04d', i, j),
                  CASE WHEN i = 1 THEN ${users} + 10000 + j / 7 ELSE ${users} + i * 10000 + j END
             FROM n JOIN r ON r.j < CASE WHEN i = 1 THEN ${HEAVY_ROWS} WHEN i % 100 = 0 THEN 12 ELSE 10 END
            ORDER BY i, j`);
  db.exec(`WITH RECURSIVE n(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM n WHERE k < ${AUDIT_ROWS - 1})
           INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, created_at, outcome)
           SELECT printf('bulk-a-%05d', k), 'bulk-admin',
                  CASE k % 4 WHEN 0 THEN 'user.list' WHEN 1 THEN 'ledger.view' WHEN 2 THEN 'user.suspend' ELSE 'table.close' END,
                  CASE k % 4 WHEN 1 THEN NULL WHEN 3 THEN 'table' ELSE 'user' END,
                  CASE k % 4 WHEN 1 THEN NULL WHEN 3 THEN 'it-admin-0' ELSE printf('bulk-u-%05d', (k / 4) % ${MEMBERS} + 1) END,
                  CASE WHEN k % 1000 = 0 THEN printf('{"k":%d,"note":"needle-in-bulk"}', k) ELSE printf('{"k":%d}', k) END,
                  ${audit} + k / 5,
                  CASE WHEN k % 20 = 19 THEN 'failed' ELSE 'ok' END
             FROM n`);
  db.exec('COMMIT');
  db.close();
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const timings: Record<string, number[]> = {};
async function timed<T>(label: string, run: () => Promise<T>) {
  const t0 = performance.now();
  const out = await run();
  (timings[label] ??= []).push(performance.now() - t0);
  return out;
}

describe('admin lists over thousands of rows', () => {
  const state = resolve(root, 'tests/.state/bulk');
  const port = 8813;
  let worker: RunningWorker | undefined;
  let admin: Client;

  beforeAll(async () => {
    await prepareState(state, TABLES.slice(0, 1));
    seed(state, Date.now());
    worker = await startWorker(port, state);
    const email = `boss-${Date.now()}@ops.dev`;
    const m = new Client(WEB_ORIGIN, worker.url);
    expect((await m.post('/api/auth/register', await signupBody(m, { email, nickname: `boss${Date.now() % 100000}` }))).status).toBe(201);
    await d1(`UPDATE users SET role = 'super_admin' WHERE id = '${(await m.get('/api/auth/me')).body.id}'`, state);
    admin = new Client('http://localhost:5174', worker.url);
    expect((await admin.post('/api/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  }, 240_000);

  afterAll(async () => {
    await worker?.stop();
    const line = Object.entries(timings).map(([k, v]) => `${k} n=${v.length} median=${median(v).toFixed(1)} max=${Math.max(...v).toFixed(1)}`);
    console.log(`BULK timings (ms, local workerd)\n${line.join('\n')}`);
  });

  type Member = { id: string; createdAt: number; balance: number; status: string };
  /** Every page of a member list, `limit` at a time, until the announced total is reached. */
  async function allMembers(label: string, query: string) {
    const first = await timed(label, () => admin.get(`/api/admin/users?paged=1&limit=200&${query}`));
    expect(first.status).toBe(200);
    const total = first.body.total as number;
    const items: Member[] = [...first.body.items];
    for (let offset = 200; offset < total; offset += 200) {
      const r = await timed(label, () => admin.get(`/api/admin/users?paged=1&limit=200&offset=${offset}&${query}`));
      expect(r.body.total).toBe(total);
      items.push(...r.body.items);
    }
    return { total, items };
  }

  it(`members: ${MEMBERS} found, listed once each in every sort (ties included), filters counted exactly`, async () => {
    const byCreated = await allMembers('users created', 'q=bulk.dev');
    expect(byCreated.total).toBe(MEMBERS);
    expect(new Set(byCreated.items.map((m) => m.id)).size).toBe(MEMBERS);
    for (let i = 1; i < byCreated.items.length; i++) expect(byCreated.items[i - 1]!.createdAt).toBeGreaterThan(byCreated.items[i]!.createdAt);
    expect(byCreated.items[0]!.id).toBe(`bulk-u-0${MEMBERS}`);

    // Every balance is the same: only the tie-breakers order these pages, and still no member is shown twice or skipped.
    const byBalance = await allMembers('users balance (all tied)', 'q=bulk.dev&sort=balance');
    expect(byBalance.total).toBe(MEMBERS);
    expect(new Set(byBalance.items.map((m) => m.id)).size).toBe(MEMBERS);
    expect(byBalance.items.every((m) => m.balance === 10_005)).toBe(true);

    const suspended = await allMembers('users suspended', 'q=bulk.dev&status=suspended');
    expect(suspended.total).toBe(MEMBERS / 10);
    expect(new Set(suspended.items.map((m) => m.id)).size).toBe(MEMBERS / 10);
    expect(suspended.items.every((m) => m.status === 'suspended')).toBe(true);
    const english = await timed('users en', () => admin.get('/api/admin/users?paged=1&limit=200&q=bulk.dev&locale=en'));
    expect(english.body.total).toBe(Math.floor(MEMBERS / 3));
    // Past the end: an empty page with the same total.
    const past = await admin.get(`/api/admin/users?paged=1&limit=200&offset=${MEMBERS}&q=bulk.dev`);
    expect(past.body).toMatchObject({ items: [], total: MEMBERS });
  }, 300_000);

  type LedgerItem = { seq: number; id: string; type: string; amount: number; createdAt: number };
  async function allLedger(label: string, query: string) {
    const items: LedgerItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await timed(label, () => admin.get(`/api/admin/ledger?paged=1&limit=200&${query}${cursor ? `&cursor=${cursor}` : ''}`));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      items.push(...r.body.items);
      cursor = r.body.next;
      pages++;
    } while (cursor && pages < 1_000);
    return { items, pages };
  }

  it('ledger: the whole ledger, one member, and a rare type, page by page, each row once in order', async () => {
    const rows = (await d1<{ n: number }>('SELECT COUNT(*) AS n FROM chip_ledger', state))[0]!.n;
    const all = await allLedger('ledger all', '');
    expect(all.items).toHaveLength(rows);
    expect(new Set(all.items.map((l) => l.id)).size).toBe(rows);
    for (let i = 1; i < all.items.length; i++) expect(all.items[i - 1]!.seq).toBeGreaterThan(all.items[i]!.seq);
    expect(all.items.reduce((s, l) => s + l.amount, 0)).toBe((await d1<{ s: number }>('SELECT SUM(amount) AS s FROM chip_ledger', state))[0]!.s);

    // The long history, seven rows to a millisecond: time then rowid keeps every row and its order.
    const heavy = await allLedger('ledger one member', 'member=bulk00001');
    expect(heavy.items).toHaveLength(HEAVY_ROWS);
    expect(new Set(heavy.items.map((l) => l.id)).size).toBe(HEAVY_ROWS);
    for (let i = 1; i < heavy.items.length; i++) {
      const [a, b] = [heavy.items[i - 1]!, heavy.items[i]!];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.seq > b.seq)).toBe(true);
    }
    expect(heavy.items.reduce((s, l) => s + l.amount, 0)).toBe(10_005);

    const rare = await allLedger('ledger rare type', 'type=admin_adjust');
    expect(rare.items).toHaveLength((MEMBERS / 100) * 2);
    expect(rare.items.every((l) => l.type === 'admin_adjust')).toBe(true);
    expect(rare.items.reduce((s, l) => s + l.amount, 0)).toBe(0);

    // Each page was recorded (what was asked, which page, how many rows).
    const [views] = await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'ledger.view' AND actor_id != 'bulk-admin'`, state);
    expect(views!.n).toBe(all.pages + heavy.pages + rare.pages);
  }, 300_000);

  type AuditItem = { id: string; action: string; outcome: string; createdAt: number };
  async function allAudit(label: string, query: string) {
    const first = await timed(label, () => admin.get(`/api/admin/audit?paged=1&limit=100&actor=bulk-admin&${query}`));
    expect(first.status).toBe(200);
    const items: AuditItem[] = [...first.body.items];
    let next = first.body.nextBefore ? { before: first.body.nextBefore as number, id: first.body.nextBeforeId as string } : null;
    for (let pages = 1; next && pages < 1_000; pages++) {
      const cur = next;
      const r = await timed(label, () => admin.get(`/api/admin/audit?paged=1&limit=100&actor=bulk-admin&${query}&before=${cur.before}&beforeId=${cur.id}`));
      expect(r.body.total).toBeUndefined();
      items.push(...r.body.items);
      next = r.body.nextBefore ? { before: r.body.nextBefore, id: r.body.nextBeforeId } : null;
    }
    for (let i = 1; i < items.length; i++) {
      const [a, b] = [items[i - 1]!, items[i]!];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)).toBe(true);
    }
    expect(new Set(items.map((a) => a.id)).size).toBe(items.length);
    return { total: first.body.total as number, capped: first.body.totalCapped as boolean, items };
  }

  it(`audit log: ${AUDIT_ROWS} entries walked to the end; the count stops at its cap, filters count exactly`, async () => {
    const all = await allAudit('audit all', '');
    expect(all).toMatchObject({ total: 10_000, capped: true });
    expect(all.items).toHaveLength(AUDIT_ROWS);

    const close = await allAudit('audit one action', 'action=table.close');
    expect(close).toMatchObject({ total: AUDIT_ROWS / 4, capped: false });
    expect(close.items).toHaveLength(AUDIT_ROWS / 4);
    expect(close.items.every((a) => a.action === 'table.close')).toBe(true);

    const family = await allAudit('audit family user.*', 'action=user.*');
    expect(family).toMatchObject({ total: 10_000, capped: true });
    expect(family.items).toHaveLength(AUDIT_ROWS / 2);
    expect(family.items.every((a) => a.action.startsWith('user.'))).toBe(true);

    const failed = await allAudit('audit failed', 'outcome=failed');
    expect(failed).toMatchObject({ total: AUDIT_ROWS / 20, capped: false });
    expect(failed.items.every((a) => a.outcome === 'failed')).toBe(true);
    expect(failed.items).toHaveLength(AUDIT_ROWS / 20);

    const text = await allAudit('audit text', 'q=needle-in-bulk');
    expect(text).toMatchObject({ total: AUDIT_ROWS / 1000, capped: false });
    expect(text.items).toHaveLength(AUDIT_ROWS / 1000);

    const target = await allAudit('audit target', 'targetType=user&targetId=bulk-u-00004');
    expect(target.total).toBe(4);
    expect(target.items.map((a) => a.id)).toEqual(['bulk-a-20014', 'bulk-a-20012', 'bulk-a-00014', 'bulk-a-00012']);
  }, 300_000);
});
