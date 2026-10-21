import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { HAND_2, HAND_6, HAND_9 } from './replay-hands';
import { measureReplay, type LayoutReport } from './replay-layout';

// A phone upright and on its side, and a desktop: the folded controls and the capture mode at 2, 6 and 9 seats on each.
const SCREENS = [
  { name: 'phone', width: 390, height: 844, mobile: true, dpr: 3 },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true, dpr: 3 },
  { name: 'desktop', width: 1440, height: 900, mobile: false, dpr: 1 },
];

/** Overlapping pieces, anything cut off by the table or the screen, anything drawn over (as replay-layout.spec.ts). */
const hard = (m: LayoutReport) => m.issues.filter((x) => x.kind === 'overlap' || x.kind === 'clipped' || x.kind === 'covered');

const height = (page: Page, id: string) => page.getByTestId(id).evaluate((e) => e.getBoundingClientRect().height);

/** The faces showing in an area, in order: the capture must show those the replay's table does, no more. */
const faces = (page: Page, id: string) => page.getByTestId(id).evaluate((e) => Array.from(e.querySelectorAll('[data-card]')).map((c) => c.getAttribute('data-card')).sort());

/** Every seat, the board and the pot in the capture: whole inside the screen and inside its table area. */
const outside = (page: Page) =>
  page.evaluate(() => {
    const area = document.querySelector('[data-testid=capture-table]')!.getBoundingClientRect();
    const [w, h] = [innerWidth, innerHeight];
    const capture = document.querySelector('[data-testid=replay-capture]')!;
    const parts = Array.from(capture.querySelectorAll('[data-testid]')).filter((e) => /^(seat-\d+|board|pot)$/.test(e.getAttribute('data-testid')!));
    const out: string[] = [];
    for (const e of parts) {
      const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > w + 0.5 || r.bottom > h + 0.5) out.push(`${e.getAttribute('data-testid')} off screen`);
      if (r.left < area.left - 0.5 || r.top < area.top - 0.5 || r.right > area.right + 0.5 || r.bottom > area.bottom + 0.5) out.push(`${e.getAttribute('data-testid')} outside the table area`);
    }
    return { out, seats: parts.filter((e) => e.getAttribute('data-testid')!.startsWith('seat-')).length };
  });

/** What is drawn at the top and the bottom of the screen: the capture, not the page's header or navigation over it. */
const onTop = (page: Page) =>
  page.evaluate(() => [4, innerHeight - 4].map((y) => !!document.elementFromPoint(innerWidth / 2, y)?.closest('[data-testid=replay-capture]')));

