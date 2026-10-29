import { hasPrivateKey } from '@jc/types';
import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, sitWith, test, uid } from './helpers';
import { ALL_GRANTS, promoteSql } from '../support/grants';

/** A table of its own for a test (a 6-max 5/10 with no bots), so what it shows is only what the test did there. */
function newTable(name: string) {
  const id = uid('e2e-cc-');
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('${id}', '${name}', 6, 5, 10, 100, 1000, 30)`);
  return id;
}

/** Every string anywhere in `v` except under a hand's board (the community cards, which are public). */
function stringsOf(v: unknown, out: string[] = [], key = ''): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, key);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'board') stringsOf(x, out, k);
  return out;
}

/** The control center's socket frames and its room reads, as they arrived, kept to be read for private data. */
function recordMonitor(page: Page) {
  const frames: string[] = [];
  const reads: string[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws/admin/monitor')) return;
    ws.on('framereceived', (f) => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')));
  });
  page.on('response', (r) => {
    if (r.url().endsWith('/api/admin/monitor/rooms')) void r.text().then((s) => reads.push(s), () => undefined);
  });
  return { frames, reads };
}

/** The page fits its window: nothing scrolls sideways. */
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

const card = (page: Page, id: string) => page.locator(`[data-testid=cc-card][data-table="${id}"]`);

test('control center: a member sitting down shows on the table’s card without a reload, the table opens beside the grid with its seats and hand, and no socket frame or room read carries a card in hand', async ({ browser }) => {
  test.setTimeout(150_000);
  const id = newTable('E2E Control Watch');
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const seen = recordMonitor(page);

  await page.goto(`${ADMIN}/control-center`);
  await expect(page.getByTestId('cc-link')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('cc-admin')).toHaveText(op.nickname);
  await expect(card(page, id)).toBeVisible();
  await expect(card(page, id)).toContainText('0/6');
  // Watching is not spectating: the admin's page leaves the table's spectator count as it was.
  await expect(card(page, id).getByTitle(/^(관전자|Spectators)$/)).toHaveText(/^0/);

  // A member sits down: the count on the card follows, with no reload.
  const a = await signUp(browser);
  await sitWith(a.page, id, 500);
  await expect(card(page, id)).toContainText('1/6');

  // Open it: beside the grid, with its room's answer and the member on a seat.
  await card(page, id).getByRole('button', { name: /^E2E Control Watch, / }).click();
  await expect(page).toHaveURL(new RegExp(`focus=${id}`));
  const detail = page.getByTestId('cc-detail');
  await expect(detail).toHaveAttribute('data-table', id);
  await expect(page.getByTestId('cc-room-word')).toContainText(/룸 응답|Room answered/);
  await expect(page.getByTestId('cc-seats')).toContainText(a.nickname);
  await expect(page.getByTestId('cc-grid')).toBeVisible();

  // A second member: a hand is dealt, and the open table follows it (its number and street) as it is played.
  const b = await signUp(browser);
  await sitWith(b.page, id, 500);
  const own = (p: Page, nick: string) => p.locator('[data-testid^=seat-]').filter({ hasText: nick }).locator('[data-card]');
  await expect(own(a.page, a.nickname)).toHaveCount(2);
  await expect(own(b.page, b.nickname)).toHaveCount(2);
  await expect(detail).toContainText(/프리플랍|Preflop/);
  // The turn's countdown never reads more than the table's 30 seconds, even for a turn that just began.
  const left = Number((await page.getByTestId('cc-turn-left').textContent())?.match(/\d+/)?.[0]);
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThanOrEqual(30);
  await expect(card(page, id)).toHaveAttribute('data-room', 'yes');
  await expect(card(page, id)).toContainText('#1');
  await expect(page.getByTestId('cc-seats')).toContainText(b.nickname);
  await page.screenshot({ path: 'test-results/control-center-1920.png' });

  // What the members hold is on their own screens only: not on the admin's, not in a frame, not in a room read.
  const held = [...(await own(a.page, a.nickname).evaluateAll((els) => els.map((e) => e.getAttribute('data-card')!))), ...(await own(b.page, b.nickname).evaluateAll((els) => els.map((e) => e.getAttribute('data-card')!)))];
  expect(held).toHaveLength(4);
  expect(await page.locator('[data-testid=control-center] [data-card]').count()).toBe(0);
  expect(seen.frames.length).toBeGreaterThan(0);
  expect(seen.reads.length).toBeGreaterThan(0);
  for (const raw of [...seen.frames, ...seen.reads]) {
    const msg = JSON.parse(raw) as unknown;
    expect(hasPrivateKey(msg), raw).toBe(false);
    for (const s of stringsOf(msg)) expect(held, raw).not.toContain(s);
  }
  // The room frames this page got were for the table it opened, and only while it was open.
  const rooms = seen.frames.map((f) => JSON.parse(f) as { t: string; e?: { type: string; room?: { tableId: string } } }).filter((m) => m.e?.type === 'admin.monitor.room');
  expect(rooms.length).toBeGreaterThan(0);
  for (const m of rooms) expect(m.e!.room!.tableId).toBe(id);
});

test('control center: filter, sort, size and the open table stay in the address through a reload, a pinned table keeps its own tab, and at 1440×900 the grid and the panel sit side by side without scrolling sideways', async ({ browser }) => {
  test.setTimeout(120_000);
  const id = newTable('E2E Control Pin');
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.goto(`${ADMIN}/control-center`);
  await expect(card(page, id)).toBeVisible();

  // The empty-table filter, the name sort and the large cards: in the address, and still there after a reload.
  await page.getByTestId('cc-state').selectOption('empty');
  await page.getByTestId('cc-sort').selectOption('name');
  await page.getByRole('group', { name: /카드 크기|Card size/ }).getByRole('button', { name: /크게|^L$/ }).click();
  await expect(page).toHaveURL(/state=empty/);
  await expect(page).toHaveURL(/sort=name/);
  await expect(page).toHaveURL(/size=l/);
  await page.reload();
  await expect(page.getByTestId('cc-state')).toHaveValue('empty');
  await expect(page.getByTestId('cc-sort')).toHaveValue('name');
  await expect(card(page, id)).toBeVisible();

  // Searching by name narrows the list on the server.
  await page.getByTestId('cc-search').fill('E2E Control Pin');
  await page.getByTestId('cc-search').press('Enter');
  await expect(page).toHaveURL(/q=E2E/);
  await expect(page.getByTestId('cc-card')).toHaveCount(1);
  await page.getByTestId('cc-search').fill('');
  await page.getByTestId('cc-search').press('Enter');
  await expect(page).not.toHaveURL(/q=/);

  // Pinned: counted in its tab, alone there, and still pinned after a reload (this browser keeps it).
  await card(page, id).getByRole('button', { name: /^(고정|Pin): / }).click();
  await expect(page.getByTestId('cc-tab-pinned')).toContainText('1');
  await page.getByTestId('cc-tab-pinned').click();
  await expect(page.getByTestId('cc-card')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('cc-tab-pinned')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cc-card')).toHaveCount(1);
  await expect(card(page, id)).toBeVisible();

  // Opened at 1440×900: the panel is beside the grid, not over it, and the page does not scroll sideways.
  await card(page, id).getByRole('button', { name: /^E2E Control Pin, / }).click();
  await expect(page.getByTestId('cc-detail')).toHaveAttribute('data-table', id);
  const grid = (await page.getByTestId('cc-grid').boundingBox())!;
  const panel = (await page.getByTestId('cc-panel').boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(grid.x + grid.width);
  expect(panel.x + panel.width).toBeLessThanOrEqual(1440);
  await noSideScroll(page);
  await page.reload();
  await expect(page.getByTestId('cc-detail')).toHaveAttribute('data-table', id);
  await page.screenshot({ path: 'test-results/control-center-1440.png' });

  // Escape closes the table; unpinning empties the tab.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cc-detail')).toHaveCount(0);
  await expect(page).not.toHaveURL(/focus=/);
  await card(page, id).getByRole('button', { name: /^(고정 해제|Unpin): / }).click();
  await expect(page.getByTestId('cc-empty')).toBeVisible();
});

test('control center: an administrator without table access has no menu entry for it, and the page shows the refusal instead of tables', async ({ browser }) => {
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`, ALL_GRANTS.filter((g) => g !== 'tables')));
  const page = await adminLogin(browser, op.email);
  await expect(page.getByRole('link', { name: /^(종합 관제|Control Center)$/ })).toHaveCount(0);
  await page.goto(`${ADMIN}/control-center`);
  await expect(page.getByTestId('control-center').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('cc-card')).toHaveCount(0);
  await expect(page.getByTestId('cc-link')).not.toHaveAttribute('data-state', 'live');
});
