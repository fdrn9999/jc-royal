import { expect, type Page } from '@playwright/test';
import { signUp, sitWith, test, widerThanDevice } from './helpers';

const lobbyGets = (page: Page) => {
  const seen = { n: 0 };
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/tables') seen.n += 1;
  });
  return seen;
};
const isList = (r: { url(): string; request(): { method(): string } }) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/tables';

test('lobby: a full table without spectating offers the waitlist, and the table says where you stand', async ({ browser }) => {
  // E2E Lobby Hidden: 2 seats, spectating off.
  const a = await signUp(browser);
  await sitWith(a.page, 'e2e-lobby-full', 100);
  const b = await signUp(browser);
  await sitWith(b.page, 'e2e-lobby-full', 100);

  const c = await signUp(browser);
  const card = c.page.getByTestId('lobby-table').filter({ hasText: 'E2E Lobby Hidden' });
  const enter = card.getByTestId('lobby-enter');
  // The list may still show the seat count from before B sat; the visible lobby polls.
  await expect(enter).toHaveAttribute('data-entry', 'wait', { timeout: 15_000 });
  await expect(enter).toHaveText(/^(대기 등록|Join waitlist)$/);
  await expect(card.getByTestId('full-badge')).toBeVisible();
  await expect(card.getByTestId('lobby-watch')).toBeDisabled();
  await expect(card.getByTestId('lobby-watch')).toHaveText(/^(관전 불가|No spectators)$/);
  await expect(card.getByTestId('lobby-wait-hint')).toContainText(/핸드는 보이지 않습니다|hands stay hidden/);
  await card.scrollIntoViewIfNeeded();
  await c.page.screenshot({ path: 'test-results/lobby-full-desktop.png' });

  // It joins the waitlist (not a page that only looks like watching).
  await enter.click();
  await expect(c.page).toHaveURL(/\/table\/e2e-lobby-full$/);
  const status = c.page.getByTestId('viewer-status');
  await expect(status).toContainText(/대기열 1번째|#1 on the waitlist/);
  await expect(status).toContainText(/관전할 수 없는 테이블|Spectating is off/);
  await expect(status).not.toContainText(/관전 중입니다|You are watching/);
  await expect(c.page.getByRole('button', { name: /대기열 취소|Leave waitlist/ })).toBeVisible();
  await c.page.screenshot({ path: 'test-results/lobby-waitlisted-desktop.png' });

  // The lobby counts C on the waitlist.
  await c.page.goto('/');
  await expect(card).toContainText(/대기 1|Waitlist 1/, { timeout: 15_000 });
});

test('lobby: favourites stay after a reload and come first; recent lists the tables opened, newest first', async ({ browser }) => {
  const { page } = await signUp(browser);
  await page.getByTestId('lobby-filter-recent').click();
  await expect(page.getByText(/최근에 들어간 테이블이 없습니다|No recently visited tables/)).toBeVisible();
  await page.getByTestId('lobby-filter-all').click();

  const fav = page.getByTestId('lobby-table').filter({ hasText: 'E2E Lobby Fav' });
  const star = fav.getByTestId('fav-toggle');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lobby-table').first()).toHaveAttribute('data-table', 'e2e-lobby-fav');

  await page.reload();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lobby-table').first()).toHaveAttribute('data-table', 'e2e-lobby-fav');
  await page.getByTestId('lobby-filter-fav').click();
  await expect(page.getByTestId('lobby-filter-fav')).toContainText('1');
  await expect(page.getByTestId('lobby-table')).toHaveCount(1);

  // Opening tables (watching is enough) records them.
  for (const id of ['e2e-hu', 'e2e-lobby-fav']) {
    await page.goto(`/table/${id}`);
    await expect(page.getByTestId('viewer-status')).toBeVisible();
  }
  await page.goto('/');
  await page.getByTestId('lobby-filter-recent').click();
  const recent = page.getByTestId('lobby-table');
  await expect(recent).toHaveCount(2);
  await expect(recent.nth(0)).toHaveAttribute('data-table', 'e2e-lobby-fav');
  await expect(recent.nth(1)).toHaveAttribute('data-table', 'e2e-hu');

  // Unstarring it from the favourites view leaves an explained empty list.
  await page.getByTestId('lobby-filter-fav').click();
  await star.click();
  await expect(page.getByTestId('lobby-table')).toHaveCount(0);
  await expect(page.getByText(/즐겨찾는 테이블이 없습니다|No favorite tables yet/)).toBeVisible();
  await page.getByTestId('lobby-reset').click();
  await expect(page.getByTestId('lobby-filter-all')).toHaveAttribute('aria-selected', 'true');
});

test('lobby: the size and blind filters narrow the list as well as quick play', async ({ browser }) => {
  const { page } = await signUp(browser);
  const panel = page.getByTestId('quick-play');
  await panel.getByTestId('quick-seats-6').click();
  await panel.getByTestId('quick-blind').selectOption('6');
  const cards = page.getByTestId('lobby-table');
  await expect(cards.filter({ hasText: 'E2E Lobby Fav' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'E2E Lobby Hidden' })).toHaveCount(0);
  await expect(cards.filter({ hasText: 'E2E Six' })).toHaveCount(0);
  for (const text of await cards.allTextContents()) expect(text).toMatch(/\/6\D.*3 \/ 6/);
  await expect(page.getByTestId('lobby-filtered')).toContainText(/6인 · 3\/6|6 seats · 3\/6/);
  // A table and back (its leave button, the logo, the browser) finds the lobby as it was: the tab, the search, both filters.
  await page.getByTestId('lobby-filter-open').click();
  await page.getByRole('textbox', { name: /테이블 검색|Search tables/ }).fill('Fav');
  await expect(page).toHaveURL('/?seats=6&bb=6&tab=open&q=Fav');
  const kept = async () => {
    await expect(page).toHaveURL('/?seats=6&bb=6&tab=open&q=Fav');
    await expect(page.getByTestId('lobby-filter-open')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: /테이블 검색|Search tables/ })).toHaveValue('Fav');
    await expect(panel.getByTestId('quick-seats-6')).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByTestId('quick-blind')).toHaveValue('6');
    await expect(cards).toHaveCount(1);
  };
  for (const back of ['leave', 'logo', 'browser'] as const) {
    await cards.getByTestId('lobby-watch').click();
    await expect(page).toHaveURL('/table/e2e-lobby-fav');
    await expect(page.getByTestId('viewer-status')).toBeVisible();
    if (back === 'leave') await page.getByTestId('leave').click();
    else if (back === 'logo') await page.getByRole('link', { name: /^(로비|Lobby)$/ }).first().click();
    else await page.goBack();
    await kept();
  }
  await page.getByTestId('lobby-filter-all').click();
  await page.getByRole('textbox', { name: /테이블 검색|Search tables/ }).fill('');
  await expect(page).toHaveURL('/?seats=6&bb=6');
  // At the narrowest desktop width the panel's controls still sit inside it, next to the description.
  await page.setViewportSize({ width: 1024, height: 800 });
  const outer = (await panel.boundingBox())!;
  const go = (await panel.getByTestId('quick-go').boundingBox())!;
  expect(go.x + go.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/lobby-filtered-1024.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('lobby-filtered').getByRole('button').click();
  await expect(panel.getByTestId('quick-seats-0')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('lobby-filtered')).toHaveCount(0);
  expect(await cards.count()).toBeGreaterThan(1);
});

