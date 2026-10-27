import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { HAND_6 } from './replay-hands';

// Phones upright (the smallest first) and on their side, a tablet, a laptop and desktops.
const SCREENS = [
  { name: '320x568', width: 320, height: 568, mobile: true },
  { name: '360x640', width: 360, height: 640, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '430x932', width: 430, height: 932, mobile: true },
  { name: '844x390', width: 844, height: 390, mobile: true },
  { name: '768x1024', width: 768, height: 1024, mobile: true },
  { name: '1280x720', width: 1280, height: 720, mobile: false },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '1920x1080', width: 1920, height: 1080, mobile: false },
];

// HAND_6's steps where the viewer (seat 0, UTG) decided: the open, the call of the all-in, the flop call, the turn bet,
// the river check.
const DECISIONS = [2, 8, 11, 15, 19];

/** The step line, the table and the controls, where they sit on the page (not the screen) and how big they are. */
const areas = (page: Page) =>
  page.evaluate(() =>
    ['replay-status', 'replay-table', 'replay-controls'].map((id) => {
      const r = document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
      return [id, Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    }),
  );

/** The areas once two reads a moment apart agree: the first step has given the table time to take its size. */
async function settled(page: Page) {
  for (let last = await areas(page); ; ) {
    await page.waitForTimeout(300);
    const now = await areas(page);
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
}

/** The review's box on the page, the lowest of the three areas' ends, and anything in it running past its sides. */
const review = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid=replay-strategy]')!;
    const r = el.getBoundingClientRect();
    const above = Math.max(...['replay-status', 'replay-table', 'replay-controls'].map((id) => document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().bottom));
    const past = Array.from(el.querySelectorAll('*'))
      .filter((x) => {
        const b = x.getBoundingClientRect();
        return b.width > 0 && (b.left < r.left - 0.5 || b.right > r.right + 0.5);
      })
      .map((x) => (x as HTMLElement).dataset.testid ?? x.tagName);
    return { top: r.top, left: r.left, right: r.right, height: r.height, above, vw: document.documentElement.clientWidth, past, overflow: el.scrollWidth - el.clientWidth };
  });

