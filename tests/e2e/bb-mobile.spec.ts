import type { HandDetailDto, HandSummaryDto } from '@jc/types';
import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

/** What the page's room connection reported (my seat, the hand, each seat's bet this street) and the commands it sent. */
function watch(page: Page) {
  const w = { mySeat: null as number | null, handId: null as string | null, bets: [] as number[], sent: [] as { t: string; type?: string; amount?: number }[] };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') w.sent.push(JSON.parse(payload) as { t: string });
    });
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as { t: string; state?: { hand: { id: string } | null; seats: { streetBet: number }[]; you: { seatIndex: number | null } } };
      if (m.t !== 'state') return;
      const s = m.state!;
      if (s.you.seatIndex !== null) w.mySeat = s.you.seatIndex;
      w.handId = s.hand?.id ?? null;
      w.bets = s.seats.map((x) => x.streetBet);
    });
  });
  return w;
}

/** Same-origin JSON call with the page's session. */
async function call<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => (await (await fetch(p)).json()) as T, path);
}

/** Every stack and bet label inside the screen's width. */
const labelsOnScreen = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="stack-"], [data-testid^="bet-"]')).every((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.right <= document.documentElement.clientWidth;
    }),
  );

const BB = /^-?[\d,]+(\.\d{1,2})? BB$/;
const CHIPS = /^[\d,]+$/;

