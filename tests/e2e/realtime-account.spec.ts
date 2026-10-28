import { expect, type WebSocketRoute } from '@playwright/test';
import { promoteSql } from '../support/grants';
import { adminLogin, sql } from './analytics-helpers';
import { balanceOf, PASSWORD, signUp, test } from './helpers';
import { idOf } from './hand-review-seed';

test('account: a grant whose event never reached the page shows in the header once the realtime socket is back, without a reload', async ({ browser }) => {
  const member = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const admin = await adminLogin(browser, op.email);

  const page = await member.page.context().newPage();
  // The first socket hears the hello and then nothing, as one that dropped its events would; the next one is the real one.
  let first: WebSocketRoute | undefined;
  const hellos = { n: 0 };
  await page.routeWebSocket(/\/ws\/realtime/, (ws) => {
    const server = ws.connectToServer();
    const lossy = !first;
    if (lossy) first = ws;
    server.onMessage((m) => {
      if (String(m).includes('"hello"')) hellos.n += 1;
      else if (lossy) return;
      ws.send(m);
    });
  });
  await page.goto('/');
  const pill = page.getByTestId('balance').first();
  const before = await balanceOf(page);
  await expect(pill).toHaveText(before.toLocaleString('en-US'));
  await expect.poll(() => hellos.n).toBe(1);

  const id = await idOf(page);
  const status = await admin.evaluate(
    async ({ id, key, password }) => {
      const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await post('/api/admin/auth/reauth', { password });
      return (await post(`/api/admin/users/${id}/chips`, { amount: 777, memo: 'resync check', idempotencyKey: key })).status;
    },
    { id, key: `e2e-resync-${Date.now()}`, password: PASSWORD },
  );
  expect(status).toBe(200);
  expect(await balanceOf(page)).toBe(before + 777);
  // The event was lost: the header still shows the old balance.
  await page.waitForTimeout(2_000);
  await expect(pill).toHaveText(before.toLocaleString('en-US'));

  // The socket drops and opens again: the page reads the account once more.
  await first!.close({ code: 1011, reason: 'gone' });
  await expect.poll(() => hellos.n, { timeout: 20_000 }).toBe(2);
  await expect(pill).toHaveText((before + 777).toLocaleString('en-US'));
});
