import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, uid, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

/** Every visible control and card on the page lies within the phone's width, and the page does not scroll sideways. */
async function fitsPhone(page: Page) {
  expect(await widerThanDevice(page)).toBe(false);
  const width = page.viewportSize()!.width;
  const out = await page.getByTestId('control-center').evaluate(
    (el, w) =>
      Array.from(el.querySelectorAll('select, input, button, [role=alert], [role=group], [data-testid=cc-card], h1'))
        .filter((x) => (x as HTMLElement).offsetParent !== null || getComputedStyle(x).position === 'fixed')
        .map((x) => ({ id: x.getAttribute('data-testid') ?? x.getAttribute('aria-label') ?? x.tagName, r: x.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.left < -0.5 || r.right > w + 0.5))
        .map(({ id, r }) => `${id} ${Math.round(r.left)}..${Math.round(r.right)}`),
    width,
  );
  expect(out, 'past the screen edge').toEqual([]);
}

test('control center on a phone: summary, filters and cards fit the screen, a table opens as a sheet from the bottom that leaves the cards above it, and closes again', async ({ browser }) => {
  test.setTimeout(120_000);
  const id = uid('e2e-ccm-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${id}', 'E2E Control Phone With A Rather Long Name', 9, 5, 10, 100, 1000, 30)`);
  const op = await signUp(browser, { mobile: true });
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email, { mobile: true });
  await page.goto(`${ADMIN}/control-center?q=${encodeURIComponent('E2E Control Phone')}`);
  const card = page.locator(`[data-testid=cc-card][data-table="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('0/9');
  await fitsPhone(page);
  await page.screenshot({ path: 'test-results/control-center-mobile.png', fullPage: true });
  // The alerts come before the cards and the timeline after them, each the screen's width at most.
  const width = page.viewportSize()!.width;
  for (const part of ['cc-alerts', 'cc-timeline']) {
    const el = page.getByTestId(part);
    await el.scrollIntoViewIfNeeded();
    const r = (await el.boundingBox())!;
    expect(r.x, part).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width, part).toBeLessThanOrEqual(width + 0.5);
  }
  expect((await page.getByTestId('cc-alerts').boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
  await page.getByTestId('cc-timeline').screenshot({ path: 'test-results/control-center-mobile-timeline.png' });
  await page.evaluate(() => window.scrollTo(0, 0));

  // Tapped: a sheet from the bottom, at most about two thirds of the screen, with the table's name and seats.
  await card.getByRole('button', { name: /^E2E Control Phone With A Rather Long Name, / }).tap();
  const panel = page.getByTestId('cc-panel');
  await expect(page.getByTestId('cc-detail')).toHaveAttribute('data-table', id);
  await expect(page.getByTestId('cc-seats').locator('li')).toHaveCount(9);
  const h = page.viewportSize()!.height;
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThan(h * 0.3);
  expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(h);
  await fitsPhone(page);
  await page.screenshot({ path: 'test-results/control-center-mobile-sheet.png' });

  // The narrowest phone: still nothing past the edge, with the sheet open.
  await page.setViewportSize({ width: 320, height: 568 });
  await fitsPhone(page);
  await page.screenshot({ path: 'test-results/control-center-mobile-320.png' });

  // Closed from its button: the sheet goes, the card stays.
  await page.getByTestId('cc-detail').getByRole('button', { name: /^(닫기|Close)$/ }).tap();
  await expect(page.getByTestId('cc-detail')).toHaveCount(0);
  await expect(panel).toBeHidden();
  await expect(card).toBeVisible();
});
