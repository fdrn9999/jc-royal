import { expect, type Browser, type Page } from '@playwright/test';
import { signUp, sitWith, standUp, test } from './helpers';

/**
 * The board on the felt at a live table, with bots in the other seats, on the screens the table is played on (Chrome
 * emulation, not devices): its cards' middle on the felt's middle, and the cards inside the line drawn round the felt,
 * not over it or out to the rail. Seated, waiting, on the turn and with the raise panel open (each gives the table
 * another area), with two, six and nine seats.
 */
interface Screen {
  name: string;
  viewport: { width: number; height: number };
  touch?: boolean;
}
const PHONE = { touch: true };
const SCREENS: Screen[] = [
  { name: '320x568', viewport: { width: 320, height: 568 }, ...PHONE },
  { name: '360x640', viewport: { width: 360, height: 640 }, ...PHONE },
  { name: '375x667', viewport: { width: 375, height: 667 }, ...PHONE },
  { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE },
  { name: '430x932', viewport: { width: 430, height: 932 }, ...PHONE },
  { name: '768x1024', viewport: { width: 768, height: 1024 }, ...PHONE },
  { name: '1024x768', viewport: { width: 1024, height: 768 } },
  { name: '1366x768', viewport: { width: 1366, height: 768 } },
  { name: '1920x1080', viewport: { width: 1920, height: 1080 } },
  { name: '844x390-side', viewport: { width: 844, height: 390 }, ...PHONE },
  { name: '667x375-side', viewport: { width: 667, height: 375 }, ...PHONE },
];
const pick = (...names: string[]) => SCREENS.filter((s) => names.includes(s.name));

interface Seen {
  screen: string;
  state: string;
  density: string;
  /** The board's middle less the felt's (px). */
  dx: number;
  dy: number;
  /** The board's width and height as shares of the felt's. */
  w: number;
  h: number;
  /** How far out the board's farthest corner lies on the felt's line (1: on it, more: past it). */
  corner: number;
  board: string;
  felt: string;
}

/** The board and the felt as drawn. */
function measure(p: Page): Promise<Omit<Seen, 'screen' | 'state'>> {
  return p.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const felt = box('[data-testid=felt]');
    const line = box('[data-testid=felt] > :first-child');
    const board = box('[data-testid=board]');
    const mid = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const f = mid(line);
    const b = mid(board);
    const dx = b.x - f.x;
    const dy = b.y - f.y;
    const round = (x: number, k = 10) => Math.round(x * k) / k;
    return {
      density: document.querySelector('[data-testid=table]')!.getAttribute('data-density') ?? '',
      dx: round(dx),
      dy: round(dy),
      w: round(board.width / felt.width, 100),
      h: round(board.height / felt.height, 100),
      corner: round(Math.hypot((Math.abs(dx) + board.width / 2) / (line.width / 2), (Math.abs(dy) + board.height / 2) / (line.height / 2)), 100),
      board: `${Math.round(board.width)}×${Math.round(board.height)}`,
      felt: `${Math.round(felt.width)}×${Math.round(felt.height)}`,
    };
  });
}

async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return check.click().catch(() => {});
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
}

/** Sits down at `table` (bots fill the rest), then looks at the board on each screen: waiting, on the turn, raising. */
async function walk(browser: Browser, table: string, seats: number, screens: Screen[]) {
  const { page } = await signUp(browser);
  await sitWith(page, table, 1000);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(seats, { timeout: 120_000 });
  const state = await page.context().storageState();
  await page.goto('/');
  const seen: Seen[] = [];
  for (const sc of screens) {
    const touch = !!sc.touch;
    const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto(`/table/${table}`);
    await expect(filled(p)).toHaveCount(seats);
    const bar = p.getByTestId('action-bar');
    const look = async (state: string) => {
      seen.push({ screen: sc.name, state, ...(await measure(p)) });
      await p.screenshot({ path: test.info().outputPath(`board-${table}-${sc.name}-${state}.png`) });
    };
    await expect(async () => {
      if (await bar.isVisible()) await act(p);
      await expect(bar).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
    await p.waitForTimeout(300);
    await look('waiting');
    await expect(bar).toBeVisible({ timeout: 120_000 });
    await p.waitForTimeout(300);
    await look('turn');
    const raise = bar.getByTestId('action-dock-toggle');
    if (await raise.isVisible()) {
      await raise.click();
      await expect(bar.locator('[data-raise-panel]')).toBeVisible();
      await p.waitForTimeout(200);
      await look('raise');
      await raise.click();
    }
    await act(p);
    await ctx.close();
  }
  await page.goto(`/table/${table}`);
  await expect(filled(page)).toHaveCount(seats);
  await standUp(page);
  await page.context().close();
  return seen;
}

/** Writes what was seen for the report (TEST_REPORT), and says each look whose board is off the felt's middle or past its line. */
async function report(name: string, seen: Seen[]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('test-results/board', { recursive: true });
  writeFileSync(`test-results/board/${name}.json`, JSON.stringify(seen, null, 1));
  for (const s of seen) console.log(`board ${name} ${s.screen} ${s.state}: ${JSON.stringify({ ...s, screen: undefined, state: undefined })}`);
  return {
    off: seen.filter((s) => Math.abs(s.dx) > 1 || Math.abs(s.dy) > 2).map((s) => `${name} ${s.screen} ${s.state}: ${s.dx},${s.dy}`),
    out: seen.filter((s) => s.corner > 1).map((s) => `${name} ${s.screen} ${s.state}: ${s.corner}`),
  };
}
function hold(...found: { off: string[]; out: string[] }[]) {
  expect(found.flatMap((x) => x.off), "the board's middle on the felt's").toEqual([]);
  expect(found.flatMap((x) => x.out), "the board inside the felt's line").toEqual([]);
}

test('6인 테이블, 휴대폰부터 FHD까지 11개 화면: 보드는 펠트 가운데, 펠트 안쪽 선 안에 놓인다', async ({ browser }) => {
  test.setTimeout(900_000);
  hold(await report('six', await walk(browser, 'e2e-bd6', 6, SCREENS)));
});

test('2인과 9인 테이블: 보드는 펠트 가운데, 펠트 안쪽 선 안에 놓인다', async ({ browser }) => {
  test.setTimeout(900_000);
  const two = await walk(browser, 'e2e-bd2', 2, pick('320x568', '390x844', '768x1024', '1366x768', '1920x1080', '667x375-side'));
  const nine = await walk(browser, 'e2e-bd9', 9, pick('320x568', '375x667', '430x932', '1024x768', '1920x1080', '844x390-side'));
  hold(await report('two', two), await report('nine', nine));
});
