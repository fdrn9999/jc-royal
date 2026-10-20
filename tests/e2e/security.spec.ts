import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { balanceOf, PASSWORD, signUp, test } from './helpers';
import { promoteSql } from '../support/grants';

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

async function signIn(page: Page, email: string) {
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

async function openConsole(browser: Browser, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, email);
  return page;
}

/** The console's next request finds its session gone and shows the sign-in page. */
async function signedOut(page: Page) {
  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await expect(page.getByRole('button', { name: /^로그인$|^Log in$/ })).toBeVisible();
}

/** Sensitive changes ask for the password again unless it was confirmed a few minutes ago. */
async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await prompt.click();
  }
}

const idOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

test('permissions and audit: a plain admin is refused super-admin work and sees only their own log; a super admin searches, filters and pages every entry, refusals included', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await signUp(browser);
  const plain = await signUp(browser);
  const boss = await signUp(browser);
  sql(promoteSql(`email = '${plain.email}'`));
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);
  // Sixty earlier notes by the super admin about the member: more than one page of the log.
  sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) ` +
      `INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, ip, created_at, outcome) ` +
      `SELECT '${a.nickname}-' || i, (SELECT id FROM users WHERE email = '${boss.email}'), 'note.create', 'user', (SELECT id FROM users WHERE email = '${a.email}'), ` +
      `'{"memo":"E2E 페이지 ' || i || '"}', NULL, ${Date.now() - 3_600_000} + i * 1000, 'ok' FROM n`,
  );
  const aId = await idOf(a.page);
  const plainId = await idOf(plain.page);

  // A plain administrator: member export is for super admins, and suspending an administrator is refused in the preview,
  // before anything changes.
  const p = await openConsole(browser, plain.email);
  await p.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await p.getByTestId('select-all').check();
  await expect(p.getByTestId('export-csv')).toBeDisabled();
  await expect(p.getByTestId('export-bar')).toContainText(/최고관리자만|Only a super admin/);
  await p.getByPlaceholder(/검색|Search/).fill(boss.nickname);
  await p.getByPlaceholder(/검색|Search/).press('Enter');
  await p.locator('tbody tr').filter({ hasText: boss.nickname }).getByRole('link', { name: /상세|Details/ }).click();
  await expect(p.getByTestId('suspend')).toBeVisible();
  await expect(p.getByTestId('role-admin')).toHaveCount(0);
  await p.locator('form').filter({ has: p.getByTestId('suspend') }).getByRole('textbox').fill('E2E 권한 확인');
  await p.getByTestId('suspend').click();
  await expect(p.getByTestId('preview-error')).toContainText(/최고관리자만|Only a super admin/);
  await expect(p.getByTestId('confirm-end')).toBeDisabled();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);

  // Their security page: every super-admin ability marked as such, export not allowed, and only their own sessions.
  await p.getByRole('link', { name: /^보안$|^Security$/ }).click();
  const mine = p.getByTestId('my-permissions');
  // One per capability in CAPABILITIES (apps/api/src/lib/permissions.ts); a plain administrator holds none of them.
  await expect(mine.getByText(/^최고관리자 전용$|^Super admin only$/)).toHaveCount(15);
  await expect(mine.getByText(/^가능$|^Allowed$/)).toHaveCount(0);
  await expect(p.getByTestId('permission-matrix').locator('tr').filter({ hasText: /회원 정보 내보내기|Member data export/ })).toContainText(/불가|None/);
  await expect(p.getByTestId('admin-session').first()).toBeVisible();
  await expect(p.getByTestId('admin-session').filter({ hasNotText: plain.nickname })).toHaveCount(0);

  // Their log: own entries only (none of the super admin's), the refusal among them with its status, marked failed.
  await p.getByRole('link', { name: /^관리 이력$|^Admin log$/ }).click();
  await expect(p.getByTestId('audit-scope')).toContainText(/내 기록만|My entries only/);
  await expect(p.getByTestId('audit-actor')).toHaveCount(0);
  await expect(p.getByTestId('audit-row').first()).toBeVisible();
  await expect(p.getByTestId('audit-row').filter({ hasNotText: plain.nickname })).toHaveCount(0);
  await p.getByTestId('audit-outcome').selectOption('failed');
  await expect(p).toHaveURL(/outcome=failed/);
  const refused = p.getByTestId('audit-row').filter({ hasText: 'user.suspend.failed' });
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText(/실패|Failed/);
  await refused.getByTestId('audit-detail-toggle').click();
  await expect(p.getByTestId('audit-detail')).toContainText('"status": 403');
  await expect(p.getByTestId('audit-detail')).toContainText('"preview": true');

  // The super admin opens the member's log from the member page: every administrator, narrowed to the member.
  const b = await openConsole(browser, boss.email);
  await b.goto(`${ADMIN}/users/${aId}`);
  await b.getByTestId('user-audit').click();
  await expect(b.getByTestId('audit-scope')).toContainText(/모든 관리자|All administrators/);
  await expect(b.getByTestId('audit-target-chip')).toContainText(a.nickname);
  await b.getByTestId('audit-family').selectOption('note.*');
  const pager = b.getByTestId('audit-pager');
  const rows = b.getByTestId('audit-row');
  await expect(pager).toContainText(/60건 중 1–50|1–50 of 60/);
  await expect(rows).toHaveCount(50);
  await b.getByTestId('audit-next').click();
  await expect(pager).toContainText(/60건 중 51–60|51–60 of 60/);
  await expect(rows).toHaveCount(10);
  await expect(rows.last()).toContainText('"E2E 페이지 1"');
  await b.getByTestId('audit-prev').click();
  await expect(pager).toContainText(/60건 중 1–50|1–50 of 60/);
  await expect(rows.first()).toContainText('"E2E 페이지 60"');

  // Text search within the filters; a single character is not searched.
  const q = b.getByTestId('audit-q');
  await q.fill('7');
  await expect(b.getByText(/두 글자 이상 입력하세요|Type at least two characters/)).toBeVisible();
  await q.fill('페이지 7');
  await q.press('Enter');
  await expect(pager).toContainText(/1건 중 1–1|1–1 of 1/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('"E2E 페이지 7"');

  // All entries again, then only failures: the plain admin's refusal is there; its actor narrows the log to them.
  await b.getByTestId('audit-reset').click();
  await expect(b.getByTestId('audit-target-chip')).toHaveCount(0);
  await b.getByTestId('audit-outcome').selectOption('failed');
  const refusal = rows.filter({ hasText: 'user.suspend.failed' }).filter({ hasText: plain.nickname });
  await expect(refusal).toHaveCount(1);
  await refusal.getByRole('button', { name: plain.nickname }).click();
  await expect(b.getByTestId('audit-actor')).toHaveValue(plainId);
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasNotText: plain.nickname })).toHaveCount(0);
  await b.screenshot({ path: 'test-results/admin-audit-failed.png', fullPage: true });
});

test('previews and sessions: suspending and closing a table show what will happen first; ending a session or changing a role signs that console out on its next request', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await signUp(browser);
  const plain = await signUp(browser);
  const boss = await signUp(browser);
  sql(promoteSql(`email = '${plain.email}'`));
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);
  const aId = await idOf(a.page);
  const plainId = await idOf(plain.page);
  await a.page.goto('/table/e2e-close?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await expect(a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname })).toBeVisible();
  const buyIn = 10_000 - (await balanceOf(a.page));
  expect(buyIn).toBeGreaterThan(0);

  // Suspend preview: the seat it would end and the sign-ins it would close. Cancelled, nothing changes.
  const b = await openConsole(browser, boss.email);
  await b.goto(`${ADMIN}/users/${aId}`);
  await b.locator('form').filter({ has: b.getByTestId('suspend') }).getByRole('textbox').fill('E2E 미리보기');
  await b.getByTestId('suspend').click();
  const preview = b.getByTestId('change-preview');
  await expect(preview).toContainText(/테이블 1곳에서 일어나고|Leaves 1 table/);
  await expect(preview).toContainText('E2E Close');
  await expect(preview).toContainText(/게임 1개|1 game/);
  await b.keyboard.press('Escape');
  await expect(b.getByRole('dialog')).toHaveCount(0);
  await expect(b.getByTestId('suspend')).toBeVisible();

  // Closing the table: the seated player with the stack the room holds, then the password, then the chips go home.
  await b.goto(`${ADMIN}/tables/e2e-close`);
  await b.getByTestId('close-table').click();
  const closing = b.getByTestId('close-preview');
  await expect(closing).toContainText(/앉아 있는 플레이어 1명|Cashes out 1 seated/);
  await expect(closing).toContainText(a.nickname);
  await expect(closing).toContainText(new RegExp(`(스택|stack) ${buyIn.toLocaleString('en-US')}`));
  await b.screenshot({ path: 'test-results/admin-close-preview.png', fullPage: true });
  await b.getByTestId('confirm-close').click();
  await reauthIfAsked(b);
  await expect(b.getByTestId('close-table')).toBeDisabled();
  await expect.poll(() => balanceOf(a.page), { timeout: 45_000 }).toBe(10_000);

  // Sessions: the super admin sees everyone's, ends their own other session, then the plain admin's.
  const b2 = await openConsole(browser, boss.email);
  const p = await openConsole(browser, plain.email);
  await b.getByRole('link', { name: /^보안$|^Security$/ }).click();
  const sessions = b.getByTestId('admin-session');
  await expect(sessions.filter({ hasText: plain.nickname })).toHaveCount(1);
  await expect(sessions.filter({ hasText: boss.nickname })).toHaveCount(2);
  await b.getByTestId('end-others').click();
  await expect(b.getByRole('dialog')).toContainText(/세션 1개|1 of your console session/);
  await b.getByTestId('confirm-end-session').click();
  await expect(b.getByTestId('security-msg')).toContainText(/세션 1개를 종료했습니다|Ended 1 session/);
  await expect(sessions.filter({ hasText: boss.nickname })).toHaveCount(1);
  await signedOut(b2);

  await sessions.filter({ hasText: plain.nickname }).getByTestId('end-session').click();
  await expect(b.getByRole('dialog')).toContainText(plain.nickname);
  await b.getByTestId('confirm-end-session').click();
  await expect(b.getByTestId('security-msg')).toContainText(/세션을 종료했습니다|Session ended/);
  await expect(sessions.filter({ hasText: plain.nickname })).toHaveCount(0);
  await signedOut(p);

  // Role change: the preview names the console access and sessions it ends; applied, their console is out at once.
  await signIn(p, plain.email);
  await b.goto(`${ADMIN}/users/${plainId}`);
  await b.getByTestId('role-user').click();
  await expect(b.getByTestId('confirm-change')).toContainText(/관리자 → 일반 회원|Admin → Member/);
  await expect(preview).toContainText(/접속 가능 → 접속 불가|allowed → not allowed/);
  await expect(preview).toContainText(/관리자 콘솔 세션 1개|1 admin console session/);
  await b.getByTestId('confirm-reason').fill('E2E 권한 회수');
  await b.getByTestId('confirm-end').click();
  await reauthIfAsked(b);
  await expect(b.getByTestId('role-user')).toBeDisabled();
  await signedOut(p);

  // Both kinds of change are in the log.
  await b.getByRole('link', { name: /^관리 이력$|^Admin log$/ }).click();
  await b.getByTestId('audit-family').selectOption('admin.*');
  await expect(b.getByTestId('audit-row').filter({ hasText: 'admin.session.end_others' }).filter({ hasText: boss.nickname }).first()).toBeVisible();
  await b.getByTestId('audit-family').selectOption('user.*');
  await expect(b.getByTestId('audit-row').filter({ hasText: 'user.role' }).filter({ hasText: plain.nickname }).first()).toBeVisible();
});
