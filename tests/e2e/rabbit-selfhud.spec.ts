import { expect, type Page } from '@playwright/test';
import type { PlayerHudDto } from '@jc/types';
import { expectHudBars, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';

/** The pick button on the seat of the member named `nickname` (it carries their name). */
const seatOf = (page: Page, nickname: string) => page.locator(`[data-testid^="seat-pick-"][aria-label="${nickname}"]`);
const fold = (page: Page) => page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)/ });
const cardsIn = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => e.getAttribute('data-card') ?? e.querySelector('[data-card]')?.getAttribute('data-card') ?? ''));

/** Whoever is to act folds: the hand ends before the flop. Returns the page that folded. */
async function foldPreflop(a: Page, b: Page): Promise<Page> {
  let who: Page | null = null;
  await expect(async () => {
    for (const p of [a, b]) {
      if (await fold(p).isVisible().catch(() => false)) {
        who = p;
        return;
      }
    }
    throw new Error('nobody to act yet');
  }).toPass({ timeout: 45_000 });
  // Not offered while the hand is played.
  for (const p of [a, b]) await expect(p.getByTestId('rabbit-hunt')).toHaveCount(0);
  await fold(who!).click();
  return who!;
}

test('rabbit hunting: after a fold before the flop, the five cards that would have come, for the one who asked, marked as no part of the hand, gone with the next deal; on a phone at 320 px too', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  await sitWith(a.page, 'e2e-rabbit', 1000);
  await sitWith(b.page, 'e2e-rabbit', 1000);
  await a.page.setViewportSize({ width: 320, height: 568 });

  await foldPreflop(a.page, b.page);
  // Offered to both once the hand is settled; nothing is on the board until it is asked for.
  const ask = a.page.getByTestId('rabbit-hunt');
  await expect(ask).toBeVisible();
  await expect(ask).toHaveText(/래빗헌팅/);
  await expect(b.page.getByTestId('rabbit-hunt')).toBeVisible();
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);
  const stacks = (page: Page) => page.locator('[data-testid^="stack-"]').allInnerTexts();
  // Once the pot has been pushed (the stacks hold every chip again).
  await expect.poll(async () => (await stacks(a.page)).reduce((sum, x) => sum + Number(x.replace(/\D/g, '')), 0), { timeout: 15_000 }).toBe(2000);
  const before = await stacks(a.page);
  const mine = await cardsIn(a.page, '[data-testid^="seat-"] .jc-card[data-card]');

  await ask.tap();
  const rabbit = a.page.getByTestId('rabbit-card');
  await expect(rabbit).toHaveCount(5);
  // Only for the one who asked; the other player asks too, and is shown the same five cards (the deck as it lies).
  await expect(b.page.getByTestId('rabbit-card')).toHaveCount(0);
  await b.page.getByTestId('rabbit-hunt').click();
  await expect(b.page.getByTestId('rabbit-card')).toHaveCount(5);
  await expect(a.page.getByTestId('rabbit-label')).toHaveText('RABBIT HUNT');
  await expect(a.page.getByTestId('rabbit-note')).toContainText('래빗헌팅 결과');
  // The rabbit is the icon set's, on the cards' mark and on the note: no emoji anywhere on the table.
  await expect(a.page.getByTestId('rabbit-label').locator('svg.lucide-rabbit')).toHaveCount(1);
  await expect(a.page.getByTestId('rabbit-note').locator('svg.lucide-rabbit')).toHaveCount(1);
  expect(await a.page.getByTestId('table-stack').innerText()).not.toContain('🐇');
  await expect(a.page.getByTestId('rabbit-note')).toContainText('실제 게임 결과에는 영향을 주지 않습니다.');
  await expect(ask).toHaveCount(0);
  // Five different cards, none of them one I hold; the stacks as the hand left them.
  const shown = await cardsIn(a.page, '[data-testid="rabbit-card"]');
  expect(new Set(shown).size).toBe(5);
  for (const c of shown) expect(c).toMatch(/^[2-9TJQKA][cdhs]$/);
  for (const c of mine.filter(Boolean)) expect(shown).not.toContain(c);
  expect(await stacks(a.page)).toEqual(before);
  expect(await cardsIn(b.page, '[data-testid="rabbit-card"]')).toEqual(shown);
  // On the narrowest phone: nothing wider than the screen, the cards and their mark inside it.
  expect(await widerThanDevice(a.page)).toBe(false);
  for (const box of await rabbit.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })))) {
    expect(box.l).toBeGreaterThanOrEqual(0);
    expect(box.r).toBeLessThanOrEqual(320);
  }
  await expect(a.page.getByTestId('rabbit-label')).toBeInViewport({ ratio: 1 });
  // Turned face up one after another; the pictures are taken with the turning done (no waiting: the next deal is near).
  await a.page.screenshot({ path: 'test-results/rabbit-320.png', animations: 'disabled' });
  await b.page.screenshot({ path: 'test-results/rabbit-desktop.png', animations: 'disabled' });

  // The next deal takes it all away, on both.
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId('rabbit-card')).toHaveCount(0, { timeout: 20_000 });
    await expect(p.getByTestId('rabbit-note')).toHaveCount(0);
    await expect(p.getByTestId('rabbit-label')).toHaveCount(0);
  }
  await standUp(a.page);
  await standUp(b.page);
});

