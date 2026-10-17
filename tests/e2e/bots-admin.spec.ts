import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { checkOrCall, PASSWORD, signUp, sitWith, test } from './helpers';

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

/** Sensitive changes ask for the password again unless it was confirmed a few minutes ago. */
async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await prompt.click();
  }
}

// The test ends with bots off; the seeded policy (on, 1,000,000 chips, 20 bots) comes back for whatever runs next.
test.afterEach(() => {
  sql(
    `INSERT INTO bot_policies (version, enabled, fund_limit, max_bots, change, reason) SELECT version + 1, 1, 1000000, 20, 'policy', 'e2e reset' FROM bot_policies WHERE version = (SELECT MAX(version) FROM bot_policies) AND NOT (enabled = 1 AND fund_limit = 1000000 AND max_bots = 20)`,
  );
});

test('bot administration: the seated bot and its fund, a policy change with before → after and a reason, an emergency stop the table follows, the event log and the fund check', async ({ browser }) => {
  // E2E Bots Admin: 2 seats, one hard bot keeps a lone member company.
  const m = await signUp(browser);
  await sitWith(m.page, 'e2e-bots-admin', 100);
  await expect(m.page.getByTestId('bot-badge')).toHaveAttribute('data-level', 'hard', { timeout: 30_000 });

  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByRole('link', { name: /^봇 운영$|^Bots$/ }).click();
  await expect(page).toHaveURL(/\/bots$/);

  // The policy in force, the bot at the table, and the chips the fund issued for its buy-in.
  const policy = page.getByTestId('bots-policy');
  await expect(policy).toHaveAttribute('data-enabled', 'true');
  await expect(policy).toContainText('1,000,000');
  const row = page.getByTestId('bots-tables').locator('tr[data-table="e2e-bots-admin"]');
  await expect(row.getByTestId('bots-table-counts')).toHaveText('회원 1 · 봇 1 / 2석');
  await expect(row).toContainText('어려움');
  expect(Number((await page.getByTestId('bots-seated-now').innerText()).replace(/,/g, ''))).toBeGreaterThanOrEqual(1);
  expect(Number((await page.getByTestId('bots-issued').innerText()).replace(/,/g, ''))).toBeGreaterThan(0);

  // The table's own page shows the same settings and whether bots may sit there now.
  await row.getByRole('link', { name: 'E2E Bots Admin' }).click();
  await expect(page.getByTestId('table-bots-live')).toContainText('지금 봇 착석 가능');
  await expect(page.getByTestId('bot-level')).toHaveValue('hard');
  await page.getByTestId('table-bots-link').click();
  await expect(page).toHaveURL(/\/bots\?table=e2e-bots-admin$/);
  await expect(page.getByTestId('bots-events-table')).toHaveValue('e2e-bots-admin');
  await expect(page.getByTestId('bots-events').locator('tr[data-kind="join"]').first()).toBeVisible();

  // A new policy: the change is shown before it is saved, with a reason and the password.
  await page.getByTestId('bots-max').fill('10');
  await page.getByTestId('bots-preview').click();
  const change = page.getByTestId('bots-change');
  await expect(change).toContainText('20 → 10');
  await expect(page.getByTestId('bots-applies')).toContainText('핸드 사이에 적용됩니다');
  await expect(page.getByTestId('bots-apply')).toBeDisabled();
  await page.getByTestId('bots-reason').fill('E2E 봇 정책 변경');
  await page.getByTestId('bots-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('bots-feedback')).toContainText('봇 정책을 저장했습니다.');
  await expect(policy).toContainText('E2E 봇 정책 변경');
  await expect(page.getByTestId('bots-versions')).toContainText('E2E 봇 정책 변경');
  await page.screenshot({ path: 'test-results/bots-admin.png', fullPage: true, animations: 'disabled' });

  // Emergency stop: a reason first; the bot finishes its hand and stands up.
  await page.getByTestId('bots-stop').click();
  await expect(page.getByTestId('bots-stop-confirm')).toBeDisabled();
  await page.getByTestId('bots-stop-reason').fill('E2E 봇 긴급 중지');
  await page.getByTestId('bots-stop-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('bots-feedback')).toContainText('봇을 껐습니다.');
  await expect(policy).toHaveAttribute('data-enabled', 'false');
  await expect(page.getByTestId('bots-off-note')).toContainText('다시 켜려면');
  // The member plays the hand out; when the bot bets more than the member has left there is no call, only fold or all-in.
  await expect(async () => {
    if (!(await checkOrCall(m.page))) {
      const fold = m.page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ });
      if (await fold.isVisible().catch(() => false)) await fold.click();
    }
    await expect(m.page.getByTestId('bot-badge')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await expect(async () => {
    await page.reload();
    await expect(row.getByTestId('bots-table-counts')).toHaveText('회원 1 · 봇 0 / 2석', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('bots-events').locator('tr[data-kind="leave"]').first()).toBeVisible();

  // The fund's books add up.
  await page.getByTestId('bots-integrity-run').click();
  await expect(page.getByTestId('bots-integrity')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('bots-fund-diff')).toHaveText('0');
  await page.screenshot({ path: 'test-results/bots-admin-stopped.png', fullPage: true, animations: 'disabled' });
});
