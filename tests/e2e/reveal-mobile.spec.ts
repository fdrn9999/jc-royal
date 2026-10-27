import { expect, type Page } from '@playwright/test';
import { checkOrCall, dealtCards, signUp, test, widerThanDevice } from './helpers';

/** The cards resting by the board for a winner's seat: their boxes, and whether they lie clear of the board and every seat. */
function restLayout(page: Page, seat: string) {
  return page.evaluate((id) => {
    const crosses = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const cards = Array.from(document.querySelectorAll(`[data-testid=reveal-${id.slice(5)}] .jc-card`)).map((c) => c.getBoundingClientRect());
    const board = document.querySelector('[data-testid=board]')!.getBoundingClientRect();
    const seats = Array.from(document.querySelectorAll('[data-testid=table] [data-testid^="seat-"][data-state]')).map((s) => s.getBoundingClientRect());
    return {
      cards: cards.map((r) => ({ x: Math.round(r.left), y: Math.round(r.top) })),
      clear: cards.length > 0 && !cards.some((r) => crosses(r, board) || seats.some((s) => crosses(r, s))),
      inside: cards.every((r) => r.left >= 0 && r.top >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= window.innerHeight),
    };
  }, seat);
}

/** Whether the reveal's own animations (the slide, the flip) have run their course. */
const settled = (page: Page, seat: string) =>
  page.waitForFunction((id) => (document.querySelector(`[data-testid=reveal-${id.slice(5)}]`)?.getAnimations({ subtree: true }).length ?? 1) === 0, seat, { timeout: 3_000 });

// The room deals the next hand 5.5 s after a hand members played (4 s, and 1.5 s to decide whether to show): one card
// shown, then the other, in that gap.
test('mobile: a winner shows one card, then the other; each slides to rest by the board, clear of it and the seats, for the other player and a spectator', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser, { mobile: true });
  const watcher = await signUp(browser, { mobile: true });
  await watcher.page.emulateMedia({ reducedMotion: 'reduce' });
  await a.page.goto('/table/e2e-reveal?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-reveal?sit=1');
  await b.page.getByTestId('buyin-confirm').tap();
  await watcher.page.goto('/table/e2e-reveal');
  await expect(a.page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(2);

  // B folds where it would have to call (its small blind) and checks where it may; A checks or calls: A wins B's small
  // blind uncontested every other hand, its cards face down.
  const mine = a.page.locator('[data-testid^="seat-"]:has([data-testid="show-cards"])');
  let done: { seat: string; cards: string[] } | null = null;
  await expect(async () => {
    if (!((await mine.locator('.jc-winner').count()) > 0 && (await a.page.getByTestId('show-card-1').isVisible()))) {
      const bar = b.page.getByTestId('action-bar');
      const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
      const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
      if (await check.isVisible().catch(() => false)) await check.tap();
      else if (await fold.isVisible().catch(() => false)) await fold.tap();
      else await checkOrCall(a.page);
      await a.page.waitForTimeout(250);
      expect(done).not.toBeNull();
    }
    const seat = (await mine.getAttribute('data-testid'))!;
    // As dealt: the show buttons go by that order; A sees them drawn with the higher rank on the left.
    const cards = await dealtCards(a.page, seat);
    expect(cards).toHaveLength(2);
    const onB = b.page.getByTestId(`reveal-${seat.slice(5)}`);

    // The second card: it slides (and turns face up) for B; nothing else of A's comes face up.
    await a.page.getByTestId('show-card-1').click();
    await expect(onB.locator('[data-card]')).toHaveCount(1, { timeout: 1_500 });
    await expect(onB.locator('[data-card]')).toHaveAttribute('data-card', cards[1]!);
    await expect(onB.locator('.jc-reveal-in')).toHaveCount(1);
    await expect(b.page.locator(`[data-testid=${seat}] [data-card]`)).toHaveCount(1);
    await settled(b.page, seat);
    const first = await restLayout(b.page, seat);
    expect(first).toMatchObject({ clear: true, inside: true });

    // Then the first: it takes its own place beside the other, which stays where it rests.
    await a.page.getByTestId('show-card-0').click();
    await expect(onB.locator('[data-card]')).toHaveCount(2, { timeout: 1_500 });
    await expect(onB.locator('[data-card]').first()).toHaveAttribute('data-card', cards[0]!);
    await settled(b.page, seat);
    const both = await restLayout(b.page, seat);
    expect(both).toMatchObject({ clear: true, inside: true });
    expect(both.cards[1]).toEqual(first.cards[0]);

    // The spectator, with reduced motion: the two cards at rest by the board, without moving there.
    const onW = watcher.page.getByTestId(`reveal-${seat.slice(5)}`);
    await expect(onW.locator('[data-card]')).toHaveCount(2, { timeout: 1_500 });
    expect(await onW.evaluate((g) => g.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await restLayout(watcher.page, seat)).toMatchObject({ clear: true, inside: true });
    await b.page.screenshot({ path: test.info().outputPath('reveal-mobile-390.png'), animations: 'disabled' });
    done = { seat, cards };
  }).toPass({ timeout: 150_000 });

  expect(await widerThanDevice(b.page)).toBe(false);
  // The next deal takes them away.
  const { seat } = done!;
  await expect(b.page.getByTestId(`reveal-${seat.slice(5)}`)).toHaveCount(0, { timeout: 15_000 });
  await expect(watcher.page.getByTestId(`reveal-${seat.slice(5)}`)).toHaveCount(0);
  await expect(b.page.locator(`[data-testid=${seat}] [data-card]`)).toHaveCount(0);
});
