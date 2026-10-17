import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { checkOrCall, PASSWORD, signUp, test, widerThanDevice } from './helpers';

const ADMIN = 'http://localhost:5174';
const TABLE = 'e2e-tb';

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
    await page.getByRole('dialog').getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await prompt.click();
  }
}

/** Every time bank request the page sent. */
function sentTimeBank(page: Page) {
  const sent: { handId: string; seq: number; seen: number }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as { t: string; handId: string; seq: number; seen: number };
      if (m.t === 'timeBank') sent.push(m);
    }),
  );
  return sent;
}

// The seeded policy again after the test, so a failure part-way leaves no changed one behind.
test.afterEach(() => {
  sql(
    `INSERT INTO time_bank_policies (version, enabled, member_rooms, initial_ms, max_ms, unit_ms, refill_hands, refill_ms, change, reason, created_at) SELECT version + 1, 1, 1, 30000, 60000, 10000, 10, 5000, 'policy', 'e2e reset', ${Date.now()} FROM time_bank_policies WHERE version = (SELECT MAX(version) FROM time_bank_policies) AND NOT (enabled = 1 AND member_rooms = 1 AND initial_ms = 30000 AND max_ms = 60000 AND unit_ms = 10000 AND refill_hands = 10 AND refill_ms = 5000)`,
  );
});

test('mobile: the time bank on my turn (time left, one tap adds it, the clock grows), and its administration at phone width', async ({ browser }) => {
  // The administrator (on a phone too) signs in first, so A's turn is not spent waiting for it.
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const page = op.page;
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const sent = sentTimeBank(a.page);
  await a.page.goto(`/table/${TABLE}?sit=1`);
  await a.page.getByTestId('buyin-confirm').tap();
  await b.page.goto(`/table/${TABLE}?sit=1`);
  await b.page.getByTestId('buyin-confirm').click();

  // Only on A's own turn: B plays until it is.
  const bank = a.page.getByTestId('time-bank');
  await expect(async () => {
    if (await bank.isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    expect(await bank.isVisible()).toBe(true);
  }).toPass({ timeout: 60_000 });
  await expect(b.page.getByTestId('time-bank')).toHaveCount(0);

  const use = a.page.getByTestId('time-bank-use');
  await expect(a.page.getByTestId('time-bank-left')).toHaveText('30초');
  await expect(use).toHaveText('+10초');
  await expect(use).toBeEnabled();
  await expect(a.page.getByTestId('time-bank-added')).toHaveCount(0);
  // A thumb-sized button inside the phone's width, above the action bar.
  const box = (await use.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(36);
  expect(box.x + box.width).toBeLessThanOrEqual(a.page.viewportSize()!.width);
  const bar = (await a.page.getByTestId('action-bar').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 1);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('time-bank-turn.png'), animations: 'disabled' });

  await use.tap();
  await expect(a.page.getByTestId('time-bank-left')).toHaveText('20초');
  await expect(a.page.getByTestId('time-bank-added')).toHaveText('이번 차례 +10초');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.seen).toBe(0);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('time-bank-used.png'), animations: 'disabled' });

  // The administrator: the table's clock with the time added, then the policy page.
  await page.goto(`${ADMIN}/tables/${TABLE}`);
  const timer = page.getByTestId('table-timer');
  await expect(timer).toHaveAttribute('data-state', 'ok');
  await expect(timer).toContainText('60초 + 10초');
  await expect(timer).toContainText('시간 은행 +10초');
  await expect(page.getByTestId('table-time-bank')).toContainText('이 핸드 사용 1회');
  await timer.scrollIntoViewIfNeeded();
  expect(await widerThanDevice(page)).toBe(false);
  await timer.screenshot({ path: test.info().outputPath('time-bank-admin-timer.png'), animations: 'disabled' });

  await page.goto(`${ADMIN}/tables/time-bank`);
  const policy = page.getByTestId('tb-policy');
  await expect(policy).toContainText('30초');
  await expect(policy).toContainText('60초');
  await expect(policy).toContainText('10초');
  await expect(page.getByTestId('tb-boundary')).toContainText('다음 핸드부터');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('time-bank-admin.png'), fullPage: true, animations: 'disabled' });

  // A new unit: before → after and where it applies, then a reason and the password.
  await page.getByTestId('tb-unit').fill('5');
  await page.getByTestId('tb-preview').click();
  const change = page.getByTestId('tb-change');
  await expect(change).toContainText('10초 → 5초');
  await expect(page.getByTestId('tb-applies')).toContainText('진행 중인 턴의 마감 시각은 바뀌지 않습니다');
  await expect(page.getByTestId('tb-apply')).toBeDisabled();
  await page.getByTestId('tb-reason').fill('E2E 사용 단위 변경');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('time-bank-admin-preview.png'), animations: 'disabled' });
  await page.getByTestId('tb-apply').click();
  await reauthIfAsked(page);
  await expect(page.getByTestId('tb-feedback')).toContainText('정책을 저장했습니다.');
  await expect(policy).toContainText('5초');
  await expect(page.getByTestId('tb-versions')).toContainText('E2E 사용 단위 변경');

  // A's turn keeps the hand's rules: still +10 seconds a use, and the time already added stays.
  await a.page.waitForTimeout(500);
  await expect(use).toHaveText('+10초');
  await expect(a.page.getByTestId('time-bank-added')).toHaveText('이번 차례 +10초');
  await use.tap();
  await expect(a.page.getByTestId('time-bank-left')).toHaveText('10초');
  await expect(a.page.getByTestId('time-bank-added')).toHaveText('이번 차례 +20초');
  // The table page now shows the next hand's version apart from this hand's.
  await page.goto(`${ADMIN}/tables/${TABLE}`);
  await expect(page.getByTestId('table-time-bank')).toContainText('이 핸드 사용 2회');
  await expect(page.getByTestId('table-time-bank')).toContainText('다음 핸드');
});
