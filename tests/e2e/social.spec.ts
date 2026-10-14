import { expect, test, type Page } from '@playwright/test';
import { signUp } from './helpers';

/** Same-origin JSON call with the page's session. */
async function call<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}

test('friends: request by nickname, accept, 1:1 chat with read receipt, unfriend', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);

  // A sends a request by nickname from the friends page.
  await a.page.getByTestId('nav-friends').click();
  await a.page.getByTestId('friend-nickname').fill(b.nickname);
  await a.page.getByTestId('friend-add').click();
  await expect(a.page.getByRole('status')).toContainText(b.nickname);
  await expect(a.page.getByTestId('outgoing-requests')).toContainText(b.nickname);

  // B sees the pending request on the nav badge, then accepts it.
  await b.page.reload();
  await expect(b.page.getByTestId('friends-badge')).toHaveText('1');
  await b.page.getByTestId('nav-friends').click();
  await expect(b.page.getByTestId('incoming-requests')).toContainText(a.nickname);
  await b.page.getByTestId('friend-accept').click();
  await expect(b.page.getByTestId('friend-list')).toContainText(a.nickname);
  await expect(b.page.getByTestId('friends-badge')).toHaveCount(0);

  // B opens the conversation and writes first.
  await b.page.getByTestId('friend-row').filter({ hasText: a.nickname }).click();
  await expect(b.page.getByTestId('dm-title')).toHaveText(a.nickname);
  await b.page.getByTestId('dm-input').fill('안녕하세요! 한 판 할래요?');
  await b.page.getByTestId('dm-send').click();
  await expect(b.page.getByTestId('dm-mine')).toHaveText(/한 판 할래요/);
  await expect(b.page.getByTestId('dm-input')).toHaveValue('');

  // A: the friend row shows the preview and an unread count; opening it marks it read.
  await a.page.reload();
  const row = a.page.getByTestId('friend-row').filter({ hasText: b.nickname });
  await expect(row).toContainText('한 판 할래요');
  await expect(row.getByTestId('friend-unread')).toHaveText('1');
  await expect(a.page.getByTestId('friends-badge')).toHaveText('1');
  await row.click();
  await expect(a.page.getByTestId('dm-theirs')).toHaveText(/한 판 할래요/);
  await expect(a.page.getByTestId('friends-badge')).toHaveCount(0);

  // B's open conversation picks up the read receipt and A's reply by polling.
  await expect(b.page.getByTestId('dm-read')).toBeVisible({ timeout: 15_000 });
  await a.page.getByTestId('dm-input').fill('좋아요 :)');
  await a.page.getByTestId('dm-input').press('Enter');
  await expect(b.page.getByTestId('dm-theirs')).toHaveText(/좋아요 :\)/, { timeout: 15_000 });
  await b.page.screenshot({ path: 'test-results/dm-conversation.png' });

  // A writes while B's page is between polls, then B sends a newer message: A's is still picked up afterwards.
  const polls = /\/api\/dm\/[^/?]+\?afterSeq=/;
  await b.page.route(polls, (r) => r.abort());
  await a.page.getByTestId('dm-input').fill('먼저 보낸 메시지');
  await a.page.getByTestId('dm-input').press('Enter');
  await expect(a.page.getByTestId('dm-mine').last()).toHaveText(/먼저 보낸/);
  await b.page.getByTestId('dm-input').fill('나중에 보낸 메시지');
  await b.page.getByTestId('dm-send').click();
  await expect(b.page.getByTestId('dm-mine').last()).toHaveText(/나중에 보낸/);
  await b.page.unroute(polls);
  await expect(b.page.getByTestId('dm-theirs').filter({ hasText: '먼저 보낸' })).toBeVisible({ timeout: 15_000 });

  // A unfriends: B can still read the history but can no longer send.
  a.page.once('dialog', (d) => void d.accept());
  await a.page.getByTestId('unfriend').click();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(a.page.getByTestId('friend-list')).toHaveCount(0);
  await expect(b.page.getByTestId('dm-not-friends')).toBeVisible({ timeout: 15_000 });
  await expect(b.page.getByTestId('dm-input')).toHaveCount(0);
  await expect(b.page.getByTestId('dm-mine').first()).toHaveText(/한 판 할래요/);
});

