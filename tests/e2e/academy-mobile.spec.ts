import { expect, test, type Page } from '@playwright/test';
import { answerAll, CARD_ANSWERS, playScenario } from './academy-helpers';
import { signUp } from './helpers';

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test('mobile academy: bottom nav, touch quiz (tap select + tap-to-swap sort), no overflow, no page scroll on card taps', async ({ browser }) => {
  const { page: p } = await signUp(browser, { mobile: true });
  await p.getByTestId('nav-academy').tap();
  await expect(p.getByTestId('academy')).toBeVisible();
  await noOverflow(p);

  await p.goto('/academy/cards?step=3');
  await noOverflow(p);
  // All four answer cards fit on a 390px screen, each at least 44px wide.
  for (const c of ['As', '7h', 'Kc', '9d']) {
    const box = await p.locator(`[data-pick="${c}"]`).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const y0 = await p.evaluate(() => window.scrollY);
  await p.locator('[data-pick="9d"]').tap();
  await expect(p.getByTestId('feedback-wrong')).toBeVisible();
  expect(await p.evaluate(() => window.scrollY)).toBe(y0);
  await answerAll(p, CARD_ANSWERS, 'tap');
  await noOverflow(p);
  await p.getByTestId('lesson-finish').tap();
  await expect(p.getByTestId('lesson-done')).toBeVisible();

  // Every lesson step renders without horizontal scroll on a phone.
  for (const [lesson, n] of [['hands', 5], ['holdem', 5], ['actions', 4]] as const) {
    for (let s = 0; s < n; s++) {
      await p.goto(`/academy/${lesson}?step=${s}`);
      await expect(p.getByTestId('step-title')).toBeVisible();
      await noOverflow(p);
    }
  }
});

test('mobile practice: raise with presets by touch, hand chart as a bottom sheet, actions stay on screen', async ({ browser }) => {
  const { page: p } = await signUp(browser, { mobile: true });
  await p.goto('/academy/practice/C');
  await expect(p.getByTestId('action-bar')).toBeVisible({ timeout: 15_000 });
  const bar = await p.getByTestId('action-bar').boundingBox();
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(844);
  expect(await p.locator('[data-testid=table]').evaluate((el) => getComputedStyle(el.closest('.jc-game-surface')!).touchAction)).toBe('none');

  await p.getByTestId('practice-chart').tap();
  const sheet = p.getByRole('dialog');
  await expect(p.getByTestId('hand-chart')).toBeVisible();
  const box = await sheet.locator('.jc-panel').boundingBox();
  expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(843); // anchored to the bottom edge
  await sheet.getByRole('button', { name: 'close' }).tap();

  await playScenario(p, [{ action: /레이즈|Raise/, raise: true }], 'tap');
  await expect(p.getByTestId('practice-done')).toBeVisible({ timeout: 40_000 });
  await noOverflow(p);
});