test('my own HUD: my seat opens my own figures, private or not, and nobody else’s privacy changes; no report, friend or block for myself; the action buttons stay usable', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  await sitWith(a.page, 'e2e-selfhud', 1000);
  await sitWith(b.page, 'e2e-selfhud', 1000);
  // One hand, so there is something to count.
  await foldPreflop(a.page, b.page);
  await expect(a.page.getByTestId('rabbit-hunt')).toBeVisible();

  const relation: string[] = [];
  a.page.on('request', (r) => {
    if (/\/api\/friends\/[^/]+\/relation/.test(r.url())) relation.push(r.url());
  });
  // My statistics are private (the default), and still mine to see.
  await seatOf(a.page, a.nickname).tap();
  const card = a.page.getByTestId('player-card');
  await expect(card).toContainText(a.nickname);
  const hud = card.getByTestId('seat-hud');
  await expect(hud).toBeVisible();
  await expect(card.getByTestId('seat-hud-hidden')).toHaveCount(0);
  await expect(hud).toHaveAttribute('data-kind', 'cash');
  await expect(hud.getByTestId('seat-hud-hands')).toContainText('1');
  await expect(card.getByTestId('hud-self-note')).toBeVisible();
  for (const id of ['player-report', 'player-befriend', 'player-block', 'player-mute']) await expect(card.getByTestId(id), id).toHaveCount(0);
  expect(relation).toEqual([]);
  // The rest on request, each as the server counted it.
  await hud.getByTestId('seat-hud-more').tap();
  const aId = await a.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const dto = await a.page.evaluate(async (id) => (await (await fetch(`/api/players/${id}/hud?scope=cash`)).json()) as PlayerHudDto, aId);
  expect(dto.stats).not.toBeNull();
  const cells = { vpip: 'seat-hud-vpip', pfr: 'seat-hud-pfr', threeBet: 'seat-hud-3bet', foldTo3Bet: 'seat-hud-fold-3bet', cbet: 'seat-hud-cbet', foldToCbet: 'seat-hud-fold-cbet', wtsd: 'seat-hud-wtsd', wsd: 'seat-hud-wsd' } as const;
  for (const [key, id] of Object.entries(cells) as [keyof typeof cells, string][]) await expect(hud.getByTestId(id), id).toContainText(`${dto.stats![key].n}/${dto.stats![key].of}`);
  await expect(hud.getByTestId('seat-hud-af')).toBeVisible();
  // My own figures have the same bars as anybody's, each as far as its hands say.
  for (const [key, id] of Object.entries(cells) as [keyof typeof cells, string][]) {
    const { n, of } = dto.stats![key];
    await expect(hud.getByTestId(`${id}-bar`), id).toHaveAttribute('data-fill', of === 0 ? 'none' : String(Math.round((n / of) * 1000) / 10));
  }
  await expect.poll(() => expectHudBars(hud)).toBe(8);
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    await a.page.setViewportSize({ width, height });
    expect(await widerThanDevice(a.page)).toBe(false);
    const box = (await hud.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expect.poll(() => expectHudBars(hud)).toBe(8);
    await a.page.screenshot({ path: `test-results/selfhud-${width}.png`, animations: 'disabled' });
  }
  await a.page.setViewportSize({ width: 390, height: 844 });
  await a.page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // The same member's seat, from the other side of the table: private, as before. Asked directly, the server says so too.
  await seatOf(b.page, a.nickname).click();
  const theirs = b.page.getByTestId('player-card');
  await expect(theirs.getByTestId('seat-hud-hidden')).toBeVisible();
  await expect(theirs.getByTestId('seat-hud')).toHaveCount(0);
  await expect(theirs.getByTestId('hud-self-note')).toHaveCount(0);
  await expect(theirs.getByTestId('player-report')).toBeVisible();
  expect((await b.page.evaluate(async (id) => (await (await fetch(`/api/players/${id}/hud?scope=cash`)).json()) as PlayerHudDto, aId)).stats).toBeNull();
  await b.page.keyboard.press('Escape');
  // B's own, on a desktop.
  await seatOf(b.page, b.nickname).click();
  await expect(theirs).toContainText(b.nickname);
  await expect(theirs.getByTestId('seat-hud-hands')).toContainText('1');
  await b.page.screenshot({ path: 'test-results/selfhud-desktop.png', animations: 'disabled' });
  await b.page.keyboard.press('Escape');

  // At my turn: the card opens over the table and closes; the action bar is where it was and still acts.
  let actor: Page | null = null;
  await expect(async () => {
    for (const p of [a.page, b.page]) if (await fold(p).isVisible().catch(() => false)) actor = p;
    expect(actor).not.toBeNull();
  }).toPass({ timeout: 45_000 });
  const me = actor === a.page ? a : b;
  await seatOf(me.page, me.nickname).click();
  await expect(me.page.getByTestId('player-card').getByTestId('seat-hud')).toBeVisible();
  await me.page.keyboard.press('Escape');
  await expect(me.page.getByTestId('player-card')).toHaveCount(0);
  await expect(fold(me.page)).toBeEnabled();
  await fold(me.page).click();
  await expect(me.page.getByTestId('action-bar')).toHaveCount(0);
  await standUp(a.page);
  await standUp(b.page);
});
