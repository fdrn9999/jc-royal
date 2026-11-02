import { expect, type Page } from '@playwright/test';
import { signUp, test } from './helpers';

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
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).id;

/**
 * Reads the welcome 쪽지 every member gets at sign-up, which the bell counts as its 쪽지 item, so the bell starts empty.
 * Notices and maintenance windows earlier tests made are from before the member joined: listed read, never counted.
 */
async function quiet(page: Page) {
  await expect(page.getByTestId('bell-badge')).toHaveText('1');
  await call(page, '/api/messages/read-all', {});
  await expect(page.getByTestId('bell-badge')).toHaveCount(0);
}

/** Opens `path` and returns once its realtime socket said hello and the unread counters were first read. */
async function opened(page: Page, path = '/') {
  const up = new Promise<void>((resolve) =>
    page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/realtime')) ws.on('framereceived', (f) => String(f.payload).includes('"hello"') && resolve());
    }),
  );
  const read = page.waitForResponse((r) => r.url().includes('/api/messages/unread-count') && r.ok());
  await page.goto(path);
  await Promise.all([up, read]);
}

test('the bell counts a friend request beside the mail icon, lists it with its state, and opening it reads it and goes to it', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const bId = await idOf(b.page);
  await opened(b.page);
  await expect(b.page.getByTestId('bell')).toBeVisible();
  // The welcome 쪽지 is on both: the mail icon's count and the bell's 쪽지 item.
  await expect(b.page.getByTestId('unread-badge')).toHaveText('1');
  await quiet(b.page);

  await call(a.page, '/api/friends/requests', { userId: bId });
  // Counted without a reload, and the mail icon (쪽지함) stays where it was.
  await expect(b.page.getByTestId('bell-badge')).toHaveText('1');
  await expect(b.page.getByTestId('inbox-link')).toBeVisible();
  await expect(b.page.getByTestId('bell')).toHaveAttribute('aria-label', '알림 (읽지 않음 1개)');

  await b.page.getByTestId('bell').click();
  const panel = b.page.getByTestId('bell-panel');
  await expect(panel).toBeVisible();
  const item = panel.getByTestId('inbox-item').first();
  await expect(item).toContainText(`${a.nickname}님이 친구 요청을 보냈습니다`);
  await expect(item).toContainText('대기 중');
  await expect(item).toHaveAttribute('data-unread', 'true');
  // Under the header, inside the window.
  const box = (await panel.boundingBox())!;
  const header = (await b.page.locator('header').first().boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await b.page.screenshot({ path: 'test-results/inbox-bell-desktop.png', animations: 'disabled' });

  // Escape closes it and gives the bell the focus back.
  await b.page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(b.page.getByTestId('bell')).toBeFocused();

  await b.page.getByTestId('bell').click();
  await panel.getByTestId('inbox-item').first().click();
  await expect(b.page).toHaveURL(/\/friends$/);
  await expect(panel).toHaveCount(0);
  await expect(b.page.getByTestId('bell-badge')).toHaveCount(0);

  // The full list: the same item, read, by kind and unread only.
  await b.page.goto('/notifications');
  await expect(b.page.getByRole('heading', { name: '알림' })).toBeVisible();
  const list = b.page.getByTestId('inbox-list');
  await expect(list.getByTestId('inbox-item').filter({ hasText: a.nickname })).not.toHaveAttribute('data-unread', 'true');
  await b.page.getByTestId('inbox-tab-service').click();
  await expect(b.page.getByTestId('inbox-tab-service')).toHaveAttribute('aria-selected', 'true');
  await b.page.getByTestId('inbox-tab-social').click();
  await expect(list.getByTestId('inbox-item').filter({ hasText: a.nickname })).toBeVisible();
  await b.page.getByTestId('inbox-unread-only').check();
  await expect(b.page.getByText('읽지 않은 알림이 없습니다.')).toBeVisible();
  await b.page.screenshot({ path: 'test-results/inbox-page-desktop.png', animations: 'disabled' });
});

test('read in one tab, the other tab\'s bell follows; "mark all read" in the panel empties the count', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const aId = await idOf(a.page);
  const bId = await idOf(b.page);
  await opened(a.page);
  await quiet(a.page);
  const other = await a.page.context().newPage();
  await opened(other);
  await expect(other.getByTestId('bell-badge')).toHaveCount(0);

  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  for (const p of [a.page, other]) await expect(p.getByTestId('bell-badge')).toHaveText('1');

  await a.page.getByTestId('bell').click();
  await expect(a.page.getByTestId('bell-panel').getByTestId('inbox-item').first()).toContainText(`${b.nickname}님이 친구 요청을 수락했습니다`);
  await a.page.getByTestId('bell-read-all').click();
  await expect(a.page.getByTestId('bell-badge')).toHaveCount(0);
  await expect(a.page.getByTestId('bell-read-all')).toBeDisabled();
  // The other tab: told by the server, not reloaded.
  await expect(other.getByTestId('bell-badge')).toHaveCount(0);
});
