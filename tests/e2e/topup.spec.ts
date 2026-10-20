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
  // Let B hold the turn so A's status bar (and its top-up button) is showing. The bar ignores a press in its first
  // moment (a stray tap as it appears), so A presses until the bar is gone, not just once.
  await expect
    .poll(async () => (await checkOrCall(a.page), !(await a.page.getByTestId('action-bar').isVisible()) && (await a.page.getByTestId('topup-open').isVisible())), { timeout: 15_000 })
    .toBe(true);
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

test('top-up: the dialog opens with its suggested amount already in place, so an amount picked at once is the one sent', async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, 'e2e-topup-open', 100);
  const open = a.page.getByTestId('topup-open');
  for (const pick of [250, 250]) {
    await expect(open).toBeVisible();
    // Open the dialog and move the slider in the same task as the first paint, before any later effect could run.
    const shown = await a.page.evaluate(async (v) => {
      (document.querySelector('[data-testid="topup-open"]') as HTMLButtonElement).click();
      await Promise.resolve();
      const range = document.querySelector('[data-testid="topup-range"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, String(v));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return document.querySelector('[data-testid="topup-amount"]')!.textContent;
    }, pick);
    expect(shown).toBe(`+${pick}`);
    await a.page.keyboard.press('Escape');
    await expect(a.page.getByTestId('topup-modal')).toHaveCount(0);
  }
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

test('auto top-up: chosen with the first buy-in, it fills the stack back to the target after a hand, from the wallet, once', async ({ browser }) => {
  const a = await signUp(browser);
  await a.page.goto('/table/e2e-autotop?sit=1');
  const dialog = a.page.getByRole('dialog');
  const confirm = a.page.getByTestId('buyin-confirm');
  const auto = dialog.getByTestId('buyin-autobuy');
  await expect(auto).toBeVisible();
  // Off unless the player picks a policy, and one at a time.
  await expect(auto.getByTestId('autobuy-mode-off')).toHaveAttribute('aria-checked', 'true');
  await setRange(dialog.locator('input[type="range"]'), 300);
  await expect(confirm).toContainText('300');
  await expect(confirm).toBeEnabled();
  await auto.getByTestId('autobuy-mode-rebuy').click();
  await expect(auto.getByTestId('rebuy-range')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await auto.getByTestId('autobuy-mode-topup').click();
  await expect(auto.getByTestId('autobuy-mode-rebuy')).toHaveAttribute('aria-checked', 'false');
  await expect(auto.getByTestId('rebuy-range')).toHaveCount(0);
  // The target starts at the buy-in, and the trigger at the target (below it, a top-up is due).
  await expect(auto.getByTestId('autotop-target-amount')).toHaveText('300');
  await expect(auto.getByTestId('autotop-trigger-amount')).toHaveText('300');
  await setRange(auto.getByTestId('autotop-target'), 500);
  await expect(auto.getByTestId('autotop-trigger-amount')).toHaveText('500');
  await setRange(auto.getByTestId('autotop-trigger'), 400);
  await expect(auto.getByTestId('autotop-trigger-amount')).toHaveText('400');
  // No consent, no buy-in with the policy; changing the terms withdraws the consent given for the old ones.
  await auto.getByTestId('autotop-times-2').click();
  await expect(confirm).toBeDisabled();
  await auto.getByTestId('autotop-consent').check();
  await expect(auto.getByTestId('autotop-consent').locator('..')).toContainText(/400.*500.*1,000/);
  await expect(confirm).toBeEnabled();
  await auto.getByTestId('autotop-times-3').click();
  await expect(auto.getByTestId('autotop-consent')).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await auto.getByTestId('autotop-times-2').click();
  await auto.getByTestId('autotop-consent').check();
  await a.page.screenshot({ path: 'test-results/autotop-buyin-desktop.png', animations: 'disabled' });
  await confirm.click();
  await expect(confirm).toHaveCount(0);

  // Seated with the policy; choosing it took nothing but the buy-in.
  await expect(a.page.getByTestId('autotop-badge')).toContainText('0/1,000');
  await expect.poll(() => balanceOf(a.page)).toBe(9700);
  await a.page.getByTestId('topup-open').click();
  const modal = a.page.getByTestId('topup-modal');
  await expect(modal.getByTestId('autotop-active')).toContainText(/500.*400/);
  // 300 is below 400: the next hand, ended here, would bring 200. Shown as an estimate only.
  await expect(modal.getByTestId('autotop-estimate')).toContainText('200');
  await expect(modal.getByTestId('autotop-active')).toContainText(/확정 금액이 아닙니다|not a confirmed amount/);
  await a.page.screenshot({ path: 'test-results/autotop-status-desktop.png', animations: 'disabled' });
  await a.page.keyboard.press('Escape');
  expect(await balanceOf(a.page)).toBe(9700);

  // A hand with a second player: check/call ends it near 300, below the trigger, and the room fills it up to 500.
  const b = await signUp(browser);
  await sitWith(b.page, 'e2e-autotop', 100);
  const notice = a.page.getByTestId('table-notice');
  for (let i = 0; i < 80 && !(await notice.isVisible()); i++) {
    if (!(await checkOrCall(a.page)) && !(await checkOrCall(b.page))) await a.page.waitForTimeout(250);
  }
  await expect(notice).toContainText(/자동 스택 보충 완료|Auto top-up done/);
  const added = Number(((await notice.textContent()) ?? '').match(/([\d,]+)\s*(칩을|chips)/)![1]!.replace(/,/g, ''));
  // Whatever the hand left (290, 300 or 310 with these blinds), what the wallet gave is what the stack lacked.
  expect([190, 200, 210]).toContain(added);
  await expect.poll(() => balanceOf(a.page)).toBe(9700 - added);
  await expect(a.page.getByTestId('autotop-badge')).toContainText(`${added}/1,000`);

  // The wallet history names it apart from a top-up the player made.
  const me = await a.page.context().newPage();
  await me.goto('/me');
  await expect(me.getByTestId('ledger').getByText(/^(자동 스택 보충|Auto top-up)$/)).toHaveCount(1);
  await expect(me.getByTestId('ledger').getByText(/^(스택 충전|Table top-up)$/)).toHaveCount(0);
  await me.close();

  // Turned off from the seat (while B holds the turn, so A's bar shows), it takes nothing more.
  await expect
    .poll(async () => (await checkOrCall(a.page), !(await a.page.getByTestId('action-bar').isVisible()) && (await a.page.getByTestId('topup-open').isVisible())), { timeout: 15_000 })
    .toBe(true);
  await a.page.getByTestId('topup-open').click();
  await modal.getByTestId('autotop-off').click();
  await expect(modal.getByTestId('autotop-active')).toHaveCount(0);
  await expect(modal.getByTestId('autobuy-mode-topup')).toBeVisible();
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByTestId('autotop-badge')).toHaveCount(0);
});
