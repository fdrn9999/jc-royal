import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';
import { measureTable, smallTargets, tablePlaces, type TableReport } from './table-layout';

/**
 * The live 6-seat table, one player with five bots, on phones held upright, from the smallest still in use (320×568)
 * to a large Android (412×839), in Korean and on the narrowest in English too (Chrome emulation, not devices). Each opens
 * the table while the player waits and on their turn, opens the raise panel and closes it again.
 *
 * Waiting and on the turn every seat, bet, the board and every control has its own room and each bet lies by its own
 * seat (measureTable). The table keeps its size and place as the panel opens and closes (the dock under it keeps the
 * bar's room at its tallest: Table.tsx's dockBand). With the panel open the panel, the bar, the turn line and the time
 * bank are on screen, in reach and at least 40px each way, and the table is as on the turn: nothing over anything, and
 * every card, bet, stack, name and the pot read whole (hit-tested over all their text).
 */
// English last: the language is the account's (chosen in the settings), so every screen after it would read English.
const PHONES = [
  { name: 'small phone 320×568', viewport: { width: 320, height: 568 }, scale: 2, locale: 'ko' },
  { name: 'Android 360×800', viewport: { width: 360, height: 800 }, scale: 3, locale: 'ko' },
  { name: 'iPhone SE 375×667', viewport: { width: 375, height: 667 }, scale: 2, locale: 'ko' },
  { name: 'iPhone 15 393×852', viewport: { width: 393, height: 852 }, scale: 3, locale: 'ko' },
  { name: 'Android 412×839', viewport: { width: 412, height: 839 }, scale: 2.625, locale: 'ko' },
  { name: 'small phone 320×568 (English)', viewport: { width: 320, height: 568 }, scale: 2, locale: 'en' },
];

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click();
}

test('6인 실시간 테이블, 세로 휴대폰 320~412px: 좌석·베팅·조작이 겹침 없이 화면 안에 있고, 레이즈 패널을 열고 닫아도 테이블이 그대로다', async ({ browser }) => {
  test.setTimeout(600_000);
  const { page, nickname } = await signUp(browser);
  await sitWith(page, 'e2e-phones', 1000);
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(6, { timeout: 90_000 });
  const state = await page.context().storageState();
  // One page at the table at a time: each screen opens its own.
  await page.goto('/');

  for (const sc of PHONES) {
    const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: sc.scale, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    if (sc.locale === 'en') {
      await p.goto('/');
      await p.getByTestId('settings-open').click();
      const saved = p.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH');
      await p.getByLabel('언어', { exact: true }).selectOption('en');
      await saved;
      await p.keyboard.press('Escape');
    }
    await p.goto('/table/e2e-phones');
    await expect(p.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(6);
    await expect(p.locator('html')).toHaveAttribute('lang', sc.locale);
    const mine = (await p.locator('[data-testid=table] [data-testid^="seat-"][data-state]', { has: p.getByText(nickname, { exact: true }) }).getAttribute('data-testid'))!.slice(5);
    const bar = p.getByTestId('action-bar');
    const raise = bar.getByTestId('action-dock-toggle');
    const look = async (what: string, dense?: RegExp) => {
      const r = await measureTable(p, dense);
      expect(await widerThanDevice(p), `${sc.name} ${what}: page wider than the screen`).toBe(false);
      await p.screenshot({ path: test.info().outputPath(`phone-${sc.viewport.width}x${sc.viewport.height}-${sc.locale}-${what}.png`) });
      return r;
    };

    // Waiting: between the bots' moves (or between hands).
    if (await bar.isVisible()) await act(p);
    await expect(bar).toBeHidden({ timeout: 90_000 });
    expect((await look('waiting')).issues, `${sc.name} waiting`).toEqual([]);

    // The player's turn with the raise offered (a turn with only fold or all-in is passed by).
    let turn = null as TableReport | null;
    await expect(async () => {
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await p.waitForTimeout(400);
      if (!(await raise.isVisible())) {
        await act(p);
        throw new Error('no raise offered');
      }
      turn = await look('turn');
    }).toPass({ timeout: 180_000 });
    const before = turn!;
    // The turn label and its countdown, on screen with the bar (measured above with the stack's other lines).
    await expect(p.getByTestId('turn-banner')).toBeInViewport();
    await expect(p.getByTestId('turn-left')).toHaveText(/^(⚠ )?\d+(초|s)$/);
    expect(before.issues, `${sc.name} turn`).toEqual([]);
    expect(await smallTargets(p), `${sc.name} turn: small targets`).toEqual([]);

    // The table and the player's seat stay where they were, every frame, as the panel opens: it grows inside the dock
    // (before, the table made way for it, moving once each way: TEST_REPORT).
    expect(await tablePlaces(p, mine, () => raise.click()), `${sc.name}: the table stays put as the panel opens`).toBe(1);
    await expect(raise).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.locator('[data-raise-panel]')).toBeVisible();
    // Every card's face, bet, stack, name and the pot hit-tested over the whole of its text or face.
    const open = await look('raise-open', /^(card|board|bet|stack|name|pot)-/);
    expect(open.table, `${sc.name}: the table keeps its size with the panel open`).toEqual(before.table);
    // The panel, the bar, the turn line and the time bank on screen, in reach and clear of the table, and the table
    // with nothing over anything.
    expect(open.issues, `${sc.name} raise open`).toEqual([]);
    expect(await smallTargets(p), `${sc.name} raise open: small targets`).toEqual([]);
    expect(open.items.filter((x) => x.startsWith(`card-${mine}-`)), `${sc.name} raise open: own cards`).toHaveLength(2);

    expect(await tablePlaces(p, mine, () => raise.click()), `${sc.name}: the table stays put as the panel closes`).toBe(1);
    await expect(bar.locator('[data-raise-panel]')).toHaveCount(0);
    expect((await measureTable(p)).table, `${sc.name}: the table keeps its size with the panel closed`).toEqual(before.table);
    expect((await look('raise-closed')).issues, `${sc.name} raise closed`).toEqual([]);

    await act(p);
    await ctx.close();
  }

  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto('/table/e2e-phones');
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(6);
  await standUp(page);
});