test('mobile: with big blinds chosen, the table, the buy-in and the replay read in BB while a typed 2.5 BB raise sends 50 chips', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  await a.page.setViewportSize({ width: 360, height: 740 });
  const b = await signUp(browser);
  const wa = watch(a.page);
  const wb = watch(b.page);

  // The setting: chips until chosen.
  await a.page.getByTestId('settings-open').tap();
  const unitBB = a.page.getByTestId('settings-unit-bb');
  await unitBB.scrollIntoViewIfNeeded();
  await expect(a.page.getByTestId('settings-unit-chips')).toHaveAttribute('aria-checked', 'true');
  await expect(a.page.getByText(/지갑과 거래 내역은 항상 칩|Your wallet and history always show chips/)).toBeVisible();
  await unitBB.tap();
  await expect(unitBB).toHaveAttribute('aria-checked', 'true');
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('bb-setting-360.png') });

  // Buying in: the amount for the table in BB with the exact chips, the wallet in chips. 10/20 blinds, 200–2,000 buy-in.
  await a.page.goto('/table/e2e-bb?sit=1');
  const dialog = a.page.getByRole('dialog');
  await expect(dialog).toContainText('10 BB – 100 BB');
  await expect(a.page.getByTestId('buyin-amount')).toHaveText('100 BB2,000');
  await expect(a.page.getByTestId('buyin-confirm')).toHaveText(/100 BB \(2,000\)$/);
  // The amount typed in BB (a decimal keyboard) becomes whole chips; one outside the range (0 included) shows the
  // nearest amount it will pay.
  const typed = a.page.getByTestId('buyin-input');
  await expect(typed).toHaveAttribute('inputmode', 'decimal');
  await expect(typed).toHaveValue('100');
  await typed.fill('55.55');
  await expect(a.page.getByTestId('buyin-amount')).toHaveText('55.55 BB1,111');
  await expect(a.page.getByTestId('buyin-confirm')).toHaveText(/55\.55 BB \(1,111\)$/);
  await typed.fill('0');
  await expect(typed).toHaveAttribute('aria-invalid', 'true');
  await expect(a.page.getByTestId('buyin-confirm')).toHaveText(/10 BB \(200\)$/);
  await typed.fill('500');
  await expect(typed).toHaveAttribute('aria-invalid', 'true');
  await expect(a.page.getByTestId('buyin-confirm')).toHaveText(/100 BB \(2,000\)$/);
  await typed.blur();
  await expect(typed).toHaveValue('100');
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('bb-buyin-360.png') });
  await a.page.getByTestId('buyin-confirm').tap();
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await b.page.goto('/table/e2e-bb?sit=1');
  await expect(b.page.getByTestId('buyin-confirm')).toHaveText(/2,000$/);
  await b.page.getByTestId('buyin-confirm').click();
  await expect.poll(() => wa.handId).not.toBeNull();
  await expect.poll(() => wb.mySeat).not.toBeNull();
  const seatA = wa.mySeat!;
  const seatB = wb.mySeat!;

  // Stacks: in BB for the player who chose it, in chips for the other.
  await expect(a.page.getByTestId(`stack-${seatA}`)).toHaveText(BB);
  await expect(a.page.getByTestId(`stack-${seatB}`)).toHaveText(BB);
  await expect(b.page.getByTestId(`stack-${seatA}`)).toHaveText(CHIPS);

  // Wait for a turn with a bet or raise to make (the other player only checks or calls).
  await expect
    .poll(
      async () => {
        if (await a.page.getByTestId('action-commit').isVisible().catch(() => false)) return true;
        await checkOrCall(b.page);
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const callBtn = a.page.getByTestId('action-bar').getByRole('button', { name: /^(콜|Call)/ });
  if (await callBtn.isVisible()) await expect(callBtn).toHaveText(/ BB$/);
  await a.page.getByTestId('action-dock-toggle').tap();

  // Typing "2.5" (through "2.") holds 50 chips, shown beside the field and on the button.
  const field = a.page.getByTestId('action-amount');
  await expect(field).toHaveAttribute('inputmode', 'decimal');
  await field.fill('');
  await field.pressSequentially('2.5');
  await expect(field).toHaveValue('2.5');
  await expect(a.page.getByTestId('action-chips')).toHaveText('= 50');
  await expect(a.page.getByTestId('action-commit')).toHaveText(/2\.5 BB \(50\)$/);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('bb-raise-360.png') });
  await a.page.getByTestId('action-commit').tap();

  // The room got whole chips: 50 sent, 50 in front of the seat for everyone.
  await expect.poll(() => wa.sent.filter((m) => m.t === 'action' && (m.type === 'raise' || m.type === 'bet')).map((m) => m.amount)).toEqual([50]);
  await expect.poll(() => wb.bets[seatA]).toBe(50);
  await expect(a.page.getByTestId(`bet-${seatA}`)).toHaveText('2.5 BB');
  await expect(b.page.getByTestId(`bet-${seatA}`)).toHaveText('50');
  expect(await labelsOnScreen(a.page)).toBe(true);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('bb-table-360.png') });

  // Play the hand out, then open it from my page.
  const handId = wa.handId!;
  let hand: HandDetailDto | undefined;
  await expect(async () => {
    (await checkOrCall(b.page)) || (await checkOrCall(a.page));
    if ((await call<HandSummaryDto[]>(a.page, '/api/me/hands')).some((x) => x.id === handId)) hand = await call<HandDetailDto>(a.page, `/api/me/hands/${handId}`);
    expect(hand).toBeDefined();
  }).toPass({ timeout: 90_000 });
  expect(hand!.bigBlind).toBe(20);
  // The record keeps what each action added; with what the seat had already put in on that street, it raised to 50.
  const at = hand!.actions.findIndex((x) => x.seatIndex === seatA && (x.type === 'raise' || x.type === 'bet'));
  const raised = hand!.actions[at]!;
  expect(hand!.actions.slice(0, at + 1).filter((x) => x.seatIndex === seatA && x.stage === raised.stage).reduce((n, x) => n + x.amount, 0)).toBe(50);

  await a.page.goto(`/me/hands/${handId}`);
  await expect(a.page.getByTestId('hand-replay')).toBeVisible();
  await expect(a.page.getByTestId('replay-pot')).toHaveText(/ BB$/);
  // The action list reads the raise as the replay's line does, to the street total it reached; then the step where the
  // raise is in front of the seat.
  await expect(a.page.locator('ol li').filter({ hasText: /레이즈|Raise|벳|Bet/ })).toHaveText([/[^\d.]2\.5 BB$/]);
  const bet = a.page.getByTestId('hand-replay').getByTestId(`bet-${seatA}`);
  for (let k = 0; k < 30 && (await bet.textContent().catch(() => null)) !== '2.5 BB'; k++) await a.page.getByTestId('replay-next').tap();
  await expect(bet).toHaveText('2.5 BB');
  // The step's line reads a bet or a raise as the total it reaches, as the seat's bet shows it.
  await expect(a.page.getByTestId('replay-step')).toHaveText(/(2\.5 BB까지 레이즈|raises to 2\.5 BB|2\.5 BB 벳|bets 2\.5 BB)$/);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('bb-replay-360.png') });
  // The payout reads in BB too.
  await a.page.getByTestId('replay-last').tap();
  await expect(a.page.getByTestId('replay-pots')).toContainText(' BB');
  await a.page.screenshot({ path: test.info().outputPath('bb-replay-result-360.png'), fullPage: true });
  // The players' results in BB, with both short names whole beside them.
  await expect(a.page.getByTestId('hand-net')).toHaveText([/^[+-]?[\d,.]+ BB$/, /^[+-]?[\d,.]+ BB$/]);
  const clipped = await a.page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="hand-net"]')).map((n) => {
      const name = n.closest('li')!.querySelector('[data-testid="member-name"] > span:last-of-type') as HTMLElement;
      return name.scrollWidth > name.clientWidth;
    }),
  );
  expect(clipped).toEqual([false, false]);
  await a.page.getByTestId('hand-net').first().scrollIntoViewIfNeeded();
  await a.page.screenshot({ path: test.info().outputPath('bb-hand-players-360.png') });

  // My wallet stays in chips.
  await a.page.goto('/me');
  await expect(a.page.getByText(/ BB$/)).toHaveCount(0);
});
