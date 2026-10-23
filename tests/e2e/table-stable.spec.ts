import { expect, type Browser, type Page } from '@playwright/test';
import { answerAll, CARD_ANSWERS } from './academy-helpers';
import { setAccountPrefs, setRange, signUp, standUp, test } from './helpers';

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

/**
 * My turn's controls the dock holds (the action bar with its raise panel, the time bank), each drawn and whole inside the
 * dock's box: not hidden, cut or scrolled out of it. What is not, and why.
 */
function outOfDock(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const dock = document.querySelector('[data-testid=table-stack]')?.getBoundingClientRect();
    if (!dock) return ['no dock'];
    const out: string[] = [];
    for (const id of ['action-bar', 'time-bank']) {
      const b = document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect();
      if (!b || b.width < 1 || b.height < 1) out.push(`${id} not drawn`);
      else if (b.top < dock.top - 0.5 || b.bottom > dock.bottom + 0.5 || b.left < dock.left - 0.5 || b.right > dock.right + 0.5)
        out.push(`${id} ${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)} out of the dock ${Math.round(dock.left)},${Math.round(dock.top)}–${Math.round(dock.right)},${Math.round(dock.bottom)}`);
    }
    return out;
  });
}

/** One screen's watch over the table: each check waits for it to stop, then holds it to the first box seen. */
function stageWatch(p: Page, name: string, mine: () => string | null) {
  let stage: Box | null = null;
  return async (what: string) => {
    const at = await settledTable(p);
    expect(at, `${name} ${what}: table drawn`).not.toBeNull();
    if (!stage) {
      stage = at;
      console.log(`${name} table ${JSON.stringify(stage)}`);
    }
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(at![k] - stage![k]), `${name} ${what}: table ${k} ${at![k]} (watching: ${stage![k]})`).toBeLessThan(0.5);
    expect(await covering(p, mine()), `${name} ${what}`).toEqual([]);
    await p.screenshot({ path: test.info().outputPath(`${name}-${what}.png`) });
  };
}

