import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

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

/** An active three-seat Sit & Go template (made in the database: the operator's screens are tournament-mobile's). */
function template(name: string) {
  sql(
    `INSERT INTO tournament_templates (id, name, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                       tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, format, table_seats, status)
     VALUES ('${rid()}', '${name}', 3, 2, 1500, '[{"sb":10,"bb":20},{"sb":15,"bb":30}]', 300000, 20, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 0, 'sng', 0, 'active')`,
  );
}

/** Whether the element lies within the viewport's width (nothing cut off at the side). */
async function fitsWidth(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 0.5;
}

/** Whether a row shows all it holds (nothing pushed past its edge). */
const showsAll = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => el.scrollWidth <= el.clientWidth);

test('mobile: a private Sit & Go from its opening to the table, joined by its code, at phone widths', async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = rid().slice(0, 5);
  const tplName = `E2E 비공개 ${tag}`;
  template(tplName);
  const host = await signUp(browser, { mobile: true });
  const friend = await signUp(browser, { mobile: true });

  // The host opens it from the tournaments page: a template, a name.
  const hp = host.page;
  await hp.goto('/tournaments');
  await hp.getByTestId('tn-private-open').tap();
  const form = hp.getByTestId('tn-private-form');
  await form.getByTestId('tn-private-template').filter({ hasText: tplName }).tap();
  await form.getByTestId('tn-private-name').fill(`친구 모임 ${tag}`);
  expect(await widerThanDevice(hp)).toBe(false);
  await shot(hp, 'pv-create-390.png');
  await hp.getByTestId('tn-private-create').tap();
  await expect(hp).toHaveURL(/\/tournaments\/[a-z0-9]+$/);
  const id = hp.url().split('/tournaments/')[1]!;
  // Its code, shown this once and never in the address.
  const code = (await hp.getByTestId('tn-code').innerText()).trim();
  expect(code).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
  expect(hp.url()).not.toContain(code);
  await expect(hp.getByTestId('tn-private')).toHaveAttribute('data-mine', 'true');
  await expect(hp.getByTestId('tn-host-start')).toBeDisabled();
  await expect(hp.getByTestId('tn-host-hint')).toHaveText('2명이 모이면 시작할 수 있습니다 (지금 1명).');
  await expect(hp.getByTestId('tn-registered')).toContainText('내가 시작하면');
  expect(await widerThanDevice(hp)).toBe(false);
  await shot(hp, 'pv-host-390.png', true);
  await hp.setViewportSize({ width: 320, height: 568 });
  expect(await widerThanDevice(hp)).toBe(false);
  expect(await fitsWidth(hp, 'tn-code-box')).toBe(true);
  await shot(hp, 'pv-host-320.png', true);
  await hp.reload();
  await expect(hp.getByTestId('tn-host')).toBeVisible();
  await expect(hp.getByTestId('tn-code-box')).toHaveCount(0);

  // A friend at 320 brings the code, typed as people do; they are in, as a guest of the host.
  const fp = friend.page;
  await fp.setViewportSize({ width: 320, height: 568 });
  await fp.goto('/tournaments');
  await fp.getByTestId('tn-join-open').tap();
  await fp.getByTestId('tn-join-code').fill(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`);
  expect(await widerThanDevice(fp)).toBe(false);
  await shot(fp, 'pv-join-320.png');
  await fp.getByTestId('tn-join-submit').tap();
  await expect(fp).toHaveURL(new RegExp(`/tournaments/${id}$`));
  await expect(fp.getByTestId('tn-registered')).toBeVisible();
  await expect(fp.getByTestId('tn-private-invited')).toBeVisible();
  await expect(fp.getByTestId('tn-host')).toHaveCount(0);
  await expect(fp.getByTestId('tn-registered')).toContainText('호스트가 시작하면');
  expect(await widerThanDevice(fp)).toBe(false);
  await shot(fp, 'pv-joined-320.png', true);

  // Two are in: the host starts it and goes to its table, where the standings open from the level bar.
  await expect(async () => {
    await hp.reload();
    await expect(hp.getByTestId('tn-host-start')).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(hp.getByTestId('tn-host-hint')).toHaveText('등록한 2명으로 시작합니다 (최소 2명).');
  await hp.getByTestId('tn-host-start').tap();
  await expect(hp).toHaveURL(new RegExp(`/table/sng-${id}$`), { timeout: 15_000 });
  await expect(hp.getByTestId('tn-bar')).toBeVisible();
  await expect(hp.getByTestId('tn-final')).toHaveCount(0);
  // The level, blinds, clock and the players left (which opens the standings) fit the bar at 320.
  expect(await showsAll(hp, 'tn-bar')).toBe(true);
  await shot(hp, 'pv-bar-320.png');
  const toggle = hp.getByTestId('tn-standings-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const standings = hp.getByTestId('tn-standings');
  await expect(standings.getByTestId('tn-standing')).toHaveCount(2);
  await expect(standings).toContainText(host.nickname);
  await expect(standings).toContainText(friend.nickname);
  expect(await widerThanDevice(hp)).toBe(false);
  expect(await fitsWidth(hp, 'tn-standings')).toBe(true);
  await shot(hp, 'pv-standings-320.png');
  await hp.setViewportSize({ width: 812, height: 375 });
  expect(await widerThanDevice(hp)).toBe(false);
  expect(await fitsWidth(hp, 'tn-standings')).toBe(true);
  await shot(hp, 'pv-standings-812x375.png');
  await toggle.tap();
  await expect(standings).toHaveCount(0);

  // The overlay of a final table and of a result, on a desktop: the room's own state with only those flags changed
  // on the way (a multi-table tournament is off in this environment; its play is covered by tests/integration/mtt).
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await fp.context().storageState() });
  const dp = await desk.newPage();
  let inject: 'final' | 'finished' = 'final';
  await dp.routeWebSocket(/\/ws\/tables\//, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const x = typeof m === 'string' ? JSON.parse(m) : null;
      const tn = x?.t === 'state' ? x.state.tournament : null;
      if (tn && inject === 'final') tn.mtt = { tables: 1, finalTable: true, hold: false, movedTo: null };
      if (tn && inject === 'finished') {
        tn.status = 'finished';
        tn.playersLeft = 1;
        tn.you = { status: 'eliminated', place: 2 };
        tn.places = [
          { nickname: host.nickname, place: 1 },
          { nickname: friend.nickname, place: 2 },
        ];
      }
      ws.send(tn ? JSON.stringify(x) : m);
    });
  });
  await dp.goto(`/table/sng-${id}`);
  await expect(dp.getByTestId('tn-final')).toBeVisible();
  await expect(dp.getByTestId('tn-bar-tables')).toHaveCount(0);
  await dp.getByTestId('tn-standings-toggle').click();
  await expect(dp.getByTestId('tn-standings').getByTestId('tn-standing')).toHaveCount(2);
  await shot(dp, 'pv-final-1440.png');
  await dp.setViewportSize({ width: 360, height: 640 });
  expect(await showsAll(dp, 'tn-bar')).toBe(true);
  await shot(dp, 'pv-final-360.png');
  await dp.setViewportSize({ width: 1440, height: 900 });
  inject = 'finished';
  await dp.reload();
  const result = dp.getByTestId('tn-result');
  await expect(result).toBeVisible();
  await expect(result.getByTestId('tn-champion')).toContainText(host.nickname);
  await shot(dp, 'pv-champion-1440.png');
  await desk.close();
});

test('desktop: the host\'s page of a private tournament, its tables while running, and its cancel', async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = rid().slice(0, 5);
  const tplName = `E2E 비공개 ${tag}`;
  template(tplName);
  const host = await signUp(browser);
  const page = host.page;
  await page.goto('/tournaments');
  await page.getByTestId('tn-private-open').click();
  await page.getByTestId('tn-private-form').getByTestId('tn-private-template').filter({ hasText: tplName }).click();
  await page.getByTestId('tn-private-create').click();
  await expect(page.getByTestId('tn-code-box')).toBeVisible();
  const id = page.url().split('/tournaments/')[1]!;
  await shot(page, 'pv-host-1440.png', true);

  // Listed for the host, marked as theirs.
  await page.goto('/tournaments');
  await expect(page.locator('[data-testid="tn-private"][data-mine="true"]').first()).toBeVisible();

  // The list of tables a multi-table tournament shows while running (its detail as the api gives it, with tables).
  const withTables = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    const res = await route.fetch();
    const json = await res.json();
    json.mtt = { tableSeats: 6, tablesLeft: 3 };
    json.tables = [
      { id: `mtt-${id}-1`, players: 6 },
      { id: `mtt-${id}-2`, players: 5 },
      { id: `mtt-${id}-3`, players: 5 },
    ];
    await route.fulfill({ response: res, json });
  };
  await page.route(`**/api/tournaments/${id}`, withTables);
  await page.goto(`/tournaments/${id}`);
  const tables = page.getByTestId('tn-tables');
  await expect(tables.getByTestId('tn-table-link')).toHaveCount(3);
  await expect(page.getByTestId('tn-mtt')).toBeVisible();
  await tables.scrollIntoViewIfNeeded();
  await shot(page, 'pv-tables-1440.png');
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await widerThanDevice(page)).toBe(false);
  await tables.scrollIntoViewIfNeeded();
  await shot(page, 'pv-tables-320.png');
  await page.unroute(`**/api/tournaments/${id}`, withTables);
  await page.setViewportSize({ width: 1440, height: 900 });

  // The host cancels it, after a confirmation.
  await page.goto(`/tournaments/${id}`);
  await page.getByTestId('tn-host-cancel').click();
  const confirm = page.getByTestId('tn-host-cancel-confirm');
  await expect(confirm).toBeVisible();
  await shot(page, 'pv-cancel-1440.png');
  await confirm.click();
  await expect(page.getByTestId('tn-host')).toHaveCount(0);
  await expect(page.getByTestId('tn-detail')).toContainText(/취소/);
  await shot(page, 'pv-cancelled-1440.png', true);
});
