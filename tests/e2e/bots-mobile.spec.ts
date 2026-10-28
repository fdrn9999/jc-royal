import { expect, type Page } from '@playwright/test';
import { signUp, sitWith, standUp, test, widerThanDevice } from './helpers';

/** The seats a table bot holds, by the robot mark on its name. */
const botSeats = (page: Page) => page.locator('[data-testid^="seat-"]').filter({ has: page.getByTestId('bot-badge') });

/** The seats, taken or free, that reach past either side of the screen, with how far they run. */
const seatsOffScreen = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('[data-testid=table] [data-testid]'))
      .filter((el) => /^(seat|sit)-\d+$/.test(el.getAttribute('data-testid')!))
      .map((el) => ({ id: el.getAttribute('data-testid'), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right - vw) }))
      .filter((x) => x.left < 0 || x.right > 0);
  });

/** The styles' names on a bot's card (the console's names). */
const STYLE_KO: Record<string, string> = { balanced: '균형형', tag: '타이트 어그레시브', lag: '루즈 어그레시브', 'tight-passive': '타이트 패시브', 'loose-passive': '루즈 패시브', casual: '캐주얼' };

/** Taps the first bot's seat and returns its card. */
async function openBotCard(page: Page) {
  const seat = botSeats(page).first();
  const index = ((await seat.getAttribute('data-testid')) ?? '').replace('seat-', '');
  await page.getByTestId(`seat-pick-${index}`).tap();
  const card = page.getByTestId('bot-card');
  await expect(card).toBeVisible();
  return card;
}

test('mobile: a member alone at a bot table gets bots with the robot mark and level, a bot card with no social actions, and the lobby counts members and bots, in Korean and English', async ({ browser }) => {
  // E2E Bots Mobile: 6 seats, normal bots, at most 2, filling the table to 3 players while a member sits.
  const { page } = await signUp(browser, { mobile: true });
  await sitWith(page, 'e2e-bots-m', 100);

  // The bots sit down one after another; each seat carries the robot mark with its level.
  await expect(botSeats(page)).toHaveCount(2, { timeout: 30_000 });
  // A bot's line, while it has no action to show: its level and its style.
  await expect(page.locator('[data-testid^="bot-style-"]').first()).toHaveText(/^\s*· (균형형|TAG|LAG|타이트 패시브|루즈 패시브|캐주얼)$/, { timeout: 90_000 });
  for (const badge of await page.getByTestId('bot-badge').all()) {
    await expect(badge).toHaveAttribute('data-level', 'normal');
    await expect(badge).toHaveAttribute('title', 'AI 봇 플레이어 · 보통');
  }
  expect(await widerThanDevice(page)).toBe(false);
  // Six seats, bots and a member with a long name among them, all inside the screen on phones of several widths.
  for (const [width, height] of [[360, 800], [375, 667], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => seatsOffScreen(page), { message: `at ${width}px` }).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/bots-table-mobile.png', animations: 'disabled' });

  // A bot's card says what it is; there is nothing to befriend, message, block or report.
  const card = await openBotCard(page);
  await expect(card.getByTestId('bot-card-kind')).toHaveText('AI 봇 플레이어');
  await expect(card.getByTestId('bot-card-level')).toHaveText('난이도 보통');
  // Its style (the table leaves it to each bot): its name, what it does and four traits, a tendency and nothing more.
  const style = card.getByTestId('bot-card-style');
  const name = (await style.getAttribute('data-style')) ?? '';
  expect(Object.keys(STYLE_KO)).toContain(name);
  await expect(card.getByTestId('bot-card-style-name')).toHaveText(`스타일 ${STYLE_KO[name]}`);
  await expect(style.locator('[data-testid^="bot-trait-"]')).toHaveCount(4);
  await expect(style).toContainText('봇의 카드나 다음 행동은 알려 주지 않습니다');
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(card).toContainText('친구 신청·대화·차단·신고 대상이 아닙니다');
  await expect(page.getByTestId('player-card')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /친구|대화|메시지|차단|신고/ })).toHaveCount(0);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-card-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  // The bot's level and style on its seat open the same card.
  const line = page.locator('button[data-testid^="bot-level-"]').first();
  await line.waitFor({ timeout: 90_000 });
  await line.tap();
  await expect(card.getByTestId('bot-card-style')).toBeVisible();
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
  await expect(page.getByTestId('bot-badge').first()).toHaveAttribute('title', 'AI bot player · Normal');
  const en = await openBotCard(page);
  await expect(en.getByTestId('bot-card-kind')).toHaveText('AI bot player');
  await expect(en.getByTestId('bot-card-level')).toHaveText('Level: Normal');
  await expect(en.getByTestId('bot-card-style-name')).toHaveText(/^Style: (Balanced|Tight Aggressive|Loose Aggressive|Tight Passive|Loose Passive|Casual)$/);
  await expect(en.getByTestId('bot-card-style')).toContainText('nothing here tells its cards or its next move');
  await expect(en).toBeInViewport({ ratio: 1 });
  await expect(en).toContainText('It takes no friend requests, messages, blocks or reports.');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bots-card-mobile-en.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // With the member gone, the bots leave too.
  await standUp(page);
  await expect(botSeats(page)).toHaveCount(0, { timeout: 60_000 });
});
