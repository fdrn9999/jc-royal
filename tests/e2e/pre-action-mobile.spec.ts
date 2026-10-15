import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

interface Seen {
  handId: string;
  stage: string;
  mySeat: number | null;
  buttonSeat: number;
  bbSeat: number | null;
  preAction: string | null;
}

/** The last hand state the room sent this page, and every command the page sent. */
function watch(page: Page) {
  const w = { state: null as Seen | null, sent: [] as { t: string }[] };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') w.sent.push(JSON.parse(payload) as { t: string });
    });
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as { t: string; state?: { hand: { id: string; stage: string; buttonSeat: number; bbSeat: number | null } | null; you: { seatIndex: number | null; preAction?: string | null } } };
      const h = m.t === 'state' ? m.state!.hand : null;
      if (h) w.state = { handId: h.id, stage: h.stage, mySeat: m.state!.you.seatIndex, buttonSeat: h.buttonSeat, bbSeat: h.bbSeat, preAction: m.state!.you.preAction ?? null };
    });
  });
  return w;
}

test('mobile: a check chosen while the other player acts is made on the turn, and a bet cancels it with a notice', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const wa = watch(a.page);
  // Beginner mode stacks the most above the seat on a phone: the street note and current hand join the row.
  await a.page.evaluate(() => localStorage.setItem('jc.prefs', JSON.stringify({ beginner: true })));
  await a.page.goto('/table/e2e-pre?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();
  await b.page.goto('/table/e2e-pre?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  const preCheck = a.page.getByTestId('pre-check');
  const barA = a.page.getByTestId('action-bar');
  const barB = b.page.getByTestId('action-bar');
  const actionsSent = () => wa.sent.filter((m) => m.t === 'action').length;
  /** B is to act and A still acts after B on this street (heads-up: the big blind preflop, the button after). */
  const atSpot = async () => {
    const s = wa.state;
    const after = !!s && s.mySeat !== null && (s.stage === 'preflop' ? s.bbSeat === s.mySeat : s.stage !== 'showdown' && s.stage !== 'settled' && s.buttonSeat === s.mySeat);
    return after && (await preCheck.isVisible().catch(() => false)) && (await barB.isVisible().catch(() => false));
  };
  const reachSpot = () =>
    expect(async () => {
      if (await atSpot()) return;
      (await checkOrCall(a.page)) || (await checkOrCall(b.page));
      expect(await atSpot()).toBe(true);
    }).toPass({ timeout: 60_000 });

  await reachSpot();
  await a.page.waitForTimeout(300);
  await expect(a.page.getByTestId('pre-actions')).toBeVisible();
  await expect(a.page.getByTestId('pre-checkFold')).toBeVisible();
  await expect(a.page.getByTestId('pre-fold')).toHaveCount(0);
  expect(await widerThanDevice(a.page)).toBe(false);
  await expect(a.page.getByTestId('stage-note')).toBeVisible();
  // The whole stack (street note on top, then the row) stays below A's own seat and cards, not over them.
  const seat = (await a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname }).boundingBox())!;
  const top = (await a.page.getByTestId('stage-note').boundingBox())!;
  expect(top.y).toBeGreaterThanOrEqual(seat.y + seat.height - 1);
  await a.page.screenshot({ path: test.info().outputPath('pre-actions.png') });

  const at = wa.state!;
  const sent = actionsSent();
  await preCheck.tap();
  await expect(preCheck).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => wa.state?.preAction).toBe('check');
  await a.page.screenshot({ path: test.info().outputPath('pre-check-chosen.png') });
  await b.page.waitForTimeout(300);
  expect(await checkOrCall(b.page)).toBe(true);
  // A had to act after B on that street: it moved on without A sending an action, so the room checked for A.
  await expect.poll(() => wa.state && (wa.state.handId !== at.handId || wa.state.stage !== at.stage), { timeout: 15_000 }).toBe(true);
  expect(actionsSent()).toBe(sent);

  // Again, but B bets: the chosen check no longer fits, A is told and decides on the turn.
  await reachSpot();
  await a.page.waitForTimeout(300);
  await preCheck.tap();
  await expect.poll(() => wa.state?.preAction).toBe('check');
  await b.page.waitForTimeout(300);
  await barB.getByRole('button', { name: /^(레이즈|Raise|벳|Bet)$/ }).click();
  await barB.getByRole('textbox').fill('40');
  const commit = barB.getByTestId('action-commit');
  await commit.click();
  if (/^(한 번 더|Press again)/.test((await commit.textContent().catch(() => '')) ?? '')) await commit.click();
  const notice = a.page.getByTestId('table-notice');
  await expect(notice).toHaveText(/미리 선택을 취소|pre-selection cancelled/);
  await expect(barA.getByRole('button', { name: /^(콜|Call)/ })).toBeVisible();
  await expect(a.page.getByTestId('pre-actions')).toHaveCount(0);
  expect(actionsSent()).toBe(sent);
  // On A's turn, with the beginner help above the buttons, the notice still leaves A's seat and stack in view.
  await a.page.waitForTimeout(300);
  const seatNow = (await a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname }).boundingBox())!;
  expect((await notice.boundingBox())!.y).toBeGreaterThanOrEqual(seatNow.y + seatNow.height - 1);
  await a.page.screenshot({ path: test.info().outputPath('pre-cancelled.png') });
  // B now waits on A: on the desktop the row sits above B's status bar.
  await expect(b.page.getByTestId('pre-checkFold')).toBeVisible();
  await b.page.screenshot({ path: test.info().outputPath('pre-actions-desktop.png') });
});
