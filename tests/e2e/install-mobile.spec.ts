import { expect } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { DAY, emulateAs, emulateInstall, fireBip, IPHONE_SAFARI, KAKAO_IOS, memo, openSettings, prompts, realBip } from './install-helpers';

// Emulated (Pixel 7 in Chrome, user agents and display modes set in the page): no real phone, and nothing is installed.

test('mobile: Android Chrome lobby offers the install steps; Later and the 30-day snooze stay hidden across a reload and settings bring the offer back', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await emulateInstall(page);
  await page.reload();
  const offer = page.getByTestId('install-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('JC ROYAL을 앱으로 설치');
  // No browser prompt yet: the steps instead.
  await expect(page.getByTestId('install-offer-prompt')).toHaveCount(0);
  const vw = page.viewportSize()!.width;
  const box = (await offer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  for (const id of ['install-offer-guide', 'install-later', 'install-snooze']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(40);
    expect(b.x + b.width, id).toBeLessThanOrEqual(vw);
  }
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/install-offer-mobile.png', animations: 'disabled' });

  // The steps, on this device's tab first.
  await page.getByTestId('install-offer-guide').tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('앱으로 설치하는 방법')).toBeVisible();
  await expect(page.getByTestId('install-tab-android')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('install-steps-android').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('install-steps-samsung').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('install-steps-samsung')).toContainText('홈 화면');
  await expect(dialog).toContainText('오프라인용으로 기기에 저장하지 않습니다');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/install-guide-android-mobile.png', animations: 'disabled' });
  await page.getByTestId('install-tab-ios').tap();
  await expect(page.getByTestId('install-tab-ios')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('install-steps-ios').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('install-steps-ios')).toContainText('웹 앱으로 열기');
  await page.getByTestId('install-tab-desktop').tap();
  await expect(page.getByTestId('install-steps-desktop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('install-guide')).toHaveCount(0);

  // Later: three days, on this device, across a reload.
  const t0 = Date.now();
  await page.getByTestId('install-later').tap();
  await expect(offer).toHaveCount(0);
  const later = (await memo(page)).until!;
  expect(later - t0).toBeGreaterThan(3 * DAY - 60_000);
  expect(later - t0).toBeLessThan(3 * DAY + 60_000);
  await page.reload();
  await openSettings(page, true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'browser');
  await expect(page.getByTestId('install-hidden-until')).toBeVisible();
  // Settings bring it back at once.
  await page.getByTestId('install-unsnooze').tap();
  await expect(page.getByTestId('install-hidden-until')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(offer).toBeVisible();

  // Not for 30 days.
  const t1 = Date.now();
  await page.getByTestId('install-snooze').tap();
  await expect(offer).toHaveCount(0);
  const month = (await memo(page)).until!;
  expect(month - t1).toBeGreaterThan(30 * DAY - 60_000);
  expect(month - t1).toBeLessThan(30 * DAY + 60_000);
  await page.reload();
  await openSettings(page, true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-hidden-until')).toBeVisible();
  // The steps open in the settings themselves, not in a second dialog.
  await page.getByTestId('settings-install-guide').tap();
  await expect(page.getByTestId('settings-install-guide')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('settings-install').getByTestId('install-guide')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByTestId('settings-install').scrollIntoViewIfNeeded();
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/install-settings-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // A device clock set back a year never stretches the 30 days.
  await page.evaluate((d) => localStorage.setItem('jc.install', JSON.stringify({ until: Date.now() + 400 * d, installed: false })), DAY);
  await page.reload();
  await expect(offer).toBeVisible();
  console.log(`real beforeinstallprompt events: ${await realBip(page)}`);
});

test('mobile: the offer draws with the lobby, so quick play is not pushed down while the install steps are still loading', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await emulateInstall(page);
  // Held until released below. The offer used to come in this chunk and land above quick play when it arrived (184px
  // lower at 390×844), under a finger already on its way to quick play.
  let release!: () => void;
  const steps = new Promise<void>((r) => (release = r));
  await page.route('**/assets/Install-*.js', async (route) => {
    await steps;
    await route.continue();
  });
  await page.reload();
  const offer = page.getByTestId('install-offer');
  const quick = page.getByTestId('quick-play');
  await expect(quick).toBeVisible();
  await expect(offer).toBeVisible();
  // The web font swaps in after the first paint and reflows all lobby text by itself (12–16px at 320 and 430 wide).
  await page.evaluate(() => document.fonts.ready);
  const at = (await quick.boundingBox())!.y;
  expect((await offer.boundingBox())!.y).toBeLessThan(at);

  // Opened before the steps arrive, the dialog fills in when they do.
  await page.getByTestId('install-offer-guide').tap();
  await expect(page.getByRole('dialog').getByText('앱으로 설치하는 방법')).toBeVisible();
  await expect(page.getByTestId('install-steps-android')).toHaveCount(0);
  release();
  await expect(page.getByTestId('install-steps-android').locator('li')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('install-guide')).toHaveCount(0);
  expect((await quick.boundingBox())!.y).toBe(at);
});

test('mobile: the browser install prompt — dismissed keeps the offer, installed hides it until the browser offers again; never in the app or at a table', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await emulateInstall(page);
  await page.reload();
  const offer = page.getByTestId('install-offer');
  await expect(page.getByTestId('install-offer-guide')).toBeVisible();

  await fireBip(page, 'dismissed');
  await page.getByTestId('install-offer-prompt').tap();
  await expect(page.getByTestId('install-note')).toHaveText(/설치하지 않았습니다/);
  expect(await prompts(page)).toEqual(['dismissed']);
  // A prompt works once: back to the steps.
  await expect(page.getByTestId('install-offer-guide')).toBeVisible();
  await expect(offer).toBeVisible();

  await fireBip(page, 'accepted');
  await page.getByTestId('install-offer-prompt').tap();
  await expect.poll(() => prompts(page)).toEqual(['dismissed', 'accepted']);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(offer).toHaveCount(0);
  expect((await memo(page)).installed).toBe(true);
  await page.reload();
  await openSettings(page, true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'installed');
  await page.keyboard.press('Escape');

  // Removed again: the browser offers its prompt, and the lobby with it.
  await fireBip(page, 'dismissed');
  await expect(page.getByTestId('install-offer-prompt')).toBeVisible();
  expect((await memo(page)).installed).toBe(false);

  // At a table: settings have the section, the page never the offer.
  await page.goto('/table/e2e-six');
  const cancel = page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ });
  if (await cancel.isVisible().catch(() => false)) await cancel.tap();
  await fireBip(page, 'dismissed');
  await page.getByRole('button', { name: /^(설정|Settings)$/ }).tap();
  await page.getByTestId('settings-install').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('settings-install')).toBeVisible();
  await expect(page.getByTestId('settings-install-prompt')).toBeVisible();
  await expect(offer).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Opened as the app (display mode standalone): nothing to offer.
  await page.goto('/');
  await emulateAs(page, { standalone: 'display' });
  await fireBip(page, 'dismissed');
  await openSettings(page, true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'app');
  await expect(page.getByTestId('settings-install-guide')).toHaveCount(0);
});

