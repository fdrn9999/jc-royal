import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { HAND_2, HAND_6, HAND_9 } from './replay-hands';
import { measureReplay, type LayoutReport } from './replay-layout';

// Phones upright and on their side, a tablet, a laptop and a desktop.
const SCREENS = [
  { name: 'iphone-se', width: 375, height: 667, mobile: true, dpr: 2 },
  { name: 'iphone-15', width: 393, height: 852, mobile: true, dpr: 3 },
  { name: 'android-360', width: 360, height: 800, mobile: true, dpr: 3 },
  { name: 'pixel-7', width: 412, height: 839, mobile: true, dpr: 2.625 },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true, dpr: 3 },
  { name: 'tablet', width: 768, height: 1024, mobile: true, dpr: 2 },
  { name: 'laptop', width: 1280, height: 720, mobile: false, dpr: 1 },
  { name: 'desktop', width: 1440, height: 900, mobile: false, dpr: 1 },
];

/** The step, table and controls areas: their boxes, and how the controls are placed. */
const areas = (page: Page) =>
  page.evaluate(() => {
    const box = (id: string) => {
      const r = document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    return {
      boxes: [box('replay-status'), box('replay-table'), box('replay-controls')],
      position: getComputedStyle(document.querySelector('[data-testid=replay-controls]')!).position,
    };
  });

/** Where the status, the step line, the table and the controls sit in the page, and how big each is. */
const placed = (page: Page) =>
  page.evaluate(() =>
    ['replay-status', 'replay-step', 'replay-table', 'replay-controls'].map((id) => {
      const r = document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
      return `${id} ${Math.round(r.left)},${Math.round(r.top + scrollY)} ${Math.round(r.width)}×${Math.round(r.height)}`;
    }),
  );

/** Problems no scroll position excuses: overlapping pieces, anything cut off by the table or the screen, anything drawn over. */
const hard = (m: LayoutReport) => m.issues.filter((x) => x.kind === 'overlap' || x.kind === 'clipped' || x.kind === 'covered');

test('replay: at 2, 6 and 9 seats on phones, a tablet and desktops, every seat, card, bet, pot and control has a place of its own', async ({ browser }) => {
  test.setTimeout(600_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  for (const sc of SCREENS) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: sc.mobile, hasTouch: sc.mobile, deviceScaleFactor: sc.dpr, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    for (const hand of [HAND_2, HAND_6, HAND_9]) {
      const where = `${sc.name} · ${hand.maxSeats} seats`;
      // Long nicknames, a staff member and a bot, side pots, a split pot: the stored hand comes from the fixture.
      await p.route(`**/api/me/hands/${hand.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hand) }));
      await p.goto(`/me/hands/${hand.id}`);
      const index = p.getByTestId('replay-index');
      await expect(index).toBeVisible();
      const total = Number((await index.textContent())!.split('/')[1]);
      expect(await widerThanDevice(p), where).toBe(false);

      // Three areas side by side or one under another, never over one another; the controls stay in the page's flow.
      const a = await areas(p);
      expect(a.position, where).toBe('static');
      for (let x = 0; x < 3; x++)
        for (let y = x + 1; y < 3; y++) {
          const [m, n] = [a.boxes[x]!, a.boxes[y]!];
          expect(Math.min(m.r, n.r) - Math.max(m.l, n.l) <= 0.5 || Math.min(m.b, n.b) - Math.max(m.t, n.t) <= 0.5, `${where}: areas ${x} and ${y}`).toBe(true);
        }

      let first: string[] | null = null;
      for (let k = 1; k <= total; k++) {
        if (k > 1) {
          await p.getByTestId('replay-next').evaluate((b: HTMLButtonElement) => b.click());
          await expect(index).toHaveText(`${k}/${total}`);
        }
        // Scrolled to the top of the replay and to its end: nothing overlaps, is cut off or drawn over in either, and
        // every piece shows whole in at least one (a 9-seat table on the smallest phones is taller than the screen).
        // Where the settlement under the controls fills the end, the controls show whole once scrolled to them.
        const top = await measureReplay(p, 'table');
        const end = await measureReplay(p, 'bottom');
        expect(hard(top), `${where} · step ${k} from the top`).toEqual([]);
        expect(hard(end), `${where} · step ${k} at the end`).toEqual([]);
        const hidden = (m: LayoutReport) => new Set(m.issues.filter((x) => x.kind === 'offscreen').map((x) => x.item));
        const [h1, h2] = [hidden(top), hidden(end)];
        let never = top.items.filter((x) => h1.has(x) && h2.has(x));
        if (never.length > 0 || top.window) {
          const reach = await measureReplay(p, 'controls');
          expect(hard(reach), `${where} · step ${k} at the controls`).toEqual([]);
          const h3 = hidden(reach);
          never = never.filter((x) => h3.has(x));
          // A table in a window (upright phones): scrolled through half a window at a time with the controls in reach,
          // nothing overlaps, is cut off or drawn over anywhere, and every piece shows whole somewhere.
          if (reach.window) {
            const { max, view } = reach.window;
            for (let at = 0; ; at = Math.min(max, at + Math.max(1, Math.floor(view / 2)))) {
              const m = await measureReplay(p, 'controls', undefined, at);
              expect(hard(m), `${where} · step ${k} with the table window at ${at}/${max}`).toEqual([]);
              const h = hidden(m);
              never = never.filter((x) => h.has(x));
              if (at >= max) break;
            }
          }
        }
        expect(never, `${where} · step ${k} never whole on screen`).toEqual([]);
        // From step to step nothing above the settlement moves or changes size: not for the long payout line, the side
        // pots or the step count (taken once measuring has given the first step's table time to take its size).
        const at = await placed(p);
        first ??= at;
        expect(at, `${where} · step ${k} placed as step 1`).toEqual(first);
      }
      await p.screenshot({ path: test.info().outputPath(`replay-${sc.name}-${hand.maxSeats}.png`), fullPage: true });
    }
    await ctx.close();
  }
});
