import { expect } from '@playwright/test';
import { balanceOf, signUp, test, widerThanDevice } from './helpers';

test('mobile: quick play seats players at the table, then explains a full table and what to do instead', async ({ browser }) => {
  // E2E Quick Mobile is the only 2-seat table at 9/18.
  const first = await signUp(browser, { mobile: true });
  const panel = first.page.getByTestId('quick-play');
  await expect(panel).toBeVisible();
  expect(await widerThanDevice(first.page)).toBe(false);
  await panel.getByTestId('quick-seats-2').tap();
  await panel.getByTestId('quick-blind').selectOption('18');
  await first.page.screenshot({ path: 'test-results/quick-play-mobile.png' });
  await panel.getByTestId('quick-go').tap();
  await expect(first.page).toHaveURL(/\/table\/e2e-quick-m\?/);
  await first.page.getByTestId('buyin-confirm').tap();
  await expect.poll(() => balanceOf(first.page)).toBe(8200);

  const second = await signUp(browser, { mobile: true });
  await second.page.getByTestId('quick-seats-2').tap();
  await second.page.getByTestId('quick-blind').selectOption('18');
  await second.page.getByTestId('quick-go').tap();
  await expect(second.page).toHaveURL(/\/table\/e2e-quick-m\?/);
  await second.page.getByTestId('buyin-confirm').tap();
  await expect.poll(() => balanceOf(second.page)).toBe(8200);

  // The only matching table is now full: the room says so even if the lobby counts lag, and the panel offers a way on.
  const third = await signUp(browser, { mobile: true });
  const quick = third.page.getByTestId('quick-play');
  await quick.getByTestId('quick-seats-2').tap();
  await quick.getByTestId('quick-blind').selectOption('18');
  await quick.getByTestId('quick-go').tap();
  const miss = quick.getByTestId('quick-miss');
  await expect(miss).toHaveAttribute('data-code', 'tables_full');
  // Still the lobby (no table opened), its filters in the address.
  await expect(third.page).toHaveURL('/?seats=2&bb=18');
  expect(await widerThanDevice(third.page)).toBe(false);
  await third.page.screenshot({ path: 'test-results/quick-full-mobile.png' });
  await miss.getByRole('button', { name: /방 만들기|Create room/ }).tap();
  await expect(third.page.getByTestId('room-create')).toBeVisible();
  await third.page.getByRole('button', { name: /^(취소|Cancel)$/ }).tap();
  await miss.getByTestId('quick-reset').tap();
  await expect(quick.getByTestId('quick-blind')).toHaveValue('0');
  await expect(quick.getByTestId('quick-seats-0')).toHaveAttribute('aria-checked', 'true');
  await expect(miss).toHaveCount(0);

  // Arriving through a quick play link after the seat went: a banner that fits the phone, not a dead end.
  await third.page.goto('/table/e2e-quick-m?sit=1&quick=2,18,e2e-quick-m');
  const missed = third.page.getByTestId('quick-missed');
  await expect(missed).toBeVisible();
  expect(await widerThanDevice(third.page)).toBe(false);
  await third.page.screenshot({ path: 'test-results/quick-missed-mobile.png' });
  await missed.getByTestId('quick-another').tap();
  await expect(missed.getByTestId('quick-miss')).toHaveAttribute('data-code', 'no_table');
  expect(await balanceOf(third.page)).toBe(10000);
});
