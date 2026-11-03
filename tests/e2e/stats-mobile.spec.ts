import { expect } from '@playwright/test';
import { playOneHand, signUp, sitWith, test, widerThanDevice } from './helpers';

test('mobile: my statistics, positions and the daily trend fit the phone in Korean and English', async ({ browser }) => {
  const m = await signUp(browser, { mobile: true });
  const o = await signUp(browser);
  await sitWith(m.page, 'e2e-stats-m', 500);
  await sitWith(o.page, 'e2e-stats-m', 500);
  await playOneHand(m.page, o.page);

  await m.page.goto('/me?tab=history');
  await expect(m.page.getByTestId('stats')).toBeVisible();
  await expect(m.page.getByTestId('stats-vpip')).toContainText('/ 1 핸드');
  await expect(m.page.getByTestId('stats-wtsd')).toContainText('100%');
  // A phone's card keeps the figure, its hands and the warning; what it counts is left to the definitions.
  await expect(m.page.getByTestId('stats-vpip').getByText('프리플랍에 스스로 칩을 넣은 핸드')).toBeHidden();
  await expect(m.page.getByTestId('stats-vpip-small')).toBeVisible();
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
  // BB/100 by position fits the phone too, each row on one line: the code, the bar, the figure and its sample.
  const bars = m.page.getByTestId('stats-pos-bb100');
  await bars.scrollIntoViewIfNeeded();
  const bx = (await bars.boundingBox())!;
  expect(bx.x).toBeGreaterThanOrEqual(0);
  expect(bx.x + bx.width).toBeLessThanOrEqual(390);
  for (const p of ['EP', 'MP', 'CO', 'BTN', 'SB', 'BB']) expect((await bars.getByTestId(`stats-pos-bb100-${p}`).boundingBox())!.height).toBeLessThan(28);
  // The bars' tracks share their columns, so the zero lines stand one above another whatever the figure beside them.
  const tracks = await bars.locator('li > span:nth-child(2)').evaluateAll((es) => es.map((e) => `${Math.round(e.getBoundingClientRect().x)}:${Math.round(e.getBoundingClientRect().width)}`));
  expect(tracks).toHaveLength(6);
  expect(new Set(tracks).size).toBe(1);
  await bars.screenshot({ path: 'test-results/me-stats-pos-bb100-mobile.png', animations: 'disabled' });

  // Tapping today's bar spells the day out; the period and measure buttons are thumb-sized.
  const chart = trend.getByTestId('stats-trend-chart');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  // Today carries a mark: a bar, or a grey mark on the zero line if the hand broke even (a split pot).
  await expect(chart.locator('[data-testid=stats-trend-bar], [data-testid=stats-trend-even]')).toHaveCount(1);
  await chart.tap({ position: { x: box.width - 3, y: box.height / 2 } });
  await expect(trend.getByTestId('stats-trend-selected')).toContainText('1핸드');
  const period = m.page.getByTestId('stats-period');
  for (const d of [7, 30, 90, 'all']) expect((await period.getByTestId(`stats-days-${d}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const k of ['net', 'hands', 'bb100', 'vpip', 'showdown']) expect((await trend.getByTestId(`stats-trend-metric-${k}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await period.getByTestId('stats-days-90').tap();
  await expect(period.getByTestId('stats-days-90')).toHaveAttribute('aria-checked', 'true');
  await expect(m.page.getByTestId('stats')).toHaveAttribute('data-days', '90');
  await expect(m.page.getByTestId('stats-vpip')).toContainText('/ 1 핸드');
  await expect(trend.getByTestId('stats-trend-summary')).toContainText('1핸드');
  // Showdown shares as two lines, on the phone as well.
  await trend.getByTestId('stats-trend-metric-showdown').tap();
  await expect(trend).toHaveAttribute('data-metric', 'showdown');
  await expect(trend.getByTestId('stats-trend-legend')).toBeVisible();
  await expect(trend.getByTestId('stats-trend-chart').getByTestId('stats-trend-dot')).toHaveCount(2);
  // The period's first and last days each on one line beside the two-line legend.
  // (The text's own line boxes: the span itself stretches to the legend's height.)
  for (const id of ['stats-trend-first', 'stats-trend-last']) {
    const lines = await trend.getByTestId(id).evaluate((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return new Set(Array.from(r.getClientRects(), (x) => Math.round(x.top))).size;
    });
    expect(lines, id).toBe(1);
  }
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.getByTestId('stats-definitions').locator('summary').tap();
  // The nine definitions, the two of the later figures (3-bet, c-bet, AF, BB/100), the period and the samples.
  await expect(m.page.getByTestId('stats-definitions').locator('li')).toHaveCount(13);
  await expect(m.page.getByTestId('stats-bb100')).toContainText(/BB\/100\s*(?:[+-]100\.00|0\.00)\s*100핸드당/);
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
  await expect(m.page.getByTestId('stats-definitions')).toContainText('the one the bots read opponents with');
  await expect(m.page.getByTestId('stats-fold-cbet')).toContainText('Fold to C-Bet');
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.getByTestId('stats').scrollIntoViewIfNeeded();
  await m.page.screenshot({ path: 'test-results/me-stats-mobile-en.png', fullPage: true, animations: 'disabled' });
});
