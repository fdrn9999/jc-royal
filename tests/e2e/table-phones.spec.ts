import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test, widerThanDevice } from './helpers';
import type { LayoutIssue } from './replay-layout';
import { measureTable, smallTargets, tablePlaces, type TableReport } from './table-layout';

/**
 * The live 6-seat table, one player with five bots, on phones held upright, from the smallest still in use (320×568)
 * to a large Android (412×839), in Korean and on the narrowest in English too (Chrome emulation, not devices). Each opens
 * the table while the player waits and on their turn, opens the raise panel and closes it again.
 *
 * Waiting and on the turn every seat, bet, the board and every control has its own room and each bet lies by its own
 * seat (measureTable). With the panel open the panel, the bar, the turn line and the time bank are on screen, in reach
 * and at least 40px each way, and so is the table, every card, bet, stack, name and the pot read whole (hit-tested over
 * all their text), but where it is short of room (320 wide, `tight`): there pieces may touch, and what matters less may
 * lie under what matters more (a seat's name, status line and cards face down; a stack under the pot; the player's own
 * bet under their seat; their cards over the board's edge by 2px at most), while the player's cards, the board, the pot
 * and every other bet read whole. The table gets its room back when the panel closes.
 */
// English last: the language is the account's (chosen in the settings), so every screen after it would read English.
const PHONES = [
  { name: 'small phone 320×568', viewport: { width: 320, height: 568 }, scale: 2, locale: 'ko', tight: true },
  { name: 'Android 360×800', viewport: { width: 360, height: 800 }, scale: 3, locale: 'ko' },
  { name: 'iPhone SE 375×667', viewport: { width: 375, height: 667 }, scale: 2, locale: 'ko' },
  { name: 'iPhone 15 393×852', viewport: { width: 393, height: 852 }, scale: 3, locale: 'ko' },
  { name: 'Android 412×839', viewport: { width: 412, height: 839 }, scale: 2.625, locale: 'ko' },
  { name: 'small phone 320×568 (English)', viewport: { width: 320, height: 568 }, scale: 2, locale: 'en', tight: true },
];

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click();
}

test('6인 실시간 테이블, 세로 휴대폰 320~412px: 좌석·베팅·조작이 겹침 없이 화면 안에 있고, 레이즈 패널을 열어도 내 카드와 조작이 보이며 닫으면 테이블이 돌아온다', async ({ browser }) => {
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
    const raise = bar.locator('button[aria-expanded]');
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

    // The table makes way for the panel a frame after it opens (once the stack's room is measured), in one move: the
    // table's size is worked out with the room it gives, not measured a frame later (it moved twice; TEST_REPORT).
    expect(await tablePlaces(p, mine, () => raise.click()), `${sc.name}: the table moves once as the panel opens`).toBe(2);
    await expect(raise).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.getByTestId('action-commit')).toBeVisible();
    await expect.poll(async () => (await measureTable(p)).table, { message: `${sc.name}: table makes way for the panel` }).not.toEqual(before.table);
    // Every card's face, bet, stack, name and the pot hit-tested over the whole of its text or face.
    const open = await look('raise-open', /^(card|board|bet|stack|name|pot)-/);
    // The panel, the bar, the turn line and the time bank on screen, in reach and clear of the table.
    expect(open.issues.filter((x) => x.item.includes(':') || x.item.startsWith('line-')), `${sc.name} raise open: controls`).toEqual([]);
    expect(await smallTargets(p), `${sc.name} raise open: small targets`).toEqual([]);
    const own = (id = '') => id.startsWith(`card-${mine}-`);
    expect(open.items.filter((x) => own(x)), `${sc.name} raise open: own cards`).toHaveLength(2);
    // The table with nothing over anything, but where it is short of room while the panel is open (320 wide, `tight`):
    // there no way of laying six seats and their bets out in it leaves nothing overlapping (layout.ts lays the least,
    // the board's cards and each bet by its own seat first), so pieces may touch, and what matters less may lie under
    // what matters more (the order the table keeps: the player's own cards, the board and the pot, the bets and stacks,
    // then the rest). The player's own cards, the board's cards, the pot and every other bet still read whole (the dense
    // hit tests), and so does every stack but the one of the seat across the table under the pot (the pot's row lies on
    // it: the three seats at the top take the whole width). What may lie under them: a seat's name (cut short to a letter
    // here), its status line (the last action, a bot's level) and its cards face down, and the player's own bet under
    // their own seat (its amount is on the call and the raise: "N from your stack"). The player's own cards lie over the
    // board's edge (drawn above it) by 2px at most (TEST_REPORT).
    const by = (x: LayoutIssue) => (x.by ?? '').split(' | ');
    const tight = (x: LayoutIssue) => {
      if (!('tight' in sc)) return false;
      if (x.kind === 'covered') {
        if (/^(name-\d+|status-\d+-\d+)$/.test(x.item)) return true;
        const back = /^card-(\d+)-\d+$/.exec(x.item);
        if (back) return back[1] !== mine;
        if (x.item === `bet-${mine}`) return by(x).every((b) => b.startsWith(`seat-${mine}>`) || b.startsWith(`card-${mine}-`) || b.startsWith('react-open'));
        return /^stack-\d+$/.test(x.item) && by(x).every((b) => b === 'pot' || b.startsWith('pot>'));
      }
      if (x.kind !== 'overlap') return false;
      if (own(x.item) || own(x.by)) {
        const other = own(x.item) ? x.by! : x.item;
        return other === `bet-${mine}` || (/^board-\d+$/.test(other) && (x.px ?? 0) <= 2);
      }
      return true;
    };
    expect(open.issues.filter((x) => !x.item.includes(':') && !x.item.startsWith('line-') && !tight(x)), `${sc.name} raise open: table`).toEqual([]);

    expect(await tablePlaces(p, mine, () => raise.click()), `${sc.name}: the table moves once as the panel closes`).toBe(2);
    await expect(bar.getByTestId('action-commit')).toHaveCount(0);
    // The table takes its room back once the panel has closed (a frame for the stack to be read again).
    await expect.poll(async () => (await measureTable(p)).table, { message: `${sc.name}: table back to its size` }).toEqual(before.table);
    expect((await look('raise-closed')).issues, `${sc.name} raise closed`).toEqual([]);

    await act(p);
    await ctx.close();
  }

  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto('/table/e2e-phones');
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(6);
  await page.getByTestId('leave').click();
});
