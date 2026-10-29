import { hasPrivateKey } from '@jc/types';
import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { balanceOf, PASSWORD, signUp, sitWith, test, uid } from './helpers';
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

/** The console's password question, when its policy asks again before a control. */
async function reauth(page: Page) {
  await expect(page.getByTestId('reauth-confirm')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByTestId('reauth-confirm').click();
}

/** A line of the page's timeline, by its kind and code, about one table. */
const line = (page: Page, id: string, kind: string, code: string) => page.locator(`[data-testid=cc-tl-line][data-kind=${kind}][data-code=${code}][data-table="${id}"]`);

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
  // That came as an event, so the header shows how long events take to get here (and from how many).
  await expect(page.getByTestId('cc-delay')).toHaveText(/^(이벤트 지연 ≈\d+ms|Event delay ≈\d+ ms)$/);
  await expect(page.getByTestId('cc-delay')).toHaveAttribute('title', /(최근 이벤트 [1-9]\d*개|last [1-9]\d* events)/);

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

test('control center: pausing a table asks first, naming it, with a reason and the password; the table shows it paused, the timeline has the action, the audit log keeps the reason, and resuming within the password window asks no password', async ({ browser }) => {
  test.setTimeout(120_000);
  const id = newTable('E2E Control Act');
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${ADMIN}/control-center?focus=${id}`);
  const detail = page.getByTestId('cc-detail');
  await expect(detail).toHaveAttribute('data-table', id);

  // The question names the table (name and id), says what it is now and what the control does, and waits for a reason.
  await page.getByTestId('cc-ctl-hands').click();
  await expect(page.getByTestId('cc-ctl-target')).toContainText('E2E Control Act');
  await expect(page.getByTestId('cc-ctl-target')).toContainText(id);
  await expect(page.getByTestId('cc-ctl-after')).toBeVisible();
  const confirm = page.getByTestId('cc-ctl-confirm');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('cc-ctl-reason').fill('x');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('cc-ctl-reason').fill('점검 전 새 핸드 중단');
  await page.screenshot({ path: 'test-results/control-center-control.png' });
  await confirm.click();
  // A fresh console session has not given its password yet: it is asked for before anything changes.
  await reauth(page);
  await expect(page.getByTestId('cc-ctl-note')).toHaveAttribute('role', 'status');
  await expect(detail).toContainText(/핸드 중단됨|Hands paused/);
  await expect(card(page, id).getByTitle(/^(핸드 중단됨|Hands paused)$/)).toBeVisible();
  await expect(line(page, id, 'admin', 'pause')).toHaveCount(1);
  await expect(line(page, id, 'table', 'paused')).toHaveCount(1);
  await expect(page.getByTestId('cc-ctl-hands')).toHaveText(/운영 재개|Resume/);

  // The table's audit entries, from the panel: the control with its reason.
  await page.getByTestId('cc-audit').click();
  await expect(page).toHaveURL(new RegExp(`/audit\\?targetType=table&targetId=${id}`));
  const row = page.getByTestId('audit-row').filter({ hasText: 'table.control' });
  await expect(row).toHaveCount(1);
  await row.getByTestId('audit-detail-toggle').click();
  await expect(page.getByTestId('audit-detail')).toContainText('점검 전 새 핸드 중단');
  await expect(page.getByTestId('audit-detail')).toContainText('"action": "pause"');

  // Resumed a moment later: the password given still counts, so only the question and its reason.
  await page.goBack();
  await expect(detail).toHaveAttribute('data-table', id);
  await page.getByTestId('cc-ctl-hands').click();
  await page.getByTestId('cc-ctl-reason').fill('점검 완료, 운영 재개');
  await page.getByTestId('cc-ctl-confirm').click();
  await expect(page.getByTestId('reauth-confirm')).toHaveCount(0);
  await expect(page.getByTestId('cc-ctl-note')).toHaveAttribute('role', 'status');
  await expect(detail).not.toContainText(/핸드 중단됨|Hands paused/);
  await expect(page.getByTestId('cc-ctl-hands')).toHaveText(/새 핸드 중단|Pause new hands/);
});

test('control center: a safe close shows who sits there and with what before it asks for a reason; once closed the panel offers no controls, the member has their chips back, and the reason is in the audit log', async ({ browser }) => {
  test.setTimeout(150_000);
  const id = newTable('E2E Control Close');
  const a = await signUp(browser);
  const before = await balanceOf(a.page);
  await sitWith(a.page, id, 500);
  expect(await balanceOf(a.page)).toBe(before - 500);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${ADMIN}/control-center?focus=${id}`);
  await expect(page.getByTestId('cc-seats')).toContainText(a.nickname);

  // The preview first (no password for it): the member, the stack, and nothing to confirm until it has come.
  await page.getByTestId('cc-ctl-close').click();
  const preview = page.getByTestId('cc-close-preview');
  await expect(preview).toContainText(a.nickname);
  await expect(preview).toContainText('500');
  await expect(page.getByTestId('reauth-confirm')).toHaveCount(0);
  await page.getByTestId('cc-ctl-reason').fill('운영 점검 전 테이블 정리');
  await page.getByTestId('cc-ctl-confirm').click();
  await reauth(page);
  await expect(page.getByTestId('cc-ctl-note')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('cc-ctl-closed')).toBeVisible();
  await expect(page.getByTestId('cc-ctl-hands')).toHaveCount(0);
  await expect(line(page, id, 'admin', 'close')).toHaveCount(1);
  // The member's chips went back to the wallet, all of them.
  await expect.poll(() => balanceOf(a.page)).toBe(before);

  await page.getByTestId('cc-audit').click();
  const row = page.getByTestId('audit-row').filter({ hasText: 'table.close' });
  await expect(row).toHaveCount(1);
  await row.getByTestId('audit-detail-toggle').click();
  await expect(page.getByTestId('audit-detail')).toContainText('운영 점검 전 테이블 정리');
});

