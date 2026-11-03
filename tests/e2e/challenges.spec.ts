import { expect } from '@playwright/test';
import { seedTodayHands } from './challenges-seed';
import { idOf } from './hand-review-seed';
import { signUp, test } from './helpers';

test('My Page: the challenges the server judged from the hands it recorded, completed once, with the totals on the card', async ({ browser }) => {
  const { page } = await signUp(browser);
  const id = await idOf(page);
  seedTodayHands(id, 10);
  await page.goto('/me');
  const card = page.getByTestId('challenges');
  const item = (code: string) => card.locator(`[data-testid=challenge][data-code=${code}]`);
  // Opening them judges the ten hands: the day's ten, dated; the thirty counts them, the showdowns none.
  await expect(item('d_hands_10')).toHaveAttribute('data-done', '');
  await expect(item('d_hands_10').getByTestId('challenge-progress')).toHaveText('10/10');
  await expect(item('d_hands_10')).toContainText(/완료|Done/);
  await expect(item('d_hands_30').getByTestId('challenge-progress')).toHaveText('10/30');
  await expect(item('d_hands_30')).not.toHaveAttribute('data-done');
  await expect(item('d_showdown_3').getByTestId('challenge-progress')).toHaveText('0/3');
  await expect(item('w_days_3').getByTestId('challenge-progress')).toHaveText('1/3');
  await expect(page.getByTestId('challenges-total')).toContainText(/1회 완료 · 진행 점수 1|Completed so far: 1 · progress points 1/);
  await expect(card).toContainText(/칩이 아니고|not chips/);
  // On a computer the day and the week side by side.
  const day = (await page.getByTestId('challenges-day').boundingBox())!;
  const week = (await page.getByTestId('challenges-week').boundingBox())!;
  expect(Math.abs(day.y - week.y)).toBeLessThan(2);
  expect(week.x).toBeGreaterThanOrEqual(day.x + day.width);
  await page.getByTestId('challenges-recent').locator('summary').click();
  await expect(page.getByTestId('challenges-recent')).toContainText(/핸드 10회|10 hands/);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/challenges-desktop.png', animations: 'disabled' });

  // Checking again judges again and completes nothing more.
  const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me/challenges');
  await page.getByTestId('challenges-refresh').click();
  expect((await again).status()).toBe(200);
  await expect(page.getByTestId('challenges-total')).toContainText(/1회 완료|Completed so far: 1/);

  // The profile card shows the totals (shown with the achievements).
  await page.goto(`/players/${id}`);
  await expect(page.getByTestId('card-challenges')).toContainText('1');
});
