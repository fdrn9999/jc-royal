import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

/** What the page's room connection last reported: my seat, the hand on the table, and whether I may show cards from it. */
function watch(page: Page) {
  const w = { mySeat: null as number | null, handId: null as string | null, stage: null as string | null, folded: false, canShow: false };
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as {
        t: string;
        state?: { hand: { id: string; stage: string } | null; seats: { state: string }[]; you: { seatIndex: number | null; canShow?: boolean } };
      };
      if (m.t !== 'state') return;
      const s = m.state!;
      if (s.you.seatIndex !== null) w.mySeat = s.you.seatIndex;
      w.handId = s.hand?.id ?? null;
      w.stage = s.hand?.stage ?? null;
      w.folded = w.mySeat !== null && s.seats[w.mySeat]?.state === 'folded';
      w.canShow = !!s.you.canShow;
    });
  });
  return w;
}

/** Folds when it is this page's turn and folding needs no confirmation (nothing to check); otherwise checks or calls. */
async function foldOrCheck(page: Page) {
  const bar = page.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  if (await bar.getByRole('button', { name: /^(체크|Check)$/ }).isVisible().catch(() => false)) return checkOrCall(page);
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (!(await fold.isVisible().catch(() => false))) return false;
  await fold.tap();
  await page.waitForTimeout(250);
  return true;
}

/** Where the show buttons sit on the 360px screen: inside it, on top (a tap reaches them) and clear of the board and the other seat. */
function showButtonLayout(page: Page, mySeat: number) {
  return page.evaluate((seat) => {
    const overlap = (x: DOMRect, y: DOMRect) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    const rectOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const board = rectOf('[data-testid=board]');
    const pot = rectOf('[data-testid=pot]');
    const others = Array.from(document.querySelectorAll('[data-testid^="seat-"]'))
      .filter((e) => /^seat-\d+$/.test(e.getAttribute('data-testid')!) && e.getAttribute('data-testid') !== `seat-${seat}`)
      .map((e) => e.getBoundingClientRect());
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="show-cards"] > *')).map((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        id: el.dataset.testid,
        h: Math.round(r.height),
        inside: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight,
        onTop: !!top && el.contains(top),
        clear: !(board && overlap(r, board)) && !(pot && overlap(r, pot)) && !others.some((o) => overlap(r, o)),
      };
    });
  }, mySeat);
}

test('mobile: after folding, a player with auto-muck on taps Show on one card and the other player sees that card only', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  await a.page.setViewportSize({ width: 360, height: 740 });
  const b = await signUp(browser);
  const wa = watch(a.page);
  await a.page.goto('/table/e2e-show?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();
  await expect.poll(() => wa.mySeat).not.toBeNull();

  // The setting now says what it hides and what it lets you show.
  await a.page.getByRole('button', { name: /^(설정|Settings)$/ }).tap();
  const box = a.page.getByTestId('settings-automuck');
  await box.scrollIntoViewIfNeeded();
  await expect(a.page.getByText('쇼다운에서 진 패 숨기기 (자동 머크)')).toBeVisible();
  await expect(a.page.getByText(/보이기 버튼으로 보여 주고 싶은 카드만 공개/)).toBeVisible();
  expect(await widerThanDevice(a.page)).toBe(false);
  await box.tap();
  await expect(box).toBeChecked();
  await a.page.screenshot({ path: test.info().outputPath('show-setting.png') });
  await a.page.getByRole('dialog').getByRole('button', { name: 'close' }).tap();
  await expect(a.page.getByRole('dialog')).toHaveCount(0);

  await b.page.goto('/table/e2e-show?sit=1');
  await b.page.getByTestId('buyin-confirm').click();
  // No buttons while a hand is being played.
  await expect.poll(() => wa.stage, { timeout: 20_000 }).toBe('preflop');
  await expect(a.page.getByTestId('show-cards')).toHaveCount(0);

  // Play until A folds a hand, then show its second card in the gap before the next deal (4 s).
  let done: { handId: string; layout: Awaited<ReturnType<typeof showButtonLayout>>; card: string } | null = null;
  await expect(async () => {
    if (!(wa.stage === 'settled' && wa.folded && wa.canShow)) {
      (await foldOrCheck(a.page)) || (await checkOrCall(b.page));
      expect(done).not.toBeNull();
    }
    const handId = wa.handId!;
    const seat = wa.mySeat!;
    await expect(a.page.getByTestId('show-card-1')).toBeVisible({ timeout: 1_000 });
    const layout = await showButtonLayout(a.page, seat);
    const card = (await a.page.locator(`[data-testid=seat-${seat}] [data-card]`).nth(1).getAttribute('data-card'))!;
    await a.page.getByTestId('show-card-1').tap();
    await expect(a.page.getByTestId('shown-card-1')).toBeVisible({ timeout: 1_500 });
    await expect(a.page.getByTestId('show-card-0')).toBeVisible();
    // B sees exactly that card face up on A's seat; the other stays face down.
    const onB = b.page.locator(`[data-testid=seat-${seat}] [data-card]`);
    await expect(onB).toHaveCount(1, { timeout: 1_500 });
    await expect(onB).toHaveAttribute('data-card', card);
    // The card flips in from transparent: capture where the animation ends.
    await Promise.all([
      a.page.screenshot({ path: test.info().outputPath('show-mobile-360.png'), animations: 'disabled' }),
      b.page.screenshot({ path: test.info().outputPath('show-other-view.png'), animations: 'disabled' }),
    ]);
    expect(wa.handId).toBe(handId);
    done = { handId, layout, card };
  }).toPass({ timeout: 150_000 });

  const { layout } = done!;
  expect(layout).toEqual([
    { id: 'show-card-0', h: 24, inside: true, onTop: true, clear: true },
    { id: 'show-card-1', h: 24, inside: true, onTop: true, clear: true },
  ]);
  expect(await widerThanDevice(a.page)).toBe(false);

  // The next deal takes the shown card and the buttons away.
  await expect(a.page.getByTestId('show-cards')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => wa.handId, { timeout: 15_000 }).not.toBe(done!.handId);
  await expect(b.page.locator(`[data-testid=seat-${wa.mySeat}] [data-card]`)).toHaveCount(0);
});
