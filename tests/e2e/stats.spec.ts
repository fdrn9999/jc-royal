import { expect, type Page } from '@playwright/test';
import { playOneHand, signUp, sitWith, test } from './helpers';

test('my statistics: VPIP, PFR, showdowns, positions and the daily trend from a hand played, nothing for a spectator', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const watcher = await signUp(browser);
  await sitWith(a.page, 'e2e-stats', 500);
  await sitWith(b.page, 'e2e-stats', 500);
  await watcher.page.goto('/table/e2e-stats');
  await expect(watcher.page.getByTestId('board')).toBeVisible();
  await playOneHand(a.page, b.page);

  const shown = async (page: Page) => {
    await page.goto('/me?tab=history');
    await expect(page.getByTestId('stats')).toBeVisible();
    const pos = Object.fromEntries(
      await Promise.all(
        ['EP', 'MP', 'CO', 'BTN', 'SB', 'BB'].map(async (p) => [p, (await page.getByTestId(`stats-pos-${p}`).locator('td').nth(1).textContent())!.trim()] as const),
      ),
    );
    return { vpip: (await page.getByTestId('stats-vpip').textContent())!, pfr: (await page.getByTestId('stats-pfr').textContent())!, pos };
  };
  const sa = await shown(a.page);
  const sb = await shown(b.page);
  // Heads-up: one of them was the button (it posted the small blind and called: VPIP), the other the big blind (checked).
  expect([sa.pos.BTN, sb.pos.BTN].sort()).toEqual(['0', '1']);
  expect([sa.pos.BB, sb.pos.BB].sort()).toEqual(['0', '1']);
  for (const s of [sa, sb]) {
    expect([s.pos.EP, s.pos.MP, s.pos.CO, s.pos.SB]).toEqual(['0', '0', '0', '0']);
    expect(s.pfr).toContain('0%');
    expect(s.pfr).toContain('0 / 1 핸드');
  }
  const [btn, bb] = sa.pos.BTN === '1' ? [a.page, b.page] : [b.page, a.page];
  await expect(btn.getByTestId('stats-vpip')).toContainText('100%');
  await expect(btn.getByTestId('stats-vpip')).toContainText('1 / 1 핸드');
  await expect(bb.getByTestId('stats-vpip')).toContainText('0%');
  await expect(bb.getByTestId('stats-vpip')).toContainText('0 / 1 핸드');
  // Check/call to the river: both saw the flop and went to showdown.
  for (const p of [btn, bb]) await expect(p.getByTestId('stats-wtsd')).toContainText('100%');
  // Raise share has no hands to count for the big blind, who never entered by choice.
  await expect(bb.getByTestId('stats-raise-share')).toContainText('—');
  // The later figures: a limped pot checked down gives no 3-bet or c-bet chance (a dash, not 0%) and no bet or call after
  // the flop; BB/100 is the hand's net in big blinds of 10, times 100.
  for (const p of [btn, bb]) {
    await expect(p.getByTestId('stats-counted')).toContainText('1핸드');
    for (const id of ['stats-3bet', 'stats-fold-3bet', 'stats-cbet', 'stats-fold-cbet']) {
      await expect(p.getByTestId(id)).toContainText('—');
      await expect(p.getByTestId(id)).toContainText('0 / 0 핸드');
    }
    await expect(p.getByTestId('stats-af')).toContainText('—');
    // The whole figure, between its label and its line (one big blind won, lost, or none).
    await expect(p.getByTestId('stats-bb100')).toContainText(/BB\/100\s*(?:[+-]100\.00|0\.00)\s*100핸드당/);
  }

  // BB/100 by position, with the hands behind each: the button's one hand (a small sample), a dash where none was played.
  await expect(btn.getByTestId('stats-pos-bb100-BTN')).toContainText('1핸드');
  await expect(btn.getByTestId('stats-pos-bb100-BTN')).toHaveAttribute('data-small', 'true');
  await expect(btn.getByTestId('stats-pos-bb100-CO')).toContainText('—');
  await expect(btn.getByTestId('stats-pos-bb100-CO')).toContainText('0핸드');

  // The trend shows today's hand.
  const trend = btn.getByTestId('stats-trend');
  await expect(trend.getByTestId('stats-trend-summary')).toContainText('1핸드');
  await expect(trend.getByTestId('stats-trend-chart')).toBeVisible();
  await expect(trend.getByTestId('stats-trend-all')).toBeVisible();
  // The period counts the tab's figures again, the trend with them: the last 7 days still hold today's hand.
  const period = btn.getByTestId('stats-period');
  await period.getByTestId('stats-days-7').click();
  await expect(period.getByTestId('stats-days-7')).toHaveAttribute('aria-checked', 'true');
  await expect(btn.getByTestId('stats')).toHaveAttribute('data-days', '7');
  await expect(btn.getByTestId('stats-vpip')).toContainText('100%');
  await expect(btn.getByTestId('stats-vpip')).toContainText('1 / 1 핸드');
  await expect(btn.getByTestId('stats-vpip-small')).toBeVisible();
  await expect(btn.getByTestId('stats-counted')).toContainText('1핸드');
  await expect(btn.getByTestId('stats-pos-bb100-BTN')).toContainText('1핸드');
  await expect(trend.getByTestId('stats-trend-all')).toHaveCount(0);
  await expect(trend.getByTestId('stats-trend-summary')).toContainText('1핸드');
  // Picking today's bar spells the day out.
  const chart = trend.getByTestId('stats-trend-chart');
  await expect(chart.locator('[data-testid=stats-trend-bar], [data-testid=stats-trend-even]')).toHaveCount(1);
  const box = (await chart.boundingBox())!;
  await chart.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await expect(trend.getByTestId('stats-trend-selected')).toContainText('1핸드');
  // The other measures: hands as a bar a day; VPIP and PFR as two lines, one day so a dot each, with their legend and
  // the small-sample note.
  await trend.getByTestId('stats-trend-metric-hands').click();
  await expect(trend).toHaveAttribute('data-metric', 'hands');
  await expect(chart.getByTestId('stats-trend-bar')).toHaveCount(1);
  await trend.getByTestId('stats-trend-metric-vpip').click();
  await expect(trend).toHaveAttribute('data-metric', 'vpip');
  await expect(trend.getByTestId('stats-trend-legend')).toContainText('PFR');
  await expect(chart.getByTestId('stats-trend-dot')).toHaveCount(2);
  await expect(trend.getByTestId('stats-trend-selected')).toContainText('VPIP 100%');
  await expect(trend.getByTestId('stats-trend-selected')).toContainText('PFR 0%');
  await expect(trend.getByTestId('stats-trend-small')).toBeVisible();
  await btn.getByTestId('stats-definitions').locator('summary').click();
  await expect(btn.getByTestId('stats-definitions')).toContainText('관전한 핸드는 포함하지 않으며');
  await btn.getByTestId('stats').scrollIntoViewIfNeeded();
  await btn.screenshot({ path: 'test-results/me-stats-play-desktop.png', fullPage: true });
  // Back to every hand.
  await period.getByTestId('stats-days-all').click();
  await expect(btn.getByTestId('stats')).toHaveAttribute('data-days', 'all');
  await expect(btn.getByTestId('stats-vpip')).toContainText('1 / 1 핸드');

  // The spectator watched the whole hand: nothing counted, dashes instead of 0%.
  await watcher.page.goto('/me?tab=history');
  const ws = watcher.page.getByTestId('stats');
  await expect(ws).toBeVisible();
  await expect(watcher.page.getByTestId('stats-vpip')).toContainText('—');
  await expect(watcher.page.getByTestId('stats-vpip')).toContainText('0 / 0 핸드');
  await expect(watcher.page.getByTestId('stats-pos-BTN').locator('td').nth(1)).toHaveText('0');
  await expect(watcher.page.getByTestId('stats-counted')).toContainText('0핸드');
  await expect(watcher.page.getByTestId('stats-bb100')).toContainText('—');
  await expect(watcher.page.getByTestId('stats-pos-bb100-BTN')).toContainText('—');
  await expect(watcher.page.getByTestId('stats-trend')).toContainText('이 기간에 플레이한 핸드가 없습니다.');
  await watcher.page.screenshot({ path: 'test-results/me-stats-empty-desktop.png', fullPage: true });
});
