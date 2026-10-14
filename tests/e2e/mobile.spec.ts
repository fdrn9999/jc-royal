import { expect, test } from '@playwright/test';
import { checkOrCall, signUp } from './helpers';

test('mobile: lobby → seat → playable action bar, no horizontal overflow', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const overflow = () => a.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(await overflow()).toBe(false);

  await a.page.getByTestId('lobby-table').filter({ hasText: 'E2E Six' }).getByRole('button', { name: /참여|Join/ }).click();
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-six');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();

  await expect(a.page.getByTestId('table')).toHaveAttribute('data-portrait', '1');
  // Within a few actions the mobile player gets the action bar and can act with it.
  await expect(async () => {
    if (await a.page.getByTestId('action-bar').isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(a.page.getByTestId('action-bar')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  const box = await a.page.getByTestId('action-bar').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(await checkOrCall(a.page)).toBe(true);
  expect(await overflow()).toBe(false);
});
