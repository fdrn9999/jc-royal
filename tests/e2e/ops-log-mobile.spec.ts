import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, uid, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

async function check() {
  const r = await fetch(`http://127.0.0.1:8798/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  expect(r.status).toBe(200);
}

/** Every visible control lies within the phone's width, and the page does not scroll sideways. */
async function fitsPhone(page: Page, root: string) {
  expect(await widerThanDevice(page)).toBe(false);
  const width = page.viewportSize()!.width;
  const out = await page.getByTestId(root).evaluate(
    (el, w) =>
      Array.from(el.querySelectorAll('select, input, button, a, li, h1, h2'))
        .filter((x) => (x as HTMLElement).offsetParent !== null)
        .map((x) => ({ id: x.getAttribute('data-testid') ?? x.tagName, r: x.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.left < -0.5 || r.right > w + 0.5))
        .map(({ id, r }) => `${id} ${Math.round(r.left)}..${Math.round(r.right)}`),
    width,
  );
  expect(out, 'past the screen edge').toEqual([]);
}

test('mobile: the ops log, an alert’s screen and the control center’s alerts fit a phone, at 390 and 320', async ({ browser }) => {
  test.setTimeout(150_000);
  const op = await signUp(browser, { mobile: true });
  sql(promoteSql(`email = '${op.email}'`));
  const member = await signUp(browser, { mobile: true });
  const id = uid('e2e-opsm-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, status) VALUES ('${id}', 'E2E Ops Phone With A Rather Long Table Name', 9, 5, 10, 100, 1000, 30, 'closed')`);
  sql(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) SELECT '${id}-s', '${id}', id, 0, 100, 'seated' FROM users WHERE email = '${member.email}'`);
  await check();

  const page = await adminLogin(browser, op.email, { mobile: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
    await page.goto(`${ADMIN}/control-center`);
    const ours = page.locator(`[data-testid=cc-ops-alert][data-table="${id}"]`);
    await expect(ours).toBeVisible();
    await fitsPhone(page, 'control-center');
    await page.getByTestId('cc-ops').screenshot({ path: `test-results/ops-cc-${width}.png` });

    await page.goto(`${ADMIN}/ops`);
    await expect(page.locator('[data-testid=ops-alert-row][data-code=seated_on_closed]').filter({ hasText: 'E2E Ops Phone' })).toBeVisible();
    await fitsPhone(page, 'ops-page');
    await page.screenshot({ path: `test-results/ops-log-${width}.png`, fullPage: true });

    await page.locator('[data-testid=ops-alert-row][data-code=seated_on_closed]').filter({ hasText: 'E2E Ops Phone' }).getByTestId('ops-alert-open').click();
    await expect(page.getByTestId('ops-incident-title')).toBeVisible();
    await fitsPhone(page, 'ops-incident');
    // The note's buttons are big enough for a thumb.
    const ack = (await page.getByTestId('ops-handling-ack').boundingBox())!;
    expect(ack.height).toBeGreaterThanOrEqual(32);
    await page.screenshot({ path: `test-results/ops-incident-${width}.png`, fullPage: true });
  }
  sql(`UPDATE table_sessions SET status = 'closed', cash_out = 100, closed_at = ${Date.now()} WHERE id = '${id}-s'`);
  await check();
});
