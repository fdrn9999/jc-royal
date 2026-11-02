import { expect, type Page } from '@playwright/test';
import type { MonitorRoomsResponse } from '@jc/types';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, sitWith, test, uid } from './helpers';
import { promoteSql } from '../support/grants';

/**
 * The api's minute cron (the realtime outbox, push, then the operations check): local wrangler dev runs it on request.
 * A connection of its own: `sql` blocks the event loop, so a kept-alive one the server closed meanwhile (after ~5 s
 * idle) is not seen closed and the call is reset.
 */
async function check() {
  const r = await fetch(`http://127.0.0.1:8798/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`, { headers: { connection: 'close' } });
  expect(r.status).toBe(200);
}

/** A closed table with a seat still open on it, the state a failed close leaves behind. */
function stuckTable(name: string, email: string) {
  const id = uid('e2e-ops-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, status) VALUES ('${id}', '${name}', 6, 5, 10, 100, 1000, 30, 'closed')`);
  sql(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) SELECT '${id}-s', '${id}', id, 0, 100, 'seated' FROM users WHERE email = '${email}'`);
  return id;
}

const health = (page: Page, key: string) => page.getByTestId(`health-${key}`);

test('ops log: a problem the minute check finds is on the control center without a reload, opens on one screen with its table, its log and the controls, keeps an administrator’s note, and leaves when it is no longer seen', async ({ browser }) => {
  test.setTimeout(180_000);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const member = await signUp(browser);
  const stuck = stuckTable('E2E Ops Stuck', member.email);

  // A table in play beside it, to read one table's health from its room.
  const live = uid('e2e-ops-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${live}', 'E2E Ops Live', 6, 5, 10, 100, 1000, 30)`);
  const a = await signUp(browser);
  const b = await signUp(browser);
  await sitWith(a.page, live, 500);
  await sitWith(b.page, live, 500);

  const page = await adminLogin(browser, op.email);
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Every rooms read the console makes, to check below that none carries a held card.
  const roomReads: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/admin/monitor/rooms')) r.text().then((body) => roomReads.push(body), () => {});
  });
  await page.goto(`${ADMIN}/control-center`);
  await expect(page.getByTestId('cc-link')).toHaveAttribute('data-state', 'live');
  const ours = page.locator(`[data-testid=cc-ops-alert][data-table="${stuck}"]`);
  await expect(ours).toHaveCount(0);

  // The check runs: the console is told and reads the alerts again.
  await check();
  await expect(ours).toBeVisible();
  await expect(ours).toHaveAttribute('data-code', 'seated_on_closed');
  await expect(ours).toHaveAttribute('data-severity', 'critical');
  await expect(page.getByTestId('cc-ops-watch')).toHaveAttribute('data-late', '0');

  // The live table's health, from its room: nothing unobserved is shown as fine.
  await page.locator(`[data-testid=cc-card][data-table="${live}"]`).getByRole('button', { name: /^E2E Ops Live, / }).click();
  await expect(page.getByTestId('cc-detail')).toHaveAttribute('data-table', live);
  await expect(page.getByTestId('health')).toBeVisible();
  await expect(health(page, 'members')).toHaveAttribute('data-state', 'ok');
  await expect(health(page, 'members')).toContainText('2/2');
  await expect(health(page, 'street')).toHaveAttribute('data-state', 'ok');
  await expect(health(page, 'sync')).toHaveAttribute('data-state', 'ok');
  await expect(health(page, 'settlement')).toHaveAttribute('data-state', 'ok');
  await expect(health(page, 'lastGood')).toHaveAttribute('data-state', 'ok');
  // The reads behind that health, with a hand dealt there: no held card or deck in them, by field name (the api's test
  // compares the cards themselves: tests/integration/admin-monitor.test.ts).
  const dealt = (body: string) => {
    const r = (JSON.parse(body) as Partial<MonitorRoomsResponse>).rooms?.[live];
    return !!r && 'room' in r && r.room.hand !== null;
  };
  await expect.poll(() => roomReads.some(dealt)).toBe(true);
  for (const body of roomReads) expect(body).not.toMatch(/"(holeCards|remainingDeck|deck)"/);
  await page.screenshot({ path: 'test-results/ops-control-center-1920.png' });

  // One screen for the alert: its table, its log, and a note kept for every console.
  await ours.getByTestId('cc-ops-detail').click();
  await expect(page).toHaveURL(/\/ops\/alerts\//);
  await expect(page.getByTestId('ops-incident-title')).toBeVisible();
  await expect(page.getByTestId('ops-incident-table')).toContainText('E2E Ops Stuck');
  await expect(page.getByTestId('health-settlement')).toHaveAttribute('data-state', 'bad');
  await expect(page.locator('[data-testid=ops-incident-event]')).toHaveCount(1);
  await page.getByTestId('ops-handling-investigating').click();
  await expect(page.getByTestId('ops-handling-investigating')).toBeDisabled();
  await expect(page.locator('[data-testid=ops-incident-event]')).toHaveCount(2);
  // Not the seated member's name, and no card drawn, anywhere on it (a closed table: the rooms reads are checked above).
  await expect(page.getByTestId('ops-incident')).not.toContainText(member.nickname);
  expect(await page.locator('[data-testid=ops-incident] [data-card]').count()).toBe(0);
  await page.screenshot({ path: 'test-results/ops-incident-1920.png', fullPage: true });

  // The log, after the console was closed and opened again.
  await page.goto(`${ADMIN}/ops`);
  const stuckRow = page.locator(`[data-testid=ops-alert-row][data-code=seated_on_closed]`).filter({ hasText: 'E2E Ops Stuck' });
  await expect(stuckRow).toBeVisible();
  // A table's name filters the list to it, and says so in a chip that clears it.
  await stuckRow.getByRole('button', { name: 'E2E Ops Stuck' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]table=${stuck}`));
  await expect(page.getByTestId('ops-table-chip')).toContainText('E2E Ops Stuck');
  await expect(page.locator('[data-testid=ops-alert-row]')).toHaveCount(1);
  await page.getByTestId('ops-table-chip').click();
  await expect(page.getByTestId('ops-table-chip')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]table=/);
  await page.getByTestId('ops-tab-events').click();
  // A line names its table as it is called now.
  await expect(page.locator('[data-testid=ops-event-row][data-kind=alert_handled]').filter({ hasText: 'E2E Ops Stuck' })).toBeVisible();
  await page.getByTestId('ops-kind').selectOption('alert_opened');
  await expect(page.locator('[data-testid=ops-event-row]:not([data-kind=alert_opened])')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/ops-log-1920.png', fullPage: true });

  // The seat is settled: the next check ends the alert, and the control center lets it go without a reload.
  await page.goto(`${ADMIN}/control-center`);
  await expect(ours).toBeVisible();
  sql(`UPDATE table_sessions SET status = 'closed', cash_out = 100, closed_at = ${Date.now()} WHERE id = '${stuck}-s'`);
  await check();
  await expect(ours).toHaveCount(0);
});
