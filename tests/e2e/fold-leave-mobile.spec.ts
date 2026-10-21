import { expect, type Page } from '@playwright/test';
import { balanceOf, checkOrCall, signUp, standUp, test, widerThanDevice } from './helpers';

// A phone upright, a small one, and one on its side.
const PHONES = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
];

/** Each element: inside the screen and on top at its middle (a tap reaches it), and how tall a target it is. */
function placed(page: Page, ids: string[]) {
  return page.evaluate(
    (list) =>
      list.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return { id, at: 'missing', height: 0 };
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const inside = r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5;
        return { id, at: !inside ? 'off screen' : top && el.contains(top) ? 'ok' : 'covered', height: Math.round(r.height) };
      }),
    ids,
  );
}

/** On each phone: everything in reach and no sideways scroll; the buttons a finger's size. */
async function onEachPhone(page: Page, what: string, ids: string[], buttons: string[]) {
  for (const v of PHONES) {
    await page.setViewportSize(v);
    const where = `${what} ${v.width}×${v.height}`;
    await expect.poll(async () => (await placed(page, ids)).filter((x) => x.at !== 'ok').map((x) => `${x.id} ${x.at}`), where).toEqual([]);
    const sizes = await placed(page, buttons);
    test.info().annotations.push({ type: 'tap', description: `${where}: ${sizes.map((x) => `${x.id} ${x.height}px`).join(', ')}` });
    for (const x of sizes) expect(x.height, `${where}: ${x.id} is a short target`).toBeGreaterThanOrEqual(40);
    expect(await widerThanDevice(page), where).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`fold-leave-${what}-${v.width}x${v.height}.png`) });
  }
  await page.setViewportSize(PHONES[0]!);
}

test('mobile: standing up mid-hand on a phone, the question and what comes next fit the screen with every button in reach', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) {
    await p.goto('/table/e2e-fold-m?sit=1');
    await p.getByTestId('buyin-confirm').click();
    await expect(p.getByTestId('buyin-confirm')).toHaveCount(0);
  }
  const mine = a.page.locator('[data-testid=table] [data-testid^="seat-"][data-state]').filter({ hasText: a.nickname });

  // In a hand, the button asks first: on my turn or not, the question and both answers in reach on every phone.
  const leave = a.page.getByTestId('leave');
  await expect(leave).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
  await leave.tap();
  await expect(a.page.getByTestId('leave-ask')).toBeVisible();
  await onEachPhone(a.page, 'ask', ['leave-ask', 'leave-cancel', 'leave-fold'], ['leave-cancel', 'leave-fold']);

  // Folded at once on my turn, else when it comes (the other plays on); then what next, in reach on every phone.
  const before = await balanceOf(a.page);
  await a.page.getByTestId('leave-fold').tap();
  await expect(async () => {
    await checkOrCall(b.page);
    await expect(mine).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 90_000 });
  await expect(a.page.getByTestId('left-next')).toBeVisible();
  await onEachPhone(a.page, 'left', ['left-next', 'quick-another', 'stay-here', 'left-lobby'], ['quick-another', 'stay-here', 'left-lobby']);
  await expect.poll(() => balanceOf(a.page), { timeout: 15_000 }).toBeGreaterThan(before);

  // Every chip back in a wallet.
  await standUp(b.page);
  await expect.poll(async () => (await balanceOf(a.page)) + (await balanceOf(b.page)), { timeout: 30_000 }).toBe(20_000);
});
