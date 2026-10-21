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

test('mobile lobby: a table with a long name ends it in an ellipsis on the narrowest phone, and the page and its bottom bar stay the screen’s width', async ({ browser }) => {
  // E2E 이름이 아주 긴 …: 37 characters, most of them wide (a table's name may have up to 40).
  const { page } = await signUp(browser, { mobile: true });
  for (const w of [320, 360]) {
    await page.setViewportSize({ width: w, height: 740 });
    await page.goto('/');
    const card = page.locator('[data-testid=lobby-table][data-table=e2e-lobby-long]');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x + box.width, `${w}: the card runs past the screen`).toBeLessThanOrEqual(w + 0.5);
    const name = await card.getByRole('heading', { level: 2 }).evaluate((h) => ({ cut: h.scrollWidth > h.clientWidth, ellipsis: getComputedStyle(h).textOverflow }));
    expect(name, `${w}: the name is not cut with an ellipsis`).toEqual({ cut: true, ellipsis: 'ellipsis' });
    expect(await widerThanDevice(page)).toBe(false);
    // The fixed bottom bar is drawn against the page's width: it stays the screen's, and at the screen's foot.
    const bar = await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed')!.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });
    expect(bar.right, `${w}: the bottom bar is wider than the screen`).toBeLessThanOrEqual(w + 0.5);
    expect(bar.bottom, `${w}: the bottom bar is below the screen`).toBeLessThanOrEqual(740.5);
  }
  await page.screenshot({ path: 'test-results/lobby-long-name-mobile.png', animations: 'disabled' });
});
