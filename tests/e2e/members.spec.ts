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
    await page.getByRole('dialog').getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await prompt.click();
  }
}

test('member management: list filters, sign-in time, activity, notes without personal data, and sanctions with before → after and a reason', async ({ browser }) => {
  const a = await signUp(browser);
  const op = await signUp(browser);
  // A second super admin (the bootstrap is one-time and belongs to the admin console test); role changes need one.
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // List: search, then a status filter that leaves nobody; the row shows when the member last signed in.
  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await page.getByPlaceholder(/검색|Search/).fill(a.nickname);
  await page.getByPlaceholder(/검색|Search/).press('Enter');
  const row = page.locator('tbody tr').filter({ hasText: a.nickname });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(/기록 없음|Not recorded/);
  await page.getByTestId('status-filter').selectOption('suspended');
  await expect(page.getByTestId('no-members')).toBeVisible();
  await page.getByTestId('status-filter').selectOption('');
  await page.getByTestId('sort-select').selectOption({ index: 2 });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: /상세|Details/ }).click();

  // Detail: last sign-in, and play by period (none yet).
  await expect(page.getByTestId('last-login')).not.toHaveText(/기록 없음|Not recorded/);
  await expect(page.getByTestId('activity')).toContainText('0/7');
  await page.getByTestId('activity-30').click();
  await expect(page.getByTestId('activity-30')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('activity')).toContainText('0/30');

  // Notes: a phone number is refused with a reason; a handover note is kept in the history.
  const note = page.getByTestId('note-input');
  await note.fill('연락처 010-1234-5678');
  await page.getByTestId('note-add').click();
  await expect(page.getByRole('alert')).toContainText(/개인정보|personal data/);
  await note.fill('E2E 인수인계: 다음 주에 다시 확인');
  await page.getByTestId('note-add').click();
  await expect(note).toHaveValue('');
  await expect(page.getByTestId('history-item').first()).toContainText('E2E 인수인계: 다음 주에 다시 확인');

  // Suspend: the confirmation shows the change before it is made.
  await page.locator('form').filter({ has: page.getByTestId('suspend') }).getByRole('textbox').fill('E2E 욕설');
  await page.getByTestId('suspend').click();
  await expect(page.getByTestId('confirm-change')).toContainText(/정상 → 정지됨|Active → Suspended/);
  await page.getByTestId('confirm-end').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('unsuspend')).toBeVisible();

  // Lifting it needs a reason, and shows the reason it was suspended for.
  await page.getByTestId('unsuspend').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('confirm-change')).toContainText(/정지됨 → 정상|Suspended → Active/);
  await expect(dialog).toContainText(/현재 정지 사유: E2E 욕설|Current suspension reason: E2E 욕설/);
  await expect(dialog.getByTestId('confirm-end')).toBeDisabled();
  await dialog.getByTestId('confirm-reason').fill('E2E 이의 인정');
  await dialog.getByTestId('confirm-end').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('suspend')).toBeVisible();
  const history = page.getByTestId('history');
  await expect(history.getByTestId('history-item').first()).toContainText('E2E 이의 인정');
  await expect(history.getByTestId('history-item').first()).toContainText(/정지됨 → 정상|Suspended → Active/);
  await expect(history.getByTestId('history-item').first()).toContainText(/정지 사유: E2E 욕설|Suspension reason: E2E 욕설/);

  // Role change: before → after and a reason, then in the history.
  await page.getByTestId('role-admin').click();
  await expect(dialog.getByTestId('confirm-change')).toContainText(/일반 회원 → 관리자|Member → Admin/);
  await expect(dialog.getByTestId('confirm-end')).toBeDisabled();
  await dialog.getByTestId('confirm-reason').fill('E2E 운영진 합류');
  await dialog.getByTestId('confirm-end').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('role-admin')).toBeDisabled();
  await expect(history.getByTestId('history-item').first()).toContainText('E2E 운영진 합류');

  // Filters: sanctions only, then notes only; the note can be deleted after a confirmation.
  await page.getByTestId('history-sanction').click();
  await expect(history.getByTestId('history-item')).toHaveCount(2);
  await page.getByTestId('history-note').click();
  await expect(history.getByTestId('history-item')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/admin-member-history.png', fullPage: true });
  await page.getByTestId('note-delete').click();
  await page.getByTestId('note-delete-confirm').click();
  // What stays is who removed a note and when, not its text.
  await expect(history.getByTestId('history-item')).toHaveCount(1);
  await expect(history.getByTestId('history-item')).toContainText(/메모 삭제|Note deleted/);
  await expect(history).not.toContainText('E2E 인수인계');
});
