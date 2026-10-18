import { expect, type Page } from '@playwright/test';
import { balanceOf, signUp, test } from './helpers';

/** Every chip flight the table draws from now on, in order, as `kind:seat:amount`. */
async function recordFlights(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __flights: string[] };
    w.__flights = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          for (const el of n instanceof HTMLElement ? [n, ...Array.from(n.querySelectorAll<HTMLElement>('[data-flight]'))] : [])
            if (el.dataset.flight) w.__flights.push(`${el.dataset.flight}:${el.dataset.seat}:${el.dataset.amount}`);
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const flights = (page: Page) => page.evaluate(() => (window as unknown as { __flights: string[] }).__flights);
const chipsIn = async (page: Page, testId: string) => Number(((await page.getByTestId(testId).textContent()) ?? '').replace(/\D/g, ''));

test('a raise everyone folds to: the raise above the call goes straight back, only the blinds are won', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) {
    await p.goto('/table/e2e-uncalled?sit=1');
    await p.getByTestId('buyin-confirm').click();
    await expect(p.getByTestId('buyin-confirm')).toHaveCount(0);
  }
  // Heads-up the button posts the small blind and acts first.
  let raiser: Page | null = null;
  await expect(async () => {
    for (const p of [a.page, b.page]) if (await p.getByTestId('action-bar').isVisible().catch(() => false)) raiser = p;
    expect(raiser).not.toBeNull();
  }).toPass({ timeout: 30_000 });
  const r = raiser!;
  const folder = r === a.page ? b.page : a.page;
  const buyIn = 10_000 - (await balanceOf(r));
  for (const p of [r, folder]) await recordFlights(p);

  const bar = r.getByTestId('action-bar');
  await r.waitForTimeout(400); // past the appear guard
  await bar.getByRole('button', { name: /^(레이즈|Raise)$/ }).click();
  await bar.getByRole('textbox').fill('100');
  await bar.getByTestId('action-commit').click();
  const fold = folder.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ });
  await expect(fold).toBeVisible();
  await folder.waitForTimeout(400);
  await fold.click();

  // Raised to 100 over the big blind's 10: 90 goes back from the bet spot, the two 10s are the win.
  let seat = '';
  for (const p of [r, folder]) {
    await expect.poll(() => flights(p), { timeout: 10_000 }).toContainEqual(expect.stringMatching(/^payout:/));
    const seen = await flights(p);
    const back = seen.filter((f) => f.startsWith('return:'));
    const pays = seen.filter((f) => f.startsWith('payout:'));
    expect(back.map((f) => f.split(':')[2]), seen.join(' ')).toEqual(['90']);
    expect(pays.map((f) => f.split(':')[2]), seen.join(' ')).toEqual(['20']);
    // Back before anything is swept into the pot, to the one who is paid.
    expect(seen.indexOf(back[0]!)).toBeLessThan(seen.findIndex((f) => f.startsWith('sweep:')));
    seat = pays[0]!.split(':')[1]!;
    expect(back[0]!.split(':')[1]).toBe(seat);
  }
  // The seat reads the 20 it won, never the 110 it was paid; the stacks are as the server settled them.
  for (const p of [r, folder]) {
    await expect(p.getByTestId(`seat-${seat}`)).toContainText('+20');
    await expect(p.getByTestId(`seat-${seat}`)).not.toContainText('+110');
    await expect.poll(() => chipsIn(p, `stack-${seat}`)).toBe(buyIn + 10);
  }
  await r.screenshot({ path: 'test-results/uncalled-raise-fold.png' });
  for (const p of [a.page, b.page]) await p.getByTestId('leave').click();
});
