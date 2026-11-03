import { expect, type Locator, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

/** The card sits inside the screen and nothing scrolls sideways. */
async function fits(page: Page, el: Locator) {
  expect(await widerThanDevice(page)).toBe(false);
  const width = page.viewportSize()!.width;
  const box = (await el.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

/** Checks or calls; a big call asks for a second tap, and facing more than the stack (fold or all in) it folds. */
async function act(page: Page) {
  if (await checkOrCall(page)) return;
  const bar = page.getByTestId('action-bar');
  const again = bar.getByRole('button', { name: /^(한 번 더|Press again)/ });
  if (await again.first().isVisible().catch(() => false)) return again.first().click();
  if (await bar.getByRole('button', { name: /^(체크|Check|콜|Call)/ }).count()) return;
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click();
}

/** Plays hands until `n` have ended, dealing the next one after each. */
async function playHands(page: Page, n: number) {
  for (let hand = 1; hand <= n; hand++) {
    await expect(async () => {
      await act(page);
      await expect(page.getByTestId('free-next')).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 60_000 });
    if (hand < n) await page.getByTestId('free-next').click();
  }
}

test('free practice: topic, bot level and style, stacks and blinds; results on this screen only; a bot’s HUD, on a phone and a desktop', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser, { mobile: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/academy/practice/free');
  const setup = page.getByTestId('free-setup');

  // Heads-up is one opponent, whatever was chosen.
  await setup.locator('[data-topic="headsUp"]').tap();
  await expect(setup.locator('[data-bots="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(setup.locator('[data-bots="5"]')).toBeDisabled();
  // The tables' styles only with a table level; the beginner bots keep theirs.
  await expect(setup.locator('[data-style="lag"]')).toHaveCount(0);
  await setup.locator('[data-topic="bbDefense"]').tap();
  await expect(setup.getByTestId('free-topic-about')).toContainText('빅 블라인드');
  await expect(setup.locator('[data-bots="5"]')).toBeEnabled();
  await setup.locator('[data-level="normal"]').tap();
  await expect(setup.locator('[data-style="tight"]')).toHaveCount(0);
  await setup.locator('[data-style="lag"]').tap();
  await setup.locator('[data-stack="50"]').tap();
  await setup.locator('[data-blinds="50"]').tap();
  for (const [width, height] of [[320, 568], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    expect(await widerThanDevice(page)).toBe(false);
    await page.screenshot({ path: `test-results/practice-setup-${width}.png`, fullPage: true, animations: 'disabled' });
  }

  // Nothing of the practice reaches the server: no socket, and nothing written but the academy's own progress.
  const sockets: string[] = [];
  const writes: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('request', (r) => {
    if (r.method() !== 'GET' && !r.url().includes('/api/academy/')) writes.push(`${r.method()} ${r.url()}`);
  });
  await page.getByTestId('free-start').tap();
  await expect(page.getByTestId('free-table')).toBeVisible();
  // The chosen stacks and blinds, defending the big blind: 50 big blinds of 50, the big blind already posted.
  await expect(page.getByTestId('seat-0')).toContainText('2,450');
  await expect(page.getByTestId('seat-0')).toContainText('BB');
  await playHands(page, 3);
  expect(sockets).toEqual([]);
  expect(writes).toEqual([]);

  // The results: the topic, said to be math and rules of thumb, kept on this screen only.
  await page.getByTestId('free-summary-open').tap();
  const summary = page.getByTestId('free-summary');
  await expect(summary.getByTestId('free-summary-topic')).toHaveText('블라인드 방어');
  await expect(summary.getByTestId('free-summary-count')).toHaveText(/^결정 \d+$/);
  await expect(summary.locator('[data-analysis="math"]').first()).toHaveText('수학 계산');
  await expect(summary.locator('[data-analysis="heuristic"]').first()).toHaveText('휴리스틱');
  await expect(summary.locator('[data-analysis="solver"]')).toHaveCount(0);
  await expect(summary.getByTestId('free-summary-habits')).toContainText('정답이나 오답 판정이 아닙니다');
  await expect(summary.getByTestId('free-summary-kept')).toContainText('공식 전적·지갑·칩 원장에 저장되지 않고');
  await expect(summary.getByTestId('free-summary-topic-study')).toHaveAttribute('href', '/academy/gto/hands?id=bb-86s');
  // Every decision shown is one from the big blind; each with its price and SPR (or why there is none).
  for (const row of await summary.getByTestId('free-summary-decision').all()) {
    await expect(row).toContainText('BB');
    await expect(row.getByTestId('free-summary-odds')).not.toBeEmpty();
    await expect(row.getByTestId('free-summary-spr')).not.toBeEmpty();
  }
  // The hero's own figures over the three hands, counted in the browser.
  const myHud = summary.getByTestId('seat-hud');
  await expect(myHud).toHaveAttribute('data-kind', 'practice');
  await expect(myHud).toHaveAttribute('data-bot', 'false');
  await expect(myHud.getByTestId('seat-hud-hands')).toContainText('3');
  for (const [width, height] of [[320, 568], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await fits(page, summary);
    await page.screenshot({ path: `test-results/practice-results-${width}.png`, animations: 'disabled' });
  }
  await page.keyboard.press('Escape');
  await expect(summary).toHaveCount(0);

  // A bot's card: a practice bot, its level and style, its HUD over the session, marked as a bot's.
  await page.getByTestId('seat-pick-2').tap();
  const bot = page.getByTestId('free-bot');
  await expect(bot.getByTestId('free-bot-badge')).toHaveText('연습 봇');
  await expect(bot.getByTestId('free-bot-level')).toHaveText('난이도 보통');
  await expect(bot.getByTestId('free-bot-style')).toHaveText('스타일 루즈 어그레시브');
  await expect(bot).toContainText('자기 카드와 모두에게 공개된 정보만 보고 행동하며');
  const hud = bot.getByTestId('seat-hud');
  await expect(hud).toHaveAttribute('data-kind', 'practice');
  await expect(hud).toHaveAttribute('data-bot', 'true');
  await expect(hud.getByTestId('seat-hud-scope')).toHaveText('이번 연습');
  await expect(hud.getByTestId('seat-hud-bot')).toHaveText('봇 기록');
  await expect(hud.getByTestId('seat-hud-hands')).toContainText('3');
  await hud.getByTestId('seat-hud-more').tap();
  await expect(hud.getByTestId('seat-hud-notes')).toContainText('연습은 기록으로 남지 않습니다');
  for (const [width, height] of [[320, 568], [390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await expect(bot).toBeInViewport();
    await fits(page, bot);
    await page.screenshot({ path: `test-results/practice-bot-${width}.png`, animations: 'disabled' });
  }
  await page.keyboard.press('Escape');
  // The hero's own seat opens nothing.
  await expect(page.getByTestId('seat-pick-0')).toHaveCount(0);
  // The header fits its buttons on the narrowest phone, the net beside the title not cut off.
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByTestId('free-summary-open')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '족보표' })).toBeInViewport({ ratio: 1 });
  const clipped = await page.getByTestId('free-net').evaluate((el) => {
    const box = el.parentElement!.parentElement!;
    const right = box.getBoundingClientRect().right;
    return Array.from(box.children)
      .flatMap((line) => Array.from(line.children))
      .filter((x) => x.scrollWidth > x.clientWidth || x.getBoundingClientRect().right > right + 0.5)
      .map((x) => `${x.textContent} ${x.scrollWidth}/${x.clientWidth} ${x.getBoundingClientRect().right}/${right}`);
  });
  expect(clipped).toEqual([]);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/practice-table-320.png', animations: 'disabled' });
});
