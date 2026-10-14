import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

const ADMIN = 'http://localhost:5174';

test('admin console: bootstrap, login, create table, adjust chips with password re-confirmation, member is notified', async ({ browser, request }) => {
  // The owner registers on the player site, then is promoted with the deployment bootstrap token.
  const owner = await signUp(browser);
  const boot = await request.post(`${ADMIN}/api/admin/auth/bootstrap`, { headers: { Origin: ADMIN }, data: { token: 'e2e-bootstrap-token-0123456789', email: owner.email } });
  expect(boot.status()).toBe(200);
  const member = await signUp(browser);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(owner.email);
  await page.getByLabel(/비밀번호|Password/).fill('password123');
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // Create a table → visible in the player lobby.
  await page.getByRole('link', { name: /^테이블$|^Tables$/ }).click();
  await page.getByTestId('create-table').click();
  await page.getByLabel(/^이름$|^Name$/).fill('E2E 로열 라운지');
  await page.getByRole('button', { name: /^저장$|^Save$/ }).click();
  await expect(page.getByText('E2E 로열 라운지')).toBeVisible();
  await member.page.reload();
  await expect(member.page.getByText('E2E 로열 라운지')).toBeVisible();

  // Chip grant requires the admin password again.
  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await page.getByPlaceholder(/검색|Search/).fill(member.nickname);
  await page.getByPlaceholder(/검색|Search/).press('Enter');
  await page.getByRole('link', { name: /상세|Details/ }).first().click();
  await page.getByLabel(/금액|Amount/).fill('777');
  await page.getByLabel(/메모|Memo/).fill('E2E 이벤트');
  await page.getByRole('button', { name: /^확인$|^Confirm$/ }).first().click();
  await expect(page.getByTestId('reauth-confirm')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/비밀번호|Password/).fill('password123');
  await page.getByTestId('reauth-confirm').click();
  await expect(page.getByText('+777')).toBeVisible();

  // The member sees the new balance and an automatic event message.
  await member.page.goto('/messages');
  await expect(member.page.getByText('가상 칩 지급 안내')).toBeVisible();
  await expect(member.page.getByTestId('balance')).toContainText('10,777');
});
