import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page, type Route } from '@playwright/test';
import { checkOrCall, PASSWORD, signUp, test, widerThanDevice } from './helpers';

const ADMIN = 'http://localhost:5174';

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await prompt.click();
  }
}

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: test.info().outputPath(name), fullPage, animations: 'disabled' });

test('mobile: a heads-up Sit & Go from the template to the stop, for the operator and both players at phone width', async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = Math.random().toString(36).slice(2, 7);
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const page = op.page;
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // A super admin's template: two seats, 200 chips, the summary before it is saved.
  await page.goto(`${ADMIN}/tournaments/templates`);
  await expect(page.getByTestId('tpl-super-only')).toHaveCount(0);
  await page.getByTestId('tpl-new').click();
  await page.getByTestId('tpl-name').fill(`E2E 헤즈업 ${tag}`);
  await page.getByTestId('tpl-capacity').fill('2');
  await page.getByTestId('tpl-start-stack').fill('200');
  // Too small a stack for the first big blind is caught before anything is sent.
  await page.getByTestId('tpl-start-stack').fill('150');
  await expect(page.getByTestId('tpl-problem')).toContainText('10배');
  await expect(page.getByTestId('tpl-preview')).toBeDisabled();
  await page.getByTestId('tpl-start-stack').fill('200');
  await expect(page.getByTestId('tpl-problem')).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-template-form.png');
  await page.getByTestId('tpl-preview').click();
  const change = page.getByTestId('tpl-change');
  await expect(change).toContainText('정원');
  await expect(change).toContainText('10/20');
  await page.getByTestId('tpl-reason').fill('E2E 헤즈업 템플릿');
  await shot(page, 'tn-template-summary.png');
  await page.getByTestId('tpl-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('tpl-feedback')).toContainText('템플릿을 만들었습니다');
  await expect(page.getByTestId('tpl-card').filter({ hasText: `E2E 헤즈업 ${tag}` })).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-templates.png', true);

  // An operator opens a tournament from it, after the summary.
  await page.goto(`${ADMIN}/tournaments`);
  const pick = page.getByTestId('tn-create-template');
  await pick.selectOption({ label: (await pick.locator('option', { hasText: `E2E 헤즈업 ${tag}` }).textContent())! });
  const name = `E2E 대회 ${tag}`;
  await page.getByTestId('tn-create-name').fill(name);
  await page.getByTestId('tn-create-preview').click();
  const summary = page.getByTestId('tn-create-summary');
  await expect(summary).toContainText('2명');
  await expect(summary).toContainText('정원이 차면 자동 시작');
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-create-summary.png');
  await page.getByTestId('tn-create-apply').click();
  await expect(page.getByTestId('tn-name')).toHaveText(name);
  const id = page.url().split('/tournaments/')[1]!;
  await expect(page.getByTestId('tn-stats')).toContainText('0/2명 등록');
  await expect(page.getByTestId('tn-controls')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-admin-registering.png', true);

  // Two members register; the second fills it and it starts by itself.
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  await a.page.goto(`/tournaments/${id}`);
  await expect(a.page.getByTestId('tn-detail')).toBeVisible();
  await a.page.getByTestId('tn-register').tap();
  await expect(a.page.getByTestId('tn-registered')).toBeVisible();
  expect(await widerThanDevice(a.page)).toBe(false);
  await shot(a.page, 'tn-member-registered.png', true);
  await b.page.goto(`/tournaments/${id}`);
  await b.page.getByTestId('tn-register').click();
  // The registration that fills it starts it, and takes that player straight to the table.
  await expect(b.page).toHaveURL(new RegExp(`/table/sng-${id}$`), { timeout: 15_000 });
  await expect(async () => {
    await a.page.reload();
    await expect(a.page.getByTestId('tn-table')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await shot(a.page, 'tn-member-running.png', true);

  // The table: the level bar, tournament chips, and no buy-in, top-up or stand-up.
  await a.page.getByTestId('tn-table').tap();
  const bar = a.page.getByTestId('tn-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('레벨 1/6');
  await expect(bar).toContainText('10/20');
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await expect(a.page.getByTestId('topup-open')).toHaveCount(0);
  await expect(a.page.getByTestId('leave')).toHaveAttribute('aria-label', /대회/);
  expect(await widerThanDevice(a.page)).toBe(false);
  await shot(a.page, 'tn-table.png');

  // The operator's view of it running, and its table, which the cash-table controls leave alone.
  await page.goto(`${ADMIN}/tournaments/${id}`);
  await expect(page.getByTestId('tn-stats')).toContainText('2명 중 2명 생존');
  await expect(page.getByTestId('tn-entries').getByTestId('tn-entry')).toHaveCount(2);
  await expect(page.getByTestId('tn-act-start')).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-admin-running.png', true);
  await page.goto(`${ADMIN}/tables/sng-${id}`);
  await expect(page.getByTestId('tn-table-panel')).toContainText(name);
  await expect(page.getByTestId('emergency')).toHaveCount(0);
  await expect(page.getByTestId('close-table')).toHaveCount(0);
  await expect(page.getByTestId('table-timer')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-admin-table.png', true);

  // Pause from the next hand, then the stop: the reason, the name typed again, the password.
  await page.goto(`${ADMIN}/tournaments/${id}`);
  // The page is slow to look again after each change: the stop is opened as soon as the pause says it is done, and it
  // must name the version the pause made (the page said done only once it had it), not the one before.
  const slowLook = async (route: Route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  };
  await page.route(`**/api/admin/tournaments/${id}`, slowLook);
  await page.getByTestId('tn-act-pause').click();
  await expect(page.getByTestId('tn-act-dialog')).toContainText('진행 중인 핸드는 그대로 끝나고');
  await page.getByTestId('tn-act-confirm').click();
  await expect(page.getByTestId('tn-detail-feedback')).toContainText(/일시정지/);
  await page.getByTestId('tn-act-abort').click();
  const dialog = page.getByTestId('tn-act-dialog');
  await expect(dialog).toContainText('시작 전 취소와 다름');
  // The name to type is shown as it is spelled (innerText is what the eye sees, after any capitalising style).
  expect(await page.locator('label[for="tn-act-name"]').innerText()).toContain(name);
  await page.getByTestId('tn-act-reason').fill('E2E 진행 중 중단');
  await page.getByTestId('tn-act-name').fill('다른 이름');
  await expect(dialog).toContainText('대회 이름과 다릅니다.');
  await expect(page.getByTestId('tn-act-confirm')).toBeDisabled();
  await page.getByTestId('tn-act-name').fill(name);
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'tn-admin-abort.png');
  await page.getByTestId('tn-act-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('tn-detail-feedback')).toContainText('중단했습니다');
  await expect(page.getByTestId('tn-result')).toContainText('정상 종료가 아니며');
  await page.unroute(`**/api/admin/tournaments/${id}`, slowLook);

  // The hand in play finishes; then each player's card says the tournament was stopped.
  await expect(async () => {
    await checkOrCall(a.page);
    await checkOrCall(b.page);
    await expect(a.page.getByTestId('tn-result')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 90_000 });
  await expect(a.page.getByTestId('tn-result')).toHaveAttribute('data-status', 'stopped');
  expect(await widerThanDevice(a.page)).toBe(false);
  await shot(a.page, 'tn-table-stopped.png');
  await page.reload();
  await expect(page.getByTestId('tn-history')).toContainText('대회 진행 중 중단');
  await shot(page, 'tn-admin-aborted.png', true);
});
