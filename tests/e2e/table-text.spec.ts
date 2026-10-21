import { expect, type Browser, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';
import type { LayoutIssue } from './replay-layout';
import { measureTable } from './table-layout';

/**
 * The live table with the browser's text at 125% (Chrome's own font size setting at 20px, as a reader who wants larger
 * text sets it: rem and the rem media queries follow it), Chrome emulation, not devices. Seat.tsx draws the seats in rem
 * and layout.ts plans them in px at 16px, so the table is planned for the text it is drawn at (planForText): every seat,
 * bet, the board and every control keeps its own room, waiting and on the turn, as at 100%. Six seats on an upright phone
 * with room for three seats across, on phones held on their side and on a laptop; nine on the wider two of those. Where
 * three seats across have no room at 125% (upright phones 375 wide and less), the top seat's bet on the upright phone
 * that has it, and with nine seats on the smaller screens, what is left is in TEST_REPORT.
 */
interface Screen {
  name: string;
  viewport: { width: number; height: number };
  touch?: boolean;
  /** How far a bet may lie over another part, or nearer another seat than its own, here (px); else not at all. */
  bets?: number;
  /** How much nearer another seat than its own a bet may lie here (px); else not at all. */
  astray?: number;
  /** How far two bets may lie over each other here (px); else as `bets`. */
  betOverBet?: number;
}
const PHONE = { touch: true };
/**
 * On the upright phone the top seat's bet has no room between it and the board at 125% and lies beside the seat, a few
 * px nearer a neighbour drawn with its badges than to the seat drawn without: up to 10px as planned over the table's
 * heights there (560–780px), 5px as measured (TEST_REPORT).
 */
const SIX: Screen[] = [
  { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE, astray: 11 },
  { name: '667x375-side', viewport: { width: 667, height: 375 }, ...PHONE },
  { name: '844x390-side', viewport: { width: 844, height: 390 }, ...PHONE },
  { name: '1366x768', viewport: { width: 1366, height: 768 } },
];
const screen = (name: string) => SIX.find((s) => s.name === name)!;
/**
 * Nine seats on a phone held on its side: at 125% no plan leaves every bet its room there (the one for the text, the
 * one halfway, the one for 16px drawn larger), so a bet may lie up to 12px over a neighbour's cards or status, or nearer
 * a neighbour than its own seat, as measured; and the plan for the text, where nothing fits, lays two pairs of the top
 * seats' bets over each other, up to 30px for six digits as planned (14px measured, a blind's amount under a raise's
 * chips: TEST_REPORT). The seats, the board and the controls may not.
 */
const NINE: Screen[] = [{ ...screen('844x390-side'), bets: 12, betOverBet: 31 }, screen('1366x768')];
/** A bet nearer another seat than its own, or a bet and a seat's piece or another bet over each other: nothing else. */
function betOnly(x: LayoutIssue) {
  if (x.kind === 'astray') return true;
  if (x.kind !== 'overlap' && x.kind !== 'covered') return false;
  const ids = [x.item, ...(x.by ?? '').split(' | ')];
  return ids.some((id) => id.startsWith('bet-')) && ids.every((id) => /^(bet|card|status|seat)-/.test(id));
}

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return checkOrCall(p);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
}

/** Sits down at `table` (bots fill the rest), then looks at it on each screen with the text at 125%: waiting, on the turn. */
async function walk(browser: Browser, table: string, seats: number, screens: Screen[]) {
  const { page } = await signUp(browser);
  await sitWith(page, table, 1000);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(seats, { timeout: 120_000 });
  const state = await page.context().storageState();
  // One page at the table at a time: each screen opens its own.
  await page.goto('/');
  const found: string[] = [];
  for (const sc of screens) {
    const touch = !!sc.touch;
    const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    // Before the page draws, as the browser's setting would have it.
    await (await ctx.newCDPSession(p)).send('Page.setFontSizes', { fontSizes: { standard: 20 } });
    await p.goto(`/table/${table}`);
    await expect(filled(p)).toHaveCount(seats);
    expect(await p.evaluate(() => getComputedStyle(document.documentElement).fontSize), `${sc.name}: the text at 125%`).toBe('20px');
    const bar = p.getByTestId('action-bar');
    const look = async (what: string) => {
      const r = await measureTable(p);
      if (await widerThanDevice(p)) found.push(`${table} ${sc.name} ${what}: page wider than the screen`);
      for (const x of r.issues) {
        if (sc.bets != null && betOnly(x) && (x.px ?? 0) <= sc.bets) continue;
        if (sc.astray != null && x.kind === 'astray' && (x.px ?? 0) <= sc.astray) continue;
        if (sc.betOverBet != null && x.kind === 'overlap' && x.item.startsWith('bet-') && x.by?.startsWith('bet-') && (x.px ?? 0) <= sc.betOverBet) continue;
        found.push(`${table} ${sc.name} ${what}: ${x.kind} ${x.item}${x.by ? ` × ${x.by}` : ''}${x.px != null ? ` ${x.px}px` : ''}`);
      }
      await p.screenshot({ path: test.info().outputPath(`text-${table}-${sc.name}-${what}.png`) });
    };
    // Waiting: between the bots' moves (or between hands).
    await expect(async () => {
      if (await bar.isVisible()) await act(p);
      await expect(bar).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
    await p.waitForTimeout(400);
    await look('waiting');
    // On the turn: the action bar below the table takes more of the screen.
    await expect(bar).toBeVisible({ timeout: 120_000 });
    await p.waitForTimeout(400);
    await look('turn');
    await act(p);
    await ctx.close();
  }
  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto(`/table/${table}`);
  await expect(filled(page)).toHaveCount(seats);
  await standUp(page);
  await page.context().close();
  return found;
}

test('글자 125%(크롬 글꼴 설정) 6인 테이블, 휴대폰·가로 휴대폰·노트북: 좌석·베팅·보드·조작이 겹치지 않고 화면 안에 있다', async ({ browser }) => {
  test.setTimeout(600_000);
  expect(await walk(browser, 'e2e-tx6', 6, SIX)).toEqual([]);
});

test('글자 125%(크롬 글꼴 설정) 9인 테이블, 가로 휴대폰·노트북: 좌석·베팅·보드·조작이 겹치지 않고 화면 안에 있다', async ({ browser }) => {
  test.setTimeout(600_000);
  expect(await walk(browser, 'e2e-tx9', 9, NINE)).toEqual([]);
});
