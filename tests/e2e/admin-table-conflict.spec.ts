import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Browser } from '@playwright/test';
import { PASSWORD, signUp, test } from './helpers';
import { promoteSql } from '../support/grants';

const ADMIN = 'http://localhost:5174';
const TABLE = 'e2e-conflict';

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

/** Signs an administrator in to the console and opens the table's page. */
async function tablePage(browser: Browser, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.goto(`${ADMIN}/tables/${TABLE}`);
  const form = page.getByTestId('table-blinds');
  await expect(form).toBeVisible();
  const field = (label: RegExp) => form.getByLabel(label);
  return {
    page,
    sb: field(/스몰 블라인드|Small blind/),
    bb: field(/빅 블라인드|Big blind/),
    max: field(/최대 바이인|Max buy-in|Maximum buy-in/),
    save: () => form.getByRole('button', { name: /^(저장|Save)$/ }).click(),
  };
}

test('two administrators on one table: a save from the page opened before the other’s change is refused, the page shows the table as it is now, and saving again from there keeps both changes', async ({ browser }) => {
  sql(`INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${TABLE}', 'E2E Conflict', 6, 5, 10, 200, 2000, 30)`);
  const a = await signUp(browser);
  const b = await signUp(browser);
  sql(promoteSql(`email IN ('${a.email}', '${b.email}')`));
  const one = await tablePage(browser, a.email);
  const two = await tablePage(browser, b.email);
  await expect(one.sb).toHaveValue('5');

  // The second administrator raises the blinds.
  await two.sb.fill('10');
  await two.bb.fill('20');
  await two.save();
  await expect(two.page.getByText(/^(저장되었습니다\.|Saved\.)$/)).toBeVisible();

  // The first, still on the page from before, raises the maximum buy-in: refused, and the form starts again from the
  // blinds the other saved, without the maximum just typed.
  await one.max.fill('3000');
  await one.save();
  await expect(one.page.getByText(/다른 관리자가 먼저 이 테이블 설정을 바꿨습니다|Another administrator changed this table first/)).toBeVisible();
  await expect(one.sb).toHaveValue('10');
  await expect(one.bb).toHaveValue('20');
  await expect(one.max).toHaveValue('2000');
  await one.page.screenshot({ path: 'test-results/admin-table-conflict.png', fullPage: true });

  // Saving again from the page as it is now goes through, and the other's blinds stay.
  await one.max.fill('3000');
  await one.save();
  await expect(one.page.getByText(/^(저장되었습니다\.|Saved\.)$/)).toBeVisible();
  await two.page.reload();
  await expect(two.sb).toHaveValue('10');
  await expect(two.bb).toHaveValue('20');
  await expect(two.max).toHaveValue('3000');
});
