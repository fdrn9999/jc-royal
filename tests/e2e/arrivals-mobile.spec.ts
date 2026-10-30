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

/** The notice sits between the header and the bottom tabs, inside the screen's width, and the page does not scroll sideways. */
async function fits(page: Page, width: number) {
  const box = (await page.getByTestId('arrival-friendRequests').boundingBox())!;
  const header = (await page.locator('header').first().boundingBox())!;
  const tabs = (await page.getByTestId('nav-friends-mobile').locator('..').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(box.y + box.height).toBeLessThanOrEqual(tabs.y);
  expect(await widerThanDevice(page)).toBe(false);
}

test('mobile: an arriving friend request is announced above the bottom tabs, fits 390 and 320 wide, and a tap opens the friends page', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aId = (await call<{ id: string }>(a.page, '/api/auth/me')).id;
  const up = new Promise<void>((resolve) =>
    a.page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/realtime')) ws.on('framereceived', (f) => String(f.payload).includes('"hello"') && resolve());
    }),
  );
  const read = a.page.waitForResponse((r) => r.url().includes('/api/messages/unread-count') && r.ok());
  await a.page.goto('/');
  await Promise.all([up, read]);

  await call(b.page, '/api/friends/requests', { userId: aId });
  const request = a.page.getByTestId('arrival-friendRequests');
  await expect(request).toBeVisible();
  await expect(request).toContainText('받은 친구 요청 1개');
  await fits(a.page, 390);
  await a.page.screenshot({ path: 'test-results/arrivals-mobile.png', animations: 'disabled' });
  await a.page.setViewportSize({ width: 320, height: 568 });
  await fits(a.page, 320);
  await a.page.screenshot({ path: 'test-results/arrivals-mobile-320.png', animations: 'disabled' });

  await a.page.getByTestId('arrival-friendRequests-open').tap();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(request).toHaveCount(0);
  await expect(a.page.getByTestId('incoming-requests')).toContainText(b.nickname);
});
