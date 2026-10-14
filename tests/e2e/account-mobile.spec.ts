import { expect, type Page } from '@playwright/test';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';

const sessionCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'jc_sid');

async function logOutFromGear(page: Page) {
  await page.getByTestId('settings-open').tap();
  await page.getByTestId('settings-logout').tap();
  await expect(page).toHaveURL(/\/login$/);
  expect(await sessionCookie(page)).toBeUndefined();
}

test('mobile: my page fits the phone, the header gear opens settings with logout, and 자동 로그인 decides how long the sign-in lasts', async ({ browser }) => {
  const { page, email } = await signUp(browser, { mobile: true });

  // The session list shows this phone's long user agent on one line; it must not widen the page.
  await page.goto('/me');
  await expect(page.getByText(/현재 기기|This device/)).toBeVisible();
  // Settings live behind a gear that every page header shows, on the phone too.
  const gear = page.getByTestId('settings-open');
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect(await widerThanDevice(page)).toBe(false);
    await expect(gear).toBeVisible();
    const box = (await gear.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/me-mobile-${width}.png`, fullPage: true });
  }
  await page.goto('/');
  await gear.tap();
  await expect(page.getByTestId('settings-logout')).toBeVisible();
  await page.screenshot({ path: 'test-results/settings-mobile.png', animations: 'disabled' });
  await page.getByTestId('settings-logout').tap();
  await expect(page).toHaveURL(/\/login$/);
  expect(await sessionCookie(page)).toBeUndefined();

  const remember = page.getByTestId('login-remember');
  async function logIn(keep: boolean) {
    await page.getByLabel(/^(이메일|Email)$/).fill(email);
    await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await remember.setChecked(keep);
    await page.getByRole('button', { name: /^(로그인|Log in)$/ }).tap();
    await expect(page).toHaveURL(/\/$/);
    return (await sessionCookie(page))!;
  }
  // Off (the default): a browser-session cookie, gone when the browser closes.
  await expect(remember).not.toBeChecked();
  await page.screenshot({ path: 'test-results/login-mobile.png', animations: 'disabled' });
  expect((await logIn(false)).expires).toBe(-1);
  await logOutFromGear(page);

  // On: the cookie lasts 30 days, and the box stays ticked on this device next time.
  const kept = await logIn(true);
  expect(kept.expires * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
  await page.reload();
  await expect(page.getByTestId('settings-open')).toBeVisible();
  // My page also offers logout next to the account actions.
  await page.goto('/me');
  await page.getByTestId('me-logout').tap();
  await expect(page).toHaveURL(/\/login$/);
  await expect(remember).toBeChecked();
});
