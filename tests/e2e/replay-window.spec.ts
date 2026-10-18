import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { HandDetailDto } from '@jc/types';
import { buildReplay } from '../../apps/web/src/game/replay';
import { signUp, test, widerThanDevice } from './helpers';
import { HAND_2, HAND_6, HAND_9 } from './replay-hands';

/**
 * Upright phones too short for a 6- or 9-seat table and the replay's controls together: the table is drawn whole in a
 * window that scrolls, as tall as keeps the controls on screen, and each step scrolls the window to what it is about.
 */
const SE = { name: 'iphone-se', width: 375, height: 667, dpr: 2 };
const MEDIUM = [
  { name: 'iphone-15', width: 393, height: 852, dpr: 3 },
  { name: 'pixel-7', width: 412, height: 839, dpr: 2.625 },
  { name: 'android-360', width: 360, height: 800, dpr: 3 },
];
const REACH = ['replay-table', 'replay-phase-result', 'replay-slider', 'replay-next', 'replay-play', 'replay-speed-2'];

async function open(browser: Browser, state: Awaited<ReturnType<BrowserContext['storageState']>>, sc: typeof SE, hand: HandDetailDto) {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: true, hasTouch: true, deviceScaleFactor: sc.dpr, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.route(`**/api/me/hands/${hand.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hand) }));
  await p.goto(`/me/hands/${hand.id}`);
  await expect(p.getByTestId('replay-index')).toBeVisible();
  return { ctx, p };
}

/** How far the lowest control (and the table) runs past the bottom navigation, and how far the replay's top is under the header. */
const reach = (page: Page) =>
  page.evaluate((ids) => {
    const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed')!.getBoundingClientRect().top;
    const header = document.querySelector('header')!.getBoundingClientRect().bottom;
    const below = Math.max(...ids.map((id) => document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().bottom)) - nav;
    const under = header - document.querySelector('[data-testid=replay-status]')!.getBoundingClientRect().top;
    return { below, under, scrollY, windowed: document.querySelector('[data-testid=replay-table]')!.getAttribute('data-window') === '1' };
  }, REACH);

test('replay window: on upright phones the 6- and 9-seat replays open with the table, the timeline and play above the bottom navigation', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  for (const sc of MEDIUM) {
    for (const hand of [HAND_2, HAND_6, HAND_9]) {
      const where = `${sc.name} · ${hand.maxSeats} seats`;
      const { ctx, p } = await open(browser, state, sc, hand);
      expect(await widerThanDevice(p), where).toBe(false);
      // Measured once the table has taken its size: the first render assumes a wide box.
      await expect.poll(async () => (await reach(p)).below, where).toBeLessThanOrEqual(0);
      await p.waitForTimeout(400);
      const r = await reach(p);
      expect(r.below, where).toBeLessThanOrEqual(0);
      expect(r.under, where).toBeLessThanOrEqual(0);
      expect(r.scrollY, where).toBe(0);
      if (hand.maxSeats > 2) expect(r.windowed, where).toBe(true);
      await p.screenshot({ path: test.info().outputPath(`open-${sc.name}-${hand.maxSeats}.png`) });
      await ctx.close();
    }
  }

  // The smallest phone has no room for a window under the page's title: one scroll puts the replay under the header,
  // and then its step line, the table window and every control are on screen together.
  for (const hand of [HAND_6, HAND_9]) {
    const where = `${SE.name} · ${hand.maxSeats} seats`;
    const { ctx, p } = await open(browser, state, SE, hand);
    await expect.poll(async () => (await reach(p)).windowed, where).toBe(true);
    await p.waitForTimeout(400);
    await p.evaluate(() => scrollBy(0, document.querySelector('[data-testid=replay-status]')!.getBoundingClientRect().top - document.querySelector('header')!.getBoundingClientRect().bottom));
    const r = await reach(p);
    expect(r.below, where).toBeLessThanOrEqual(0);
    expect(r.under, where).toBeLessThanOrEqual(0.5);
    await p.screenshot({ path: test.info().outputPath(`open-${SE.name}-${hand.maxSeats}.png`) });
    await ctx.close();
  }
});

test('replay window: every step scrolls the window to the seat that acted, showed or won, or to the board; a finger scrolls it too', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  for (const sc of [MEDIUM[0]!, SE]) {
    for (const hand of [HAND_6, HAND_9]) {
      const where = `${sc.name} · ${hand.maxSeats} seats`;
      const { ctx, p } = await open(browser, state, sc, hand);
      await expect.poll(async () => (await reach(p)).windowed, where).toBe(true);
      await p.waitForTimeout(400);
      const steps = buildReplay(hand, 0);
      const index = p.getByTestId('replay-index');
      await expect(index).toHaveText(`1/${steps.length}`);
      for (let k = 1; k <= steps.length; k++) {
        if (k > 1) {
          await p.getByTestId('replay-next').evaluate((b: HTMLButtonElement) => b.click());
          await expect(index).toHaveText(`${k}/${steps.length}`);
        }
        const step = steps[k - 1]!;
        const seats = step.kind === 'deal' ? [0] : step.line.flatMap((x) => ('seat' in x ? [x.seat] : []));
        const sel = seats.flatMap((s) => [`[data-testid="seat-${s}"]`, `[data-testid="bet-${s}"]`]);
        if (step.line.some((x) => x.kind === 'board')) sel.push('[data-testid=board]');
        if (sel.length === 0) continue;
        // What the step is about lies inside the part of the window showing; when it is taller than the window, from its top.
        const seen = await p.evaluate((qs) => {
          const f = document.querySelector('[data-testid=replay-table]') as HTMLElement;
          const r = f.getBoundingClientRect();
          const lo = r.top + f.clientTop;
          const hi = lo + f.clientHeight;
          const boxes = qs.flatMap((q) => Array.from(f.querySelectorAll(q), (e) => e.getBoundingClientRect())).filter((b) => b.height > 0);
          const top = Math.min(...boxes.map((b) => b.top));
          const bottom = Math.max(...boxes.map((b) => b.bottom));
          return { n: boxes.length, top: top - lo, bottom: hi - bottom, tall: bottom - top > hi - lo };
        }, sel);
        expect(seen.n, `${where} · step ${k}: ${sel.join(' ')}`).toBeGreaterThan(0);
        expect(seen.top, `${where} · step ${k}: top inside the window`).toBeGreaterThanOrEqual(-0.5);
        if (!seen.tall) expect(seen.bottom, `${where} · step ${k}: bottom inside the window`).toBeGreaterThanOrEqual(-0.5);
      }

      // A finger drags the table up and down inside its window; the page stays where it was.
      const frame = p.getByTestId('replay-table');
      await expect(frame).toHaveAttribute('role', 'region');
      await expect(frame).toHaveAttribute('aria-label', /.+/);
      await frame.evaluate((f) => f.scrollTo({ top: 0 }));
      const box = (await frame.boundingBox())!;
      const x = box.x + box.width / 2;
      const cdp = await p.context().newCDPSession(p);
      const before = await p.evaluate(() => scrollY);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + box.height * 0.75 }] });
      for (let s = 1; s <= 10; s++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: box.y + box.height * (0.75 - (0.4 * s) / 10) }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => frame.evaluate((f) => f.scrollTop), where).toBeGreaterThan(20);
      expect(await p.evaluate(() => scrollY), where).toBe(before);
      await ctx.close();
    }
  }
});