test('mobile: iPhone Safari gets the Share → Add to Home Screen steps, an in-app browser the way out, the home screen app nothing; in English too', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await emulateInstall(page);
  await emulateAs(page, { ua: IPHONE_SAFARI });
  const offer = page.getByTestId('install-offer');
  await expect(offer).toBeVisible();
  await page.getByTestId('install-offer-guide').tap();
  await expect(page.getByTestId('install-tab-ios')).toHaveAttribute('aria-selected', 'true');
  const ios = page.getByTestId('install-steps-ios');
  await expect(ios.locator('li')).toHaveCount(5);
  await expect(ios.locator('li').nth(0)).toContainText('Safari');
  await expect(ios.locator('li').nth(1)).toContainText('공유 버튼');
  await expect(ios.locator('li').nth(2)).toContainText('홈 화면에 추가');
  await expect(ios.locator('li').nth(3)).toContainText('웹 앱으로 열기');
  await expect(ios.locator('li').nth(4)).toContainText('추가');
  await expect(page.getByTestId('install-inapp')).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/install-guide-ios-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // KakaoTalk's browser cannot install: the way out, and the address to take along.
  await emulateAs(page, { ua: KAKAO_IOS });
  await expect(offer).toContainText('다른 앱 안의 브라우저');
  await page.getByTestId('install-offer-guide').tap();
  await expect(page.getByTestId('install-inapp')).toBeVisible();
  await page.getByTestId('install-copy').tap();
  await expect(page.getByTestId('install-inapp').getByRole('status')).toHaveText('주소를 복사했습니다.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(page.url()).origin + '/');
  await page.screenshot({ path: 'test-results/install-inapp-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // English (the account's language, chosen in the settings).
  await openSettings(page, true);
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await expect(page.getByTestId('settings-install')).toContainText('Install as an app');
  await page.keyboard.press('Escape');
  await emulateAs(page, { ua: IPHONE_SAFARI });
  await expect(offer).toContainText('Install JC ROYAL as an app');
  await expect(page.getByTestId('install-snooze')).toHaveText("Don't show for 30 days");
  await page.getByTestId('install-offer-guide').tap();
  await expect(page.getByTestId('install-steps-ios')).toContainText('Add to Home Screen');
  await expect(page.getByTestId('install-steps-ios')).toContainText('Open as Web App');
  await page.screenshot({ path: 'test-results/install-guide-ios-en-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // Opened from the home screen (navigator.standalone).
  await emulateAs(page, { ua: IPHONE_SAFARI, standalone: 'ios' });
  await openSettings(page, true);
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('install-status')).toHaveAttribute('data-state', 'app');
});
