import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { PASSWORD, signUp, test } from './helpers';

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
    await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await prompt.click();
  }
}

test('chip economy: the page shows where chips are, and a wallet mismatch is reverted only after its evidence and a confirmed before → after', async ({ browser }) => {
  const a = await signUp(browser);
  const op = await signUp(browser);
  // A second super admin (the bootstrap is one-time and belongs to the admin console test); corrections need one.
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  // A wallet changed outside the ledger.
  sql(`UPDATE users SET balance = balance + 250 WHERE email = '${a.email}'`);
  const aId = await a.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // The economy page: totals, the gap the corrupted wallet left, and a period switch.
  await page.getByRole('link', { name: /^칩 경제$|^Chip economy$/ }).click();
  await expect(page.getByTestId('economy-totals')).toContainText('회원 지갑 합계');
  await expect(page.getByTestId('economy-gap')).not.toHaveText('0');
  await expect(page.getByTestId('economy-flows')).toContainText('가입 지급');
  await expect(page.getByTestId('economy-meta')).toContainText('읽은 행');
  await page.getByTestId('economy-30').click();
  await expect(page.getByTestId('economy-30')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('economy-chart').locator('span')).toHaveCount(30);

  // Reconciliation finds the wallet; nothing changes until an administrator decides.
  await page.goto(`${ADMIN}/reconcile`);
  await page.getByTestId('run-reconcile').click();
  await expect(page.getByTestId('rec-run-result')).toContainText('불일치');
  const row = page.getByTestId('rec-row').filter({ hasText: aId });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('지갑 잔액이 원장 합계와 다릅니다.');
  await expect(row).toContainText('+250');
  await row.getByTestId('rec-evidence-toggle').click();
  const evidence = page.getByTestId('rec-evidence');
  await expect(evidence).toContainText('마지막 원장 기록');
  await expect(page.getByTestId('rec-diff-now')).toHaveText('+250');

  // Revert: the confirmation shows the balance before → after and the reason before anything is sent.
  await page.getByTestId('rec-action-revert').check();
  await page.getByTestId('rec-note').fill('E2E 원장에 없는 증가');
  await page.getByTestId('rec-submit').click();
  await expect(page.getByTestId('rec-change')).toContainText('지갑 잔액 10,250 → 10,000');
  await expect(page.getByRole('dialog')).toContainText('E2E 원장에 없는 증가');
  await page.getByTestId('rec-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('rec-result')).toContainText('현재 잔액 10,000');
  // Resolved: it leaves the open list and shows with its resolution in the full list.
  await expect(row).toHaveCount(0);
  await page.getByTestId('rec-all').click();
  await expect(row).toContainText('잔액 되돌림');
  await expect(row).toContainText('E2E 원장에 없는 증가');

  // The member sees the corrected balance and a message, without the internal note.
  await a.page.goto('/messages');
  await expect(a.page.getByText('가상 칩 잔액 정정 안내')).toBeVisible();
  await expect(a.page.getByTestId('balance')).toContainText('10,000');
  await expect(a.page.getByText('E2E 원장에 없는 증가')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/admin-reconcile.png', fullPage: true });
});
