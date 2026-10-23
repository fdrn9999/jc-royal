import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';
import { measureTable, smallTargets, type TableReport } from './table-layout';

/**
 * The live 9-seat table, one player with eight bots, on phones held upright and sideways, a tablet and a laptop
 * (Chrome emulation, not devices). Each screen opens the table while the player waits and on their turn, opens the raise
 * panel and closes it again.
 *
 * Every seat, bet, the board and every control of the stack has its own room, and each bet lies nearer its own seat
 * than any other (measureTable), and every button and field of the action bar and the raise panel is at least 40px each
 * way (smallTargets). The table keeps its size and place with the raise panel open, and so everything it holds: upright
 * the panel grows inside the dock under the table, which keeps the bar's room at its tallest (Table.tsx's dockBand), and
 * sideways (short.ts) the controls are a column at the right (at 800×360 the top row's middle bets lie beside the pot,
 * under their seats). Upright on the iPhone SE nine seats fit only with some bets nearer a
 * neighbour, and on it sideways the bets have no room each by its own seat (layout.ts places each as near its seat as
 * it can): there a bet may lie astray (TEST_REPORT), everything else is held.
 */
const SCREENS = [
  { name: 'iPhone SE 375×667', viewport: { width: 375, height: 667 }, scale: 2, mobile: true, astray: true },
  { name: 'Android 360×800', viewport: { width: 360, height: 800 }, scale: 3, mobile: true },
  { name: 'iPhone 15 393×852', viewport: { width: 393, height: 852 }, scale: 3, mobile: true },
  { name: 'phone sideways 844×390', viewport: { width: 844, height: 390 }, scale: 3, mobile: true, sideways: true },
  { name: 'Android sideways 800×360', viewport: { width: 800, height: 360 }, scale: 3, mobile: true, sideways: true },
  { name: 'iPhone SE sideways 667×375', viewport: { width: 667, height: 375 }, scale: 2, mobile: true, sideways: true, astray: true },
  { name: 'tablet 768×1024', viewport: { width: 768, height: 1024 }, scale: 2, mobile: true },
  { name: 'laptop 1280×720', viewport: { width: 1280, height: 720 }, scale: 1, mobile: false },
];

/** What a screen must show: everything in its own room and each bet by its seat, but where a bet may lie astray. */
function held(r: TableReport, sc: (typeof SCREENS)[number]) {
  return 'astray' in sc && sc.astray ? r.issues.filter((x) => x.kind !== 'astray') : r.issues;
}

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click();
}

test('9인 실시간 테이블: 휴대폰(세로·가로)·태블릿·노트북에서 좌석·베팅·조작이 화면 안에 겹침 없이 있고, 레이즈 패널을 열고 닫아도 테이블이 그대로다', async ({ browser }) => {
  test.setTimeout(630_000);
  const { page } = await signUp(browser);
  await sitWith(page, 'e2e-nine', 1000);
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(9, { timeout: 90_000 });
  const state = await page.context().storageState();
  // One page at the table at a time: each screen opens its own.
  await page.goto('/');

  for (const sc of SCREENS) {
    const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: sc.scale, isMobile: sc.mobile, hasTouch: sc.mobile, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto('/table/e2e-nine');
    await expect(p.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(9);
    const bar = p.getByTestId('action-bar');
    const raise = bar.getByTestId('action-dock-toggle');
    const look = async (what: string) => {
      const r = await measureTable(p);
      expect(await widerThanDevice(p), `${sc.name} ${what}: page wider than the screen`).toBe(false);
      await p.screenshot({ path: test.info().outputPath(`nine-${sc.viewport.width}x${sc.viewport.height}-${what}.png`) });
      return r;
    };

    // Waiting: between the bots' moves (or between hands).
    if (await bar.isVisible()) await act(p);
    await expect(bar).toBeHidden({ timeout: 90_000 });
    const waiting = await look('waiting');
    expect(held(waiting, sc), `${sc.name} waiting`).toEqual([]);

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
    expect(held(before, sc), `${sc.name} turn`).toEqual([]);
    expect(await smallTargets(p), `${sc.name} turn: small targets`).toEqual([]);

    await raise.click();
    await expect(raise).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.locator('[data-raise-panel]')).toBeVisible();
    const open = await look('raise-open');
    // The panel, the bar, the turn line and the time bank on screen and in reach, and the table as it was, with all it
    // holds (before, an upright phone's table made way for the panel: TEST_REPORT).
    expect(open.table, `${sc.name}: the table keeps its size with the panel open`).toEqual(before.table);
    expect(held(open, sc), `${sc.name} raise open`).toEqual([]);
    // Every button and field of the bar and the panel at least 40px each way, the column's too.
    expect(await smallTargets(p), `${sc.name} raise open: small targets`).toEqual([]);

    await raise.click();
    await expect(bar.locator('[data-raise-panel]')).toHaveCount(0);
    expect((await measureTable(p)).table, `${sc.name}: the table keeps its size with the panel closed`).toEqual(before.table);
    const after = await look('raise-closed');
    expect(held(after, sc), `${sc.name} raise closed`).toEqual([]);

    await act(p);
    await ctx.close();
  }

  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto('/table/e2e-nine');
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(9);
  await standUp(page);
});
