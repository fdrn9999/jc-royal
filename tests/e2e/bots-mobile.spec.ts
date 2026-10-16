import { expect, type Page } from '@playwright/test';
import { signUp, sitWith, test, widerThanDevice } from './helpers';

/** The seats a table bot holds, by their BOT pill. */
const botSeats = (page: Page) => page.locator('[data-testid^="seat-"]').filter({ has: page.getByTestId('bot-badge') });

/** Taps the first bot's seat and returns its card. */
async function openBotCard(page: Page) {
  const seat = botSeats(page).first();
  const index = ((await seat.getAttribute('data-testid')) ?? '').replace('seat-', '');
  await page.getByTestId(`seat-pick-${index}`).tap();
  const card = page.getByTestId('bot-card');
  await expect(card).toBeVisible();
  return card;
}

test('mobile: a member alone at a bot table gets bots with a BOT pill and level, a bot card with no social actions, and the lobby counts members and bots, in Korean and English', async ({ browser }) => {
  // E2E Bots Mobile: 6 seats, normal bots, at most 2, filling the table to 3 players while a member sits.
  const { page } = await signUp(browser, { mobile: true });
  await sitWith(page, 'e2e-bots-m', 100);

  // The bots sit down one after another; each seat carries the BOT pill with its level.
  await expect(botSeats(page)).toHaveCount(2, { timeout: 30_000 });
  for (const badge of await page.getByTestId('bot-badge').all()) {
    await expect(badge).toHaveAttribute('data-level', 'normal');
    await expect(badge).toHaveAttribute('title', '테이블 봇 · 보통');
  }
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-table-mobile.png', animations: 'disabled' });

  // A bot's card says what it is; there is nothing to befriend, message, block or report.
  const card = await openBotCard(page);
  await expect(card.getByTestId('bot-card-level')).toHaveText('난이도 보통');
  await expect(card).toContainText('친구 신청·대화·차단·신고 대상이 아닙니다');
  await expect(page.getByTestId('player-card')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /친구|대화|메시지|차단|신고/ })).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-card-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // The lobby marks the table as one bots play at and counts who is seated.
  await page.goto('/');
  const row = page.getByTestId('lobby-table').filter({ hasText: 'E2E Bots Mobile' });
  await expect(row.getByTestId('bot-table-badge')).toHaveAttribute('data-level', 'normal');
  await expect(row.getByTestId('bot-table-badge')).toHaveText('봇 · 보통');
  await expect(row.getByTestId('lobby-humans-bots')).toHaveText('회원 1 · 봇 2');
  await row.scrollIntoViewIfNeeded();
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-lobby-mobile.png', animations: 'disabled' });

  // English, chosen in the settings (a member's account language wins over what the browser saved).
  await page.getByTestId('settings-open').click();
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await page.keyboard.press('Escape');
  await expect(row.getByTestId('bot-table-badge')).toHaveText('Bots · Normal');
  await expect(row.getByTestId('lobby-humans-bots')).toHaveText('Members 1 · Bots 2');
  await page.goto('/table/e2e-bots-m');
  await expect(botSeats(page)).toHaveCount(2);
  await expect(page.getByTestId('bot-badge').first()).toHaveAttribute('title', 'Table bot · Normal');
  const en = await openBotCard(page);
  await expect(en.getByTestId('bot-card-level')).toHaveText('Level: Normal');
  await expect(en).toContainText('It takes no friend requests, messages, blocks or reports.');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-card-mobile-en.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // With the member gone, the bots leave too.
  await page.getByTestId('leave').click();
  await expect(botSeats(page)).toHaveCount(0, { timeout: 60_000 });
});
