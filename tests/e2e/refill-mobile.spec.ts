import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { balanceOf, signUp, test, widerThanDevice } from './helpers';

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

const shot = (name: string) => `test-results/refill-${name}.png`;

test('free refill on a phone: the terms on the Me page, a refill taken from the buy-in notice, then the wait', async ({ browser }) => {
  const m = await signUp(browser, { mobile: true });
  const page = m.page;
  await page.setViewportSize({ width: 360, height: 740 });

  // A new member's 10,000 chips are above the line: the card says so, with the terms (seeded policy: below 1,000, 2,000, 6 hours).
  await page.goto('/me');
  const card = page.getByTestId('refill-card');
  await expect(card).toHaveAttribute('data-reason', 'above');
  await expect(page.getByTestId('refill-terms')).toContainText('1,000칩 미만이면 2,000칩');
  await expect(page.getByTestId('refill-terms')).toContainText('6시간');
  await expect(page.getByTestId('refill-state')).toContainText('기준(1,000칩) 이상');
  await expect(page.getByTestId('refill-claim')).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await card.screenshot({ path: shot('above') });

  // The wallet drops to 10 chips through an adjustment the ledger records (the books stay balanced).
  const id = await page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  sql(
    `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, memo, created_at) VALUES ('e2e-rf-${id}', '${id}', 'admin_adjust', -9990, 10, 'e2e-rf-${id}', 'e2e', ${Date.now()}); UPDATE users SET balance = 10 WHERE id = '${id}'`,
  );

  // Too few chips for the table: the buy-in notice offers the refill right there, and taking it makes the buy-in possible.
  await page.goto('/table/e2e-refill?sit=1');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('보유 칩이 부족합니다.');
  const hint = dialog.getByTestId('refill-hint');
  await expect(hint).toHaveAttribute('data-reason', 'eligible');
  await expect(hint).toContainText('무료 칩 보충 · 지금 2,000칩을 받을 수 있습니다.');
  await expect(page.getByTestId('buyin-confirm')).toBeDisabled();
  expect(await widerThanDevice(page)).toBe(false);
  await dialog.screenshot({ path: shot('buyin-hint') });
  await hint.getByTestId('refill-hint-claim').click();
  await expect(hint.getByTestId('refill-note')).toContainText('2,000칩을 받았습니다. 지갑 잔액 2,010칩.');
  await expect(hint).toHaveAttribute('data-reason', 'cooldown');
  await expect(hint).toContainText('남음');
  await expect(page.getByTestId('buyin-confirm')).toBeEnabled();
  expect(await balanceOf(page)).toBe(2010);
  await dialog.screenshot({ path: shot('buyin-claimed') });

  // Asking again pays nothing more: the server answers with the wait.
  const again = await page.evaluate(async () => {
    const r = await fetch('/api/me/refill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: r.status, body: (await r.json()) as { error: { code: string; details: { status: { reason: string } } } } };
  });
  expect(again.status).toBe(409);
  expect(again.body.error.code).toBe('refill_refused');
  expect(again.body.error.details.status.reason).toBe('cooldown');
  expect(await balanceOf(page)).toBe(2010);

  // Back on the Me page: the wait and the next time, one refill received, and the ledger line.
  await page.goto('/me');
  await expect(card).toHaveAttribute('data-reason', 'cooldown');
  await expect(page.getByTestId('refill-state')).toContainText('다음 보충은');
  await expect(page.getByTestId('refill-received')).toContainText('지금까지 1회 받음');
  await expect(page.getByTestId('me-balance')).toHaveText('2,010');
  await expect(page.getByTestId('ledger')).toContainText('무료 칩 보충');
  expect(await widerThanDevice(page)).toBe(false);
  await card.screenshot({ path: shot('cooldown') });

  // English.
  await page.getByTestId('settings-open').click();
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Free chip refill', { exact: true })).toBeVisible();
  await expect(page.getByTestId('refill-state')).toContainText('The next refill comes at');
  await expect(page.getByTestId('refill-received')).toContainText('Refills received: 1');
  expect(await widerThanDevice(page)).toBe(false);
  await card.screenshot({ path: shot('cooldown-en') });
});
