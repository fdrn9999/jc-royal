import { expect } from '@playwright/test';
import { ADMIN, adminLogin, iso, seedStats, sql, today } from './analytics-helpers';
import { signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

test('operations stats on a phone: the page fits the screen, the wide table scrolls inside its panel, and the period buttons work by touch', async ({ browser }) => {
  const op = await signUp(browser, { mobile: true });
  sql(promoteSql(`email = '${op.email}'`));
  seedStats();
  const page = await adminLogin(browser, op.email, { mobile: true });
  await page.goto(`${ADMIN}/stats`);
  await expect(page.getByTestId('stats-hands-day')).toHaveText('50');
  expect(await widerThanDevice(page)).toBe(false);

  // The table is wider than the phone; its own box scrolls, the page does not.
  const box = page.getByTestId('stats-table').locator('table').locator('..');
  const fits = await box.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).overflowX }));
  expect(fits.scroll).toBeGreaterThan(fits.client);
  expect(fits.overflow).toMatch(/auto|scroll/);
  // Column headings stay on one line.
  const heights = await page.getByTestId('stats-table').locator('thead th').evaluateAll((ths) => ths.map((th) => th.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThan(2 * Math.min(...heights));

  await page.getByTestId('stats-month').tap();
  await expect(page).toHaveURL(`${ADMIN}/stats?unit=month`);
  await expect(page.getByTestId('stats-table').locator('tbody tr').first()).toHaveAttribute('data-period', `${iso(today() - 1).slice(0, 7)}-01`);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/admin-stats-mobile.png', fullPage: true });
});
