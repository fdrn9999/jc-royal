import { expect } from '@playwright/test';
import { seedTodayHands } from './challenges-seed';
import { idOf } from './hand-review-seed';
import { signUp, test, widerThanDevice } from './helpers';

test('mobile My Page: the challenges fit every phone, the day above the week, with nothing cut and a thumb-sized button', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  seedTodayHands(await idOf(page), 10);
  await page.goto('/me');
  const card = page.getByTestId('challenges');
  await expect(card.locator('[data-testid=challenge][data-code=d_hands_10]')).toHaveAttribute('data-done', '');
  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [390, 844],
    [430, 932],
    [667, 375],
    [812, 375],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await card.scrollIntoViewIfNeeded();
    expect(await widerThanDevice(page), `${w}x${h}: wider than the screen`).toBe(false);
    const day = (await page.getByTestId('challenges-day').boundingBox())!;
    const week = (await page.getByTestId('challenges-week').boundingBox())!;
    expect(week.y, `${w}x${h}: the week beside the day`).toBeGreaterThanOrEqual(day.y + day.height);
    // Every line of the card stays inside it: no name, count or note runs out or is cut.
    const cut = await card.evaluate((c) =>
      Array.from(c.querySelectorAll('*'))
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline' && getComputedStyle(e).overflow !== 'hidden')
        .map((e) => e.textContent),
    );
    expect(cut, `${w}x${h}: text cut`).toEqual([]);
    const box = (await card.boundingBox())!;
    const right = await card.evaluate((c) => Math.max(...Array.from(c.querySelectorAll('*')).map((e) => e.getBoundingClientRect().right)));
    expect(right, `${w}x${h}: runs past the card`).toBeLessThanOrEqual(box.x + box.width + 1);
    for (const t of [page.getByTestId('challenges-refresh'), page.getByTestId('challenges-recent').locator('summary')]) {
      const r = (await t.boundingBox())!;
      expect(r.height, `${w}x${h}: a button shorter than a thumb`).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ path: `test-results/challenges-${w}x${h}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('challenges-recent').locator('summary').tap();
  await expect(page.getByTestId('challenges-recent')).toContainText(/핸드 10회|10 hands/);
});
