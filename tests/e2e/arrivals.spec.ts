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

/** The next read of the unread counters. */
const counted = (page: Page) => page.waitForResponse((r) => r.url().includes('/api/messages/unread-count') && r.ok());

/** Opens `path` (the lobby) and returns once its realtime socket said hello and the unread counters were first read (where they start). */
async function opened(page: Page, path = '/') {
  const up = new Promise<void>((resolve) =>
    page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/realtime')) ws.on('framereceived', (f) => String(f.payload).includes('"hello"') && resolve());
    }),
  );
  const read = counted(page);
  await page.goto(path);
  await Promise.all([up, read]);
}

test('a friend request and a 1:1 message that arrive are announced in the corner with the way to them, never on the page that lists them, and go after a while unless held', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const aId = await idOf(a.page);
  const bId = await idOf(b.page);
  await opened(a.page);

  await call(b.page, '/api/friends/requests', { userId: aId });
  const request = a.page.getByTestId('arrival-friendRequests');
  await expect(request).toBeVisible();
  await expect(request).toContainText('새 친구 요청이 왔습니다');
  await expect(request).toContainText('받은 친구 요청 1개');
  // In the corner of the window, under nothing and over nothing of the header.
  const box = (await request.boundingBox())!;
  const header = (await a.page.locator('header').first().boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await a.page.screenshot({ path: 'test-results/arrivals-desktop.png', animations: 'disabled' });

  // Pointed at, it stays past its time; let go, it goes.
  await request.hover();
  await a.page.waitForTimeout(7_000);
  await expect(request).toBeVisible();
  await a.page.mouse.move(10, 450);
  await expect(request).toBeHidden({ timeout: 9_000 });

  await call(a.page, `/api/friends/${bId}/accept`, {});
  await call(b.page, `/api/dm/${aId}`, { text: '도착 알림 확인' });
  const dm = a.page.getByTestId('arrival-dmUnread');
  await expect(dm).toBeVisible();
  await expect(dm).toContainText('새 1:1 메시지가 왔습니다');
  await expect(dm).toContainText('읽지 않은 메시지 1개');
  // The way to it: the friends page, and the notice is gone.
  await a.page.getByTestId('arrival-dmUnread-open').click();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(dm).toHaveCount(0);

  // The friends page lists the conversations: another message counts in the badge and is not announced.
  await call(b.page, `/api/dm/${aId}`, { text: '두 번째' });
  await expect(a.page.getByTestId('friends-badge')).toHaveText('2');
  await expect(a.page.getByTestId('arrival-dmUnread')).toHaveCount(0);
});

test('an open conversation announces nothing its friend sends, but a message from another friend is announced there', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const c = await signUp(browser);
  const [aId, bId, cId] = await Promise.all([idOf(a.page), idOf(b.page), idOf(c.page)]);
  for (const [page, id] of [
    [b.page, bId],
    [c.page, cId],
  ] as const) {
    await call(page, '/api/friends/requests', { userId: aId });
    await call(a.page, `/api/friends/${id}/accept`, {});
  }
  await opened(a.page, `/friends/${bId}`);

  // The friend whose conversation is open: their message is on screen, and the counters read after it announce nothing.
  const read = counted(a.page);
  await call(b.page, `/api/dm/${aId}`, { text: '열린 대화의 메시지' });
  await expect(a.page.getByText('열린 대화의 메시지')).toBeVisible();
  await read;
  await a.page.waitForTimeout(500);
  await expect(a.page.getByTestId('arrival-dmUnread')).toHaveCount(0);

  // Another friend's is not on this screen: it is news here, with the way to the conversations.
  await call(c.page, `/api/dm/${aId}`, { text: '다른 친구의 메시지' });
  const dm = a.page.getByTestId('arrival-dmUnread');
  await expect(dm).toBeVisible();
  await expect(dm).toContainText('읽지 않은 메시지 1개');
  await expect(a.page.getByText('다른 친구의 메시지')).toHaveCount(0);
  await a.page.getByTestId('arrival-dmUnread-open').click();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(dm).toHaveCount(0);
});
