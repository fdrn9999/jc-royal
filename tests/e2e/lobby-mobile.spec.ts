import { expect } from '@playwright/test';
import { signUp, sitWith, test, widerThanDevice } from './helpers';

test('mobile lobby: one create button, a full table card that fits, and the waitlist from a tap', async ({ browser }) => {
  // E2E Lobby Mobile: 2 seats, spectating off.
  const a = await signUp(browser, { mobile: true });
  await sitWith(a.page, 'e2e-lobby-m', 100);
  const b = await signUp(browser, { mobile: true });
  await sitWith(b.page, 'e2e-lobby-m', 100);

  const { page } = await signUp(browser, { mobile: true });
  // The wide header button is for larger screens only.
  await expect(page.getByTestId('room-create-open')).toBeVisible();
  await expect(page.getByTestId('room-create-open-wide')).toBeHidden();
  expect(await widerThanDevice(page)).toBe(false);

  const card = page.getByTestId('lobby-table').filter({ hasText: 'E2E Lobby Mobile' });
  const enter = card.getByTestId('lobby-enter');
  await expect(enter).toHaveAttribute('data-entry', 'wait', { timeout: 15_000 });
  await card.getByTestId('fav-toggle').tap();
  await expect(card.getByTestId('fav-toggle')).toHaveAttribute('aria-pressed', 'true');
  // Starred, it moves to the top of the list.
  await expect(page.getByTestId('lobby-table').first()).toHaveAttribute('data-table', 'e2e-lobby-m');
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  for (const el of [card.getByTestId('lobby-watch'), enter, card.getByTestId('fav-toggle')]) {
    const r = (await el.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(r.height).toBeGreaterThanOrEqual(40);
  }
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/lobby-full-mobile.png', animations: 'disabled' });

  await enter.tap();
  await expect(page).toHaveURL(/\/table\/e2e-lobby-m$/);
  await expect(page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/lobby-waitlisted-mobile.png', animations: 'disabled' });
});

test('mobile lobby: a table with a long name ends it in an ellipsis on the narrowest phone, and the page and its bottom bar stay the screen’s width', async ({ browser }) => {
  // E2E 이름이 아주 긴 …: 37 characters, most of them wide (a table's name may have up to 40).
  const { page } = await signUp(browser, { mobile: true });
  for (const w of [320, 360]) {
    await page.setViewportSize({ width: w, height: 740 });
    await page.goto('/');
    const card = page.locator('[data-testid=lobby-table][data-table=e2e-lobby-long]');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x + box.width, `${w}: the card runs past the screen`).toBeLessThanOrEqual(w + 0.5);
    const name = await card.getByRole('heading', { level: 2 }).evaluate((h) => ({ cut: h.scrollWidth > h.clientWidth, ellipsis: getComputedStyle(h).textOverflow }));
    expect(name, `${w}: the name is not cut with an ellipsis`).toEqual({ cut: true, ellipsis: 'ellipsis' });
    expect(await widerThanDevice(page)).toBe(false);
    // The fixed bottom bar is drawn against the page's width: it stays the screen's, and at the screen's foot.
    const bar = await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed')!.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });
    expect(bar.right, `${w}: the bottom bar is wider than the screen`).toBeLessThanOrEqual(w + 0.5);
    expect(bar.bottom, `${w}: the bottom bar is below the screen`).toBeLessThanOrEqual(740.5);
  }
  await page.screenshot({ path: 'test-results/lobby-long-name-mobile.png', animations: 'disabled' });
});

test('mobile lobby: the favourite note sits above the bottom bar, and a closed favourite is cleared from the favourites tab with a thumb', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  const name = `Fav M ${Date.now() % 100_000}`;
  const id = await page.evaluate(async (n) => {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, maxSeats: 6, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000 }) });
    return ((await r.json()) as { id: string }).id;
  }, name);
  const said = page.getByTestId('lobby-fav-said');
  const card = page.locator(`[data-testid="lobby-table"][data-table="${id}"]`);
  for (const [w, h] of [
    [320, 568],
    [390, 844],
    [667, 375],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    const star = card.getByTestId('fav-toggle');
    await star.scrollIntoViewIfNeeded();
    const on = (await star.getAttribute('aria-pressed')) !== 'true';
    await star.tap();
    await expect(said).toContainText(on ? /즐겨찾기에 추가했습니다|added to favorites/ : /즐겨찾기에서 뺐습니다|removed from favorites/);
    const note = (await said.boundingBox())!;
    // The phone's tab bar, when shown (it is hidden from 640 wide, where the note sits at the bottom of the screen).
    const bar = await page.evaluate(() => Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed' && n.getClientRects().length > 0)?.getBoundingClientRect().top ?? innerHeight);
    expect(note.x, `${w}x${h}: the note starts off the screen`).toBeGreaterThanOrEqual(0);
    expect(note.x + note.width, `${w}x${h}: the note runs past the screen`).toBeLessThanOrEqual(w + 0.5);
    expect(note.y + note.height, `${w}x${h}: the note covers the bottom bar`).toBeLessThanOrEqual(bar + 0.5);
    expect(await widerThanDevice(page)).toBe(false);
    await page.screenshot({ path: `test-results/lobby-fav-said-${w}x${h}.png`, animations: 'disabled' });
  }
  // Three taps: starred at the end.
  await expect(card.getByTestId('fav-toggle')).toHaveAttribute('aria-pressed', 'true');

  expect(await page.evaluate(async (t) => (await fetch(`/api/rooms/${t}/close`, { method: 'POST' })).status, id)).toBe(200);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?tab=fav');
  const gone = page.getByTestId('lobby-fav-gone');
  await expect(gone).toContainText(/닫혀서 목록에 없는 테이블: 1개|closed and no longer listed: 1/);
  const clear = gone.getByTestId('lobby-fav-gone-clear');
  const r = (await clear.boundingBox())!;
  expect(r.height).toBeGreaterThanOrEqual(40);
  expect(r.x + r.width).toBeLessThanOrEqual(320.5);
  expect(await widerThanDevice(page)).toBe(false);
  await gone.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/lobby-fav-gone-320.png', animations: 'disabled' });
  await clear.tap();
  await expect(gone).toHaveCount(0);
  await expect(page.getByText(/즐겨찾는 테이블이 없습니다|No favorite tables yet/)).toBeVisible();
});