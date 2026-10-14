import { expect } from '@playwright/test';
import { signUp, sitWith, test, widerThanDevice } from './helpers';

test('mobile lobby: one create button, a full table card that fits, and the waitlist from a tap', async ({ browser }) => {
  // E2E Lobby Mobile: 2 seats, spectating off.
  const a = await signUp(browser, { mobile: true });
  await sitWith(a.page, 'e2e-lobby-m', 100);
  const b = await signUp(browser, { mobile: true });
  await sitWith(b.page, 'e2e-lobby-m', 100);

  const { page } = await signUp(browser, { mobile: true });
  // The wide header button is for larger screens only.
  await expect(page.getByTestId('room-create-open')).toBeVisible();
  await expect(page.getByTestId('room-create-open-wide')).toBeHidden();
  expect(await widerThanDevice(page)).toBe(false);

  const card = page.getByTestId('lobby-table').filter({ hasText: 'E2E Lobby Mobile' });
  const enter = card.getByTestId('lobby-enter');
  await expect(enter).toHaveAttribute('data-entry', 'wait', { timeout: 15_000 });
  await card.getByTestId('fav-toggle').tap();
  await expect(card.getByTestId('fav-toggle')).toHaveAttribute('aria-pressed', 'true');
  // Starred, it moves to the top of the list.
  await expect(page.getByTestId('lobby-table').first()).toHaveAttribute('data-table', 'e2e-lobby-m');
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  for (const el of [card.getByTestId('lobby-watch'), enter, card.getByTestId('fav-toggle')]) {
    const r = (await el.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(r.height).toBeGreaterThanOrEqual(40);
  }
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/lobby-full-mobile.png', animations: 'disabled' });

  await enter.tap();
  await expect(page).toHaveURL(/\/table\/e2e-lobby-m$/);
  await expect(page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/lobby-waitlisted-mobile.png', animations: 'disabled' });
});
