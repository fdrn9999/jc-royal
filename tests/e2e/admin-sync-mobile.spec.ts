import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test } from './helpers';
import { promoteSql } from '../support/grants';

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

test('on a phone: the notice of another administrator’s VIP change fits the open dialog, beside the reason typed, and the latest keeps it', async ({ browser }) => {
  test.setTimeout(120_000);
  const member = await signUp(browser, { mobile: true });
  const memberId = await idOf(member.page);
  const [a, b] = [await signUp(browser, { mobile: true }), await signUp(browser, { mobile: true })];
  sql(promoteSql(`email IN ('${a.email}', '${b.email}')`));
  const one = await adminLogin(browser, a.email, { mobile: true });
  const two = await adminLogin(browser, b.email, { mobile: true });
  await setVip(one, memberId, { enabled: true, color: 'gold' });

  const up = new Promise<void>((resolve) =>
    two.on('websocket', (ws) => {
      if (ws.url().includes('/ws/admin/monitor')) ws.on('framereceived', (f) => String(f.payload).includes('"t":"hello"') && resolve());
    }),
  );
  await two.goto(`${ADMIN}/users/${memberId}`);
  await expect(two.getByTestId('member-vip')).toHaveAttribute('data-vip', 'gold');
  await up;

  await two.getByTestId('vip-color-emerald').click();
  await two.getByTestId('vip-change-color').click();
  const change = two.getByTestId('vip-pv-change');
  await reauthIfAsked(two, change);
  const reason = two.getByTestId('vip-reason');
  await reason.fill('E2E 휴대폰에서 다시 확인');
  await setVip(one, memberId, { enabled: true, color: 'cyan' });

  const notice = two.getByTestId('vip-changed-modal');
  await expect(notice).toBeVisible();
  await expect(two.getByTestId('vip-confirm')).toBeDisabled();
  // Inside the screen's width, with no sideways scroll.
  const box = (await notice.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await two.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await notice.scrollIntoViewIfNeeded();
  await two.screenshot({ path: 'test-results/admin-sync-mobile.png' });

  await two.getByTestId('vip-changed-modal-refresh').click();
  await expect(notice).toBeHidden();
  await expect(change).toHaveAttribute('data-from', 'cyan');
  await expect(change).toHaveAttribute('data-to', 'emerald');
  await expect(reason).toHaveValue('E2E 휴대폰에서 다시 확인');
  await expect(two.getByTestId('vip-confirm')).toBeEnabled();
});
