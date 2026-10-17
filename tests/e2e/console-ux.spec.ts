import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, uid } from './helpers';
import { promoteSql } from '../support/grants';

test('a slow answer for an earlier filter does not replace the list for the filter now chosen', async ({ browser }) => {
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  const post = (title: string) =>
    page.evaluate(async (t) => ((await (await fetch('/api/admin/board/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: 'E2E' }) })).json()) as { id: string }).id, title);
  await post('E2E 보이는 공지');
  const hidden = await post('E2E 숨긴 공지');
  await page.evaluate(async (id) => fetch(`/api/admin/board/posts/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'hidden' }) }), hidden);

  // The unfiltered list answers late; the hidden-only list asked for after it answers first.
  let held = 0;
  await page.route(
    (u) => u.pathname === '/api/admin/board/posts' && !u.searchParams.has('status'),
    async (route) => {
      held += 1;
      await new Promise((r) => setTimeout(r, 2_000));
      await route.continue();
    },
  );
  await page.goto(`${ADMIN}/board`);
  await page.getByRole('combobox', { name: /상태|Status/ }).selectOption('hidden');
  await expect(page.getByText('E2E 숨긴 공지')).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(held).toBeGreaterThan(0);
  await expect(page.getByText('E2E 숨긴 공지')).toBeVisible();
  await expect(page.getByText('E2E 보이는 공지')).toHaveCount(0);
});

/** The audit entries of one action, as the API returns them (to find what a look recorded). */
const auditOf = (page: Page, action: string) =>
  page.evaluate(async (a) => JSON.stringify(await (await fetch(`/api/admin/audit?paged=1&action=${a}&limit=20`)).json()), action);

test('ledger, hands and tables: filters in the URL, page by page, and each ledger look in the audit log', async ({ browser }) => {
  const op = await signUp(browser);
  const member = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  // 60 entries that cancel out (top-up −100, cash-out +100), so the wallet still matches the ledger; with the sign-up grant, 61.
  sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, created_at) ` +
      `SELECT 'e2e-cux-' || u.id || '-' || i, u.id, CASE i % 2 WHEN 1 THEN 'top_up' ELSE 'cash_out' END, CASE i % 2 WHEN 1 THEN -100 ELSE 100 END, u.balance - (i % 2) * 100, 'e2e-cux-' || u.id || '-' || i, ` +
      `(unixepoch('subsec') * 1000) + i FROM n, users u WHERE u.email = '${member.email}'`,
  );
  const tableId = uid('e2e-cux-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('${tableId}', 'E2E 콘솔 기록 테이블', 6, 10, 20, 400, 2000, 'closed')`);
  sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) ` +
      `SELECT '${tableId}-h' || i, '${tableId}', i, (unixepoch('subsec') * 1000) - 60000, (unixepoch('subsec') * 1000) + i, '[]', 100 * i, '1', '{}' FROM n`,
  );
  sql(
    `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) ` +
      `SELECT h.id, u.id, 0, '[]', 1000, 1000, 0, 0, 0, h.ended_at FROM hands h, users u WHERE h.table_id = '${tableId}' AND u.email = '${member.email}'`,
  );
  const page = await adminLogin(browser, op.email);

  // Ledger: one member by nickname, 50 a page, the next page by cursor and back.
  await page.goto(`${ADMIN}/ledger`);
  await expect(page.getByTestId('ledger-note')).toContainText('감사 로그');
  await page.getByTestId('member-q').fill(member.nickname);
  await page.getByTestId('member-q').press('Enter');
  await expect(page.getByTestId('member-chip')).toContainText(member.nickname);
  await expect(page.getByTestId('ledger-row')).toHaveCount(50);
  const pager = page.getByTestId('ledger-pager');
  await expect(pager).toContainText('1–50');
  await pager.getByTestId('page-next').click();
  await expect(pager).toContainText('51–61');
  await expect(page.getByTestId('ledger-row')).toHaveCount(11);
  await expect(page.getByTestId('ledger-row').last()).toContainText('가입 지급');
  await expect(pager.getByTestId('page-next')).toBeDisabled();
  await pager.getByTestId('page-prev').click();
  await expect(pager).toContainText('1–50');
  // A type narrows it further and starts again from the first page; the filters are in the URL.
  await page.getByTestId('ledger-type').selectOption('cash_out');
  await expect(page.getByTestId('ledger-row')).toHaveCount(30);
  await expect(pager.getByTestId('page-next')).toBeDisabled();
  expect(new URL(page.url()).searchParams.get('type')).toBe('cash_out');
  expect(new URL(page.url()).searchParams.get('member')).toBe(member.nickname);
  await page.reload();
  await expect(page.getByTestId('ledger-row')).toHaveCount(30);
  // Nobody by that name: said so, not an empty list taken for "no entries".
  await page.getByTestId('member-q').fill('e2e-nobody-at-all');
  await page.getByTestId('member-q').press('Enter');
  await expect(page.getByTestId('member-none')).toContainText('"e2e-nobody-at-all"에 해당하는 회원이 없습니다.');
  await page.getByTestId('ledger-reset').click();
  await expect(page.getByTestId('member-none')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  // Every look is recorded: what was searched, whether it found someone, the filters and which page.
  const ledgerAudit = await auditOf(page, 'ledger.view');
  expect(ledgerAudit).toContain(member.nickname);
  expect(ledgerAudit).toContain('cash_out');
  expect(ledgerAudit).toContain('e2e-nobody-at-all');
  expect(ledgerAudit).toContain('next');

  // Hands of a member, then of one table, from the table name; each detail link stays.
  await page.goto(`${ADMIN}/hands?member=${encodeURIComponent(member.email)}`);
  await expect(page.getByTestId('member-chip')).toContainText(member.nickname);
  const rows = page.getByTestId('hands-page').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('main a[href^="/hands/"]')).toHaveCount(3);
  await rows.first().getByRole('button', { name: 'E2E 콘솔 기록 테이블' }).click();
  await expect(page.getByTestId('table-chip')).toContainText('E2E 콘솔 기록 테이블');
  expect(new URL(page.url()).searchParams.get('tableId')).toBe(tableId);
  await expect(rows).toHaveCount(3);
  await page.getByTestId('hands-reset').click();
  await expect(page.getByTestId('table-chip')).toHaveCount(0);
  expect(await auditOf(page, 'hand.list')).toContain(member.email);

  // Tables: by name or id, by state; "active" leaves out a closed table.
  await page.goto(`${ADMIN}/tables`);
  await page.getByTestId('table-q').fill(tableId);
  await page.getByTestId('table-q').press('Enter');
  await expect(page.getByText('E2E 콘솔 기록 테이블')).toBeVisible();
  await page.getByTestId('table-status').selectOption('active');
  await expect(page.getByTestId('list-empty')).toContainText('조건에 맞는 항목이 없습니다.');
  await page.getByTestId('table-status').selectOption('closed');
  await expect(page.getByText('E2E 콘솔 기록 테이블')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('a post is deleted and a message sent only after a confirmation that says what will happen', async ({ browser }) => {
  const op = await signUp(browser);
  const member = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  const title = `E2E 삭제 확인 ${uid('p')}`;
  await page.evaluate(async (t) => fetch('/api/admin/board/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: 'E2E' }) }), title);

  await page.goto(`${ADMIN}/board`);
  await page.getByTestId('board-q').fill(title);
  await page.getByTestId('board-q').press('Enter');
  const row = page.getByTestId('board-row').filter({ hasText: title });
  await expect(page.getByTestId('board-row')).toHaveCount(1);
  await row.getByTestId('post-delete').click();
  await expect(page.getByTestId('post-delete-text')).toContainText(`"${title}" 글을 삭제 상태로 바꿉니다.`);
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click();
  await expect(row).toContainText('공개');
  await row.getByTestId('post-delete').click();
  await page.getByTestId('post-delete-confirm').click();
  await expect(page.getByTestId('feedback')).toHaveText('저장되었습니다.');
  await expect(row).toContainText('삭제됨');

  await page.goto(`${ADMIN}/messages`);
  await page.getByLabel('이메일·닉네임·ID 검색').fill(member.nickname);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('button', { name: `${member.nickname} +` }).click();
  await page.getByLabel('제목', { exact: true }).fill('E2E 확인 후 발송');
  await page.getByLabel('내용', { exact: true }).fill('확인 창을 거친 쪽지');
  await page.getByTestId('send-message').click();
  await expect(page.getByTestId('send-summary')).toContainText('1명에게 쪽지를 보냅니다(한국어 1명 · 영어 0명). 보낸 쪽지는 회수할 수 없습니다.');
  await page.getByTestId('send-confirm').click();
  await expect(page.getByTestId('feedback')).toHaveText('1명에게 발송했습니다.');
  await expect(page.getByText('E2E 확인 후 발송')).toBeVisible();
  await member.page.goto('/messages');
  await expect(member.page.getByText('E2E 확인 후 발송')).toBeVisible();
});

test('a list that cannot load says so with a retry, and the console says when the network or the server is away', async ({ browser }) => {
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  const ledger = (u: URL) => u.pathname === '/api/admin/ledger';
  await page.route(ledger, (r) => r.abort('internetdisconnected'));
  await page.goto(`${ADMIN}/ledger`);
  await expect(page.getByTestId('load-error')).toContainText('불러오지 못했습니다');
  await expect(page.getByTestId('conn-banner')).toContainText('서버에 연결하지 못했습니다');
  await page.unroute(ledger);
  await page.getByTestId('retry').click();
  await expect(page.getByTestId('load-error')).toHaveCount(0);
  await expect(page.getByTestId('ledger-row').first()).toBeVisible();
  await expect(page.getByTestId('conn-banner')).toHaveCount(0);

  await page.context().setOffline(true);
  await expect(page.getByTestId('conn-banner')).toContainText('인터넷 연결이 끊겼습니다');
  await page.context().setOffline(false);
  await expect(page.getByTestId('conn-banner')).toHaveCount(0);
});
