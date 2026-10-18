import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test, widerThanDevice } from './helpers';
import { measureTable, type TableReport } from './table-layout';

/**
 * The live 9-seat table, one player with eight bots, on phones held upright and sideways, a tablet and a laptop
 * (Chrome emulation, not devices). Each screen opens the table while the player waits and on their turn, opens the raise
 * panel and closes it again.
 *
 * Upright, on the tablet and the laptop every seat, bet, the board and every control of the stack has its own room
 * (measureTable). Sideways (844×390) the table gets 286px of height, and nine seats with cards need 354px or more to
 * leave nothing overlapping at any width the column gives them: bets may lie on a neighbour's status line there, so only
 * the controls and the screen's edges are held. The raise panel takes the room from the table while it is open (on a
 * small phone the seats then overlap, and sideways the turn line and the time bank go above the column), and the table
 * gets it back when the panel closes.
 */
const SCREENS = [
  { name: 'iPhone SE 375×667', viewport: { width: 375, height: 667 }, scale: 2, mobile: true },
  { name: 'Android 360×800', viewport: { width: 360, height: 800 }, scale: 3, mobile: true },
  { name: 'iPhone 15 393×852', viewport: { width: 393, height: 852 }, scale: 3, mobile: true },
  { name: 'phone sideways 844×390', viewport: { width: 844, height: 390 }, scale: 3, mobile: true, sideways: true },
  { name: 'tablet 768×1024', viewport: { width: 768, height: 1024 }, scale: 2, mobile: true },
  { name: 'laptop 1280×720', viewport: { width: 1280, height: 720 }, scale: 1, mobile: false },
];

/** What a screen must show: everything in its own room, or sideways the controls and the screen's edges. */
function held(r: TableReport, sideways: boolean | undefined) {
  return sideways ? r.issues.filter((x) => x.kind === 'clipped' || x.kind === 'offscreen' || x.item.includes(':')) : r.issues;
}

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click();
}

test('9인 실시간 테이블: 휴대폰(세로·가로)·태블릿·노트북에서 좌석·베팅·조작이 화면 안에 겹침 없이 있고, 레이즈 패널을 닫으면 테이블이 원래 크기로 돌아온다', async ({ browser }) => {
  test.setTimeout(540_000);
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
    const raise = bar.locator('button[aria-expanded]');
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
    expect(held(waiting, sc.sideways), `${sc.name} waiting`).toEqual([]);

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
    expect(held(before, sc.sideways), `${sc.name} turn`).toEqual([]);

    await raise.click();
    await expect(raise).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.getByTestId('action-commit')).toBeVisible();
    const open = await look('raise-open');
    // The panel and the bar stay on screen and in reach; upright, the turn line and the time bank too.
    const controls = open.issues.filter((x) => (sc.sideways ? x.item.startsWith('action-bar:') : x.item.includes(':') || x.item.startsWith('line-')));
    expect(controls, `${sc.name} raise open`).toEqual([]);

    await raise.click();
    await expect(bar.getByTestId('action-commit')).toHaveCount(0);
    // The table takes its room back once the panel has closed (a frame for the stack to be read again).
    await expect.poll(async () => (await measureTable(p)).table, { message: `${sc.name}: table back to its size` }).toEqual(before.table);
    const after = await look('raise-closed');
    expect(held(after, sc.sideways), `${sc.name} raise closed`).toEqual([]);

    await act(p);
    await ctx.close();
  }

  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto('/table/e2e-nine');
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(9);
  await page.getByTestId('leave').click();
});
