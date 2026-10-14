import { expect } from '@playwright/test';
import { playOneHand, signUp, sitWith, test, widerThanDevice } from './helpers';

test('mobile: my statistics, positions and the daily trend fit the phone in Korean and English', async ({ browser }) => {
  const m = await signUp(browser, { mobile: true });
  const o = await signUp(browser);
  await sitWith(m.page, 'e2e-stats-m', 500);
  await sitWith(o.page, 'e2e-stats-m', 500);
  await playOneHand(m.page, o.page);

  await m.page.goto('/me');
  await expect(m.page.getByTestId('stats')).toBeVisible();
  await expect(m.page.getByTestId('stats-vpip')).toContainText('/ 1 핸드');
  await expect(m.page.getByTestId('stats-wtsd')).toContainText('100%');
  const trend = m.page.getByTestId('stats-trend');
  await expect(trend.getByTestId('stats-trend-summary')).toContainText('1핸드');
  expect(await widerThanDevice(m.page)).toBe(false);
  // The position table keeps its five columns on the phone (the long names give way to the codes).
  const table = m.page.getByTestId('stats-positions');
  await table.scrollIntoViewIfNeeded();
  const tb = (await table.boundingBox())!;
  expect(tb.x).toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width).toBeLessThanOrEqual(390);
  await m.page.screenshot({ path: 'test-results/me-stats-mobile.png', animations: 'disabled' });

  // Tapping today's bar spells the day out; the period buttons are thumb-sized.
  const chart = trend.getByTestId('stats-trend-chart');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  // Today carries a mark: a bar, or a grey mark on the zero line if the hand broke even (a split pot).
  await expect(chart.locator('[data-testid=stats-trend-bar], [data-testid=stats-trend-even]')).toHaveCount(1);
  await chart.tap({ position: { x: box.width - 3, y: box.height / 2 } });
  await expect(trend.getByTestId('stats-trend-selected')).toContainText('1핸드');
  for (const d of [7, 30, 90]) expect((await trend.getByTestId(`stats-days-${d}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await trend.getByTestId('stats-days-90').tap();
  await expect(trend.getByTestId('stats-days-90')).toHaveAttribute('aria-checked', 'true');
  await expect(trend.getByTestId('stats-trend-summary')).toContainText('1핸드');
  await m.page.getByTestId('stats-definitions').locator('summary').tap();
  await expect(m.page.getByTestId('stats-definitions').locator('li')).toHaveCount(9);
  expect(await widerThanDevice(m.page)).toBe(false);
  await trend.scrollIntoViewIfNeeded();
  await m.page.screenshot({ path: 'test-results/me-stats-trend-mobile.png', animations: 'disabled' });

  // English, with its longer labels: chosen in the settings the way a phone user does (it is saved on the account).
  await m.page.getByTestId('settings-open').tap();
  const saved = m.page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH' && r.ok());
  await m.page.getByLabel('언어').selectOption('en');
  await saved;
  await m.page.reload();
  await expect(m.page.getByTestId('stats-vpip')).toContainText('Hands');
  await expect(m.page.getByTestId('stats-vpip')).toContainText('/ 1');
  await expect(m.page.getByTestId('stats-trend-summary')).toContainText('Hands 1');
  await m.page.getByTestId('stats-definitions').locator('summary').tap();
  await expect(m.page.getByTestId('stats-definitions')).toContainText('Hands you watched don’t');
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.getByTestId('stats').scrollIntoViewIfNeeded();
  await m.page.screenshot({ path: 'test-results/me-stats-mobile-en.png', fullPage: true, animations: 'disabled' });
});
