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

test('mobile: touch guards — no-zoom game surface, 16px inputs, two-tap risky fold, BB stepper', async ({ browser }, info) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  await a.page.goto('/table/e2e-touch?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-touch');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();

  // Table surface blocks pinch/double-tap gestures; chat input is ≥16px (no iOS focus zoom).
  const touch = await a.page.getByTestId('table').evaluate((el) => getComputedStyle(el.closest('.jc-game-surface')!).touchAction);
  expect(touch).toBe('none');
  await a.page.getByRole('button', { name: /^(채팅|Chat)$/ }).click();
  const chatFont = await a.page.getByRole('textbox', { name: /채팅|Chat/ }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(chatFont).toBeGreaterThanOrEqual(16);
  await a.page.getByRole('button', { name: /닫기|Close/ }).click();

  const bar = a.page.getByTestId('action-bar');
  await expect(async () => {
    if (await bar.isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(bar).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  await a.page.waitForTimeout(400); // past the appear guard
  await a.page.screenshot({ path: info.outputPath('action-bar.png') });

  // Raise panel: + adds one big blind (10) to the minimum.
  const raiseBtn = bar.getByRole('button', { name: /^(레이즈|Raise|벳|Bet)$/ });
  if (await raiseBtn.isVisible().catch(() => false)) {
    await raiseBtn.click();
    const amt = bar.getByRole('textbox');
    const min = Number(await amt.inputValue());
    await bar.getByRole('button', { name: '+ 10' }).click();
    expect(Number(await amt.inputValue())).toBe(min + 10);
    await a.page.screenshot({ path: info.outputPath('raise-panel.png') });
    await raiseBtn.click();
  }

  // Fold while a free check exists needs a second tap: the first one only arms it.
  const fold = bar.getByRole('button', { name: /폴드|Fold/ });
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  await expect(async () => {
    if (await check.isVisible().catch(() => false)) return;
    if (await bar.getByRole('button', { name: /^(콜|Call)/ }).isVisible().catch(() => false)) await checkOrCall(a.page);
    else await checkOrCall(b.page);
    await expect(check).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  await a.page.waitForTimeout(400);
  if (await fold.isVisible()) {
    await fold.click();
    await expect(fold).toHaveText(/한 번 더|Tap again/);
    await expect(bar).toBeVisible();
    await a.page.screenshot({ path: info.outputPath('fold-armed.png') });
    await expect(fold).toHaveText(/^(폴드|Fold)$/, { timeout: 4000 }); // disarms by itself
  }
  expect(await checkOrCall(a.page)).toBe(true);
});
