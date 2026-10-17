import type { HandDetailDto } from '@jc/types';
import { expect, type Page } from '@playwright/test';
import { setAccountPrefs, setRange, signUp, test } from './helpers';
import { build, HAND_6 } from './replay-hands';

/** Heads-up, over before the flop: the big blind raises a limp to 300 and the small blind folds. */
const FOLDED = (() => {
  const h = build(
    'e2e-timeline-fold',
    2,
    0,
    [],
    [
      { seat: 0, name: 'WWWWWWWWWWWWWWWW', stack: 10_000, cards: ['Ah', '5d'] },
      { seat: 1, name: 'MMMMMMMMMMMMMMMM', stack: 10_000 },
    ],
    [
      [0, 'preflop', 'post-sb', 50],
      [1, 'preflop', 'post-bb', 100],
      [0, 'preflop', 'call', 50],
      [1, 'preflop', 'raise', 200],
      [0, 'preflop', 'fold', 0],
    ],
    [
      { amount: 200, eligible: [1], winners: [[1, 200]] },
      { amount: 200, eligible: [1], winners: [[1, 200]] },
    ],
  );
  // The raise nobody called goes back: the engine stores it as a pot of its own.
  h.pots![1]!.uncalled = true;
  return h;
})();

/** Opens a stored hand (served from the fixture) on my page. */
async function open(page: Page, hand: HandDetailDto) {
  await page.route(`**/api/me/hands/${hand.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hand) }));
  await page.goto(`/me/hands/${hand.id}`);
  await expect(page.getByTestId('replay-index')).toBeVisible();
}

// HAND_6: the deal, seven pre-flop actions, the flop and three actions, the turn and four, the river and two, the
// showdown and the payout.
const PARTS = { preflop: 1, flop: 9, turn: 13, river: 18, showdown: 21, result: 22 };

test('replay timeline: each street a tap away, a slider to click or drag, and every step read out in words', async ({ browser }) => {
  const { page } = await signUp(browser);
  await open(page, HAND_6);
  const index = page.getByTestId('replay-index');
  const line = page.getByTestId('replay-step');
  const slider = page.getByTestId('replay-slider');
  await expect(index).toHaveText('1/22');
  await expect(line).toHaveText('프리플랍 · 카드 배분 · abcdefghijklmnop 스몰 블라인드 50 · ZZZZZZZZZZZZZZZZ 빅 블라인드 100');
  await expect(page.getByTestId('replay-phase-preflop')).toHaveAttribute('aria-current', 'step');

  // Every street, the showdown and the result: one tap to where each begins, marked as the current one.
  for (const [phase, k] of Object.entries(PARTS)) {
    await page.getByTestId(`replay-phase-${phase}`).click();
    await expect(index).toHaveText(`${k}/22`);
    await expect(slider).toHaveValue(String(k - 1));
    await expect(page.getByTestId(`replay-phase-${phase}`)).toHaveAttribute('aria-current', 'step');
    expect(await page.locator('[data-testid^=replay-phase-][aria-current]').count()).toBe(1);
  }
  await expect(page.getByTestId('replay-pots')).toBeVisible();

  // What each step did, in the words a player would say: a raise or an all-in to its total, a call or a bet by what it put in.
  const said: [number, string][] = [
    [2, '프리플랍 · WWWWWWWWWWWWWWWW 300까지 레이즈'],
    [3, '프리플랍 · 가나다라마바사아자차카타파하거너 800까지 올인'],
    [7, '프리플랍 · ZZZZZZZZZZZZZZZZ 700 콜'],
    [9, '플랍 · Q♣ 9♠ 5♦ 공개'],
    [13, '턴 · 3♥ 공개'],
    [15, '턴 · WWWWWWWWWWWWWWWW 6,000 벳'],
    [17, '턴 · ZZZZZZZZZZZZZZZZ 폴드'],
    [21, '쇼다운 · WWWWWWWWWWWWWWWW 트리플 · 가나다라마바사아자차카타파하거너 스트레이트 · JC봇_Hard_00003 하이카드'],
    [22, '결과 · 가나다라마바사아자차카타파하거너 3,250 획득 · WWWWWWWWWWWWWWWW 18,000 획득'],
  ];
  for (const [k, text] of said) {
    await setRange(slider, k - 1);
    await expect(index).toHaveText(`${k}/22`);
    await expect(line).toHaveText(text);
  }

  // The street marks sit where each street begins: clicking one lands there.
  const track = (await slider.boundingBox())!;
  const y = track.y + track.height / 2;
  for (const phase of ['flop', 'turn', 'river'] as const) {
    const tick = (await page.getByTestId(`replay-tick-${phase}`).boundingBox())!;
    await page.mouse.click(tick.x + tick.width / 2, y);
    await expect(index).toHaveText(`${PARTS[phase]}/22`);
  }

  // Dragged by its thumb to either end; the arrow keys step one action at a time.
  const thumbAt = (k: number) => track.x + 14 + ((track.width - 28) * (k - 1)) / 21;
  await page.mouse.move(thumbAt(PARTS.river), y);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width - 1, y, { steps: 10 });
  await page.mouse.up();
  await expect(index).toHaveText('22/22');
  await page.mouse.move(thumbAt(22), y);
  await page.mouse.down();
  await page.mouse.move(thumbAt(5), y, { steps: 10 });
  await page.mouse.up();
  await expect(index).toHaveText('5/22');
  await slider.press('ArrowRight');
  await expect(index).toHaveText('6/22');
  await expect(slider).toHaveAttribute('aria-valuetext', /^6\/22 · 프리플랍 · abcdefghijklmnop 폴드$/);

  // Moving while it plays stops the playback where it was moved to.
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('replay-phase-turn').click();
  await expect(page.getByTestId('replay-play')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(1600);
  await expect(index).toHaveText('13/22');
  await page.screenshot({ path: test.info().outputPath('timeline-desktop.png') });
});

test('replay timeline: a hand over before the flop has nothing past it; English and big blinds; playback stops at the end', async ({ browser }) => {
  const { page } = await signUp(browser);
  // A signed-in member's language is the account's: chosen in the header, saved before the page reloads.
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH'), page.getByRole('button', { name: 'EN', exact: true }).click()]);
  await setAccountPrefs(page, { amountUnit: 'bb' });
  await open(page, FOLDED);
  const index = page.getByTestId('replay-index');
  const line = page.getByTestId('replay-step');
  await expect(index).toHaveText('1/5');
  await expect(line).toHaveText('Pre-flop · Cards dealt · WWWWWWWWWWWWWWWW posts the small blind 0.5 BB · MMMMMMMMMMMMMMMM posts the big blind 1 BB');

  // The streets it never reached are shown but cannot be chosen, and get no mark on the slider.
  for (const phase of ['flop', 'turn', 'river', 'showdown']) {
    await expect(page.getByTestId(`replay-phase-${phase}`)).toBeDisabled();
    await expect(page.getByTestId(`replay-tick-${phase}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('replay-slider')).toHaveAttribute('max', '4');

  await page.getByTestId('replay-next').click();
  await expect(line).toHaveText('Pre-flop · WWWWWWWWWWWWWWWW calls 0.5 BB');
  await page.getByTestId('replay-next').click();
  // The raise reads to its total (1 BB posted, 2 BB more): what sits in front of the seat.
  await expect(line).toHaveText('Pre-flop · MMMMMMMMMMMMMMMM raises to 3 BB');
  await expect(page.getByTestId('hand-replay').getByTestId('bet-1')).toHaveText('3 BB');
  await page.getByTestId('replay-next').click();
  await expect(line).toHaveText('Pre-flop · WWWWWWWWWWWWWWWW folds');

  // Played out at double speed: it stops on the payout (the raise handed back is not a win), offering to start over.
  await page.getByTestId('replay-speed-2').click();
  const play = page.getByTestId('replay-play');
  await play.click();
  await expect(index).toHaveText('5/5');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(play).toHaveText(/Replay/);
  await expect(line).toHaveText('Result · MMMMMMMMMMMMMMMM wins 2 BB');
  await expect(page.getByTestId('replay-phase-result')).toHaveAttribute('aria-current', 'step');
  await page.waitForTimeout(1000);
  await expect(index).toHaveText('5/5');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(index).not.toHaveText('5/5');
  await page.screenshot({ path: test.info().outputPath('timeline-folded-en.png') });
});