test('replay modes: folded controls give the table their room, and the capture shows the whole table, its facts and the result with no controls', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  for (const sc of SCREENS) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: sc.mobile, hasTouch: sc.mobile, deviceScaleFactor: sc.dpr, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    for (const hand of [HAND_2, HAND_6, HAND_9]) {
      const where = `${sc.name} · ${hand.maxSeats} seats`;
      await p.route(`**/api/me/hands/${hand.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hand) }));
      await p.goto(`/me/hands/${hand.id}`);
      const index = p.getByTestId('replay-index');
      await expect(index).toHaveText(/^1\//);
      const total = Number((await index.textContent())!.split('/')[1]);
      const controls = p.getByTestId('replay-controls');
      const fold = p.getByTestId('replay-fold');

      // Normal: every control, and the button to fold them.
      await expect(controls).toHaveAttribute('data-mode', 'normal');
      await expect(fold).toHaveAttribute('aria-expanded', 'true');
      await expect(p.getByTestId('replay-timeline')).toBeVisible();
      await expect(p.getByTestId('replay-slider')).toBeVisible();
      await expect(p.getByTestId('replay-speed-2')).toBeVisible();
      const before = { table: await height(p, 'replay-table'), controls: await height(p, 'replay-controls') };
      await p.screenshot({ path: test.info().outputPath(`modes-${sc.name}-${hand.maxSeats}-normal.png`) });

      // Folded: the step, previous, play and next; the table takes the room the rest leaves.
      await fold.click();
      await expect(controls).toHaveAttribute('data-mode', 'focus');
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(p.getByTestId('replay-compact')).toBeVisible();
      await expect(p.getByTestId('replay-timeline')).toHaveCount(0);
      await expect(p.getByTestId('replay-slider')).toHaveCount(0);
      await expect(p.getByTestId('replay-step')).toHaveCSS('-webkit-line-clamp', '2');
      await expect.poll(() => height(p, 'replay-controls'), where).toBeLessThan(before.controls - 20);
      await expect.poll(() => height(p, 'replay-table'), where).toBeGreaterThanOrEqual(before.table - 0.5);
      expect(await widerThanDevice(p), where).toBe(false);
      expect(hard(await measureReplay(p, 'table')), `${where} · folded, from the top`).toEqual([]);
      expect(hard(await measureReplay(p, 'bottom')), `${where} · folded, at the end`).toEqual([]);
      await p.getByTestId('replay-next').click();
      await expect(index).toHaveText(`2/${total}`);
      await p.getByTestId('replay-prev').click();
      await expect(index).toHaveText(`1/${total}`);
      await p.getByTestId('replay-play').click();
      await expect(p.getByTestId('replay-play')).toHaveAttribute('aria-pressed', 'true');
      await p.getByTestId('replay-play').click();
      await expect(p.getByTestId('replay-play')).toHaveAttribute('aria-pressed', 'false');
      const folded = await height(p, 'replay-table');
      await p.screenshot({ path: test.info().outputPath(`modes-${sc.name}-${hand.maxSeats}-focus.png`) });
      test.info().annotations.push({ type: 'table', description: `${where}: table ${Math.round(before.table)} → ${Math.round(folded)} px, controls ${Math.round(before.controls)} → ${Math.round(await height(p, 'replay-controls'))} px` });

      // Unfolded again: everything is back.
      await fold.click();
      await expect(controls).toHaveAttribute('data-mode', 'normal');
      await expect(p.getByTestId('replay-timeline')).toBeVisible();
      await expect(p.getByTestId('replay-step')).toHaveCSS('-webkit-line-clamp', '3');

      // Capture: over the header and navigation, the whole table in the screen, the same cards as the replay's table.
      const open = p.getByTestId('replay-capture-open');
      await open.click();
      const capture = p.getByTestId('replay-capture');
      await expect(capture).toBeVisible();
      await expect(capture).toHaveAttribute('role', 'dialog');
      await expect(p.getByTestId('replay-capture-close')).toBeFocused();
      // The page under it is out of reach: Tab goes round its own buttons (and the browser's), never into the page.
      expect(await p.evaluate(() => document.getElementById('root')!.inert), where).toBe(true);
      for (let k = 0; k < 6; k++) {
        await p.keyboard.press('Tab');
        expect(await p.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('[data-testid=replay-capture]')), `${where} · Tab ${k + 1}`).toBe(true);
      }
      await p.getByTestId('replay-capture-close').focus();
      await expect(p.getByTestId('replay-play')).toHaveAttribute('aria-pressed', 'false');
      expect(await onTop(p), where).toEqual([true, true]);
      for (let k = 1; k <= total; k++) {
        if (k > 1) await p.keyboard.press('ArrowRight');
        await expect(index).toHaveText(`${k}/${total}`);
        // The table follows its area a frame after the step is drawn (the result's lines under it take some of the area's
        // height on the last step): measured once it has.
        await expect.poll(async () => (await outside(p)).out, `${where} · step ${k}`).toEqual([]);
        const o = await outside(p);
        expect(o.seats, `${where} · step ${k}`).toBe(hand.maxSeats);
        // Every name, stack, card, bet, pot and line on the table readable: nothing overlaps, is cut off, drawn over or
        // off the screen.
        const m = await measureReplay(p, 'none', '[data-testid=replay-capture]');
        expect([...hard(m), ...m.issues.filter((x) => x.kind === 'offscreen')], `${where} · capture step ${k}`).toEqual([]);
        expect(await faces(p, 'capture-table'), `${where} · step ${k}`).toEqual(await faces(p, 'replay-table'));
        if (k === 1) await p.screenshot({ path: test.info().outputPath(`modes-${sc.name}-${hand.maxSeats}-capture-start.png`) });
      }
      // The last step names who won, with the hand and the amount.
      const winners = p.getByTestId('capture-winner');
      await expect(winners.first()).toBeVisible();
      const won = hand.players.filter((x) => x.won > 0);
      await expect(winners).toHaveCount(new Set(hand.pots!.flatMap((x) => x.winners.map((w) => w.seatIndex))).size);
      for (const w of won) await expect(capture.getByText(w.nickname, { exact: true }).first()).toBeVisible();
      expect(await widerThanDevice(p), where).toBe(false);
      await p.screenshot({ path: test.info().outputPath(`modes-${sc.name}-${hand.maxSeats}-capture-result.png`) });
      await p.keyboard.press('ArrowLeft');
      await expect(index).toHaveText(`${total - 1}/${total}`);

      // Escape closes it, the focus back on the button that opened it and the page scrolling again.
      await p.keyboard.press('Escape');
      await expect(capture).toHaveCount(0);
      await expect(open).toBeFocused();
      expect(await p.evaluate(() => document.documentElement.style.overflow)).toBe('');
      expect(await p.evaluate(() => document.getElementById('root')!.inert), where).toBe(false);
    }
    await ctx.close();
  }
});
