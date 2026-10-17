import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

interface Settled {
  handId: string;
  winners: number[];
  shown: number[];
}

/** Commands the page sent, the room's auto-muck setting for it, and the hands it saw settle. */
function watch(page: Page) {
  const w = { sent: [] as { t: string; on?: boolean }[], autoMuck: null as boolean | null, mySeat: null as number | null, settled: [] as Settled[] };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') w.sent.push(JSON.parse(payload) as { t: string });
    });
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as {
        t: string;
        state?: {
          hand: { id: string; stage: string; result: { winners: { seatIndex: number }[]; showdown: { seatIndex: number }[] } | null } | null;
          you: { seatIndex: number | null; autoMuck?: boolean | null };
        };
      };
      if (m.t !== 'state') return;
      w.autoMuck = m.state!.you.autoMuck ?? null;
      if (m.state!.you.seatIndex !== null) w.mySeat = m.state!.you.seatIndex;
      const h = m.state!.hand;
      if (h?.stage === 'settled' && h.result && !w.settled.some((x) => x.handId === h.id)) {
        w.settled.push({ handId: h.id, winners: h.result.winners.map((x) => x.seatIndex), shown: h.result.showdown.map((x) => x.seatIndex) });
      }
    });
  });
  return w;
}

test('mobile: auto-muck set in the table settings keeps a losing showdown hand face down for the other player only', async ({ browser }) => {
  // Hands take about 15 s each and A loses a given one about half the time, so the loop below may need several: the
  // test's own limit must outlast the loop's 150 s (at the default 90 s, a sixth hand failed the test).
  test.setTimeout(200_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const wa = watch(a.page);
  const wb = watch(b.page);
  await a.page.goto('/table/e2e-muck?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();
  await expect.poll(() => wa.autoMuck).toBe(false);

  // The setting is in the table's settings dialog, with what it does and does not hide.
  await a.page.getByRole('button', { name: /^(설정|Settings)$/ }).tap();
  const box = a.page.getByTestId('settings-automuck');
  await box.scrollIntoViewIfNeeded();
  await expect(a.page.getByText(/이긴 패와 올인한 패는 항상 공개|Winning and all-in hands are always shown/)).toBeVisible();
  expect(await widerThanDevice(a.page)).toBe(false);
  await box.tap();
  await expect(box).toBeChecked();
  await a.page.screenshot({ path: test.info().outputPath('muck-setting.png') });
  await expect.poll(() => wa.autoMuck).toBe(true);
  expect(wa.sent.filter((m) => m.t === 'muck')).toEqual([expect.objectContaining({ t: 'muck', on: true })]);
  await a.page.getByRole('dialog').getByRole('button', { name: 'close' }).tap();
  await expect(a.page.getByRole('dialog')).toHaveCount(0);

  // A reload keeps the setting (the account's), and the room already has it: nothing is sent again.
  await a.page.reload();
  await expect.poll(() => wa.autoMuck).toBe(true);
  await a.page.waitForTimeout(800);
  expect(wa.sent.filter((m) => m.t === 'muck')).toHaveLength(1);

  await b.page.goto('/table/e2e-muck?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  // Check every hand down until A loses one at showdown to a single winner.
  const missed = new Set<string>();
  const lost = () =>
    wa.settled.find((x) => !missed.has(x.handId) && x.winners.length === 1 && x.winners[0] !== wa.mySeat && wb.settled.some((y) => y.handId === x.handId));
  /** Face-up cards on the board and in a seat, read at one moment (a result stays up only until the next hand). */
  const faceUp = (page: Page, seat: number) =>
    page.evaluate((i) => ({ board: document.querySelectorAll('[data-testid=board] [data-card]').length, seat: document.querySelectorAll(`[data-testid=seat-${i}] [data-card]`).length }), seat);
  const seen: { handId: string; onA: { board: number; seat: number }; onB: { board: number; seat: number } }[] = [];
  await expect(async () => {
    const hand = lost();
    if (!hand) {
      (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    } else {
      // The result screen: the river is out on both pages.
      const at = { onA: await faceUp(a.page, wa.mySeat!), onB: await faceUp(b.page, wa.mySeat!) };
      if (at.onA.board === 5 && at.onB.board === 5) {
        seen.push({ ...at, handId: hand.handId });
        await Promise.all([a.page.screenshot({ path: test.info().outputPath('muck-loser.png') }), b.page.screenshot({ path: test.info().outputPath('muck-winner-view.png') })]);
      } else {
        // The next hand had already started: play on to another one.
        missed.add(hand.handId);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  }).toPass({ timeout: 150_000 });
  const hand = wa.settled.find((x) => x.handId === seen[0]!.handId)!;
  // Nobody was shown A's hand; B's winning hand was shown to both.
  expect(hand.shown).toEqual(hand.winners);
  expect(wb.settled.find((y) => y.handId === hand.handId)!.shown).toEqual(hand.winners);
  // On screen: B sees A's cards face down, A sees them face up.
  expect(seen[0]).toEqual({ handId: hand.handId, onA: { board: 5, seat: 2 }, onB: { board: 5, seat: 0 } });
});
