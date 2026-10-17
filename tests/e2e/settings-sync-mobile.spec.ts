import { expect } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, widerThanDevice } from './helpers';

test('settings sync on a phone: the sync line and its retry in settings, and the member settings panel with its reset preview, fit 390px', async ({ browser }) => {
  test.setTimeout(120_000);
  const m = await signUp(browser, { mobile: true });
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const mId = await m.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

  await m.page.getByTestId('settings-open').click();
  const sync = m.page.getByTestId('settings-sync');
  await expect(sync).toHaveAttribute('data-state', 'saved');
  await expect(sync).toContainText(/계정에 저장되어|saved to your account/);
  expect(await widerThanDevice(m.page)).toBe(false);
  await m.page.screenshot({ path: 'test-results/settings-sync-mobile.png', animations: 'disabled' });

  // Offline: the change applies, the line says so and offers a retry, still within the phone's width.
  const settingsUrl = (u: URL) => u.pathname === '/api/me/settings';
  await m.page.route(settingsUrl, (r) => (r.request().method() === 'PUT' ? r.abort('internetdisconnected') : r.continue()));
  await m.page.getByRole('dialog').locator('button[data-theme="crimson"]').click();
  await expect(m.page.locator('html')).toHaveAttribute('data-theme', 'crimson');
  await expect(sync).toHaveAttribute('data-state', 'error');
  await expect(m.page.getByTestId('settings-sync-retry')).toBeVisible();
  expect(await widerThanDevice(m.page)).toBe(false);
  await sync.scrollIntoViewIfNeeded();
  await m.page.screenshot({ path: 'test-results/settings-sync-error-mobile.png', animations: 'disabled' });
  await m.page.unroute(settingsUrl);
  await m.page.getByTestId('settings-sync-retry').click();
  await expect(sync).toHaveAttribute('data-state', 'saved');

  const admin = await adminLogin(browser, op.email, { mobile: true });
  await admin.goto(`${ADMIN}/users/${mId}`);
  const panel = admin.getByTestId('member-settings');
  await panel.scrollIntoViewIfNeeded();
  await expect(admin.getByTestId('member-settings-fields')).toHaveText('1 / 7');
  expect(await widerThanDevice(admin)).toBe(false);
  await panel.screenshot({ path: 'test-results/admin-member-settings-mobile.png', animations: 'disabled' });
  await admin.getByTestId('member-settings-reset').click();
  await expect(admin.getByTestId('settings-pv-scope')).toHaveAttribute('data-fields', '1');
  expect(await widerThanDevice(admin)).toBe(false);
  await admin.screenshot({ path: 'test-results/admin-settings-reset-mobile.png', animations: 'disabled' });
  // Opening the preview changes nothing.
  await admin.keyboard.press('Escape');
  await expect(admin.getByTestId('settings-act')).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-epoch', '0');
});
