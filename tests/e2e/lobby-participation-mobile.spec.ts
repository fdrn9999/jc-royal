import { expect, type Page } from '@playwright/test';
import { signUp, sitWith, test, widerThanDevice } from './helpers';

const ID = 'e2e-mine-m'; // 2 seats, no spectators

const cardOf = (page: Page, id: string) => page.locator(`[data-testid=lobby-table][data-table=${id}]`);
const myGame = (page: Page, id: string) => page.locator(`[data-testid=lobby-my-game][data-table=${id}]`);
const seatOf = (page: Page, nickname: string) => page.locator('[data-testid^=seat-]').filter({ hasText: nickname });

test('mobile: my seat and my place on the waitlist fit the lobby at 390 and 320 wide, and the way back is one tap', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  await sitWith(a.page, ID, 500);
  const b = await signUp(browser, { mobile: true });
  await sitWith(b.page, ID, 500);
  const c = await signUp(browser, { mobile: true });
  await expect(cardOf(c.page, ID).getByTestId('lobby-enter')).toHaveAttribute('data-entry', 'wait');
  await cardOf(c.page, ID).getByTestId('lobby-enter').tap();
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);
  await a.page.goto('/');
  await c.page.goto('/');

  for (const [page, badge, button, kind] of [
    [a.page, 'lobby-mine-badge', 'lobby-continue', 'seated'],
    [c.page, 'lobby-waiting-badge', 'lobby-view-waitlist', 'waiting'],
  ] as const) {
    for (const [width, height] of [
      [390, 844],
      [320, 568],
    ] as const) {
      await page.setViewportSize({ width, height });
      const card = cardOf(page, ID);
      await expect(card.getByTestId(button)).toBeVisible();
      expect(await widerThanDevice(page), `${kind} ${width}`).toBe(false);
      const box = (await card.boundingBox())!;
      // As wide as any other card (the badges wrap instead of widening it), inside the screen.
      const other = (await page.locator(`[data-testid=lobby-table]:not([data-table=${ID}])`).first().boundingBox())!;
      expect(Math.abs(box.width - other.width), `${kind} ${width}`).toBeLessThanOrEqual(1);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      // The badge stays in the card and clear of the favourite star.
      const mark = (await card.getByTestId(badge).boundingBox())!;
      const star = (await card.getByTestId('fav-toggle').boundingBox())!;
      expect(mark.x).toBeGreaterThanOrEqual(box.x);
      expect(mark.x + mark.width).toBeLessThanOrEqual(box.x + box.width);
      expect(mark.x + mark.width <= star.x || mark.y >= star.y + star.height, `${kind} ${width} badge under the star`).toBe(true);
      // One button across the card, big enough for a thumb.
      const go = (await card.getByTestId(button).boundingBox())!;
      expect(go.height).toBeGreaterThanOrEqual(40);
      expect(go.width).toBeGreaterThan(box.width * 0.7);
      // Scrolled into the middle of the screen, nothing (the bottom tab bar, the header) covers the button.
      await card.getByTestId(button).evaluate((e) => e.scrollIntoView({ block: 'center' }));
      const hit = await card.getByTestId(button).evaluate((e) => {
        const r = e.getBoundingClientRect();
        return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      expect(hit, `${kind} ${width} button covered`).toBe(true);
      await page.screenshot({ path: `test-results/participation-${kind}-card-${width}.png` });
      // 내 게임 at the top of the lobby, in the screen's width.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(myGame(page, ID)).toBeInViewport();
      const row = (await myGame(page, ID).boundingBox())!;
      expect(row.x).toBeGreaterThanOrEqual(0);
      expect(row.x + row.width).toBeLessThanOrEqual(width + 0.5);
      await page.screenshot({ path: `test-results/participation-${kind}-top-${width}.png` });
    }
  }

  // One tap back to the seat, nothing paid.
  await cardOf(a.page, ID).getByTestId('lobby-continue').tap();
  await expect(a.page).toHaveURL(new RegExp(`/table/${ID}$`));
  await expect(seatOf(a.page, a.nickname)).toBeVisible();
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);
  expect(await widerThanDevice(a.page)).toBe(false);
  await myGame(c.page, ID).tap();
  await expect(c.page).toHaveURL(new RegExp(`/table/${ID}$`));
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);
  await a.page.screenshot({ path: 'test-results/participation-back-mobile.png' });
});
