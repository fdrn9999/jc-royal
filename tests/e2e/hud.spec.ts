import { expect, type Page } from '@playwright/test';
import type { PlayerHudDto } from '@jc/types';
import { playOneHand, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';

/** The pick button on the seat of the member named `nickname` (it carries their name). */
const seatOf = (page: Page, nickname: string) => page.locator(`[data-testid^="seat-pick-"][aria-label="${nickname}"]`);

/** Turns this page's member's statistics on or off for others, as the friends settings do. */
const showStats = (page: Page, on: boolean) =>
  page.evaluate(async (v) => {
    const r = await fetch('/api/friends/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showStats: v }) });
    if (!r.ok) throw new Error(`settings ${r.status}`);
  }, on);

/** The HUD sits inside the card, the card inside the screen, and nothing scrolls sideways. */
async function fits(page: Page, card: ReturnType<Page['getByTestId']>) {
  expect(await widerThanDevice(page)).toBe(false);
  const width = page.viewportSize()!.width;
  const box = (await card.getByTestId('seat-hud').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

test('table HUD: inside the card a seat opens and never on the table; private until shown, each ratio with its hands, a bot’s marked, on a phone and a desktop', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  // One hand together, so each has a record at this kind of table; then both sit down again.
  await sitWith(a.page, 'e2e-hud', 1000);
  await sitWith(b.page, 'e2e-hud', 1000);
  await playOneHand(a.page, b.page);
  await sitWith(a.page, 'e2e-hud', 500);
  await sitWith(b.page, 'e2e-hud', 500);

  // The table itself carries no HUD: no figure covers a card, a stack, the button, a blind, a bet or a turn.
  await expect(seatOf(b.page, a.nickname)).toBeVisible();
  await expect(b.page.getByTestId('seat-hud')).toHaveCount(0);
  await expect(b.page.getByTestId('table').locator('[data-testid^="seat-hud"]')).toHaveCount(0);

  // A keeps statistics private (the default): B's click on A's seat opens the card, with no figures.
  await seatOf(b.page, a.nickname).click();
  const card = b.page.getByTestId('player-card');
  await expect(card).toContainText(a.nickname);
  await expect(card.getByTestId('seat-hud-hidden')).toHaveText(/이 회원은 통계를 공개하지 않습니다/);
  await expect(card.getByTestId('seat-hud')).toHaveCount(0);
  await b.page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // Shown: A's figures at ordinary tables, the hand counted, every ratio with its hands and the small-sample warning.
  await showStats(a.page, true);
  await seatOf(b.page, a.nickname).click();
  const hud = card.getByTestId('seat-hud');
  await expect(hud).toHaveAttribute('data-kind', 'cash');
  await expect(hud).toHaveAttribute('data-bot', 'false');
  await expect(hud.getByTestId('seat-hud-scope')).toHaveText('일반 테이블');
  await expect(hud.getByTestId('seat-hud-bot')).toHaveCount(0);
  await expect(hud.getByTestId('seat-hud-hands')).toContainText('1');
  await expect(hud.getByTestId('seat-hud-vpip')).toHaveAttribute('data-small', 'true');
  await expect(hud.getByTestId('seat-hud-small')).toBeVisible();
  // Closed: the four basic figures only; each ratio's hands and the rest until asked for.
  await expect(hud.getByTestId('seat-hud-vpip')).not.toContainText('/');
  await expect(hud.getByTestId('seat-hud-cbet')).toHaveCount(0);
  await expect(hud.getByTestId('seat-hud-more')).toHaveAttribute('aria-expanded', 'false');
  await hud.getByTestId('seat-hud-more').click();
  await expect(hud.getByTestId('seat-hud-more')).toHaveAttribute('aria-expanded', 'true');
  await expect(hud.getByTestId('seat-hud-vpip')).toContainText('/1');
  for (const id of ['seat-hud-fold-3bet', 'seat-hud-cbet', 'seat-hud-fold-cbet', 'seat-hud-af', 'seat-hud-wtsd', 'seat-hud-wsd']) await expect(hud.getByTestId(id), id).toBeVisible();
  // Each ratio as the server counted it, with its hands; one with no chance reads as a dash, never 0%.
  const aId = await a.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const dto = await b.page.evaluate(async (id) => (await (await fetch(`/api/players/${id}/hud?scope=cash`)).json()) as PlayerHudDto, aId);
  const cells = { vpip: 'seat-hud-vpip', pfr: 'seat-hud-pfr', threeBet: 'seat-hud-3bet', foldTo3Bet: 'seat-hud-fold-3bet', cbet: 'seat-hud-cbet', foldToCbet: 'seat-hud-fold-cbet', wtsd: 'seat-hud-wtsd', wsd: 'seat-hud-wsd' } as const;
  for (const [key, id] of Object.entries(cells) as [keyof typeof cells, string][]) {
    const { n, of } = dto.stats![key];
    await expect(hud.getByTestId(id), id).toContainText(`${n}/${of}`);
    if (of === 0) await expect(hud.getByTestId(id), id).toContainText('—');
    else await expect(hud.getByTestId(id), id).toContainText(`${Math.round((n / of) * 1000) / 10}%`);
  }
  await expect(card).toBeInViewport();
  await fits(b.page, card);
  await b.page.screenshot({ path: 'test-results/hud-card-desktop.png', animations: 'disabled' });
  await b.page.keyboard.press('Escape');

  // On the phone: a tap on B's seat, B's statistics private as well.
  await seatOf(a.page, b.nickname).tap();
  const mine = a.page.getByTestId('player-card');
  await expect(mine.getByTestId('seat-hud-hidden')).toBeVisible();
  await a.page.keyboard.press('Escape');
  await showStats(b.page, true);
  await seatOf(a.page, b.nickname).tap();
  await expect(mine.getByTestId('seat-hud-hands')).toContainText('1');
  for (const [width, height] of [[390, 844], [320, 568], [667, 375]] as const) {
    await a.page.setViewportSize({ width, height });
    await fits(a.page, mine);
    await a.page.screenshot({ path: `test-results/hud-card-${width}x${height}.png`, animations: 'disabled' });
  }
  await a.page.setViewportSize({ width: 390, height: 844 });
  await a.page.keyboard.press('Escape');
  await standUp(a.page);
  await standUp(b.page);

  // A bot's HUD: always shown and marked as a bot's, in the bot's own card.
  await sitWith(a.page, 'e2e-hud-bots', 100);
  const bot = a.page.locator('[data-testid^="seat-"]').filter({ has: a.page.getByTestId('bot-badge') }).first();
  await expect(bot).toBeVisible({ timeout: 30_000 });
  const index = ((await bot.getAttribute('data-testid')) ?? '').replace('seat-', '');
  await expect(a.page.getByTestId('seat-hud')).toHaveCount(0);
  await a.page.getByTestId(`seat-pick-${index}`).tap();
  const botCard = a.page.getByTestId('bot-card');
  const botHud = botCard.getByTestId('seat-hud');
  await expect(botHud).toHaveAttribute('data-bot', 'true');
  await expect(botHud.getByTestId('seat-hud-bot')).toHaveText('봇 기록');
  // What a bot acts on is the card's own line, said once.
  await expect(botCard).toContainText('자기 카드와 모두에게 공개된 정보만 보고 행동합니다');
  await expect(botCard).toBeInViewport({ ratio: 1 });
  await expect(botCard.getByTestId('bot-card-kind')).toBeInViewport();
  await fits(a.page, botCard);
  await a.page.screenshot({ path: 'test-results/hud-bot-390.png', animations: 'disabled' });
  await a.page.keyboard.press('Escape');
  await standUp(a.page);
});
