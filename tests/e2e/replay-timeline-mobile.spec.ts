import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { HAND_2, HAND_6 } from './replay-hands';

// HAND_6: where the deal, the flop, the turn, the river, the showdown and the payout begin, out of 22 steps.
const PARTS = { preflop: 1, flop: 9, turn: 13, river: 18, showdown: 21, result: 22 };

/** Scrolls the replay's controls to just above the bottom navigation, as a thumb reaching for them would. */
const toControls = (page: Page) =>
  page.evaluate(() => {
    const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed');
    const bottom = nav ? nav.getBoundingClientRect().top : innerHeight;
    scrollBy(0, document.querySelector('[data-testid=replay-controls]')!.getBoundingClientRect().bottom - bottom + 8);
    const c = document.querySelector('[data-testid=replay-controls]')!.getBoundingClientRect();
    return c.top >= document.querySelector('header')!.getBoundingClientRect().bottom && c.bottom <= bottom;
  });

test('mobile: replay timeline by touch — each street a tap away, the slider dragged by a finger without moving the page', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await page.route(`**/api/me/hands/${HAND_6.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HAND_6) }));
  await page.goto(`/me/hands/${HAND_6.id}`);
  const index = page.getByTestId('replay-index');
  await expect(index).toHaveText('1/22');
  expect(await widerThanDevice(page)).toBe(false);

  // The controls show whole between the header and the bottom navigation; every part of the hand is a finger-sized target.
  expect(await toControls(page)).toBe(true);
  for (const phase of Object.keys(PARTS)) {
    const b = (await page.getByTestId(`replay-phase-${phase}`).boundingBox())!;
    expect(Math.min(b.width, b.height), phase).toBeGreaterThanOrEqual(32);
  }

  // A tap on each street, the showdown and the result goes to where it begins.
  for (const [phase, k] of Object.entries(PARTS)) {
    await page.getByTestId(`replay-phase-${phase}`).tap();
    await expect(index).toHaveText(`${k}/22`);
    await expect(page.getByTestId(`replay-phase-${phase}`)).toHaveAttribute('aria-current', 'step');
  }

  // A finger on the thumb drags it to the end and back; the page does not scroll under it.
  await page.getByTestId('replay-phase-river').tap();
  await expect(index).toHaveText('18/22');
  expect(await toControls(page)).toBe(true);
  const slider = page.getByTestId('replay-slider');
  const track = (await slider.boundingBox())!;
  const y = track.y + track.height / 2;
  const thumbAt = (k: number) => track.x + 14 + ((track.width - 28) * (k - 1)) / 21;
  const cdp = await page.context().newCDPSession(page);
  const drag = async (from: number, to: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
    for (let s = 1; s <= 12; s++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + ((to - from) * s) / 12, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const scrolled = await page.evaluate(() => scrollY);
  await drag(thumbAt(18), track.x + track.width - 2);
  await expect(index).toHaveText('22/22');
  await expect(page.getByTestId('replay-pots')).toBeVisible();
  await drag(thumbAt(22), thumbAt(5));
  await expect(index).toHaveText('5/22');
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);

  // The street marks sit where each street begins: a tap on one lands there.
  for (const phase of ['flop', 'turn', 'river'] as const) {
    const tick = (await page.getByTestId(`replay-tick-${phase}`).boundingBox())!;
    await page.touchscreen.tap(tick.x + tick.width / 2, y);
    await expect(index).toHaveText(`${PARTS[phase]}/22`);
  }
  await expect(page.locator('[data-testid=board] [data-card]')).toHaveCount(5);
  for (const id of ['replay-prev', 'replay-next', 'replay-play', 'replay-first', 'replay-last', 'replay-speed-2']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
  // The board's cards still turning over from the quick jumps are shown as they land.
  await page.screenshot({ path: test.info().outputPath('timeline-mobile.png'), animations: 'disabled' });
});

test('mobile: a heads-up replay opens with the table, the timeline and play all above the bottom navigation', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await page.route(`**/api/me/hands/${HAND_2.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HAND_2) }));
  await page.goto(`/me/hands/${HAND_2.id}`);
  await expect(page.getByTestId('replay-index')).toHaveText('1/16');
  // Measured once the table has taken its size: the first render assumes a wide box and lays the controls out for it.
  const lowest = () =>
    page.evaluate(() => {
      const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed')!.getBoundingClientRect().top;
      const ids = ['replay-table', 'replay-phase-result', 'replay-slider', 'replay-next', 'replay-play', 'replay-speed-2'];
      return Math.max(...ids.map((id) => document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().bottom)) - nav;
    });
  await expect.poll(lowest).toBeLessThanOrEqual(0);
  await page.waitForTimeout(500);
  expect(await lowest()).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});
