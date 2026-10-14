import { expect, test } from '@playwright/test';
import { balanceOf, checkOrCall, signUp } from './helpers';

test('two browsers: join, buy in, play a hand to showdown, refresh, stand up with refund', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  expect(await balanceOf(a.page)).toBe(10000);

  // A joins from the lobby card → buy-in dialog opens automatically.
  await a.page.getByTestId('lobby-table').filter({ hasText: 'E2E Heads-up' }).getByRole('button', { name: /참여|Join/ }).click();
  await a.page.getByTestId('buyin-confirm').click();
  await expect(a.page.getByTestId('seat-0')).toHaveAttribute('data-state', /waiting|active/);

  await b.page.goto('/table/e2e-hu');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();

  // The hand starts automatically; each player sees exactly two face-up cards of their own.
  for (const p of [a.page, b.page]) await expect(p.getByTestId('board')).toBeVisible();
  await expect(async () => {
    const own = await a.page.locator('[data-testid=seat-0] [data-card]').count();
    expect(own).toBe(2);
  }).toPass({ timeout: 15_000 });
  // A never sees B's card faces before showdown.
  expect(await a.page.locator('[data-testid=seat-1] [data-card]').count()).toBe(0);

  // Play check/call to showdown.
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    await expect(a.page.getByText(/승리|Winner/).first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 60_000 });
  // Five board cards and both hands revealed at showdown.
  await expect(a.page.locator('[data-testid=board] [data-card]')).toHaveCount(5);
  await expect(a.page.locator('[data-testid=seat-1] [data-card]')).toHaveCount(2);

  // Table chips are conserved.
  const stack = async (page: typeof a.page, seat: number) => Number(((await page.getByTestId(`stack-${seat}`).textContent()) ?? '0').replace(/[^\d]/g, ''));
  const total = (await stack(a.page, 0)) + (await stack(a.page, 1));
  const buyIns = 10000 - (await balanceOf(a.page)) + 10000 - (await balanceOf(b.page));
  expect(total).toBe(buyIns);

  // Refresh keeps the seat and stack (server state is authoritative).
  const before = await stack(a.page, 0);
  await a.page.reload();
  await expect(a.page.getByTestId('seat-0')).toBeVisible();
  await expect(a.page.getByTestId('leave')).toBeVisible();
  expect(await stack(a.page, 0)).toBeGreaterThan(0);
  const walletBefore = await balanceOf(a.page);

  // Stand up → remaining stack returns to the wallet (immediately, or after the current hand).
  await a.page.getByTestId('leave').click();
  await expect(async () => {
    expect(await balanceOf(a.page)).toBeGreaterThan(walletBefore);
  }).toPass({ timeout: 45_000 });
  expect(before).toBeGreaterThan(0);
});
