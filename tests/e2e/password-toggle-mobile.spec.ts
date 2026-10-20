import { expect } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { eyeKeepsField, leftNowhere, SHOW } from './password-helpers';

test('on a phone: the eye button works by tap, and the account-deletion prompt forgets the password when it closes', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('/me');
  const open = page.getByRole('button', { name: /^(회원 탈퇴|Delete account)$/ });
  await open.tap();
  const dialog = page.getByRole('dialog');
  const pw = dialog.getByLabel(/^(비밀번호|Password)$/);
  const eye = dialog.getByTestId('password-toggle');
  // The button is big enough to tap and stays inside the field on a phone.
  const [f, b] = [(await pw.boundingBox())!, (await eye.boundingBox())!];
  expect(b.width).toBeGreaterThanOrEqual(40);
  expect(b.height).toBeGreaterThanOrEqual(36);
  expect(b.x + b.width).toBeLessThanOrEqual(f.x + f.width + 1);
  expect(await widerThanDevice(page)).toBe(false);
  const typed = await eyeKeepsField(page, pw, 'Tapped-4321', 'tap');
  // Left shown and cancelled: it opens again empty, with the password hidden.
  await eye.tap();
  await expect(pw).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: /^(취소|Cancel)$/ }).tap();
  await expect(dialog).toHaveCount(0);
  await open.tap();
  await expect(pw).toHaveValue('');
  await expect(pw).toHaveAttribute('type', 'password');
  await expect(eye).toHaveAccessibleName(SHOW);
  await leftNowhere(page, typed, logs);
});
