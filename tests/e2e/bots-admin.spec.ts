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
    await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await prompt.click();
  }
}

/** Today's counters for the expert bots, as a table's record would add them (game-worker bot-stats.ts, `bt_<level>_<key>`). */
const EXPERT_PLAY = { hands: 40, vpipOpp: 40, vpip: 11, pfr: 6, threeBetOpp: 20, threeBet: 1, bbStealOpp: 10, bbFoldToSteal: 4, foldToOverbetOpp: 8, foldToOverbet: 4, decisions: 200, fallbacks: 2, lagMs: 3000 };

// The test ends with bots off; the seeded policy (on, 1,000,000 chips, 20 bots) comes back for whatever runs next.
test.afterEach(() => {
  sql(
    `INSERT INTO bot_policies (version, enabled, fund_limit, max_bots, change, reason) SELECT version + 1, 1, 1000000, 20, 'policy', 'e2e reset' FROM bot_policies WHERE version = (SELECT MAX(version) FROM bot_policies) AND NOT (enabled = 1 AND fund_limit = 1000000 AND max_bots = 20)`,
  );
  sql(`DELETE FROM daily_stats WHERE metric GLOB 'bt_expert_*'`);
  // Bot accounts are reused by later tests' tables: they follow their tables again.
  sql(`DELETE FROM bot_profiles`);
});

