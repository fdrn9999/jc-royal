import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { PASSWORD, signUp, test } from './helpers';
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

test('emergency controls: an admin ends a seated member’s connections, the page stops reconnecting, and pausing new hands shows at the table', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const op = await signUp(browser);
  // A second administrator (the bootstrap is one-time and belongs to the admin console test).
  sql(promoteSql(`email = '${op.email}'`));

  const opened: string[] = [];
  a.page.on('websocket', (ws) => {
    if (/\/ws\/tables\//.test(ws.url())) opened.push(ws.url());
  });
  await a.page.goto('/table/e2e-kick?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-kick?sit=1');
  await b.page.getByTestId('buyin-confirm').click();
  const aOnB = b.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname });
  await expect(aOnB).toBeVisible();
  await expect(b.page.locator('[data-testid^=seat-]').filter({ hasText: b.nickname }).locator('[data-card]')).toHaveCount(2);
  const aId = await a.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // Member detail: the open seat is listed; ending the connections asks to confirm, then for the password again.
  await page.goto(`${ADMIN}/users/${aId}`);
  const form = page.getByTestId('disconnect-form');
  await expect(page.getByTestId('user-sessions').getByRole('link', { name: /e2e-kick/ })).toBeVisible();
  await expect(form.getByTestId('remove-from-table')).not.toBeChecked();
  await expect(form.getByTestId('disconnect')).toBeDisabled();
  await form.getByLabel(/사유|Reason/).fill('E2E 연결 점검');
  await form.getByTestId('disconnect').click();
  await expect(page.getByRole('dialog')).toContainText('E2E 연결 점검');
  await page.getByTestId('confirm-end').click();
  await expect(page.getByTestId('reauth-confirm')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByTestId('reauth-confirm').click();
  const result = page.getByTestId('kick-result');
  await expect(result).toContainText(/연결 1개를 닫았습니다|Closed 1 connections/);
  await expect(result).toContainText(/자리 유지|seat kept/);
  await page.screenshot({ path: 'test-results/admin-kick-result.png', fullPage: true });

  // The member's page says an admin ended it, offers the lobby, and does not reconnect; the other player is unaffected.
  await expect(a.page.getByText(/관리자가 이 테이블 연결을 종료했습니다|An administrator ended this table connection/)).toBeVisible();
  await expect(a.page.getByTestId('kicked-lobby')).toBeVisible();
  // The last view goes with it: no turn, cards or buttons the room would no longer take.
  await expect(a.page.getByTestId('action-bar')).toHaveCount(0);
  await expect(a.page.locator('[data-testid^=seat-]')).toHaveCount(0);
  await expect(aOnB).toContainText(/오프라인|Offline/);
  await a.page.waitForTimeout(4_000);
  expect(opened).toHaveLength(1);
  expect(await a.page.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401);
  await a.page.screenshot({ path: 'test-results/table-kicked.png' });

  // Table detail: pausing new hands needs a reason and a confirmation; the hand in progress plays on.
  await page.goto(`${ADMIN}/tables/e2e-kick`);
  const panel = page.getByTestId('emergency');
  await expect(panel.getByTestId('toggle-pause')).toBeDisabled();
  await panel.getByTestId('control-reason').fill('E2E 점검');
  await panel.getByTestId('toggle-pause').click();
  await page.getByTestId('confirm-control').click();
  await expect(page.getByText(/현재 핸드가 끝난 뒤 멈춥니다|It stops after the current hand/)).toBeVisible();
  await expect(panel.getByTestId('toggle-pause')).toHaveText(/운영 재개|Resume/);
  await expect(page.getByTestId('diagnosis')).toBeVisible();
  const paused = b.page.getByText(/새 핸드를 잠시 멈췄습니다|paused new hands/);
  await expect(paused).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-table-emergency.png', fullPage: true });

  // Resuming clears the notice at the table.
  await panel.getByTestId('control-reason').fill('E2E 재개');
  await panel.getByTestId('toggle-pause').click();
  await page.getByTestId('confirm-control').click();
  await expect(panel.getByTestId('toggle-pause')).toHaveText(/새 핸드 중단|Pause new hands/);
  await expect(paused).toBeHidden();
});