test('lobby: on a slow device a tab tapped and a search typed right after both stay, key by key, and a key in the middle stays there', async ({ browser }) => {
  const { page } = await signUp(browser);
  const box = page.getByRole('textbox', { name: /테이블 검색|Search tables/ });
  // As a slow phone: the next key comes before the page has drawn the last one (CI lost the tab this way).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.getByTestId('lobby-filter-open').click();
  await box.pressSequentially('Fav');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await expect(page).toHaveURL('/?tab=open&q=Fav');
  await expect(box).toHaveValue('Fav');
  await expect(page.getByTestId('lobby-filter-open')).toHaveAttribute('aria-selected', 'true');
  await box.press('Home');
  await box.press('ArrowRight');
  await box.press('x');
  await expect(box).toHaveValue('Fxav');
  expect(await box.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(2);
  await expect(page).toHaveURL('/?tab=open&q=Fxav');
});

test('lobby: polls only while visible, never overlaps, and refreshes on coming back', async ({ browser }) => {
  const { page: first } = await signUp(browser);
  const page = await first.context().newPage();
  const gets = lobbyGets(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('lobby-table').first()).toBeVisible();
  // Stop the page clock from moving by itself, so only the test advances it.
  await page.clock.pauseAt(Date.now() + 2_000);
  await page.waitForTimeout(300);
  let base = gets.n;
  expect(base).toBeGreaterThanOrEqual(1);

  // Visible: one request per 5 seconds.
  for (let i = 1; i <= 2; i++) {
    const answered = page.waitForResponse(isList);
    await page.clock.runFor(5_000);
    await answered;
    expect(gets.n).toBe(base + i);
  }
  base = gets.n;

  // Hidden: nothing for half a minute.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(30_000);
  await page.waitForTimeout(500);
  expect(gets.n).toBe(base);

  // Back: one request at once.
  const answered = page.waitForResponse(isList);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await answered;
  await page.waitForTimeout(300);
  expect(gets.n).toBe(base + 1);
});

test('lobby: slows to every 30 seconds after a minute without input, and the next input refreshes at once', async ({ browser }) => {
  const { page: first } = await signUp(browser);
  const page = await first.context().newPage();
  const gets = lobbyGets(page);
  const done = { n: 0 };
  page.on('response', (r) => {
    if (isList(r)) done.n += 1;
  });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('lobby-table').first()).toBeVisible();
  await page.clock.pauseAt(Date.now() + 2_000);
  await expect.poll(() => done.n).toBe(gets.n);
  // Five seconds at a time, letting each request finish (a poll that comes due while one is out is skipped).
  const step = async () => {
    const before = gets.n;
    await page.clock.runFor(5_000);
    await page.waitForTimeout(150);
    await expect.poll(() => done.n).toBe(gets.n);
    return gets.n - before;
  };
  const made: number[] = [];
  for (let i = 1; i <= 25; i++) if (await step()) made.push(i * 5);
  // Every 5 s for the first minute, then every 30 s: at 85 s and 115 s.
  expect(made).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 85, 115]);

  // Someone moves the mouse: the list is refreshed at once, and every 5 s again from then on.
  const answered = page.waitForResponse(isList);
  const before = gets.n;
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 240);
  await answered;
  expect(gets.n).toBe(before + 1);
  let next = 0;
  for (let i = 0; i < 4; i++) next += await step();
  expect(next).toBeGreaterThanOrEqual(3);
});
