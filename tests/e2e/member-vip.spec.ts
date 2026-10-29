import { expect, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test } from './helpers';
import { promoteSql } from '../support/grants';

/** Same-origin JSON call with the page's session. */
async function call<T>(page: Page, path: string, body?: unknown, method = 'POST'): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(p, b === undefined ? {} : { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, body: (await r.json()) as T };
    },
    [path, body, method] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).body.id;

/** Runs `go` and returns once the page's realtime socket said hello (an event sent before that never reaches it). */
async function live(page: Page, go: () => Promise<unknown>) {
  const up = new Promise<void>((resolve) =>
    page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/realtime')) ws.on('framereceived', (f) => String(f.payload).includes('"hello"') && resolve());
    }),
  );
  await go();
  await up;
}

/** The member's VIP as an administrator sets it from the console (password confirmed first, as the console asks). */
async function setVip(admin: Page, id: string, body: { enabled: boolean; color?: string }) {
  expect((await call(admin, '/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
  const { version } = (await call<{ version: number }>(admin, `/api/admin/users/${id}/vip`)).body;
  const r = await call(admin, `/api/admin/users/${id}/vip`, { ...body, reason: 'E2E 공개 VIP 확인', expectedVersion: version }, 'PATCH');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

test("public VIP: a friend's list and a post's page that are open show another member's new VIP color without a reload, and read nothing again for it", async ({ browser }) => {
  test.setTimeout(120_000);
  const viewer = await signUp(browser);
  const vip = await signUp(browser);
  const [viewerId, vipId] = [await idOf(viewer.page), await idOf(vip.page)];
  await call(viewer.page, '/api/friends/requests', { userId: vipId });
  await call(vip.page, `/api/friends/${viewerId}/accept`, {});
  const post = (await call<{ id: string }>(vip.page, '/api/board/posts', { title: 'E2E VIP 작성자', body: '이름 색이 바뀌는지 봅니다' })).body;

  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const admin = await adminLogin(browser, op.email);
  expect(admin.url().startsWith(ADMIN)).toBe(true);

  // The viewer's friends list and the post, open side by side before the change; each counts the reads it makes.
  const list = viewer.page;
  const reads = { friends: 0, post: 0 };
  list.on('request', (r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/friends' && reads.friends++);
  await live(list, () => list.goto('/friends'));
  const row = list.getByTestId('friend-row').filter({ hasText: vip.nickname });
  await expect(row.locator('[data-testid=member-name] [data-vip]')).toHaveCount(0);
  const page = await viewer.page.context().newPage();
  page.on('request', (r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/board/posts/${post.id}` && reads.post++);
  await live(page, () => page.goto(`/board/${post.id}`));
  const author = page.getByTestId('author-name');
  await expect(author).toContainText(vip.nickname);
  await expect(author.locator('[data-vip]')).toHaveCount(0);
  await list.waitForTimeout(500);
  const before = { ...reads };

  // Made VIP: the color arrives on both, from the event alone (the post page never reads again; the list's next read
  // is a minute away).
  await setVip(admin, vipId, { enabled: true, color: 'sapphire' });
  await expect(row.locator('[data-vip="sapphire"]')).toBeVisible({ timeout: 10_000 });
  await expect(author.locator('[data-vip="sapphire"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('vip-badge')).toBeVisible();
  await page.screenshot({ path: 'test-results/member-vip-post.png' });

  // Ended: the color goes again, still without a read.
  await setVip(admin, vipId, { enabled: false });
  await expect(row.locator('[data-vip]')).toHaveCount(0, { timeout: 10_000 });
  await expect(author.locator('[data-vip]')).toHaveCount(0, { timeout: 10_000 });
  expect(reads).toEqual(before);

  // A reload reads the same as the event said.
  await page.reload();
  await expect(page.getByTestId('author-name')).toContainText(vip.nickname);
  await expect(page.getByTestId('author-name').locator('[data-vip]')).toHaveCount(0);
});
