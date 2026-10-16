import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN, adminLogin, seedStats, sql } from './analytics-helpers';
import { idOf, seedHands } from './hand-review-seed';
import { signUp, test, widerThanDevice } from './helpers';

const listed = (page: Page, ids: Record<string, string>) =>
  page
    .getByTestId('hand-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-hand')))
    .then((xs) => xs.map((x) => Object.keys(ids).find((k) => ids[k] === x) ?? x));

/** At least 40 × 40 CSS pixels, so a thumb finds it. */
const tapSize = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return Math.min(b.width, b.height);
};

test('mobile: hand list filters fold away, bookmarks and tags are thumb-sized, the memo saves, and the pot odds fit the screen', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const ids = seedHands(await idOf(a.page), await idOf(b.page));
  const page = a.page;

  await page.goto('/me');
  await page.getByTestId('me-all-hands').tap();
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'B', 'C', 'D']);
  expect(await widerThanDevice(page)).toBe(false);
  // The filters are folded so the hands come first; one tap opens them.
  await expect(page.getByTestId('hands-position')).toBeHidden();
  await page.getByTestId('hands-filters-toggle').tap();
  await page.getByTestId('hands-position').selectOption('BTN');
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'C']);
  await expect(page.getByTestId('hands-filters-toggle')).toContainText('(1)');
  expect(await widerThanDevice(page)).toBe(false);

  const rowC = page.locator(`[data-testid=hand-row][data-hand="${ids.C}"]`);
  const mark = rowC.getByTestId('hand-bookmark');
  expect(await tapSize(mark)).toBeGreaterThanOrEqual(40);
  await mark.tap();
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('hands-mobile.png'), fullPage: true });

  await page.locator(`[data-testid=hand-row][data-hand="${ids.A}"]`).getByRole('link').tap();
  await expect(page).toHaveURL(`/me/hands/${ids.A}`);
  const note = page.getByTestId('hand-note');
  const tag = note.locator('[data-tag=hardCall]');
  expect(await tapSize(tag)).toBeGreaterThanOrEqual(40);
  await tag.tap();
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('hand-memo').fill('플랍 콜은 괜찮았고 턴 폴드는 다시 보기');
  await page.getByTestId('hand-memo-save').tap();
  await expect(page.getByTestId('hand-memo-status')).toHaveText('저장되었습니다.');
  await expect(page.getByTestId('pot-odds')).toHaveCount(3);
  // Each pot-odds line stays inside the screen.
  const right = await page.getByTestId('pot-odds').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
  expect(right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await widerThanDevice(page)).toBe(false);
  await note.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('hand-note-mobile.png') });
  await page.getByTestId('pot-odds-note').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('pot-odds-mobile.png') });

  // The memo stays after a reload.
  await page.reload();
  await expect(page.getByTestId('hand-memo')).toHaveValue('플랍 콜은 괜찮았고 턴 폴드는 다시 보기');
  await expect(page.getByTestId('hand-note').locator('[data-tag=hardCall]')).toHaveAttribute('aria-pressed', 'true');

  // The operator's panel on a phone.
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'admin' WHERE email = '${op.email}'`);
  seedStats();
  const admin = await adminLogin(browser, op.email, { mobile: true });
  await admin.goto(`${ADMIN}/stats`);
  const panel = admin.getByTestId('stats-hand-notes');
  await expect(admin.getByTestId('stats-hn-now')).toHaveText(/^[1-9]\d*$/);
  await expect(admin.locator('body')).not.toContainText('턴 폴드는 다시 보기');
  expect(await widerThanDevice(admin)).toBe(false);
  await panel.scrollIntoViewIfNeeded();
  await admin.screenshot({ path: test.info().outputPath('admin-hand-notes-mobile.png') });
});
