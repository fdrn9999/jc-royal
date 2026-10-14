import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test } from './helpers';

/** Same-origin JSON call with the page's session. */
async function call<T = any>(page: Page, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(p, { method: m, headers: b === undefined ? {} : { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body, method] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).id;

test('1:1 chat: report one message, block with a confirmation, the other side sees only that messaging is off; unblock in settings', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const [aId, bId] = [await idOf(a.page), await idOf(b.page)];
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  await call(b.page, `/api/dm/${aId}`, { text: '이 링크 눌러서 칩 받아가세요' });
  await call(b.page, `/api/dm/${aId}`, { text: '빨리요' });

  // Selecting one of their messages offers a report for exactly that message.
  await a.page.goto(`/friends/${bId}`);
  await expect(a.page.getByTestId('dm-report')).toHaveCount(0);
  const bubble = a.page.getByTestId('dm-theirs').getByRole('button', { name: /칩 받아가세요/ });
  await bubble.click();
  await expect(bubble).toHaveAttribute('aria-pressed', 'true');
  await expect(a.page.getByTestId('dm-report')).toHaveCount(1);
  await a.page.getByTestId('dm-report').click();
  await expect(a.page.getByTestId('report-form')).toContainText('칩 받아가세요');
  await expect(a.page.getByTestId('report-form')).not.toContainText('빨리요');
  await a.page.getByRole('radio', { name: /스팸|Spam/ }).check();
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
  await a.page.keyboard.press('Escape');

  // Blocking asks first and says what happens.
  await a.page.getByTestId('dm-block').click();
  await expect(a.page.getByTestId('block-confirm')).toContainText(/알리지 않습니다|not told/);
  await a.page.screenshot({ path: 'test-results/block-confirm.png' });
  await a.page.getByTestId('block-confirm-yes').click();
  await expect(a.page.getByTestId('dm-blocked')).toBeVisible();
  await expect(a.page.getByTestId('dm-input')).toHaveCount(0);
  await expect(a.page.getByTestId('dm-theirs')).toHaveCount(2); // history stays

  // B is no longer a friend and cannot write, with no mention of a block.
  await b.page.goto(`/friends/${aId}`);
  await expect(b.page.getByTestId('dm-not-friends')).toBeVisible();
  await expect(b.page.getByTestId('dm-blocked')).toHaveCount(0);
  await expect(b.page.getByTestId('dm-input')).toHaveCount(0);
  expect((await call(b.page, '/api/friends/requests', { userId: aId })).error.code).toBe('request_unavailable');

  // Settings list the block and undo it; the friendship is not restored.
  await a.page.getByTestId('nav-friends').click();
  await a.page.getByTestId('friends-settings').click();
  await expect(a.page.getByTestId('blocked-row')).toContainText(b.nickname);
  await a.page.screenshot({ path: 'test-results/friend-settings.png' });
  await a.page.getByTestId('blocked-unblock').click();
  await expect(a.page.getByTestId('blocked-row')).toHaveCount(0);
  expect((await call(a.page, `/api/friends/${bId}/relation`)).relation).toBe('none');

  // Turning off friend requests is saved on the server.
  const toggle = a.page.getByTestId('settings-friend-requests');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(a.page.getByRole('status')).toHaveText(/저장했습니다|Saved/);
  await a.page.reload();
  await expect(a.page.getByTestId('settings-friend-requests')).not.toBeChecked();
  expect((await call(b.page, '/api/friends/requests', { userId: aId })).error.code).toBe('request_unavailable');
});

test('table: mute hides one player’s chat for me only; after the hand, report them from the hand record', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  await b.page.goto('/table/e2e-social?sit=1');
  await b.page.getByTestId('buyin-confirm').click();
  await a.page.goto('/table/e2e-social?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await expect(a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname })).toBeVisible();

  const chat = b.page.getByRole('textbox', { name: /채팅|Chat/ });
  await chat.fill('시끄러운 채팅');
  await chat.press('Enter');
  const line = a.page.getByTestId('chat-line').filter({ hasText: '시끄러운 채팅' });
  await expect(line).toBeVisible();

  // Mute from their card: their lines disappear for A, while B still sees them.
  await a.page.getByTestId('chat-author').filter({ hasText: b.nickname }).first().click();
  await expect(a.page.getByTestId('player-mute')).toHaveAttribute('aria-pressed', 'false');
  await a.page.getByTestId('player-mute').click();
  await expect(a.page.getByTestId('player-mute')).toHaveAttribute('aria-pressed', 'true');
  await a.page.keyboard.press('Escape');
  await expect(line).toHaveCount(0);
  await expect(b.page.getByTestId('chat-line').filter({ hasText: '시끄러운 채팅' })).toBeVisible();
  // Survives a reload (device-local), and can be undone from their seat.
  await a.page.reload();
  await expect(a.page.locator('[data-testid^=seat-]').filter({ hasText: b.nickname })).toBeVisible();
  await expect(a.page.getByTestId('chat-line').filter({ hasText: '시끄러운 채팅' })).toHaveCount(0);
  await a.page.locator('[data-testid^=seat-pick-]').first().click();
  await expect(a.page.getByTestId('player-card')).toContainText(b.nickname);
  await a.page.getByTestId('player-mute').click();
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByTestId('chat-line').filter({ hasText: '시끄러운 채팅' })).toBeVisible();

  // Play into a hand, then both stand up.
  await expect(async () => {
    if (!(await checkOrCall(a.page))) await checkOrCall(b.page);
    expect((await call<unknown[]>(a.page, '/api/me/hands')).length).toBeGreaterThan(0);
  }).toPass({ timeout: 60_000 });
  for (const p of [b, a]) {
    await expect(async () => {
      await checkOrCall(a.page);
      await checkOrCall(b.page);
      await p.page.getByTestId('leave').click();
      await expect(p.page.locator('[data-testid^=seat-]').filter({ hasText: p.nickname })).toHaveCount(0, { timeout: 3000 });
    }).toPass({ timeout: 45_000 });
  }

  // From the hand record, after leaving: report B (never myself).
  const [hand] = await call<{ id: string }[]>(a.page, '/api/me/hands');
  await a.page.goto(`/me/hands/${hand!.id}`);
  await expect(a.page.getByTestId('hand-report')).toHaveCount(1);
  await a.page.getByTestId('hand-report').click();
  await expect(a.page.getByTestId('report-form')).toContainText(b.nickname);
  await a.page.getByRole('radio', { name: /욕설|Abuse/ }).check();
  await a.page.getByTestId('report-submit').click();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
});
