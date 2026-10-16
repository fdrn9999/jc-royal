import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { balanceOf, PASSWORD, signUp, test } from './helpers';

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

/** Leaves the member's wallet at `to` chips through a ledger row, so the books stay balanced. */
function dropWallet(id: string, to: number) {
  sql(
    `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, memo, created_at) VALUES ('e2e-rfa-${id}', '${id}', 'admin_adjust', ${to - 10_000}, ${to}, 'e2e-rfa-${id}', 'e2e', ${Date.now()}); UPDATE users SET balance = ${to} WHERE id = '${id}'`,
  );
}

type Claim = { status: number; body: { amount?: number; balance?: number; error?: { code: string; details: { status: { reason: string } } } } };
const claim = (page: Page) =>
  page.evaluate(async (): Promise<Claim> => {
    const r = await fetch('/api/me/refill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: r.status, body: await r.json() };
  });
const idOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

/** The policy form: new values, the server's before → after, a reason, then the password. */
async function changePolicy(page: Page, v: { below: string; amount: string }, reason: string, expectChange: string[]) {
  await page.getByTestId('refill-below').fill(v.below);
  await page.getByTestId('refill-amount').fill(v.amount);
  await page.getByTestId('refill-preview').click();
  const change = page.getByTestId('refill-change');
  for (const s of expectChange) await expect(change).toContainText(s);
  await expect(page.getByTestId('refill-applies')).toContainText('다음 수령 요청부터 적용됩니다.');
  await expect(page.getByTestId('refill-apply')).toBeDisabled();
  await page.getByTestId('refill-reason').fill(reason);
  await page.getByTestId('refill-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('refill-feedback')).toContainText('정책을 저장했습니다.');
}

// The test ends with the seeded policy again; a failure part-way must not leave a changed one to the refill tests after it.
test.afterEach(() => {
  sql(
    `INSERT INTO refill_policies (version, enabled, paused, below, amount, cooldown_ms, change, reason) SELECT version + 1, 1, 0, 1000, 2000, 21600000, 'policy', 'e2e reset' FROM refill_policies WHERE version = (SELECT MAX(version) FROM refill_policies) AND NOT (enabled = 1 AND paused = 0 AND below = 1000 AND amount = 2000 AND cooldown_ms = 21600000)`,
  );
});

test('free refill administration: the policy changed with before → after and a reason, an emergency pause and resume, and a refill taken back from the member page', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const aId = await idOf(a.page);
  const bId = await idOf(b.page);
  dropWallet(aId, 10);
  dropWallet(bId, 10);
  // A takes a refill under the seeded policy (below 1,000 → 2,000 chips, then 6 hours).
  const first = await claim(a.page);
  expect(first.status).toBe(200);
  expect(first.body.amount).toBe(2000);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // The economy page counts refills apart from the other chips issued and links to their page.
  await page.getByRole('link', { name: /^칩 경제$|^Chip economy$/ }).click();
  await expect(page.getByText(/무료 보충 [1-9][\d,]*/)).toBeVisible();
  await page.getByTestId('economy-refill-link').click();
  await expect(page).toHaveURL(/\/economy\/refill$/);

  // The policy in force, the refill just paid, and the day's totals.
  const policy = page.getByTestId('refill-policy');
  await expect(policy).toContainText('켜짐');
  await expect(policy).toContainText('1,000');
  await expect(policy).toContainText('2,000');
  await expect(policy).toContainText('6시간');
  await expect(page.getByTestId('refill-running')).toContainText(/대기 중인 회원 [1-9]\d*명/);
  await expect(page.getByTestId('refill-claims')).toContainText(a.nickname);
  await expect(page.getByTestId('refill-claims').getByRole('row').filter({ hasText: a.nickname })).toContainText('+2,000');
  expect(Number((await page.getByTestId('refill-paid-n').innerText()).replace(/,/g, ''))).toBeGreaterThanOrEqual(1);

  // A new policy: what changes is shown before it is saved, and members already waiting keep their time.
  await changePolicy(page, { below: '1500', amount: '2500' }, 'E2E 정책 변경', ['기준', '1,000 → 1,500', '2,000 → 2,500']);
  await expect(policy).toContainText('1,500');
  await expect(policy).toContainText('2,500');
  await expect(policy).toContainText('E2E 정책 변경');
  await expect(page.getByTestId('refill-versions')).toContainText('E2E 정책 변경');
  const again = await claim(a.page);
  expect(again.status).toBe(409);
  expect(again.body.error?.details.status.reason).toBe('cooldown');

  // Emergency pause: no new refills until a super admin resumes them.
  await page.getByTestId('refill-pause').click();
  await expect(page.getByTestId('refill-switch-confirm')).toBeDisabled();
  await page.getByTestId('refill-switch-reason').fill('E2E 긴급 중지');
  await page.getByTestId('refill-switch-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('refill-feedback')).toContainText('신규 지급을 일시중지했습니다.');
  await expect(policy).toHaveAttribute('data-paused', 'true');
  await expect(policy).toContainText('신규 지급 멈춤');
  const paused = await claim(b.page);
  expect(paused.status).toBe(409);
  expect(paused.body.error?.details.status.reason).toBe('paused');
  expect(await balanceOf(b.page)).toBe(10);
  await page.screenshot({ path: 'test-results/refill-admin-paused.png', fullPage: true });

  await page.getByTestId('refill-resume').click();
  await page.getByTestId('refill-switch-reason').fill('E2E 재개');
  await page.getByTestId('refill-switch-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('refill-feedback')).toContainText('지급을 재개했습니다.');
  await expect(policy).toHaveAttribute('data-paused', 'false');
  await expect(policy).not.toContainText('신규 지급 멈춤');
  // B is paid under the new policy.
  const paid = await claim(b.page);
  expect(paid.status).toBe(200);
  expect(paid.body.amount).toBe(2500);
  expect(await balanceOf(b.page)).toBe(2510);

  // The seeded values again, for the other refill tests in this run.
  await changePolicy(page, { below: '1000', amount: '2000' }, 'E2E 원래 값으로', ['1,500 → 1,000', '2,500 → 2,000']);
  await expect(page.getByTestId('refill-versions').getByRole('row')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/refill-admin.png', fullPage: true });

  // B's page: the refill with its policy version, and taking it back as a chip adjustment linked to it.
  await page.goto(`${ADMIN}/users/${bId}`);
  const panel = page.getByTestId('member-refill');
  await expect(page.getByTestId('member-refill-status')).toContainText('지금 받을 수 없음: 대기 시간 중');
  const row = panel.getByRole('row').filter({ hasText: '#1' });
  await expect(row).toContainText('+2,500');
  await row.getByTestId('refill-correct').click();
  await expect(page.getByTestId('chip-amount')).toHaveValue('-2500');
  await expect(page.getByTestId('chip-memo')).toHaveValue('무료 보충 #1 회수');
  await expect(page.getByTestId('chip-ref')).toContainText('연결한 원거래: 무료 칩 보충 #1 +2,500');
  await page.getByTestId('chip-submit').click();
  await expect(page.getByTestId('confirm-change')).toContainText('2,510 → 10');
  await expect(page.getByTestId('change-preview').getByTestId('chip-ref')).toContainText('무료 칩 보충 #1 +2,500');
  await page.getByTestId('confirm-end').click();
  await reauthIfAsked(page);
  await expect(panel.getByTestId('refill-corrections')).toContainText('-2,500');
  await expect(row.getByTestId('refill-correct')).toHaveCount(0);
  expect(await balanceOf(b.page)).toBe(10);
  await panel.screenshot({ path: 'test-results/refill-admin-member.png' });
});
