import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';

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


const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: test.info().outputPath(name), fullPage, animations: 'disabled' });
const rid = () => Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

// A multi-table tournament is off in this environment (its play is covered by tests/integration/mtt): its operator
// screens are drawn here from the api's own answers with only the flag, or a coordinator's answer, added on the way.
test('mobile: the operator\'s multi-table screens: the format in the template form, refused while off, and the coordinator', async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = rid().slice(0, 5);
  sql(
    `INSERT INTO tournament_templates (id, name, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                       tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, format, table_seats, status)
     VALUES ('${rid()}', 'E2E 조정자 ${tag}', 3, 2, 1500, '[{"sb":10,"bb":20},{"sb":15,"bb":30}]', 300000, 20, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 0, 'sng', 0, 'active')`,
  );
  const op = await signUp(browser, { mobile: true });
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const page = op.page;

  // A tournament to draw the coordinator on (a private one: the quickest to open).
  await page.goto('/tournaments');
  await page.getByTestId('tn-private-open').tap();
  await page.getByTestId('tn-private-form').getByTestId('tn-private-template').filter({ hasText: `E2E 조정자 ${tag}` }).tap();
  await page.getByTestId('tn-private-create').tap();
  await expect(page).toHaveURL(/\/tournaments\/[a-z0-9]+$/);
  const id = page.url().split('/tournaments/')[1]!;

  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // Off, the form has no format to choose.
  await page.goto(`${ADMIN}/tournaments/templates`);
  await page.getByTestId('tpl-new').click();
  await expect(page.getByTestId('tpl-name')).toBeVisible();
  await expect(page.getByTestId('tpl-format')).toHaveCount(0);
  await page.goto(`${ADMIN}/tournaments/templates`);

  // On (the list's flag as the api would give it): the format and the seats of a table, one table being too few.
  await page.route(/\/api\/admin\/tournament-templates\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    json.mttEnabled = true;
    await route.fulfill({ response: res, json });
  });
  await page.reload();
  await page.getByTestId('tpl-new').click();
  await page.getByTestId('tpl-name').fill(`E2E 멀티 ${tag}`);
  await page.getByTestId('tpl-format').selectOption('mtt');
  await page.getByTestId('tpl-table-seats').selectOption('6');
  await page.getByTestId('tpl-capacity').fill('6');
  await expect(page.getByTestId('tpl-problem')).toContainText('한 테이블의 좌석보다');
  await page.getByTestId('tpl-capacity').fill('13');
  await page.getByTestId('tpl-min-players').fill('13');
  await expect(page.getByTestId('tpl-problem')).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await shot(page, 'mtt-template-form.png');
  // The server still refuses it while MTT_ENABLED is off, whatever the form offered: at its summary, before any change.
  await page.getByTestId('tpl-preview').click();
  await expect(page.getByTestId('tpl-error')).toContainText('MTT_ENABLED');
  await expect(page.getByTestId('tpl-change')).toHaveCount(0);
  await page.getByTestId('tpl-error').scrollIntoViewIfNeeded();
  await shot(page, 'mtt-template-refused.png');

  // The coordinator's tables on the tournament's page: a move under way, a table behind its orders, one broken.
  let coordinator: unknown = {
    answered: true,
    level: 1,
    paused: false,
    hands: 41,
    playersLeft: 9,
    final: null,
    tables: [
      { id: `mtt-${id}-1`, broken: false, players: 5, leaving: 1, behind: false, hands: 21 },
      { id: `mtt-${id}-2`, broken: false, players: 4, leaving: 0, behind: true, hands: 20 },
      { id: `mtt-${id}-3`, broken: true, players: 0, leaving: 0, behind: false, hands: 9 },
    ],
  };
  await page.route(`**/api/admin/tournaments/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    json.tournament.mtt = { tableSeats: 6, tablesLeft: 2 };
    json.coordinator = coordinator;
    await route.fulfill({ response: res, json });
  });
  await page.goto(`${ADMIN}/tournaments/${id}`);
  await expect(page.getByTestId('tn-badge-private')).toBeVisible();
  await expect(page.getByText('호스트가 시작', { exact: true })).toBeVisible();
  const panel = page.getByTestId('tn-coordinator');
  await expect(panel).toHaveAttribute('data-answered', 'true');
  await expect(panel).toContainText('남은 인원 9명 · 핸드 41 · 레벨 2');
  await expect(panel.getByTestId('tn-coord-table')).toHaveCount(3);
  await expect(panel.locator('[data-testid="tn-coord-table"][data-broken="true"]')).toHaveCount(1);
  await expect(panel).toContainText('이동 중 1명');
  await expect(panel).toContainText('지시 미반영');
  expect(await widerThanDevice(page)).toBe(false);
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'mtt-coordinator-390.png');
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await widerThanDevice(page)).toBe(false);
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'mtt-coordinator-320.png');

  // The final table drawn; and a coordinator that did not answer.
  coordinator = { answered: true, level: 2, paused: false, hands: 60, playersLeft: 6, final: { table: `mtt-${id}-1`, drawn: true }, tables: [{ id: `mtt-${id}-1`, broken: false, players: 6, leaving: 0, behind: false, hands: 33 }] };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(panel).toContainText('파이널 테이블');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'mtt-coordinator-final-1440.png');
  coordinator = { answered: false };
  await page.reload();
  await expect(panel).toHaveAttribute('data-answered', 'false');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'mtt-coordinator-silent-1440.png');
});