test('control center: an administrator who may watch tables but not control them sees no controls, and the control route refuses them all the same', async ({ browser }) => {
  const id = newTable('E2E Control Watch Only');
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`, ALL_GRANTS.filter((g) => g !== 'tableControl')));
  const page = await adminLogin(browser, op.email);
  await page.goto(`${ADMIN}/control-center?focus=${id}`);
  await expect(page.getByTestId('cc-detail')).toHaveAttribute('data-table', id);
  await expect(page.getByTestId('cc-ctl-none')).toBeVisible();
  await expect(page.locator('[data-testid=cc-ctl-hands], [data-testid=cc-ctl-entry], [data-testid=cc-ctl-timer], [data-testid=cc-ctl-close]')).toHaveCount(0);
  // Their own audit entries are theirs to read, as on the table page.
  await expect(page.getByTestId('cc-audit')).toBeVisible();

  // Hiding the buttons is not the protection: the server checks the switch on the request itself.
  const refused = await page.evaluate(async (tableId) => {
    const r = await fetch(`/api/admin/tables/${tableId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause', reason: '권한 없는 시도' }) });
    return { status: r.status, body: (await r.json()) as { error?: { code?: string } } };
  }, id);
  expect(refused.status).toBe(403);
  expect(refused.body.error?.code).toBe('permission_off');
  await page.reload();
  await expect(page.getByTestId('cc-detail')).not.toContainText(/핸드 중단됨|Hands paused/);
});

test('control center: a seated member losing their connection raises an alert at that table; noting it is only a note, and the alert resolves itself once the member is back', async ({ browser }) => {
  test.setTimeout(150_000);
  const id = newTable('E2E Control Alert');
  const a = await signUp(browser);
  await sitWith(a.page, id, 500);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${ADMIN}/control-center?focus=${id}`);
  await expect(page.getByTestId('cc-seats')).toContainText(a.nickname);
  const off = page.locator(`[data-testid=cc-alert][data-table="${id}"][data-code=disconnected]`);
  await expect(off).toHaveCount(0);

  // The member's page goes away: the seat stays (only the member leaves it), the connection does not.
  await a.page.goto('about:blank');
  await expect(off).toHaveCount(1, { timeout: 20_000 });
  await expect(off).toHaveAttribute('data-handling', 'new');
  await expect(line(page, id, 'alert', 'raised')).toHaveCount(1);
  await expect(card(page, id)).toContainText('1/6');

  // Noted: the page remembers who is on it, and the alert stays as long as the problem does.
  await off.getByTestId('cc-alert-ack').click();
  await expect(off).toHaveAttribute('data-handling', 'ack');
  await expect(off.getByTestId('cc-alert-ack')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/control-center-alert.png' });
  await page.waitForTimeout(6_000);
  await expect(off).toHaveCount(1);

  // Back at the table: once the room has shown the member connected for a while, the alert resolves itself.
  await a.page.goto(`/table/${id}`);
  await expect(off).toHaveCount(0, { timeout: 40_000 });
  await expect(page.locator(`[data-testid=cc-alert-gone][data-table="${id}"][data-code=disconnected]`)).toHaveCount(1);
  await expect(line(page, id, 'alert', 'resolved')).toHaveCount(1);
});
