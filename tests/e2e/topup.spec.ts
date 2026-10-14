import { expect } from '@playwright/test';
import { balanceOf, checkOrCall, setRange, signUp, sitWith, test } from './helpers';

test('top-up: between hands it applies at once; during a hand it waits, can be cancelled, and arrives after the hand', async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, 'e2e-topup', 100);
  await expect.poll(() => balanceOf(a.page)).toBe(9900);

  // Alone at the table: no hand, so the chips join the stack at once.
  await a.page.getByTestId('topup-open').click();
  const modal = a.page.getByTestId('topup-modal');
  await expect(modal.getByTestId('topup-stack')).toHaveText('100');
  await expect(modal.getByTestId('topup-wallet')).toHaveText('9,900');
  await expect(modal).toContainText(/충전 후 스택은 100–1,000 사이|between 100 and 1,000/);
  // The control never offers more than the table's maximum.
  await expect(modal.getByTestId('topup-range')).toHaveAttribute('max', '900');
  await setRange(modal.getByTestId('topup-range'), 200);
  await expect(modal.getByTestId('topup-amount')).toHaveText('+200');
  await a.page.screenshot({ path: 'test-results/topup-desktop.png', animations: 'disabled' });
  await modal.getByTestId('topup-confirm').click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => balanceOf(a.page)).toBe(9700);

  // A second player starts a hand.
  const b = await signUp(browser);
  await sitWith(b.page, 'e2e-topup', 100);
  await expect(a.page.getByText(/(핸드|Hand) #1 ·/).first()).toBeVisible({ timeout: 15_000 });
  // Let B hold the turn so A's status bar (and its top-up button) is showing.
  await expect.poll(async () => (await checkOrCall(a.page)) || (await a.page.getByTestId('topup-open').isVisible()), { timeout: 15_000 }).toBe(true);
  await expect(a.page.getByTestId('topup-open')).toBeVisible();

  await a.page.getByTestId('topup-open').click();
  await expect(modal).toContainText(/핸드가 끝난 뒤 충전|added when it ends/);
  await setRange(modal.getByTestId('topup-range'), 300);
  await modal.getByTestId('topup-confirm').click();
  await expect(a.page.getByTestId('topup-queued')).toContainText('300');
  // Nothing leaves the wallet while it waits, and it can be withdrawn.
  expect(await balanceOf(a.page)).toBe(9700);
  await a.page.screenshot({ path: 'test-results/topup-queued-desktop.png', animations: 'disabled' });
  await a.page.getByTestId('topup-cancel').click();
  await expect(a.page.getByTestId('topup-queued')).toHaveCount(0);
  await a.page.getByTestId('topup-open').click();
  await setRange(modal.getByTestId('topup-range'), 300);
  await modal.getByTestId('topup-confirm').click();
  await expect(a.page.getByTestId('topup-queued')).toContainText('300');

  // Play the hand out; the room then adds the chips and says so.
  const notice = a.page.getByTestId('table-notice');
  for (let i = 0; i < 80 && !(await notice.isVisible()); i++) {
    if (!(await checkOrCall(a.page)) && !(await checkOrCall(b.page))) await a.page.waitForTimeout(250);
  }
  await expect(notice).toContainText(/300 칩을 충전|Added 300 chips/);
  await expect(a.page.getByTestId('topup-queued')).toHaveCount(0);
  await expect.poll(() => balanceOf(a.page)).toBe(9400);

  // The wallet history names the top-ups.
  const me = await a.page.context().newPage();
  await me.goto('/me');
  await expect(me.getByTestId('ledger').getByText(/^(스택 충전|Table top-up)$/)).toHaveCount(2);
});

test('auto rebuy: off by default, needs explicit consent with an amount and a limit, and can be turned off', async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, 'e2e-rebuy', 100);
  await expect(a.page.getByTestId('rebuy-badge')).toHaveCount(0);
  await a.page.getByTestId('topup-open').click();
  const modal = a.page.getByTestId('topup-modal');
  const on = modal.getByTestId('rebuy-on');
  await expect(on).toBeDisabled();
  await setRange(modal.getByTestId('rebuy-range'), 200);
  await modal.getByTestId('rebuy-times-3').click();
  await expect(modal.getByTestId('rebuy-times-3')).toHaveAttribute('aria-checked', 'true');
  await modal.getByTestId('rebuy-consent').check();
  await expect(modal.getByTestId('rebuy-consent').locator('..')).toContainText(/200.*600/);
  // Changing the terms withdraws the consent given for the old ones.
  await modal.getByTestId('rebuy-times-5').click();
  await expect(modal.getByTestId('rebuy-consent')).not.toBeChecked();
  await expect(on).toBeDisabled();
  await modal.getByTestId('rebuy-consent').check();
  await expect(modal.getByTestId('rebuy-consent').locator('..')).toContainText(/200.*1,000/);
  // The button looks active (not just enabled) once consent is given.
  await expect(on).toBeEnabled();
  await expect(on).toHaveCSS('opacity', '1');
  await a.page.screenshot({ path: 'test-results/rebuy-desktop.png', animations: 'disabled' });
  await on.click();
  await expect(modal.getByTestId('rebuy-active')).toContainText(/1,000/);
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByTestId('rebuy-badge')).toContainText('0/1,000');
  // Turning it on takes nothing yet.
  expect(await balanceOf(a.page)).toBe(9900);

  await a.page.getByTestId('topup-open').click();
  await modal.getByTestId('rebuy-off').click();
  await expect(modal.getByTestId('rebuy-on')).toBeVisible();
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByTestId('rebuy-badge')).toHaveCount(0);
});
