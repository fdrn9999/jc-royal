import { expect, type Page } from '@playwright/test';
import { playOneHand, signUp, sitWith, test, widerThanDevice } from './helpers';

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

/** Nothing scrolls sideways and the card's panels stay inside the screen. */
async function fits(page: Page, width: number) {
  expect(await widerThanDevice(page)).toBe(false);
  for (const id of ['card-achievements', 'card-stats']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
  }
}

test('profile card, friend table alert and leaderboard: what a member chose to show, on a phone and a desktop', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aId = (await call<{ id: string }>(a.page, '/api/auth/me')).id;
  const bId = (await call<{ id: string }>(b.page, '/api/auth/me')).id;
  await call(b.page, '/api/friends/requests', { userId: aId });
  await call(a.page, `/api/friends/${bId}/accept`, {});

  // Stats start hidden from others; A turns them on in the friends settings.
  await b.page.goto(`/players/${aId}`);
  await expect(b.page.getByTestId('player-card')).toContainText(a.nickname);
  await expect(b.page.getByTestId('card-stats')).toHaveCount(0);
  await expect(b.page.getByTestId('card-only-me')).toHaveCount(0);
  await a.page.goto('/friends/settings');
  await expect(a.page.getByTestId('settings-show-stats')).not.toBeChecked();
  await expect(a.page.getByTestId('settings-show-achievements')).toBeChecked();
  await expect(a.page.getByTestId('settings-share-table')).toBeChecked();
  await expect(a.page.getByTestId('settings-show-ranking')).toBeChecked();
  const saved = a.page.waitForResponse((r) => r.url().endsWith('/api/friends/settings') && r.request().method() === 'PATCH' && r.ok());
  // The switch follows the server (as the other settings do): it turns on when the save comes back.
  await a.page.getByTestId('settings-show-stats').click();
  await saved;
  await expect(a.page.getByTestId('settings-show-stats')).toBeChecked();
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: 'test-results/players-settings-390.png', animations: 'disabled', fullPage: true });

  // A sits at a public table: B's bell gets the friend's table, and the item opens it.
  await b.page.goto('/');
  // The welcome 쪽지 and A's acceptance are read first, so the friend's table is the only unread item.
  await call(b.page, '/api/notifications/read', { all: true });
  await expect(b.page.getByTestId('bell-badge')).toHaveCount(0);
  await sitWith(a.page, 'e2e-card', 1000);
  await expect(b.page.getByTestId('bell-badge')).toHaveText('1', { timeout: 40_000 });
  await b.page.getByTestId('bell').click();
  const item = b.page.getByTestId('bell-panel').getByTestId('inbox-item').first();
  await expect(item).toContainText(a.nickname);
  await expect(item).toContainText('E2E Card');
  await b.page.screenshot({ path: 'test-results/players-friend-table-bell.png', animations: 'disabled' });
  await item.click();
  await expect(b.page).toHaveURL(/\/table\/e2e-card$/);

  // One hand together: both have played their first hand.
  await sitWith(b.page, 'e2e-card', 1000);
  await playOneHand(a.page, b.page);

  await b.page.goto(`/players/${aId}`);
  await expect(b.page.locator('[data-testid="card-achievement"][data-code="first_hand"]')).toHaveAttribute('data-earned', '', { timeout: 15_000 });
  await expect(b.page.getByTestId('card-stats')).toContainText('1');
  await b.page.screenshot({ path: 'test-results/players-card-desktop.png', animations: 'disabled', fullPage: true });

  // A's own card from the profile page, on phones of every size and one on its side.
  await a.page.goto('/me');
  await a.page.getByTestId('me-card').click();
  await expect(a.page).toHaveURL(new RegExp(`/players/${aId}$`));
  await expect(a.page.getByTestId('card-privacy')).toBeVisible();
  await expect(a.page.locator('[data-testid="card-achievement"][data-earned]')).not.toHaveCount(0);
  await fits(a.page, 390);
  await a.page.screenshot({ path: 'test-results/players-card-390.png', animations: 'disabled', fullPage: true });
  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [844, 390],
  ] as const) {
    await a.page.setViewportSize({ width: w, height: h });
    await fits(a.page, w);
    await a.page.screenshot({ path: `test-results/players-card-${w}x${h}.png`, animations: 'disabled', fullPage: true });
  }

  // The leaderboard: from the tournaments page, this month first, earlier months with the arrow.
  await a.page.setViewportSize({ width: 390, height: 844 });
  await a.page.goto('/tournaments');
  await a.page.getByTestId('tn-leaderboard').click();
  await expect(a.page).toHaveURL(/\/leaderboard$/);
  const season = a.page.getByTestId('board-season');
  await expect(season).toBeVisible();
  const now = await season.textContent();
  await a.page.getByTestId('board-prev').click();
  await expect(season).not.toHaveText(now!);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.setViewportSize({ width: 320, height: 568 });
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: 'test-results/players-leaderboard-320.png', animations: 'disabled', fullPage: true });
  await b.page.setViewportSize({ width: 1920, height: 1080 });
  await b.page.goto('/leaderboard');
  await expect(b.page.getByTestId('board-season')).toBeVisible();
  await b.page.screenshot({ path: 'test-results/players-leaderboard-1920.png', animations: 'disabled' });
});
