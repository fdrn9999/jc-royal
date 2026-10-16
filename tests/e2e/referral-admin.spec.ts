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

const idOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
/** The member's referral code (made when their card is first opened). */
const codeOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/me/referral')).json()) as { code: string }).code);

// The test ends with the seeded policy again; a failure part-way must not leave a changed or paused one to the referral tests after it.
test.afterEach(() => {
  sql(
    `INSERT INTO referral_policies (version, enabled, paused, referrer_amount, invitee_amount, daily_cap, total_cap, min_hands, burst_limit, change, reason) SELECT version + 1, 1, 0, 1000, 1000, 5, 50, 0, 20, 'policy', 'e2e reset' FROM referral_policies WHERE version = (SELECT MAX(version) FROM referral_policies) AND NOT (enabled = 1 AND paused = 0 AND referrer_amount = 1000 AND invitee_amount = 1000 AND daily_cap = 5 AND total_cap = 50 AND min_hands = 0 AND burst_limit = 20)`,
  );
});

test('referral administration: the overview against the ledger, a pause that holds payouts, a policy change with before → after, a burst approved, and the member page', async ({ browser }) => {
  const a = await signUp(browser);
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const code = await codeOf(a.page);
  const aId = await idOf(a.page);
  // B signs up with A's code under the seeded policy: both are paid at once.
  const b = await signUp(browser, { ref: code });
  expect(await balanceOf(b.page)).toBe(11_000);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // The economy page counts referral rewards apart from the other chips issued and links to their page.
  await page.getByRole('link', { name: /^칩 경제$|^Chip economy$/ }).click();
  await expect(page.getByText(/추천 보상 [1-9][\d,]*/).first()).toBeVisible();
  await page.getByTestId('economy-referral-link').click();
  await expect(page).toHaveURL(/\/referrals$/);

  const policy = page.getByTestId('referral-policy');
  await expect(policy).toHaveAttribute('data-enabled', 'true');
  await expect(policy).toHaveAttribute('data-paused', 'false');
  await expect(policy).toContainText('켜짐');
  await expect(policy).toContainText('1,000');
  await expect(page.getByTestId('referral-integrity')).toHaveAttribute('data-ok', 'true');
  expect(Number((await page.getByTestId('referral-paid-chips').innerText()).replace(/,/g, ''))).toBeGreaterThanOrEqual(2000);

  // The list, narrowed to A: B's signup settled, with the shared-network signal only as a signal and no e-mail shown.
  await page.getByTestId('referral-filter-user').fill(aId);
  await page.getByTestId('referral-filter-user').press('Enter');
  const list = page.getByTestId('referral-list');
  const bRow = list.getByRole('row').filter({ hasText: b.nickname });
  await expect(bRow).toHaveAttribute('data-status', 'settled');
  await expect(bRow).toContainText('정산 완료');
  await expect(list).not.toContainText('@e2e.dev');

  // Emergency pause: a signup meanwhile is recorded and waits; settling it now pays nothing.
  await page.getByTestId('referral-pause').click();
  await expect(page.getByTestId('referral-switch-confirm')).toBeDisabled();
  await page.getByTestId('referral-switch-reason').fill('E2E 지급 일시중지');
  await page.getByTestId('referral-switch-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('referral-feedback')).toContainText('추천 보상 지급을 일시중지했습니다.');
  await expect(policy).toHaveAttribute('data-paused', 'true');
  await expect(page.getByTestId('referral-pause')).toHaveCount(0);
  await expect(page.getByTestId('referral-resume')).toBeVisible();

  const d = await signUp(browser, { ref: code });
  expect(await balanceOf(d.page)).toBe(10_000);
  await page.goto(`${ADMIN}/referrals?user=${aId}`);
  const dRow = list.getByRole('row').filter({ hasText: d.nickname });
  await expect(dRow).toHaveAttribute('data-status', 'pending');
  await expect(dRow.getByTestId('referral-why')).toContainText('지급 일시중지');
  await dRow.getByTestId('referral-settle').click();
  await expect(page.getByTestId('referral-feedback')).toContainText('지금 지급할 보상이 없습니다');
  expect(await balanceOf(d.page)).toBe(10_000);
  await page.screenshot({ path: 'test-results/referral-admin-paused.png', fullPage: true });

  // Resumed: the waiting signup is paid once, from this page.
  await page.getByTestId('referral-resume').click();
  await page.getByTestId('referral-switch-reason').fill('E2E 지급 재개');
  await page.getByTestId('referral-switch-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('referral-feedback')).toContainText('추천 보상 지급을 재개했습니다.');
  await expect(policy).toHaveAttribute('data-paused', 'false');
  await dRow.getByTestId('referral-settle').click();
  await expect(page.getByTestId('referral-feedback')).toContainText('이번에 지급: 추천인 1,000칩 · 가입자 1,000칩');
  await expect(dRow).toHaveAttribute('data-status', 'settled');
  expect(await balanceOf(d.page)).toBe(11_000);

  // A new policy: what changes is shown before it is saved, and from when it applies.
  await page.getByTestId('referral-referrer-amount').fill('1500');
  await page.getByTestId('referral-burst').fill('2');
  await page.getByTestId('referral-preview').click();
  const change = page.getByTestId('referral-change');
  await expect(change).toContainText('1,000 → 1,500');
  await expect(change).toContainText('20 → 2');
  await expect(page.getByTestId('referral-applies')).toContainText('다음 가입부터');
  await expect(page.getByTestId('referral-apply')).toBeDisabled();
  await page.getByTestId('referral-reason').fill('E2E 정책 변경');
  await page.getByTestId('referral-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('referral-feedback')).toContainText('추천 보상 정책을 저장했습니다.');
  await expect(policy).toContainText('1,500');
  await expect(policy).toContainText('E2E 정책 변경');
  await expect(page.getByTestId('referral-versions')).toContainText('E2E 정책 변경');

  // A third signup on A's code from the same network within a day now waits for review; approving pays it, once.
  const c = await signUp(browser, { ref: code });
  expect(await balanceOf(c.page)).toBe(10_000);
  await page.goto(`${ADMIN}/referrals?user=${aId}`);
  const cRow = list.getByRole('row').filter({ hasText: c.nickname });
  await expect(cRow).toHaveAttribute('data-status', 'review');
  await expect(cRow.getByTestId('referral-why')).toContainText('단시간 다수 가입(검토)');
  await expect(cRow).toContainText('1,500');
  await cRow.getByTestId('referral-approve').click();
  await expect(page.getByTestId('referral-act')).toContainText(`추천인 ${a.nickname} → 가입자 ${c.nickname}`);
  await expect(page.getByTestId('referral-act-confirm')).toBeDisabled();
  await page.getByTestId('referral-act-reason').fill('E2E 확인 완료');
  await page.getByTestId('referral-act-confirm').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('referral-feedback')).toContainText('승인했습니다. 이번에 지급: 추천인 1,500칩 · 가입자 1,000칩');
  await expect(cRow).toHaveAttribute('data-status', 'settled');
  await expect(cRow).toContainText('E2E 확인 완료');
  await expect(cRow.getByTestId('referral-approve')).toHaveCount(0);
  expect(await balanceOf(c.page)).toBe(11_000);
  expect(await balanceOf(a.page)).toBe(10_000 + 1_000 + 1_000 + 1_500);
  await expect(page.getByTestId('referral-integrity')).toHaveAttribute('data-ok', 'true');
  await page.screenshot({ path: 'test-results/referral-admin.png', fullPage: true });

  // A's member page: the code and three referrals, read only; C's page names who invited them.
  await page.goto(`${ADMIN}/users/${aId}`);
  const panel = page.getByTestId('member-referral');
  await expect(page.getByTestId('member-referral-code')).toHaveText(code);
  await expect(panel.getByRole('row').filter({ hasText: c.nickname })).toHaveAttribute('data-status', 'settled');
  await expect(panel).toContainText('받은 보상 3,500칩');
  await expect(panel.getByTestId('referral-approve')).toHaveCount(0);
  await panel.screenshot({ path: 'test-results/referral-admin-member.png' });
  const cId = await idOf(c.page);
  await page.goto(`${ADMIN}/users/${cId}`);
  await expect(page.getByTestId('member-referral-by')).toContainText(a.nickname);
  await expect(page.getByTestId('member-referral-code')).toHaveText('—');
});