test('reports: a post, a comment and a player at the table; the author card offers a friend request', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const { id: postId } = await call<{ id: string }>(b.page, '/api/board/posts', { title: 'E2E 신고 대상 글', body: '광고성 본문입니다.' });
  await call(b.page, `/api/board/posts/${postId}/comments`, { body: '광고 댓글입니다.' });

  // The author's name opens their card with a friend request.
  await a.page.goto(`/board/${postId}`);
  await a.page.getByTestId('author-name').first().click();
  await expect(a.page.getByTestId('player-card')).toContainText(b.nickname);
  await a.page.getByTestId('player-befriend').click();
  await expect(a.page.getByTestId('player-card')).toContainText(b.nickname);
  await expect(a.page.getByRole('dialog').getByRole('button', { name: /요청 보냄|Request sent/ })).toBeDisabled();
  await a.page.keyboard.press('Escape');

  // Report the post: a reason is required; the second report on the same post is refused.
  await a.page.getByTestId('report-post').click();
  await expect(a.page.getByTestId('report-submit')).toBeDisabled();
  await expect(a.page.getByRole('radio', { name: /부정 플레이|Cheating/ })).toHaveCount(0);
  await a.page.getByRole('radio', { name: /스팸|Spam/ }).check();
  await a.page.getByRole('textbox', { name: /상세 내용|Details/ }).fill('같은 광고를 반복합니다.');
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
  await a.page.getByTestId('report-done').getByRole('button').click();
  await a.page.getByTestId('report-post').click();
  await a.page.getByRole('radio', { name: /스팸|Spam/ }).check();
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByRole('dialog').getByRole('alert')).toContainText(/이미 신고|already reported/);
  await a.page.keyboard.press('Escape');

  // Report the comment.
  await a.page.getByTestId('comment').getByTestId('report-comment').click();
  await expect(a.page.getByRole('dialog')).toContainText('광고 댓글입니다.');
  await a.page.getByRole('radio', { name: /욕설|Abuse/ }).check();
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
  await a.page.keyboard.press('Escape');
  // My own content has no report button.
  await b.page.goto(`/board/${postId}`);
  await expect(b.page.getByTestId('post-title')).toBeVisible();
  await expect(b.page.getByTestId('report-post')).toHaveCount(0);
  await expect(b.page.getByTestId('report-comment')).toHaveCount(0);

  // At the table: B sits and chats; A watches, taps B's seat and reports for cheating.
  await b.page.goto('/table/e2e-social?sit=1');
  await b.page.getByTestId('buyin-confirm').click();
  await expect(b.page.locator('[data-testid^=seat-]').filter({ hasText: b.nickname })).toBeVisible();
  const chat = b.page.getByRole('textbox', { name: /채팅|Chat/ });
  await chat.fill('수상한 채팅');
  await chat.press('Enter');
  await a.page.goto('/table/e2e-social');
  await expect(a.page.getByText('수상한 채팅')).toBeVisible();
  await expect(b.page.locator('[data-testid^=seat-pick-]')).toHaveCount(0); // never my own seat
  await a.page.locator('[data-testid^=seat-pick-]').first().click();
  await expect(a.page.getByTestId('player-card')).toContainText(b.nickname);
  await a.page.getByTestId('player-report').click();
  await expect(a.page.getByTestId('report-form')).toContainText(b.nickname);
  await a.page.getByRole('radio', { name: /부정 플레이|Cheating/ }).check();
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
  await a.page.keyboard.press('Escape');
  // The chat author's name opens the same card.
  await a.page.getByTestId('chat-author').filter({ hasText: b.nickname }).first().click();
  await expect(a.page.getByTestId('player-card')).toContainText(b.nickname);
  await a.page.keyboard.press('Escape');

  await b.page.getByTestId('leave').click();
  await expect(b.page.locator('[data-testid^=seat-]').filter({ hasText: b.nickname })).toHaveCount(0);
});

test('1:1 chat sync: no polling while the tab is hidden; coming back or reconnecting catches up at once', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const idOf = async (p: Page) => (await call<{ id: string }>(p, '/api/auth/me')).id;
  const [aId, bId] = [await idOf(a.page), await idOf(b.page)];
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});

  // B's clock moves only when the test moves it, so every request below is one the page chose to make.
  await b.page.clock.install();
  await b.page.goto(`/friends/${aId}`);
  await expect(b.page.getByTestId('dm-title')).toHaveText(a.nickname);
  await b.page.clock.pauseAt(Date.now() + 1_000);
  const dmPolls: string[] = [];
  const badgePolls: string[] = [];
  b.page.on('request', (r) => {
    const u = new URL(r.url());
    if (/^\/api\/dm\/[^/]+$/.test(u.pathname) && u.searchParams.has('afterSeq')) dmPolls.push(u.search);
    if (u.pathname === '/api/messages/unread-count') badgePolls.push(u.pathname);
  });
  const setVisible = (on: boolean) =>
    b.page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, on);

  // Visible: the conversation polls on its interval.
  await b.page.clock.runFor(4_500);
  await expect.poll(() => dmPolls.length).toBeGreaterThan(0);

  // Hidden: two minutes pass without a request, even with a message waiting.
  await setVisible(false);
  await b.page.waitForTimeout(300);
  dmPolls.length = 0;
  badgePolls.length = 0;
  await call(a.page, `/api/dm/${bId}`, { text: '숨긴 동안 온 메시지' });
  await b.page.clock.runFor(120_000);
  await b.page.waitForTimeout(500);
  expect(dmPolls).toEqual([]);
  expect(badgePolls).toEqual([]);
  await expect(b.page.getByTestId('dm-theirs')).toHaveCount(0);

  // Visible again: one request at once, from where it left off, without waiting for the next tick.
  await setVisible(true);
  await expect(b.page.getByTestId('dm-theirs')).toHaveText(/숨긴 동안/);
  expect(dmPolls).toEqual(['?afterSeq=0']);

  // Offline: a poll fails and the page keeps its place. Back online, it asks again at once and nothing repeats.
  await b.page.context().setOffline(true);
  await b.page.clock.runFor(4_500);
  await call(a.page, `/api/dm/${bId}`, { text: '끊긴 동안 온 메시지' });
  await b.page.context().setOffline(false);
  await expect(b.page.getByTestId('dm-theirs').filter({ hasText: '끊긴 동안' })).toBeVisible();
  await expect(b.page.getByTestId('dm-theirs')).toHaveCount(2);
  expect(dmPolls.at(-1)).toBe('?afterSeq=1');
});
