import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';

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

// The seeded social policy again after the test, so a failure part-way leaves no changed one behind.
test.afterEach(() => {
  sql(
    `INSERT INTO social_policies (version, reactions_enabled, reaction_cooldown_ms, reaction_burst_max, reaction_burst_window_ms, show_super_admin, show_admin, change, reason, created_at) SELECT version + 1, 1, 2000, 5, 30000, 1, 1, 'policy', 'e2e reset', ${Date.now()} FROM social_policies WHERE version = (SELECT MAX(version) FROM social_policies) AND NOT (reactions_enabled = 1 AND reaction_cooldown_ms = 2000 AND reaction_burst_max = 5 AND reaction_burst_window_ms = 30000 AND show_super_admin = 1 AND show_admin = 1)`,
  );
});

test('mobile: social operations and brand status in the console at phone width (policy, preview, save; previews, image, install checks)', async ({ browser }) => {
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const page = op.page;
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // Social: reached from the tables page (no menu entry of its own).
  await page.goto(`${ADMIN}/tables`);
  await page.getByTestId('social-link').click();
  await expect(page).toHaveURL(/\/tables\/social$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('소셜 운영');
  const policy = page.getByTestId('so-policy');
  await expect(policy).toContainText('2초');
  await expect(page.getByTestId('so-boundary')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('social-admin.png'), fullPage: true, animations: 'disabled' });
  await policy.screenshot({ path: test.info().outputPath('social-admin-policy.png'), animations: 'disabled' });

  // A slower cooldown: before → after and what changes for players, then a reason and the password.
  await page.getByTestId('so-cooldown').fill('3');
  await page.getByTestId('so-preview').click();
  const change = page.getByTestId('so-change');
  await expect(change).toContainText('2초 → 3초');
  await expect(page.getByTestId('so-effects')).toContainText('반응 제한이 바뀝니다');
  await expect(page.getByTestId('so-apply')).toBeDisabled();
  await page.getByTestId('so-reason').fill('E2E 반응 간격 조정');
  await page.waitForTimeout(600);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('social-admin-preview.png'), animations: 'disabled' });
  await page.getByTestId('so-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('so-feedback')).toContainText('정책을 저장했습니다.');
  await expect(policy).toContainText('3초');
  await expect(page.getByTestId('so-versions')).toContainText('E2E 반응 간격 조정');

  // A table's page names the version its room holds.
  await page.goto(`${ADMIN}/tables/e2e-tb`);
  const social = page.getByTestId('table-social');
  await expect(social).toHaveAttribute('data-reactions', 'true');
  await social.scrollIntoViewIfNeeded();
  expect(await widerThanDevice(page)).toBe(false);

  // Brand: reached from the service page.
  await page.goto(`${ADMIN}/service`);
  await page.getByTestId('brand-link').click();
  await expect(page).toHaveURL(/\/service\/brand$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('브랜드 상태');
  await expect(page.getByTestId('br-summary')).toBeVisible();
  // The image the tags name, as the console loads it (its own origin).
  const img = page.getByTestId('br-image-preview');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBe(1200);
  for (const kind of ['home', 'homeEn', 'register']) await expect(page.getByTestId(`br-page-${kind}`)).toBeVisible();
  await expect(page.getByTestId('br-index')).toBeVisible();
  await expect(page.getByTestId('br-pwa-checks').locator('[data-check="serviceWorker"]')).toHaveAttribute('data-status', 'info');
  // This build passes every check; the passed ones stay folded under their count until opened.
  await expect(page.locator('[data-check][data-status="fail"]')).toHaveCount(0);
  const home = page.getByTestId('br-page-home');
  await expect(home.locator('[data-check="tags"]')).toBeHidden();
  await home.getByText(/정상 항목 \d+개/).click();
  await expect(home.locator('[data-check="tags"]')).toBeVisible();
  await expect(home.locator('[data-check="tags"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('br-tool-kakao')).toHaveAttribute('href', /developers\.kakao\.com/);
  await expect(page.getByTestId('br-tool-facebook')).toHaveAttribute('target', '_blank');
  // Both manifest icons answer, each verdict beside its file at phone width.
  await expect(page.locator('[data-testid="br-icon"][data-status="ok"]')).toHaveCount(2);
  expect(await widerThanDevice(page)).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('brand-admin.png'), fullPage: true, animations: 'disabled' });
  await page.getByTestId('br-pwa').screenshot({ path: test.info().outputPath('brand-admin-pwa.png'), animations: 'disabled' });
  // The same page as a wide screen lays it out (image and install panels side by side), nothing cut off.
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await widerThanDevice(page)).toBe(false);
  for (const icon of await page.getByTestId('br-icon').all()) {
    const [row, badge] = await Promise.all([icon.boundingBox(), icon.locator('span').nth(1).boundingBox()]);
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(row!.x + row!.width + 0.5);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('brand-admin-wide.png'), fullPage: true, animations: 'disabled' });

  // English at phone width: both pages in the other language, still within the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Brand status');
  await expect(page.getByTestId('br-page-home').getByText(/\d+ checks passed/)).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await page.goto(`${ADMIN}/tables/social`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Social');
  await expect(policy).toContainText('3 s');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('social-admin-en.png'), fullPage: true, animations: 'disabled' });
});
