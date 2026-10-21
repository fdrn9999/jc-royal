import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test } from './helpers';

/**
 * Counts the board cards' turns (jc-flip-in) starting (window.__flips): the cards that turned, the ones that started
 * turning again after they began (back to their first frame mid-turn), and the rivers (the board's fifth card).
 */
function countFlips() {
  const w = window as unknown as { __flips: { cards: number; restarts: number; rivers: number } };
  w.__flips = { cards: 0, restarts: 0, rivers: 0 };
  const seen = new WeakSet<Element>();
  addEventListener(
    'animationstart',
    (e) => {
      const el = e.target as Element;
      if (e.animationName !== 'jc-flip-in' || !el.closest?.('[data-testid=board]')) return;
      if (seen.has(el)) {
        w.__flips.restarts += 1;
        return;
      }
      seen.add(el);
      w.__flips.cards += 1;
      if (el.parentElement?.children[4] === el) w.__flips.rivers += 1;
    },
    true,
  );
}
const flips = (p: Page) => p.evaluate(() => (window as unknown as { __flips: { cards: number; restarts: number; rivers: number } }).__flips);

test('보드 카드: 플롭·턴·리버의 카드는 한 번만 뒤집히고, 뒤집히는 도중 첫 프레임으로 돌아가 다시 뒤집히지 않는다', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser);
  await page.addInitScript(countFlips);
  await sitWith(page, 'e2e-flip', 1000);
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(2, { timeout: 90_000 });

  // Check or call to the river, twice: a staged street's plan ends 60ms after its last card while that card still turns.
  await expect(async () => {
    await checkOrCall(page);
    expect((await flips(page)).rivers).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 180_000 });
  // The last river's turn has had its time.
  await page.waitForTimeout(1500);
  const f = await flips(page);
  expect(f.restarts, 'board cards that started turning again mid-turn').toBe(0);

  await page.getByTestId('leave').click();
});
