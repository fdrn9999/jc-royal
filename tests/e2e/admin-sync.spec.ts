import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test } from './helpers';
import { promoteSql } from '../support/grants';

const TABLE = 'e2e-admin-sync';

/** Same-origin JSON call with the page's session. */
async function call<T>(page: Page, path: string, body?: unknown, method = 'POST'): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(p, b === undefined ? {} : { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, body: (await r.json()) as T };
    },
    [path, body, method] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).body.id;

/** Opens `path` on the console and returns once the page's monitor socket said hello (a change before that is not heard). */
async function opened(page: Page, path: string, ready: Locator) {
  const up = new Promise<void>((resolve) =>
    page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/admin/monitor')) ws.on('framereceived', (f) => String(f.payload).includes('"t":"hello"') && resolve());
    }),
  );
  await page.goto(`${ADMIN}${path}`);
  await expect(ready).toBeVisible();
  await up;
}

/** The member's VIP as the other administrator sets it (password confirmed first, as the console asks). */
async function setVip(admin: Page, id: string, body: { enabled: boolean; color?: string }) {
  expect((await call(admin, '/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const { version } = (await call<{ version: number }>(admin, `/api/admin/users/${id}/vip`)).body;
  const r = await call(admin, `/api/admin/users/${id}/vip`, { ...body, reason: 'E2E 다른 관리자의 변경', expectedVersion: version }, 'PATCH');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Answers the password prompt if the console asks for it before `done` shows. */
async function reauthIfAsked(page: Page, done: Locator) {
  const ask = page.getByTestId('reauth-confirm');
  await expect(ask.or(done).first()).toBeVisible();
  if (await ask.isVisible()) {
    await page.getByRole('dialog').filter({ has: ask }).getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await ask.click();
  }
  await expect(done).toBeVisible();
}

test('two administrators on one member: the other’s VIP change is announced on the open page, nothing shown or typed is replaced, and a confirm goes only from the state as it is now', async ({ browser }) => {
  test.setTimeout(120_000);
  const member = await signUp(browser);
  const memberId = await idOf(member.page);
  const [a, b] = [await signUp(browser), await signUp(browser)];
  sql(promoteSql(`email IN ('${a.email}', '${b.email}')`));
  const one = await adminLogin(browser, a.email);
  const two = await adminLogin(browser, b.email);
  expect(two.url().startsWith(ADMIN)).toBe(true);
  const panel = two.getByTestId('member-vip');
  await opened(two, `/users/${memberId}`, panel);
  await expect(panel).toHaveAttribute('data-vip', '');

  // The panel alone: announced, still showing what it read, until asked for the latest.
  await setVip(one, memberId, { enabled: true, color: 'gold' });
  await expect(two.getByTestId('vip-changed')).toBeVisible();
  await expect(panel).toHaveAttribute('data-vip', '');
  await two.getByTestId('vip-changed').scrollIntoViewIfNeeded();
  await two.screenshot({ path: 'test-results/admin-sync-panel.png' });
  await two.getByTestId('vip-changed-refresh').click();
  await expect(two.getByTestId('vip-changed')).toBeHidden();
  await expect(panel).toHaveAttribute('data-vip', 'gold');

  // The modal open with a color picked and a reason typed: announced there, confirm held, the preview left as it was.
  await two.getByTestId('vip-color-sapphire').click();
  await two.getByTestId('vip-change-color').click();
  const change = two.getByTestId('vip-pv-change');
  await reauthIfAsked(two, change);
  await expect(change).toHaveAttribute('data-from', 'gold');
  await expect(change).toHaveAttribute('data-to', 'sapphire');
  const reason = two.getByTestId('vip-reason');
  await reason.fill('E2E 다른 관리자 변경 뒤 다시 확인');
  const confirm = two.getByTestId('vip-confirm');
  await expect(confirm).toBeEnabled();
  await setVip(one, memberId, { enabled: true, color: 'rose' });
  await expect(two.getByTestId('vip-changed-modal')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(reason).toHaveValue('E2E 다른 관리자 변경 뒤 다시 확인');
  await expect(change).toHaveAttribute('data-from', 'gold');
  await two.screenshot({ path: 'test-results/admin-sync-modal.png' });

  // The latest: the preview again from the other's color, with the pick and the reason kept, and confirm goes.
  await two.getByTestId('vip-changed-modal-refresh').click();
  await expect(two.getByTestId('vip-changed-modal')).toBeHidden();
  await expect(change).toHaveAttribute('data-from', 'rose');
  await expect(change).toHaveAttribute('data-to', 'sapphire');
  await expect(reason).toHaveValue('E2E 다른 관리자 변경 뒤 다시 확인');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await reauthIfAsked(two, two.getByTestId('member-vip-feedback'));
  await expect(panel).toHaveAttribute('data-vip', 'sapphire');
  // Its own change is not announced back to it.
  await expect(two.getByTestId('vip-changed')).toBeHidden();
  const { body } = await call<{ color: string | null; version: number }>(one, `/api/admin/users/${memberId}/vip`);
  expect(body.color).toBe('sapphire');
});

test('two administrators on one table: the other’s change is announced on the open table page, and the blinds typed but not saved stay through the latest', async ({ browser }) => {
  test.setTimeout(120_000);
  sql(`INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${TABLE}', 'E2E Admin Sync', 6, 5, 10, 200, 2000, 30)`);
  const [a, b] = [await signUp(browser), await signUp(browser)];
  sql(promoteSql(`email IN ('${a.email}', '${b.email}')`));
  const one = await adminLogin(browser, a.email);
  const two = await adminLogin(browser, b.email);
  const form = two.getByTestId('table-blinds');
  await opened(two, `/tables/${TABLE}`, form);
  const sb = form.getByLabel(/스몰 블라인드|Small blind/);
  const bb = form.getByLabel(/빅 블라인드|Big blind/);
  const max = form.getByLabel(/최대 바이인|Max buy-in|Maximum buy-in/);
  await expect(sb).toHaveValue('5');
  await max.fill('3000');

  // The other raises the blinds from its own read of the table.
  expect((await call(one, '/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const { table } = (await call<{ table: { updatedAt: number } }>(one, `/api/admin/tables/${TABLE}`)).body;
  const r = await call(one, `/api/admin/tables/${TABLE}`, { smallBlind: 10, bigBlind: 20, ifUpdatedAt: table.updatedAt }, 'PATCH');
  expect(r.status, JSON.stringify(r.body)).toBe(200);

  await expect(two.getByTestId('table-changed')).toBeVisible();
  await expect(sb).toHaveValue('5');
  await expect(max).toHaveValue('3000');
  // Seen from the form being typed in, further down the page: it stays under the header, clear of the form.
  await max.scrollIntoViewIfNeeded();
  await expect(two.getByTestId('table-changed')).toBeInViewport();
  await expect(max).toBeInViewport();
  await two.screenshot({ path: 'test-results/admin-sync-table.png' });
  await two.getByTestId('table-changed-refresh').click();
  await expect(two.getByTestId('table-changed')).toBeHidden();
  await expect(sb).toHaveValue('10');
  await expect(bb).toHaveValue('20');
  await expect(max).toHaveValue('3000');

  // Saving from there keeps both changes, and the page's own save is not announced back to it.
  await form.getByRole('button', { name: /^(저장|Save)$/ }).click();
  await expect(two.getByText(/^(저장되었습니다\.|Saved\.)$/)).toBeVisible();
  await expect(two.getByTestId('table-changed')).toBeHidden();
  const after = (await call<{ table: { smallBlind: number; bigBlind: number; maxBuyIn: number } }>(one, `/api/admin/tables/${TABLE}`)).body.table;
  expect([after.smallBlind, after.bigBlind, after.maxBuyIn]).toEqual([10, 20, 3000]);
});
