import { expect, type Page } from '@playwright/test';
import { setRange, signUp, standUp, test } from './helpers';

/**
 * The table is a fixed stage: what the game does around it never changes its size or place on a screen (Table.tsx's
 * dockBand). One player, bots in the other seats, on phones upright and on their side, a tablet and a desktop (Chrome
 * emulation, not devices), from watching through sitting down, waiting, the reaction tray open and shut, the turn, the
 * raise panel open and shut, the fold, to standing up. At each step, once the table's box has stopped moving, it must
 * be the one it was while only watching (to a pixel's fraction), and the dock under it (or beside it, on its side) may
 * cover none of my cards, the board or the pot.
 */
const SCREENS = [
  { name: '320x568', viewport: { width: 320, height: 568 }, touch: true },
  { name: '390x844', viewport: { width: 390, height: 844 }, touch: true },
  { name: '844x390', viewport: { width: 844, height: 390 }, touch: true },
  { name: '768x1024', viewport: { width: 768, height: 1024 }, touch: true },
  { name: '1366x768', viewport: { width: 1366, height: 768 }, touch: false },
];
const TABLE = 'e2e-stable';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolves once the table's box has held still for 400 ms (5 s at most), with that box. */
function settledTable(p: Page): Promise<Box | null> {
  return p.evaluate(
    () =>
      new Promise<Box | null>((done) => {
        const box = () => {
          const b = document.querySelector('[data-testid=table]')?.getBoundingClientRect();
          return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
        };
        const start = performance.now();
        let last = JSON.stringify(box());
        let still = start;
        const tick = (now: number) => {
          const at = JSON.stringify(box());
          if (at !== last) [last, still] = [at, now];
          if (now - still >= 400 || now - start >= 5_000) done(box());
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** The pieces of the dock that cover something of the game, as drawn: each pair by the smaller side they share (px). */
function covering(p: Page, mine: string | null): Promise<string[]> {
  return p.evaluate((mine) => {
    const box = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      return b && b.width >= 1 && b.height >= 1 ? b : null;
    };
    const seat = mine ? document.querySelector(`[data-testid="seat-${mine}"]`) : null;
    const game: [string, DOMRect | null][] = [
      ['board', box(document.querySelector('[data-testid=board]'))],
      ['pot', box(document.querySelector('[data-testid=pot]'))],
      ...Array.from(seat?.querySelectorAll('.jc-card') ?? []).map((c, i): [string, DOMRect | null] => [`my card ${i + 1}`, box(c)]),
    ];
    const dock: [string, DOMRect | null][] = [
      ['action bar', box(document.querySelector('[data-testid=action-bar]'))],
      ['time bank', box(document.querySelector('[data-testid=time-bank]'))],
      ['pre-actions', box(document.querySelector('[data-testid=pre-actions]'))],
      ['reaction tray', box(document.querySelector('[data-testid=react-tray]'))],
      ['wallet', box(document.querySelector('[data-testid=wallet]'))],
    ];
    const out: string[] = [];
    for (const [a, ba] of dock)
      for (const [b, bb] of game) {
        if (!ba || !bb) continue;
        const shared = Math.min(Math.min(ba.right, bb.right) - Math.max(ba.left, bb.left), Math.min(ba.bottom, bb.bottom) - Math.max(ba.top, bb.top));
        if (shared > 1) out.push(`${a} over ${b} by ${Math.round(shared)}px`);
      }
    return out;
  }, mine);
}

async function act(p: Page, prefer: 'check' | 'fold') {
  const bar = p.getByTestId('action-bar');
  const order = prefer === 'fold' ? [/^(폴드|Fold)$/, /^(체크|Check)$/] : [/^(체크|Check)$/, /^(폴드|Fold)$/];
  for (const name of order) {
    const b = bar.getByRole('button', { name });
    if (await b.isVisible().catch(() => false)) return b.click().catch(() => {});
  }
}

test('the table keeps its size and place whatever the game does round it', async ({ browser }) => {
  test.setTimeout(900_000);
  const { page, nickname } = await signUp(browser);
  const state = await page.context().storageState();
  await page.close();

  for (const sc of SCREENS) {
    await test.step(sc.name, async () => {
      const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, isMobile: sc.touch, hasTouch: sc.touch, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      let stage: Box | null = null;
      let mine: string | null = null;
      const check = async (what: string) => {
        const at = await settledTable(p);
        expect(at, `${sc.name} ${what}: table drawn`).not.toBeNull();
        if (!stage) stage = at;
        for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(at![k] - stage![k]), `${sc.name} ${what}: table ${k} ${at![k]} (watching: ${stage![k]})`).toBeLessThan(0.5);
        expect(await covering(p, mine), `${sc.name} ${what}`).toEqual([]);
        await p.screenshot({ path: test.info().outputPath(`${sc.name}-${what}.png`) });
      };

      await p.goto(`/table/${TABLE}`);
      await expect(p.getByTestId('table')).toBeVisible({ timeout: 60_000 });
      await check('watching');

      // The screen before folded and stood up: its hand keeps me until it ends, so ask until a seat is offered.
      const confirm = p.getByTestId('buyin-confirm');
      await expect(async () => {
        await p.goto(`/table/${TABLE}?sit=1`);
        await expect(confirm).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 180_000 });
      await check('buy-in');
      await setRange(p.getByRole('dialog').locator('input[type="range"]'), 1000);
      await confirm.click();
      await expect(confirm).toHaveCount(0);
      const seat = p.locator('[data-testid=table] [data-testid^="seat-"][data-state]').filter({ has: p.getByText(nickname, { exact: true }) });
      await expect(seat).toHaveCount(1, { timeout: 60_000 });
      mine = (await seat.getAttribute('data-testid'))!.slice('seat-'.length);
      await check('seated');

      const bar = p.getByTestId('action-bar');
      const tray = p.getByTestId('react-tray');
      // Off my turn, with the tray open and shut (my turn shuts it: then try again on the next wait).
      await expect(async () => {
        if (await bar.isVisible()) await act(p, 'check');
        await expect(bar).toBeHidden({ timeout: 2_000 });
        await check('waiting');
        const opener = p.getByTestId('react-open');
        await (sc.touch ? opener.tap() : opener.click());
        await expect(tray).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 180_000 });
      await check('tray open');
      await p.keyboard.press('Escape');
      await expect(tray).toHaveCount(0);
      await check('tray shut');

      // My turn with a raise to make: the panel open and shut, then the fold.
      const raise = bar.locator('button[aria-expanded]');
      await expect(async () => {
        await expect(bar).toBeVisible({ timeout: 60_000 });
        if (!(await raise.isVisible())) {
          await act(p, 'check');
          throw new Error('no raise offered on this turn');
        }
      }).toPass({ timeout: 240_000 });
      await check('my turn');
      await raise.click();
      await expect(bar.getByTestId('action-commit')).toBeVisible();
      await check('raise open');
      await raise.click();
      await expect(bar.getByTestId('action-commit')).toHaveCount(0);
      await check('raise shut');
      await act(p, 'fold');
      await expect(bar).toBeHidden({ timeout: 10_000 });
      await check('folded');

      await standUp(p);
      await expect(p.getByTestId('left-next')).toBeVisible({ timeout: 60_000 });
      mine = null;
      await check('stood up');
      await ctx.close();
    });
  }
});
