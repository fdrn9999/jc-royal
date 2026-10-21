import { expect } from '@playwright/test';
import { balanceOf, setRange, signUp, sitWith, test, widerThanDevice } from './helpers';

test('mobile: top-up and auto rebuy fit the phone, and an empty wallet is explained instead of offered', async ({ browser }) => {
  const m = await signUp(browser, { mobile: true });
  await sitWith(m.page, 'e2e-topup-m', 100);
  await expect.poll(() => balanceOf(m.page)).toBe(9900);

  await m.page.getByTestId('topup-open').tap();
  const modal = m.page.getByTestId('topup-modal');
  await expect(modal).toBeVisible();
  expect(await widerThanDevice(m.page)).toBe(false);
  await setRange(modal.getByTestId('topup-range'), 250);
  await m.page.screenshot({ path: 'test-results/topup-mobile.png', animations: 'disabled' });
  await modal.getByTestId('topup-confirm').tap();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => balanceOf(m.page)).toBe(9650);

  await m.page.getByTestId('topup-open').tap();
  await expect(modal.getByTestId('topup-stack')).toHaveText('350');
  await modal.getByTestId('rebuy-section').scrollIntoViewIfNeeded();
  await modal.getByTestId('rebuy-times-5').tap();
  await modal.getByTestId('rebuy-consent').tap();
  await expect(modal.getByTestId('rebuy-consent')).toBeChecked();
  await expect(modal.getByTestId('rebuy-on')).toHaveCSS('opacity', '1');
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/rebuy-mobile.png', animations: 'disabled' });
  await modal.getByTestId('rebuy-on').tap();
  await expect(modal.getByTestId('rebuy-active')).toBeVisible();
  await m.page.getByRole('button', { name: 'close' }).tap();
  await expect(m.page.getByTestId('rebuy-badge')).toBeVisible();
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/topup-status-mobile.png', animations: 'disabled' });

  // Spend the rest of the wallet at another table, then come back: the dialog says why there is nothing to add.
  await sitWith(m.page, 'e2e-topup-drain', 9650);
  await expect.poll(() => balanceOf(m.page)).toBe(0);
  await m.page.goto('/table/e2e-topup-m');
  await m.page.getByTestId('topup-open').tap();
  await expect(modal.getByTestId('topup-short')).toBeVisible();
  await expect(modal.getByTestId('topup-confirm')).toHaveCount(0);
  await expect(modal.getByTestId('topup-short').getByRole('link')).toHaveAttribute('href', '/me');
  // In a new tab: leaving the table for the wallet would leave the seat's connection behind.
  await expect(modal.getByTestId('topup-wallet-link')).toHaveAttribute('target', '_blank');
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/topup-short-mobile.png', animations: 'disabled' });
});

test('mobile: the buy-in dialog with an auto top-up chosen fits the phone, and so does the policy shown while seated', async ({ browser }) => {
  const m = await signUp(browser, { mobile: true });
  await m.page.goto('/table/e2e-autotop-m?sit=1');
  const confirm = m.page.getByTestId('buyin-confirm');
  const auto = m.page.getByTestId('buyin-autobuy');
  await expect(auto).toBeVisible();
  await setRange(m.page.getByRole('dialog').locator('input[type="range"]'), 400);
  await auto.getByTestId('autobuy-mode-topup').scrollIntoViewIfNeeded();
  await auto.getByTestId('autobuy-mode-topup').tap();
  await setRange(auto.getByTestId('autotop-trigger'), 250);
  await auto.getByTestId('autotop-times-5').tap();
  await auto.getByTestId('autotop-partial').tap();
  await auto.getByTestId('autotop-consent').tap();
  await expect(auto.getByTestId('autotop-consent')).toBeChecked();
  // Taking what the wallet holds is part of what is agreed to.
  await expect(auto.getByTestId('autotop-consent').locator('..')).toContainText(/가진 만큼|what my wallet holds/);
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/autotop-buyin-mobile.png', animations: 'disabled' });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.tap();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => balanceOf(m.page)).toBe(9600);

  await expect(m.page.getByTestId('autotop-badge')).toContainText('0/2,000');
  await m.page.getByTestId('topup-open').tap();
  const modal = m.page.getByTestId('topup-modal');
  await modal.getByTestId('autotop-active').scrollIntoViewIfNeeded();
  // At the target nothing is due.
  await expect(modal.getByTestId('autotop-estimate')).toHaveText(/충전하지 않습니다|nothing is added/);
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/autotop-status-mobile.png', animations: 'disabled' });
});
