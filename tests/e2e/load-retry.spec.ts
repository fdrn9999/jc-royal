import { expect, type Page } from '@playwright/test';
import { signUp, test } from './helpers';

/** Fails the matching GET requests until the returned function is called. */
async function failing(page: Page, url: string | RegExp) {
  const handler = (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"internal","message":"down"}}' }) : route.fallback();
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

test('a page that cannot load says so and offers a retry, instead of a spinner that never ends; a failed block list never reads as empty', async ({ browser }) => {
  const { page } = await signUp(browser);

  // Messages.
  let restore = await failing(page, '**/api/messages');
  await page.goto('/messages');
  const failed = page.getByTestId('load-failed');
  await expect(failed).toContainText('불러오지 못했습니다');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await restore();
  await failed.getByTestId('load-failed-retry').click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByTestId('message').first().or(page.getByText(/쪽지가 없습니다|No messages/))).toBeVisible();

  // The board list.
  restore = await failing(page, /\/api\/board\/posts\?/);
  await page.goto('/board');
  await expect(failed).toBeVisible();
  await restore();
  await failed.getByTestId('load-failed-retry').click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByTestId('write-post')).toBeVisible();

  // A post that is gone is "not found", not a retry.
  await page.goto('/board/no-such-post');
  await expect(page.getByText(/찾을 수 없|not found/i)).toBeVisible();
  await expect(failed).toHaveCount(0);

  // Friend settings: the block list that failed is not "you have blocked nobody".
  restore = await failing(page, '**/api/blocks');
  await page.goto('/friends/settings');
  const blocks = page.getByTestId('blocks-failed');
  await expect(blocks).toBeVisible();
  await expect(page.getByText('차단한 플레이어가 없습니다.')).toHaveCount(0);
  await expect(page.getByTestId('settings-friend-requests')).toBeVisible();
  await restore();
  await blocks.getByTestId('blocks-failed-retry').click();
  await expect(page.getByText('차단한 플레이어가 없습니다.')).toBeVisible();

  // A hand that could not load offers a retry; one that is not there is not found.
  await page.goto('/me/hands/no-such-hand');
  await expect(page.getByText(/찾을 수 없|not found/i)).toBeVisible();
});