test('bot administration: the seated bot and its fund, a policy change with before → after and a reason, an emergency stop the table follows, the event log and the fund check', async ({ browser }) => {
  // E2E Bots Admin: 2 seats, one hard bot keeps a lone member company.
  const m = await signUp(browser);
  await sitWith(m.page, 'e2e-bots-admin', 100);
  await expect(m.page.getByTestId('bot-badge')).toHaveAttribute('data-level', 'hard', { timeout: 30_000 });

  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  // Days are counted in KST (packages/db stats.ts `statsDay`).
  const today = Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000);
  sql(
    `INSERT INTO daily_stats (day, metric, n) VALUES ${Object.entries(EXPERT_PLAY)
      .map(([k, n]) => `(${today}, 'bt_expert_${k}', ${n})`)
      .join(', ')} ON CONFLICT (day, metric) DO UPDATE SET n = excluded.n`,
  );
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
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

  // How each level played: every rate with its own denominator, and how the moves went.
  const expert = page.getByTestId('bots-level-play').locator('tr[data-level="expert"]');
  await expect(expert.locator('td')).toHaveText(['전문가', '40', '27.5% (40)', '15.0% (40)', '5.0% (20)', '60.0% (10)', '50.0% (8)', '200', '2 (1.0%)', '0 (0.0%)', '15 ms', '0']);

  // The table's own page shows the same settings and whether bots may sit there now.
  await row.getByRole('link', { name: 'E2E Bots Admin' }).click();
  await expect(page.getByTestId('table-bots-live')).toContainText('지금 봇 착석 가능');
  await expect(page.getByTestId('bot-level')).toHaveValue('hard');
  await expect(page.getByTestId('bot-style')).toHaveValue('auto');
  // Its live seats: the robot on the bot's badge (with its level), none by the member.
  const liveSeats = page.locator('#table-live li');
  await expect(liveSeats).toHaveCount(2);
  const botSeat = liveSeats.filter({ has: page.locator('svg.lucide-bot') });
  await expect(botSeat).toHaveCount(1);
  await expect(botSeat).toContainText('BOT · 어려움');
  await expect(liveSeats.filter({ hasText: m.nickname }).locator('svg.lucide-bot')).toHaveCount(0);
  await page.locator('#table-live').screenshot({ path: 'test-results/bots-admin-live-seats.png', animations: 'disabled' });
  await page.getByTestId('table-bots-link').click();
  await expect(page).toHaveURL(/\/bots\?table=e2e-bots-admin$/);
  await expect(page.getByTestId('bots-events-table')).toHaveValue('e2e-bots-admin');
  await expect(page.getByTestId('bots-events').locator('tr[data-kind="join"]').first()).toBeVisible();

  // The seated bot's own settings: the table's level and its account's auto style until an administrator sets its own,
  // previewed (before → after, and how it plays at the table) and saved with a reason; the table deals it from the next hand.
  const acct = page.getByTestId('bots-accounts').locator('tr').filter({ has: page.getByRole('link', { name: 'E2E Bots Admin' }) });
  await expect(acct).toHaveAttribute('data-level', 'hard');
  await expect(acct.getByTestId('bot-acct-level')).toContainText('어려움');
  await expect(acct.getByTestId('bot-acct-level')).toContainText('테이블');
  await expect(acct.getByTestId('bot-acct-style')).toContainText('자동');
  await acct.getByTestId('bot-acct-edit').click();
  await expect(page.getByTestId('bot-profile-now')).toContainText('E2E Bots Admin에서 지금: 어려움');
  await expect(page.getByTestId('bot-profile-preview')).toBeDisabled();
  await page.getByTestId('bot-profile-level').selectOption('expert');
  await page.getByTestId('bot-profile-style').selectOption('tag');
  // Its own buy-in in big blinds: out of range it cannot be previewed; 30 BB is 300 chips here (blinds 5/10, buy-in 100–1,000),
  // where the default 100 BB sat it down with the table's maximum.
  await expect(page.getByTestId('bot-profile-buyin-table')).toContainText('100–1,000칩');
  await expect(page.getByTestId('bot-profile-buyin-table')).toContainText('1,000칩으로 앉았습니다');
  await page.getByTestId('bot-profile-buyin').fill('501');
  await expect(page.getByTestId('bot-profile-preview')).toBeDisabled();
  await page.getByTestId('bot-profile-buyin').fill('30');
  await page.getByTestId('bot-profile-preview').click();
  const profileChange = page.getByTestId('bot-profile-change');
  await expect(profileChange).toContainText('테이블 설정 따르기 → 전문가');
  await expect(profileChange).toContainText('테이블 설정 따르기 → 타이트 어그레시브');
  await expect(profileChange).toContainText('기본 100BB → 30BB');
  await expect(page.getByTestId('bot-profile-effective')).toContainText('→ 전문가 · 타이트 어그레시브');
  await expect(page.getByTestId('bot-profile-applies')).toContainText('다음 핸드부터 적용됩니다');
  await expect(page.getByTestId('bot-profile-buyin-next')).toContainText('1,000 → 300');
  await expect(page.getByTestId('bot-profile-buyin-applies')).toContainText('다음에 앉을 때부터 적용됩니다');
  await expect(page.getByTestId('bot-profile-apply')).toBeDisabled();
  await page.getByTestId('bot-profile-reason').fill('E2E 봇 개별 설정');
  await page.screenshot({ path: 'test-results/bots-admin-profile.png', animations: 'disabled' });
  await page.getByTestId('bot-profile-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('bots-feedback')).toContainText('봇 설정을 저장했습니다.');
  await expect(acct).toHaveAttribute('data-level', 'expert');
  await expect(acct).toHaveAttribute('data-style', 'tag');
  await expect(acct.getByTestId('bot-acct-level')).toContainText('계정');
  // The seat it holds keeps the stack it sat down with.
  await expect(acct.getByTestId('bot-acct-buyin')).toContainText('30BB');
  await expect(acct.getByTestId('bot-acct-buyin')).toContainText('지금 자리 1,000칩');
  await page.screenshot({ path: 'test-results/bots-admin-accounts.png', fullPage: true, animations: 'disabled' });
  // At the member's table the bot plays from the next deal as set (the member folds the hands until then).
  await expect(async () => {
    const fold = m.page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ });
    if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
    await expect(m.page.getByTestId('bot-badge')).toHaveAttribute('data-level', 'expert', { timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  // The audit of a hand they played: the robot on the bot's row only (in another tab, the bots page stays).
  const handId = await m.page.evaluate(async () => {
    const list = (await (await fetch('/api/me/hands')).json()) as { id: string; tableId: string }[];
    return list.find((h) => h.tableId === 'e2e-bots-admin')!.id;
  });
  const audit = await ctx.newPage();
  await audit.goto(`${ADMIN}/hands/${encodeURIComponent(handId)}`);
  const players = audit.locator('li').filter({ has: audit.locator('a[href^="/users/"]') });
  await expect(players).toHaveCount(2);
  const botRow = players.filter({ has: audit.locator('svg.lucide-bot') });
  await expect(botRow).toHaveCount(1);
  await expect(botRow).toContainText('BOT');
  await expect(players.filter({ hasText: m.nickname }).locator('svg.lucide-bot')).toHaveCount(0);
  await audit.screenshot({ path: 'test-results/bots-admin-hand-audit.png', animations: 'disabled' });
  await audit.close();

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
