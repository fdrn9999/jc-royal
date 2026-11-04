import { expect } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test, uid } from './helpers';
import { promoteSql } from '../support/grants';

// 영구 삭제 in the console (docs/ADMIN_SECURITY.md): offered to a super admin beside the ordinary delete, a plan from
// the server first, then a reason, the typed id and the password; the list no longer shows the post afterwards. A
// plain administrator sees the ordinary delete only.
test('a super admin deletes a post permanently in steps, and the board no longer lists it; a plain administrator is not offered it', async ({ browser }) => {
  const member = await signUp(browser);
  const title = `E2E 영구 삭제 ${uid('p')}`;
  const created = await member.page.evaluate(
    async (t) => (await (await fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: 'E2E 본문' }) })).json()) as { id: string },
    title,
  );
  await member.page.evaluate(async (id) => fetch(`/api/board/posts/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'E2E 댓글' }) }), created.id);

  const plain = await signUp(browser);
  sql(promoteSql(`email = '${plain.email}'`));
  const staff = await adminLogin(browser, plain.email);
  await staff.goto(`${ADMIN}/board`);
  await staff.getByTestId('board-q').fill(title);
  await staff.getByTestId('board-q').press('Enter');
  await staff.getByTestId('board-row').filter({ hasText: title }).getByTestId('post-delete').click();
  await expect(staff.getByTestId('post-delete-text')).toBeVisible();
  await expect(staff.getByTestId('delete-mode')).toHaveCount(0);
  await staff.getByRole('dialog').getByRole('button', { name: '취소' }).click();

  const boss = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);
  const page = await adminLogin(browser, boss.email);
  await page.goto(`${ADMIN}/board`);
  await page.getByTestId('board-q').fill(title);
  await page.getByTestId('board-q').press('Enter');
  const row = page.getByTestId('board-row').filter({ hasText: title });
  await expect(page.getByTestId('board-row')).toHaveCount(1);
  await row.getByTestId('post-delete').click();
  // 삭제 방식: the ordinary delete is chosen first.
  await expect(page.getByTestId('delete-mode-soft')).toBeChecked();
  await page.getByTestId('delete-mode-purge').check();
  await page.getByTestId('post-delete-confirm').click();

  // The server's plan: what goes, what stays, that nothing blocks it, who may.
  const dialog = page.getByTestId('purge-dialog');
  await expect(dialog.getByTestId('purge-plan')).toHaveAttribute('data-deletable', 'true');
  await expect(dialog.getByTestId('purge-removes')).toContainText('댓글 1건');
  await expect(dialog.getByTestId('purge-removes')).toContainText('게시글 1건');
  await expect(dialog).toContainText(created.id);
  // The text to type is shown as it must be typed (not in the label style's capitals).
  await expect(page.getByTestId('purge-confirm-label')).toContainText(created.id.slice(0, 8));
  await expect(page.getByTestId('purge-confirm-label')).toHaveCSS('text-transform', 'none');
  const submit = page.getByTestId('purge-submit');
  await expect(submit).toBeDisabled();
  await page.getByTestId('purge-reason').fill('E2E 영구 삭제 확인');
  await expect(submit).toBeDisabled();
  await page.getByTestId('purge-confirm').fill(created.id.slice(0, 7));
  await expect(submit).toBeDisabled();
  await page.getByTestId('purge-confirm').fill(created.id.slice(0, 8));
  await expect(submit).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/admin-purge-plan.png', animations: 'disabled' });
  // On a phone the plan and the buttons still fit the width, and the button can be reached.
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  const box = await page.getByTestId('purge-plan').boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await page.screenshot({ path: 'test-results/admin-purge-plan-360.png', animations: 'disabled' });
  if (desktop) await page.setViewportSize(desktop);
  await submit.click();
  // The password is asked when it is sent.
  await expect(page.getByTestId('reauth-confirm')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByTestId('reauth-confirm').click();

  await expect(page.getByTestId('feedback')).toContainText(title);
  await expect(page.getByTestId('purge-dialog')).toHaveCount(0);
  await expect(page.getByTestId('board-row').filter({ hasText: title })).toHaveCount(0);
  // Gone for members too.
  expect(await member.page.evaluate(async (id) => (await fetch(`/api/board/posts/${id}`)).status, created.id)).toBe(404);
});
