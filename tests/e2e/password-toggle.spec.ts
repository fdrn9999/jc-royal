import { expect } from '@playwright/test';
import { ADMIN, sql } from './analytics-helpers';
import { PASSWORD, signUp, test } from './helpers';
import { eyeKeepsField, leftNowhere, SHOW } from './password-helpers';

test('password fields: the eye button shows and hides what was typed without losing it, and the admin password prompt forgets it', async ({ browser, page }) => {
  test.setTimeout(120_000);
  // The player site's sign-in, by mouse and by keyboard.
  await page.goto('/login');
  const login = page.getByLabel(/^(비밀번호|Password)$/);
  await eyeKeepsField(page, login, 'Typed-9876', 'click');
  await eyeKeepsField(page, login, 'Keys-5432', 'keys');

  // An administrator's sensitive change: a chip adjustment asks for the password again.
  const boss = await signUp(browser);
  const member = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const logs: string[] = [];
  a.on('console', (m) => logs.push(m.text()));
  await a.goto(ADMIN);
  await a.getByLabel(/이메일|Email/).fill(boss.email);
  const adminLogin = a.getByLabel(/^(비밀번호|Password)$/);
  await eyeKeepsField(a, adminLogin, 'Login-1111', 'click');
  await adminLogin.fill(PASSWORD);
  await a.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(a.getByTestId('dashboard')).toBeVisible();

  await a.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await a.getByPlaceholder(/검색|Search/).fill(member.nickname);
  await a.getByPlaceholder(/검색|Search/).press('Enter');
  await a.getByRole('link', { name: /상세|Details/ }).first().click();
  await a.getByLabel(/금액|Amount/).fill('25');
  await a.getByLabel(/^메모$|^Memo$/).fill('E2E 비밀번호 보기');
  const askAgain = async () => {
    await a.getByTestId('chip-submit').click();
    await a.getByTestId('confirm-end').click();
    await expect(a.getByTestId('reauth-confirm')).toBeVisible();
  };
  const prompt = a.getByRole('dialog').filter({ has: a.getByTestId('reauth-confirm') });
  const pw = prompt.getByTestId('reauth-password');
  const eye = prompt.getByTestId('password-toggle');
  const opensEmptyAndHidden = async () => {
    await askAgain();
    await expect(pw).toHaveValue('');
    await expect(pw).toHaveAttribute('type', 'password');
    await expect(eye).toHaveAccessibleName(SHOW);
  };

  await askAgain();
  await expect(pw).toHaveAccessibleName(/^(비밀번호|Password)$/);
  const shown = await eyeKeepsField(a, pw, 'Wrong-0000', 'click');
  const keyed = await eyeKeepsField(a, pw, 'Keys-3333', 'keys');
  // Left shown and cancelled: nothing was sent, and the prompt opens again empty, with the password hidden.
  await eye.click();
  await expect(pw).toHaveAttribute('type', 'text');
  await prompt.getByRole('button', { name: /^(취소|Cancel)$/ }).click();
  await expect(a.getByTestId('reauth-confirm')).toHaveCount(0);
  await expect(a.getByRole('cell', { name: '+25' })).toHaveCount(0);
  await opensEmptyAndHidden();
  // Closed with Escape: the same.
  await pw.fill('Escape-2222');
  await eye.click();
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('reauth-confirm')).toHaveCount(0);
  await opensEmptyAndHidden();
  // Sent while shown: the server still checks it, and the change goes through.
  await pw.fill(PASSWORD);
  await eye.click();
  await expect(pw).toHaveAttribute('type', 'text');
  await pw.press('Enter');
  await expect(a.getByTestId('reauth-confirm')).toHaveCount(0);
  await expect(a.getByRole('cell', { name: '+25' })).toBeVisible();
  for (const secret of [shown, keyed, 'Escape-2222', PASSWORD]) await leftNowhere(a, secret, logs);
});
