import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, widerThanDevice } from './helpers';

/** The open dialog stays inside the phone's width, and its ✕ is named in Korean. */
async function dialogFits(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '닫기' })).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('on a phone: a member’s ledger, a report decided through its confirmation, and a post deleted after one, without sideways scrolling', async ({ browser }) => {
  const bad = await signUp(browser, { mobile: true });
  const reporter = await signUp(browser, { mobile: true });
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'admin' WHERE email = '${op.email}'`);
  const title = `E2E 모바일 신고 ${Date.now().toString(36)}`;
  const postId = await bad.page.evaluate(async (t) => {
    const r = await fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: '광고 링크' }) });
    return ((await r.json()) as { id: string }).id;
  }, title);
  const filed = await reporter.page.evaluate(
    async (id) => (await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType: 'post', targetId: id, reason: 'spam' }) })).status,
    postId,
  );
  expect(filed).toBe(201);
  const page = await adminLogin(browser, op.email, { mobile: true });

  // The ledger of one member: their sign-up grant, the access note, the table scrolls inside its panel only.
  await page.goto(`${ADMIN}/ledger`);
  await page.getByTestId('member-q').fill(reporter.nickname);
  await page.getByTestId('member-q').press('Enter');
  await expect(page.getByTestId('member-chip')).toContainText(reporter.nickname);
  await expect(page.getByTestId('ledger-row')).toHaveCount(1);
  await expect(page.getByTestId('ledger-row')).toContainText('가입 지급');
  await expect(page.getByTestId('ledger-note')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);

  // A report: deciding opens a confirmation saying what will happen; nothing changes until it is confirmed.
  await page.goto(`${ADMIN}/reports`);
  const item = page.getByTestId('report-item').filter({ hasText: title });
  await item.getByTestId('report-resolve').click();
  await dialogFits(page);
  await expect(page.getByTestId('report-preview')).toContainText('같은 대상의 열린 신고 1건이 함께 닫힙니다.');
  expect(await widerThanDevice(page)).toBe(false);
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(item).toHaveCount(1);
  await item.getByTestId('report-resolve').click();
  await page.getByTestId('report-confirm').click();
  await expect(item).toHaveCount(0);

  // A post: deleting it asks first, in a dialog that fits the phone.
  await page.goto(`${ADMIN}/board`);
  await page.getByTestId('board-q').fill(title);
  await page.getByTestId('board-q').press('Enter');
  const row = page.getByTestId('board-row').filter({ hasText: title });
  await expect(page.getByTestId('board-row')).toHaveCount(1);
  await row.getByTestId('post-delete').click();
  await dialogFits(page);
  await expect(page.getByTestId('post-delete-text')).toContainText(title);
  await page.getByTestId('post-delete-confirm').click();
  await expect(page.getByTestId('feedback')).toHaveText('저장되었습니다.');
  await expect(row).toContainText('삭제됨');
  expect(await widerThanDevice(page)).toBe(false);
});