/** Sits down with 1000 at a table already open on the page, asking until a seat is offered; my seat's number. */
async function sitDown(p: Page, table: string, nickname: string) {
  const confirm = p.getByTestId('buyin-confirm');
  await expect(async () => {
    await p.goto(`/table/${table}?sit=1`);
    await expect(confirm).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 180_000 });
  await setRange(p.getByRole('dialog').locator('input[type="range"]'), 1000);
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  const seat = p.locator('[data-testid=table] [data-testid^="seat-"][data-state]').filter({ has: p.getByText(nickname, { exact: true }) });
  await expect(seat).toHaveCount(1, { timeout: 60_000 });
  return (await seat.getAttribute('data-testid'))!.slice('seat-'.length);
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
      let mine: string | null = null;
      const check = stageWatch(p, sc.name, () => mine);

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
      mine = await sitDown(p, TABLE, nickname);
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
      expect(await outOfDock(p), `${sc.name} my turn`).toEqual([]);
      await raise.click();
      await expect(bar.getByTestId('action-commit')).toBeVisible();
      await check('raise open');
      // The time bank stays with the panel open: beside the bar, or on a phone in the presets' line of its card.
      expect(await outOfDock(p), `${sc.name} raise open`).toEqual([]);
      await expect(bar.getByTestId('time-bank-use')).toHaveCount(sc.viewport.width < 640 ? 1 : 0);
      await expect(p.getByTestId('time-bank-use')).toBeEnabled();
      await raise.click();
      await expect(bar.getByTestId('time-bank-use')).toHaveCount(0);
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

/**
 * A beginner's notes and the coach's tip have room of their own in the band while the screen leaves the table enough
 * (Table.tsx's `--dock-max`); past that they scroll in what the time bank and the action bar leave them. On small phones
 * (emulated), with both on, the table holds still from watching through my turn, the raise panel and the help open, and
 * the fold; the turn's controls stay whole in the dock and nothing of the dock covers my cards, the board or the pot. On
 * the last screen the account is one hand short of the coaching's end: once that hand is settled the band keeps its
 * room, so the table holds still then too. A new account each screen (the coached hands only count up).
 */
const COACHED = [
  { name: 'coach-320x568', viewport: { width: 320, height: 568 }, last: false },
  { name: 'coach-375x667', viewport: { width: 375, height: 667 }, last: false },
  { name: 'coach-390x844', viewport: { width: 390, height: 844 }, last: true },
];
const COACH_TABLE = 'e2e-stable-c';

async function coachedPlayer(browser: Browser, last: boolean) {
  const { page, nickname } = await signUp(browser);
  await page.goto('/academy/cards?step=3');
  await answerAll(page, CARD_ANSWERS);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/academy/progress') && r.request().method() === 'PUT' && r.ok());
  await page.getByTestId('lesson-finish').click();
  await saved;
  await setAccountPrefs(page, { beginner: true });
  const id = await page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const key = `jc.academy:${id}`;
  if (last)
    await page.evaluate((k) => {
      const v = JSON.parse(localStorage.getItem(k) ?? '{}');
      localStorage.setItem(k, JSON.stringify({ ...v, updatedAt: Date.now(), coach: { ...v.coach, hands: 4 } }));
    }, key);
  const state = await page.context().storageState();
  await page.context().close();
  return { state, nickname, key };
}

test('beginner notes and the coach tip scroll in the band: small phones keep the table still and the turn whole', async ({ browser }) => {
  test.setTimeout(900_000);
  for (const sc of COACHED) {
    await test.step(sc.name, async () => {
      const { state, nickname, key } = await coachedPlayer(browser, sc.last);
      const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      let mine: string | null = null;
      const check = stageWatch(p, sc.name, () => mine);

      await p.goto(`/table/${COACH_TABLE}`);
      await expect(p.getByTestId('table')).toBeVisible({ timeout: 60_000 });
      // The account's settings are in before the table is first measured: the band is the beginner's, taller than the
      // default's 10.5rem (168px, and the 8px edge), though no notes show until a hand is dealt.
      await expect.poll(() => p.getByTestId('table-stack').evaluate((e) => e.getBoundingClientRect().height), { timeout: 60_000 }).toBeGreaterThan(203);
      await check('watching');
      mine = await sitDown(p, COACH_TABLE, nickname);
      await check('seated');

      const bar = p.getByTestId('action-bar');
      const tip = p.getByTestId('coach-tip');
      const raise = bar.locator('button[aria-expanded]');
      if (sc.last) {
        // The first hand I am dealt is the coach's last: its tip on my turn, then the fold.
        await expect(bar).toBeVisible({ timeout: 240_000 });
        await expect(tip).toBeVisible();
        await check('my turn');
        expect(await outOfDock(p), `${sc.name} my turn`).toEqual([]);
        await act(p, 'fold');
        await expect(bar).toBeHidden({ timeout: 10_000 });
        await check('folded');
        // The hand settled, the coaching is over; its room in the band is not given back.
        await expect
          .poll(() => p.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '{}') as { coach?: { hands?: number } }).coach?.hands ?? 0, key), { timeout: 180_000 })
          .toBeGreaterThanOrEqual(5);
        await check('coaching over');
      } else {
        // My turn with a raise to make and the tip up: the panel open and shut, the help open, then the fold.
        await expect(async () => {
          await expect(bar).toBeVisible({ timeout: 60_000 });
          if (!(await raise.isVisible())) {
            await act(p, 'check');
            throw new Error('no raise offered on this turn');
          }
        }).toPass({ timeout: 240_000 });
        await expect(tip).toBeVisible();
        await check('my turn');
        expect(await outOfDock(p), `${sc.name} my turn`).toEqual([]);
        await raise.tap();
        await expect(bar.getByTestId('action-commit')).toBeVisible();
        await check('raise open');
        expect(await outOfDock(p), `${sc.name} raise open`).toEqual([]);
        await raise.tap();
        await expect(bar.getByTestId('action-commit')).toHaveCount(0);
        await p.getByTestId('action-help-toggle').tap();
        await expect(p.getByTestId('action-help')).toBeVisible();
        await check('help open');
        expect(await outOfDock(p), `${sc.name} help open`).toEqual([]);
        await act(p, 'fold');
        await expect(bar).toBeHidden({ timeout: 10_000 });
        await check('folded');
      }

      await standUp(p);
      await expect(p.getByTestId('left-next')).toBeVisible({ timeout: 60_000 });
      mine = null;
      await check('stood up');
      await ctx.close();
    });
  }
});
