import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

const ADMIN = 'http://localhost:5174';

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

/** Sensitive changes ask for the password again unless it was confirmed a few minutes ago. */
async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').filter({ has: prompt }).getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await prompt.click();
  }
}

const fileReport = (page: Page, body: Record<string, string>) =>
  page.evaluate(async (b) => (await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, body);

test('report workflow: severity, assignment, internal notes, a suspension given from the report, outcome messages, and reference statistics', async ({ browser }) => {
  test.setTimeout(180_000);
  const bad = await signUp(browser);
  const r1 = await signUp(browser);
  const r2 = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));

  // Two members report the same post.
  const title = `E2E 반복 광고 ${Date.now().toString(36)}`;
  const postId = await bad.page.evaluate(async (t) => {
    const r = await fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: '광고 링크' }) });
    return ((await r.json()) as { id: string }).id;
  }, title);
  expect(await fileReport(r1.page, { targetType: 'post', targetId: postId, reason: 'spam', detail: 'E2E 광고 신고' })).toBe(201);
  expect(await fileReport(r2.page, { targetType: 'post', targetId: postId, reason: 'abuse' })).toBe(201);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByRole('link', { name: /^신고 관리$|^Reports$/ }).click();

  // The newer report (r2's) shows how long it has waited, the earlier one on the same member, and no sanctions yet.
  const item = page.getByTestId('report-item').filter({ hasText: title }).filter({ hasText: r2.nickname });
  await expect(item.getByTestId('report-dwell')).toContainText('대기');
  await expect(item.getByTestId('report-prior')).toContainText('다른 신고 1건 · 해결 0건 · 신고자 1명');
  await expect(item.getByTestId('report-sanctions')).toContainText('정지·강제 연결 종료 이력이 없습니다');

  // Severity, then taking it: the queue can be narrowed to "mine" and to a severity.
  await item.getByTestId('report-severity').selectOption('high');
  await expect(item).toContainText('심각도: 높음');
  await item.getByTestId('report-take').click();
  await expect(item.getByTestId('report-assignee')).toHaveValue(/.+/);
  await expect(item.getByTestId('report-release')).toBeVisible();
  await page.getByTestId('report-assignee-filter').selectOption('me');
  await expect(item).toHaveCount(1);
  await page.getByTestId('report-severity-filter').selectOption('critical');
  await expect(item).toHaveCount(0);
  await page.getByTestId('report-severity-filter').selectOption('high');
  await expect(item).toHaveCount(1);

  // History and notes: a phone number is refused; an evidence note is kept with the changes.
  await item.getByTestId('report-timeline-toggle').click();
  const log = item.getByTestId('report-log');
  await expect(log.getByTestId('report-event').filter({ hasText: '미지정 → 높음' })).toHaveCount(1);
  await expect(log.getByTestId('report-event').filter({ hasText: `미배정 → ${op.nickname}` })).toHaveCount(1);
  await log.getByTestId('report-note-input').fill('연락처 010-1234-5678');
  await log.getByTestId('report-note-add').click();
  await expect(log.getByRole('alert')).toContainText('개인정보');
  await log.getByTestId('report-note-input').fill('E2E 증거 확인: 같은 광고 링크 반복');
  await log.getByTestId('report-note-add').click();
  await expect(log.getByTestId('report-event').filter({ hasText: 'E2E 증거 확인' })).toHaveCount(1);
  await expect(log.getByTestId('report-note-input')).toHaveValue('');

  // A suspension from this report: a reason is required, the password is asked again, and the report stays open.
  await item.getByTestId('report-suspend').click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('report-suspend-confirm') });
  await expect(dialog).toContainText('신고 횟수나 자동 탐지만으로 정지하지 않습니다');
  await expect(dialog.getByTestId('report-suspend-confirm')).toBeDisabled();
  await dialog.getByTestId('report-suspend-reason').fill('E2E 반복 광고');
  await dialog.getByTestId('report-suspend-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByRole('status').filter({ hasText: `${bad.nickname}님을 정지했습니다` })).toBeVisible();
  await expect(item).toContainText('정지됨');
  await expect(item.getByTestId('report-suspend')).toHaveCount(0);
  await expect(item.getByTestId('report-sanctions')).toContainText('E2E 반복 광고');
  await expect(item.getByTestId('report-sanctions')).toContainText('이 신고로 조치');
  await expect(log.getByTestId('report-event').filter({ hasText: 'E2E 반복 광고' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/admin-reports.png', fullPage: true });

  // Upheld, telling the reporters and the member: both reports on the post close; three messages go out.
  await item.getByTestId('report-notify-reporter').check();
  await item.getByTestId('report-notify-target').check();
  await item.getByLabel(/처리 내용|Resolution note/).fill('광고 글 반복');
  await item.getByTestId('report-resolve').click();
  // Nothing is decided until the confirmation, which says what will happen: both reports close, 2 reporters and the member are told.
  const preview = page.getByTestId('report-preview');
  await expect(preview).toContainText('같은 대상의 열린 신고 2건이 함께 닫힙니다.');
  await expect(preview).toContainText('결과 안내 쪽지: 신고자 2명, 피신고 회원 1명');
  await expect(preview).toContainText('광고 글 반복');
  await page.getByTestId('report-confirm').click();
  await expect(page.getByRole('status')).toContainText('같은 대상의 신고 2건을 처리했습니다. 안내 쪽지 3건을 보냈습니다.');
  await expect(item).toHaveCount(0);
  await page.getByTestId('report-assignee-filter').selectOption('');
  await page.getByTestId('report-severity-filter').selectOption('');
  await page.getByTestId('report-status').selectOption('resolved');
  await expect(item.getByTestId('report-dwell')).toContainText('처리까지');
  await expect(item.getByTestId('report-notice')).toContainText('결과 안내: 신고자, 신고 대상');
  await expect(item.getByTestId('report-handled')).toContainText('광고 글 반복');

  // The reporter reads the outcome in their inbox, without the other reporter's name or the internal note.
  await r1.page.goto('/messages');
  await expect(r1.page.getByText('신고 처리 결과 안내').first()).toBeVisible();
  await expect(r1.page.locator('body')).not.toContainText(r2.nickname);
  await expect(r1.page.locator('body')).not.toContainText('E2E 증거 확인');

  // Statistics: reference figures only, with the member reported twice in the period.
  await page.getByTestId('report-view-stats').click();
  await expect(page).toHaveURL(/view=stats/);
  const stats = page.getByTestId('report-stats');
  await expect(stats.getByTestId('report-stats-repeated')).toContainText('신고 수만으로 정지하지 않으며');
  const row = stats.getByTestId('report-repeated-row').filter({ hasText: bad.nickname });
  await expect(row).toContainText('정지됨');
  await page.getByTestId('report-stats-7').click();
  await expect(page.getByTestId('report-stats-7')).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toHaveCount(1);
  await page.screenshot({ path: 'test-results/admin-reports-stats.png', fullPage: true });
  await row.getByRole('link', { name: /신고 보기/ }).click();
  await expect(page.getByTestId('report-user-filter')).toContainText(bad.nickname);
  await expect(page.getByTestId('report-item')).toHaveCount(2);

  // English, and a phone-width window: the queue and the statistics fit.
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByTestId('report-view-stats')).toHaveText('Statistics');
  await expect(page.getByTestId('report-item').first().getByTestId('report-notice')).toContainText('Outcome sent to: Reporter, Reported');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/admin-reports-mobile-en.png', fullPage: true });
  await page.getByTestId('report-view-stats').click();
  await expect(page.getByTestId('report-stats')).toContainText('For reference only');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/admin-reports-stats-mobile-en.png', fullPage: true });
  await page.getByRole('button', { name: '한국어', exact: true }).click();
});