test('replay decision review: opened under the controls at every size, it moves neither the table nor the controls, says no solver data instead of guessing, and steps to each decision', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  // Every screen in Korean, then the smallest in English (longer words): the language is the account's setting, kept
  // once changed, so it goes last.
  for (const [sc, locale] of [...SCREENS.map((x) => [x, 'ko'] as const), [SCREENS[0]!, 'en'] as const]) {
    const where = `${sc.name} · ${locale}`;
    const ctx = await browser.newContext({ storageState: state, viewport: { width: sc.width, height: sc.height }, isMobile: sc.mobile, hasTouch: sc.mobile, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.route(`**/api/me/hands/${HAND_6.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HAND_6) }));
    await p.goto(`/me/hands/${HAND_6.id}`);
    const index = p.getByTestId('replay-index');
    await expect(index).toHaveText('1/22');
    // The account's language is the one in its settings, as a player would change it.
    if (locale === 'en') {
      await p.getByTestId('settings-open').click();
      await p.getByLabel('언어', { exact: true }).selectOption('en');
      await p.keyboard.press('Escape');
      await expect(p.locator('html')).toHaveAttribute('lang', 'en');
    }
    const toggle = p.getByTestId('replay-strategy-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Its name shows whole (wrapped if need be), the button inside the screen.
    const name = await toggle.evaluate((b) => ({ cut: Array.from(b.querySelectorAll('span')).some((s) => s.scrollWidth > s.clientWidth + 0.5), right: b.getBoundingClientRect().right, vw: document.documentElement.clientWidth }));
    expect(name.cut, `${where}: the toggle's name`).toBe(false);
    expect(name.right, where).toBeLessThanOrEqual(name.vw + 0.5);
    const before = await settled(p);

    // Opened: under every area, inside the screen, nothing in it running past its sides; the step line, the table and
    // the controls where they were and as big.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = p.getByTestId('replay-strategy');
    await expect(panel).toBeVisible();
    await expect(p.getByTestId('replay-strategy-pick')).toBeVisible();
    await expect(p.getByTestId('replay-strategy-kind')).toHaveText(locale === 'ko' ? '학습용 · 솔버 결과 아님' : 'For study · not solver output');
    expect(await areas(p), `${where}: opening it`).toEqual(before);
    const open = await review(p);
    expect(open.top, `${where}: under the areas`).toBeGreaterThanOrEqual(open.above - 0.5);
    expect(open.left, where).toBeGreaterThanOrEqual(0);
    expect(open.right, where).toBeLessThanOrEqual(open.vw + 0.5);
    expect(open.past, `${where}: running past its sides`).toEqual([]);
    expect(open.overflow, where).toBeLessThanOrEqual(0);
    expect(await widerThanDevice(p), where).toBe(false);

    // Each decision a tap away: the replay goes to its step, which the review marks; the solver's part says the spot
    // is not supported (there is no solver data), and the played choice is among the options.
    const chips = p.locator('[data-testid^=replay-strategy-decision-]');
    await expect(chips).toHaveCount(DECISIONS.length);
    let tallest = 0;
    for (const [k, step] of DECISIONS.entries()) {
      await p.getByTestId(`replay-strategy-decision-${k}`).click();
      await expect(index).toHaveText(`${step}/22`);
      await expect(p.getByTestId(`replay-strategy-decision-${k}`)).toHaveAttribute('aria-current', 'step');
      await expect(p.getByTestId('replay-strategy-solver')).toHaveAttribute('data-kind', 'unsupported');
      await expect(p.locator('[data-testid=replay-strategy-options] [data-played]')).toHaveCount(1);
      await expect(p.getByTestId('replay-strategy-position')).toContainText('UTG');
      const at = await review(p);
      expect(at.past, `${where} · step ${step}: running past its sides`).toEqual([]);
      expect(at.overflow, `${where} · step ${step}`).toBeLessThanOrEqual(0);
      // Never shorter than it was: what lies under a finger stays put.
      expect(at.height, `${where} · step ${step}`).toBeGreaterThanOrEqual(tallest - 0.5);
      tallest = Math.max(tallest, at.height);
      expect(await areas(p), `${where} · step ${step}: the areas`).toEqual(before);
    }
    // The flop call faced a bet: its size and the SPR are put as arithmetic for study, beside the plain pot odds.
    await p.getByTestId('replay-strategy-decision-2').click();
    await expect(p.getByTestId('replay-strategy-note-betSize')).toBeVisible();
    await expect(p.getByTestId('replay-strategy-note-spr')).toBeVisible();
    await p.screenshot({ path: test.info().outputPath(`review-${sc.name}-${locale}.png`), fullPage: true });

    // A step that is not a decision: the review says to pick one, and keeps its height.
    await p.getByTestId('replay-next').click();
    await expect(index).toHaveText('12/22');
    await expect(p.getByTestId('replay-strategy-pick')).toBeVisible();
    expect((await review(p)).height, `${where}: off a decision`).toBeGreaterThanOrEqual(tallest - 0.5);
    // Drawn for a moment at another width and back (a window resized, a phone turned and back; a full-page capture on
    // CI): the room it kept at this width is the room it has again.
    await p.setViewportSize({ width: sc.width + 48, height: sc.height });
    await settled(p);
    await p.setViewportSize({ width: sc.width, height: sc.height });
    await settled(p);
    expect((await review(p)).height, `${where}: another width and back`).toBeGreaterThanOrEqual(tallest - 0.5);

    // Closed: gone, and the areas where they were with it open at this step.
    const open12 = await settled(p);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    expect(await areas(p), `${where}: closing it`).toEqual(open12);
    if (JSON.stringify(open12) !== JSON.stringify(before)) console.log(`[areas] ${where}: step 12 laid out unlike step 1, review open: ${JSON.stringify({ before, open12 })}`);
    await ctx.close();
  }
});

test('replay decision review: not offered on a hand the viewer was not dealt into', async ({ browser }) => {
  const { page } = await signUp(browser);
  const watched = { ...HAND_6, id: `${HAND_6.id}-watched`, players: HAND_6.players.map((x) => ({ ...x, isYou: false })) };
  await page.route(`**/api/me/hands/${watched.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(watched) }));
  await page.goto(`/me/hands/${watched.id}`);
  await expect(page.getByTestId('replay-index')).toHaveText('1/22');
  await expect(page.getByTestId('replay-strategy-toggle')).toHaveCount(0);
});
