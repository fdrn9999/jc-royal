import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PASSWORD, signUp, test } from './helpers';

const ADMIN = 'http://localhost:5174';

test('admin console: bootstrap, login, create table, adjust chips with password re-confirmation, member is notified', async ({ browser, request }) => {
  // The owner registers on the player site, then is promoted with the deployment bootstrap token.
  const owner = await signUp(browser);
  const boot = await request.post(`${ADMIN}/api/admin/auth/bootstrap`, { headers: { Origin: ADMIN }, data: { token: 'e2e-bootstrap-token-0123456789', email: owner.email } });
  expect(boot.status()).toBe(200);
  const member = await signUp(browser);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(owner.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  // The live part refreshes itself while watched; errors and connections come from the server's counters.
  await expect(page.getByTestId('live-state')).toContainText('30초마다 자동 갱신');
  await expect(page.getByTestId('live-meta')).toContainText('읽은 행');
  await expect(page.getByTestId('ops-stats')).toContainText('최근 5분 오류');
  await expect(page.getByTestId('totals')).toBeVisible();

  // Create a table → visible in the player lobby.
  await page.getByRole('link', { name: /^테이블$|^Tables$/ }).click();
  await page.getByTestId('create-table').click();
  // Typing key by key must keep focus in the field (each keystroke re-renders the page).
  const name = page.getByLabel(/^이름$|^Name$/);
  await name.click();
  await name.pressSequentially('Royal');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Royal');
  await name.fill('E2E 로열 라운지');
  await page.getByRole('button', { name: /^저장$|^Save$/ }).click();
  await expect(page.getByText('E2E 로열 라운지')).toBeVisible();
  await member.page.reload();
  await expect(member.page.getByText('E2E 로열 라운지')).toBeVisible();

  // Chip grant: the balance before and after is shown first, then the admin password is asked again.
  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await page.getByPlaceholder(/검색|Search/).fill(member.nickname);
  await page.getByPlaceholder(/검색|Search/).press('Enter');
  await page.getByRole('link', { name: /상세|Details/ }).first().click();
  await page.getByLabel(/금액|Amount/).fill('777');
  // The chip memo, not the internal-note box further down.
  await page.getByLabel(/^메모$|^Memo$/).fill('E2E 이벤트');
  await page.getByTestId('chip-submit').click();
  await expect(page.getByTestId('confirm-change')).toContainText('10,000 → 10,777');
  await expect(page.getByTestId('change-preview')).toContainText('+777');
  await page.getByTestId('confirm-end').click();
  await expect(page.getByTestId('reauth-confirm')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByTestId('reauth-confirm').click();
  await expect(page.getByRole('cell', { name: '+777' })).toBeVisible();
  // The member's history lists the adjustment with its memo.
  await expect(page.getByTestId('history')).toContainText('+777 · E2E 이벤트');
  // The member's already-open tab picks up the new balance on return, without a reload.
  await member.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(member.page.getByTestId('balance')).toContainText('10,777');

  // The member sees the new balance and an automatic event message.
  await member.page.goto('/messages');
  await expect(member.page.getByText('가상 칩 지급 안내')).toBeVisible();
  await expect(member.page.getByTestId('balance')).toContainText('10,777');

  // Member detail shows the sign-up fields; a reset link comes with a ready-to-send message.
  await expect(page.getByTestId('member-info')).toContainText('1990-01-01');
  await expect(page.getByTestId('member-info')).toContainText(/한국어|Korean/);
  await page.getByTestId('reset-link').click();
  await expect(page.getByTestId('reset-result')).toContainText(/https?:\/\/[^/]+\/reset\?token=/);
  await expect(page.getByTestId('reset-message')).toContainText(/비밀번호 재설정|Reset your password/);
  await page.screenshot({ path: 'test-results/admin-member-detail.png', fullPage: true });

  // Members list: select (all shown / one by one) and export the selection as CSV.
  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await page.getByTestId('lang-filter').selectOption('ko');
  const all = page.getByTestId('select-all');
  await all.check();
  const rows = page.locator('tbody').getByRole('checkbox');
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  await expect(page.getByTestId('export-bar')).toContainText(new RegExp(`${n}명 선택됨|${n} selected`));
  await rows.first().uncheck();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await rows.first().check();
  await page.screenshot({ path: 'test-results/admin-users-selected.png', fullPage: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^jc-royal-members-\d{8}-\d{4}\.csv$/);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('id,email,nickname,language,role,status,balance,joined_at_utc,birth_date');
  expect(csv).toContain(member.email);
  expect(csv.trimEnd().split('\r\n')).toHaveLength(n + 1);
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`${n}명의 정보를 내보냈습니다|Exported ${n} members`) })).toBeVisible();

  // Reports: the member's post is reported from the player site; the admin hides it while resolving.
  const postId = await member.page.evaluate(async () => {
    const r = await fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E 신고 처리 글', body: '신고될 본문' }) });
    return ((await r.json()) as { id: string }).id;
  });
  const filed = await owner.page.evaluate(async (id) => {
    const r = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType: 'post', targetId: id, reason: 'spam', detail: 'E2E 신고 사유' }) });
    return r.status;
  }, postId);
  expect(filed).toBe(201);
  await page.getByRole('link', { name: /^신고 관리$|^Reports$/ }).click();
  const item = page.getByTestId('report-item').filter({ hasText: 'E2E 신고 처리 글' });
  await expect(item).toContainText('E2E 신고 사유');
  await expect(item).toContainText(member.nickname);
  await item.getByTestId('report-hide').check();
  await item.getByLabel(/처리 내용|Resolution note/).fill('광고 글 숨김');
  await item.getByTestId('report-resolve').click();
  // The decision waits in a confirmation that shows what it will do (the server's preview).
  await expect(page.getByTestId('report-preview')).toContainText(/열린 신고 1건|close with it: 1/);
  await expect(page.getByTestId('report-preview')).toContainText(/신고된 글·댓글을 숨깁니다|The reported post or comment is hidden/);
  await page.getByTestId('report-confirm').click();
  await expect(page.getByRole('status').filter({ hasText: /1건|1 report/ })).toBeVisible();
  await expect(item).toHaveCount(0);
  await page.getByTestId('report-status').selectOption('resolved');
  await expect(item).toContainText('광고 글 숨김');
  await expect(item).toContainText('숨김');
  await member.page.goto(`/board/${postId}`);
  await expect(member.page.getByTestId('post-title')).toHaveCount(0);
  // Member detail links to the reports about that member.
  await item.getByRole('link', { name: member.nickname }).click();
  await page.getByTestId('user-reports').click();
  await expect(page.getByTestId('report-user-filter')).toContainText(member.nickname);
  await expect(page.getByTestId('report-item')).toHaveCount(1);
});
