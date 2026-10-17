import { expect } from '@playwright/test';
import { signUp, test } from './helpers';
import { emulateInstall, fireBip, memo, openSettings, prompts, realBip } from './install-helpers';

// Emulated in desktop Chrome: the browser's install prompt is fired by the test, and nothing is installed.

test('desktop: no lobby offer until the browser can install; the steps and the status live in settings, in Korean and English', async ({ browser }) => {
  const { page } = await signUp(browser);
  await emulateInstall(page);
  await page.reload();
  const offer = page.getByTestId('install-offer');
  await openSettings(page, false);
  // A computer gets no offer from the steps alone.
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'browser');
  await expect(page.getByTestId('settings-install-prompt')).toHaveCount(0);
  await page.getByTestId('settings-install-guide').click();
  await expect(page.getByTestId('install-tab-desktop')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('install-steps-desktop').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('install-steps-mac')).toContainText('Dock에 추가');
  await page.getByTestId('settings-install').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/install-settings-desktop.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // The browser hands over its prompt: offered in the lobby, shown when asked, gone once installed.
  await fireBip(page, 'accepted');
  await expect(page.getByTestId('install-offer-prompt')).toBeVisible();
  await expect(offer).toContainText('JC ROYAL을 앱으로 설치');
  await page.screenshot({ path: 'test-results/install-offer-desktop.png', animations: 'disabled' });
  await page.getByTestId('install-offer-prompt').click();
  await expect.poll(() => prompts(page)).toEqual(['accepted']);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(offer).toHaveCount(0);
  expect((await memo(page)).installed).toBe(true);

  // Kept after a reload; then English, the account's language chosen in the settings, at once.
  await page.reload();
  await openSettings(page, false);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'installed');
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await expect(page.getByTestId('settings-install')).toContainText('Install as an app');
  await expect(page.getByTestId('install-status')).toHaveText(/Installed in this browser/);
  await page.getByTestId('settings-install-guide').click();
  await expect(page.getByTestId('install-steps-desktop')).toContainText('Install');
  await expect(page.getByTestId('install-tab-ios')).toHaveText('iPhone·iPad');
  await page.keyboard.press('Escape');
  console.log(`real beforeinstallprompt events: ${await realBip(page)}`);
});
