import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

/** Same-origin JSON call with the page's session. */
async function call<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}

/** The header keeps the mail icon, the bell and the settings in one row; the panel is inside the screen; nothing scrolls sideways. */
async function fits(page: Page, width: number, height: number) {
  const header = (await page.locator('header').first().boundingBox())!;
  for (const id of ['inbox-link', 'bell', 'settings-open']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
    expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height);
  }
  const panel = (await page.getByTestId('bell-panel').boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  expect(panel.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(panel.y + panel.height).toBeLessThanOrEqual(height);
  // "See all" is reachable without scrolling the page.
  const all = (await page.getByTestId('bell-see-all').boundingBox())!;
  expect(all.y + all.height).toBeLessThanOrEqual(height);
  expect(await widerThanDevice(page)).toBe(false);
}

test('mobile: the bell fits 390, 320 and a phone on its side; a tap on an item opens its page', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aId = (await call<{ id: string }>(a.page, '/api/auth/me')).id;
  const read = a.page.waitForResponse((r) => r.url().includes('/api/messages/unread-count') && r.ok());
  await a.page.goto('/');
  await read;
  // The welcome 쪽지 every member gets is the bell's first item; read, the bell starts empty.
  await expect(a.page.getByTestId('bell-badge')).toHaveText('1');
  await call(a.page, '/api/messages/read-all', {});
  await expect(a.page.getByTestId('bell-badge')).toHaveCount(0);
  await call(b.page, '/api/friends/requests', { userId: aId });
  // The poll or the event: either way the count arrives.
  await expect(a.page.getByTestId('bell-badge')).toHaveText('1', { timeout: 40_000 });

  await a.page.getByTestId('bell').tap();
  await expect(a.page.getByTestId('bell-panel').getByTestId('inbox-item').first()).toContainText(b.nickname);
  await fits(a.page, 390, 844);
  await a.page.screenshot({ path: 'test-results/inbox-bell-mobile-390.png', animations: 'disabled' });
  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [667, 375],
    [844, 390],
  ] as const) {
    await a.page.setViewportSize({ width: w, height: h });
    await fits(a.page, w, h);
    await a.page.screenshot({ path: `test-results/inbox-bell-mobile-${w}x${h}.png`, animations: 'disabled' });
  }

  await a.page.setViewportSize({ width: 390, height: 844 });
  await a.page.getByTestId('bell-panel').getByTestId('inbox-item').first().tap();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(a.page.getByTestId('bell-badge')).toHaveCount(0);

  await a.page.goto('/notifications');
  await expect(a.page.getByTestId('inbox-list')).toContainText(b.nickname);
  expect(await widerThanDevice(a.page)).toBe(false);
  // The filter chips and the "unread only" checkbox never cover each other.
  const apart = async () => {
    const chips = (await a.page.getByTestId('inbox-tab-all').locator('..').boundingBox())!;
    const box = (await a.page.getByTestId('inbox-unread-only').locator('..').boundingBox())!;
    expect(box.y >= chips.y + chips.height || box.x >= chips.x + chips.width).toBe(true);
  };
  await apart();
  await a.page.screenshot({ path: 'test-results/inbox-page-mobile-390.png', animations: 'disabled' });
  await a.page.setViewportSize({ width: 320, height: 568 });
  expect(await widerThanDevice(a.page)).toBe(false);
  await apart();
  await a.page.screenshot({ path: 'test-results/inbox-page-mobile-320.png', animations: 'disabled', fullPage: true });
});
