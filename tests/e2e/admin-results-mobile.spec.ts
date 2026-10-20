import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

const TABLE = 'e2e-results';

/** `el` is on the screen below the sticky header, and nothing covers it. */
async function inSight(page: Page, el: Locator) {
  await expect(el).toBeVisible();
  const box = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  const headerBottom = await page.evaluate(() => document.querySelector('header')!.getBoundingClientRect().bottom);
  expect(box.y).toBeGreaterThanOrEqual(headerBottom - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  const hit = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + r.height / 2);
    return !!top && node.contains(top);
  });
  expect(hit).toBe(true);
  return { box, headerBottom };
}

/**
 * A jump link took the page to the panel `id`: its top lands just below the header, and below a result pinned under
 * the header while one shows (or the page ran out).
 */
async function landed(page: Page, id: string) {
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect(async () => {
    const at = await page.evaluate((id) => {
      const top = document.getElementById(id)!.getBoundingClientRect().top;
      const header = document.querySelector('header')!.getBoundingClientRect().bottom;
      const pin = document.querySelector('[data-testid="feedback-pin"]')?.getBoundingClientRect().bottom ?? 0;
      const end = scrollY + innerHeight >= document.documentElement.scrollHeight - 1;
      return { top, clear: Math.max(header, pin), end };
    }, id);
    expect(at.top).toBeGreaterThanOrEqual(at.clear);
    if (!at.end) expect(at.top).toBeLessThanOrEqual(at.clear + 16);
    else expect(at.top).toBeLessThan(page.viewportSize()!.height - 80);
  }).toPass({ timeout: 5000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('on a phone: the result of a save, a refused stale save and a chip adjustment shows below the header where the operator is, the lists’ names open their pages, and jump links reach the panels', async ({ browser }) => {
  sql(`INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${TABLE}', 'E2E Results', 6, 5, 10, 200, 2000, 30)`);
  sql(`UPDATE tables SET last_issue = '2026-10-18T01:02:03.000Z command failed: D1_ERROR e2e-results' WHERE id = '${TABLE}'`);
  const op = await signUp(browser, { mobile: true });
  const member = await signUp(browser, { mobile: true });
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email, { mobile: true });

  // The members list: the name itself opens the member, on the screen without scrolling the table sideways.
  await page.goto(`${ADMIN}/users?q=${encodeURIComponent(member.nickname)}`);
  const name = page.getByRole('link', { name: member.nickname, exact: true });
  await inSight(page, name);
  // The panels above the ledger load on their own after the page. Slowed here, they are still loading when its link is
  // followed, and each grows under the operator when its rows come.
  const panels = /\/api\/admin\/users\/[^/]+\/(activity|timeline|refill|referral|settings)\b/;
  const slow = async (route: Route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  };
  await page.route(panels, slow);
  await name.click();
  await expect(page).toHaveURL(/\/users\/[0-9a-f-]+$/);

  // The member's page: jump links reach the ledger below everything else (still there once the panels above it have
  // loaded) and the admin history.
  const jump = page.getByTestId('member-jump');
  await jump.getByRole('link', { name: '칩 원장' }).click();
  await expect(page.getByTestId('member-referral')).toBeAttached();
  await expect(page.getByTestId('member-settings')).toBeAttached();
  await landed(page, 'member-ledger');
  await page.unroute(panels, slow);
  await jump.scrollIntoViewIfNeeded();
  await jump.getByRole('link', { name: /관리 이력/ }).click();
  await landed(page, 'member-history');

  // A chip adjustment, through its confirmation and the password: the result shows where the form is, and ✕ closes it.
  await page.getByTestId('chip-amount').fill('100');
  await page.getByTestId('chip-memo').fill('e2e results');
  await page.getByTestId('chip-submit').click();
  await page.getByTestId('confirm-end').click();
  const reauth = page.getByTestId('reauth-confirm');
  await reauth.waitFor({ timeout: 15000 });
  await page.getByRole('dialog').getByLabel(/^비밀번호$/).fill(PASSWORD);
  await reauth.click();
  const note = page.getByTestId('feedback');
  await expect(note).toHaveText('저장되었습니다.');
  await expect(page.getByTestId('chip-amount')).toBeInViewport();
  await inSight(page, note);
  await page.getByTestId('feedback-close').click();
  await expect(note).toHaveCount(0);
  // Closed, it no longer pushes a jump link's panel down.
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--pin-h'))).toBe('');

  // The tables list: the name opens the table.
  await page.goto(`${ADMIN}/tables?q=${encodeURIComponent('E2E Results')}`);
  const tname = page.getByRole('link', { name: 'E2E Results', exact: true });
  await inSight(page, tname);
  await tname.click();
  await expect(page).toHaveURL(new RegExp(`/tables/${TABLE}$`));

  // The header's last-problem badge goes to the diagnosis, which shows the whole message.
  await page.getByTestId('last-issue-link').click();
  await landed(page, 'table-diagnosis');
  await expect(page.getByTestId('last-issue')).toContainText('command failed: D1_ERROR e2e-results');

  // The blinds, saved far down the page: the result shows on the screen, with the form still there.
  const form = page.getByTestId('table-blinds');
  const save = form.getByRole('button', { name: /^저장$/ });
  await save.scrollIntoViewIfNeeded();
  await save.click();
  await expect(note).toHaveText('저장되었습니다.');
  await inSight(page, note);
  await expect(save).toBeInViewport();

  // Another change lands first; the save from this page is refused, and the refusal shows beside the reloaded form.
  await page.evaluate(async (id) => {
    await fetch(`/api/admin/tables/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beginner: true }) });
  }, TABLE);
  await form.getByLabel('스몰 블라인드(SB)').fill('10');
  await form.getByLabel('빅 블라인드(BB)').fill('20');
  await save.click();
  await expect(note).toContainText('다른 관리자가 먼저 이 테이블 설정을 바꿨습니다');
  await inSight(page, note);
  await expect(form.getByLabel('스몰 블라인드(SB)')).toHaveValue('5');
  await expect(form.getByLabel('스몰 블라인드(SB)')).toBeInViewport();
  await page.screenshot({ path: 'test-results/admin-results-conflict.png' });
  expect(await widerThanDevice(page)).toBe(false);

  // With the refusal still pinned under the header, a jump link's panel stops below it: its heading is not under it.
  const tjump = page.getByTestId('table-jump');
  await tjump.scrollIntoViewIfNeeded();
  await tjump.locator('a[href="#table-emergency"]').click();
  await landed(page, 'table-emergency');
  await expect(page.getByTestId('feedback-pin')).toBeVisible();
  await inSight(page, page.locator('#table-emergency h2'));
  await page.screenshot({ path: 'test-results/admin-results-jump-pinned.png' });

  // The security page: the session's own button is on the screen, not past a table's right edge.
  await page.goto(`${ADMIN}/security`);
  await inSight(page, page.getByTestId('end-session').first());
  expect(await widerThanDevice(page)).toBe(false);
});
