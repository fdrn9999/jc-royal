import { expect } from '@playwright/test';
import { signUp, test } from './helpers';

/** The table page's own code, loaded on demand (main.tsx). */
const TABLE_CODE = /\/assets\/Table-[^/]+\.js$/;

/**
 * The table's code loads on demand, and the lobby fetches it once the browser is idle. Where it will not load (after a
 * deploy the files an older page named are gone), opening a table loads the page again, once, and the table comes up;
 * the lobby's fetch ahead failing reloads nothing.
 */
test('테이블 코드: 로비가 미리 받다 실패해도 새로고침하지 않고, 테이블을 열다 실패하면 한 번 새로고침해 테이블이 열린다', async ({ browser }) => {
  const { page } = await signUp(browser);
  const ctx = page.context();

  // The lobby fetches the table's code ahead; that failing leaves the lobby as it is.
  const lobby = await ctx.newPage();
  await lobby.route(TABLE_CODE, (route) => route.abort());
  let lobbyLoads = 0;
  lobby.on('load', () => lobbyLoads++);
  const ahead = lobby.waitForRequest(TABLE_CODE, { timeout: 15_000 });
  await lobby.goto('/');
  await ahead;
  await lobby.waitForTimeout(1500);
  expect(lobbyLoads).toBe(1);
  await expect(lobby.getByTestId('balance')).toBeVisible();
  await lobby.close();

  // Straight to a table: the first fetch of its code fails, the page loads again and the table comes up.
  const direct = await ctx.newPage();
  let tries = 0;
  await direct.route(TABLE_CODE, (route) => (tries++ === 0 ? route.abort() : route.continue()));
  let loads = 0;
  direct.on('load', () => loads++);
  await direct.goto('/table/e2e-six');
  await expect(direct.getByTestId('table')).toBeVisible({ timeout: 20_000 });
  expect(tries).toBe(2);
  expect(loads).toBe(2);
});
