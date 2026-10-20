import { expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, sql } from './analytics-helpers';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';
import { ALL_GRANTS, promoteSql } from '../support/grants';

/** Opens the console on a phone as `email`; `home` is what the first page shows (the dashboard, or that it is off). */
async function consoleOnPhone(browser: Browser, email: string, home: 'dashboard' | 'home-off') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId(home)).toBeVisible();
  return page;
}

async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await prompt.click();
  }
}

const nav = (page: Page) => page.locator('header nav');

test('on a phone: a super admin turns features on for one administrator, who sees only those in the console from their next request', async ({ browser }) => {
  test.setTimeout(120_000);
  const op = await signUp(browser, { mobile: true });
  const boss = await signUp(browser, { mobile: true });
  // A plain administrator with only the member list on, and a super admin.
  sql(promoteSql(`email = '${op.email}'`, ['members']));
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);

  // The administrator: no dashboard, and the menu holds only what is on (members) and what every administrator has.
  const p = await consoleOnPhone(browser, op.email, 'home-off');
  await expect(nav(p).getByRole('link', { name: '회원' })).toBeVisible();
  await expect(nav(p).getByRole('link', { name: '보안' })).toBeVisible();
  await expect(nav(p).getByRole('link', { name: '칩 원장' })).toHaveCount(0);
  await expect(nav(p).getByRole('link', { name: '대시보드' })).toHaveCount(0);
  expect(await widerThanDevice(p)).toBe(false);
  // Opening a switched-off page by its address: the server refuses it (the menu only leaves it out).
  await p.goto(`${ADMIN}/ledger`);
  await expect(p.getByText(/내 계정에서 꺼져 있습니다/).first()).toBeVisible();
  // Their own permissions: one switch of all on.
  await p.goto(`${ADMIN}/security`);
  await expect(p.getByTestId('my-grants')).toBeVisible();
  await expect(p.locator('[data-testid=my-grant][data-on="1"]')).toHaveCount(1);
  await expect(p.locator('[data-testid=my-grant][data-on="1"]')).toContainText('회원');
  await expect(p.getByTestId('admin-grants')).toHaveCount(0);
  expect(await widerThanDevice(p)).toBe(false);

  // The super admin finds the administrator and edits their switches.
  const b = await consoleOnPhone(browser, boss.email, 'dashboard');
  await b.goto(`${ADMIN}/security`);
  const panel = b.getByTestId('admin-grants');
  await panel.getByTestId('grants-q').fill(op.nickname);
  await panel.getByTestId('grants-q').press('Enter');
  await expect(panel.getByTestId('grants-admin')).toHaveCount(1);
  // Of every switch there is (the list grows with new pages, e.g. VIP), one is on.
  await expect(panel.getByTestId('grants-admin')).toContainText(`1/${ALL_GRANTS.length}`);
  await panel.getByTestId('grants-admin').click();
  await expect(panel.getByTestId('grants-name')).toHaveText(op.nickname);
  await expect(panel.getByTestId('grant-members')).toBeChecked();
  await expect(panel.getByTestId('grant-ledger')).not.toBeChecked();
  expect(await widerThanDevice(b)).toBe(false);
  // Emergency table control without table editing: the editor says it cannot be found in the console.
  await panel.getByTestId('grant-tableControl').check();
  await expect(panel.getByTestId('grant-needs-tableControl')).toBeVisible();
  await panel.getByTestId('grant-tableControl').uncheck();
  await expect(panel.getByTestId('grant-needs-tableControl')).toHaveCount(0);
  // Without a reason nothing can be reviewed.
  await panel.getByTestId('grant-ledger').check();
  await panel.getByTestId('grant-dashboard').check();
  await expect(panel.getByTestId('grants-review')).toBeDisabled();
  await panel.getByTestId('grants-reason').fill('E2E 원장 업무 배정');
  await panel.getByTestId('grants-review').click();
  // The preview fits the phone and lists what turns on; nothing is stored until it is saved.
  const dialog = b.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(b.getByTestId('grants-preview')).toContainText('원장');
  await expect(b.getByTestId('grants-preview')).toContainText('대시보드');
  expect(await widerThanDevice(b)).toBe(false);
  await b.getByTestId('grants-save').click();
  await reauthIfAsked(b);
  await expect(panel.getByTestId('grants-msg')).toContainText('저장했습니다');
  await expect(panel.getByTestId('grants-admin')).toContainText(`3/${ALL_GRANTS.length}`);
  await expect(panel.getByTestId('grants-history-item')).toHaveCount(1);
  await expect(panel.getByTestId('grants-history-item')).toContainText('E2E 원장 업무 배정');
  await expect(panel.getByTestId('grants-history-item')).toContainText('+');

  // The administrator's next request already has them: the dashboard and the ledger, without signing in again.
  await p.goto(ADMIN);
  await expect(p.getByTestId('dashboard')).toBeVisible();
  await expect(nav(p).getByRole('link', { name: '칩 원장' })).toBeVisible();
  await expect(nav(p).getByRole('link', { name: '대시보드' })).toBeVisible();
  expect(await widerThanDevice(p)).toBe(false);

  // A super admin has no switches, their own entry included.
  await panel.getByTestId('grants-q').fill(boss.nickname);
  await panel.getByTestId('grants-q').press('Enter');
  await expect(panel.getByTestId('grants-admin')).toHaveCount(1);
  await panel.getByTestId('grants-admin').click();
  await expect(panel.getByTestId('grants-super')).toBeVisible();
  await expect(panel.getByTestId('grant-members')).toHaveCount(0);
});
