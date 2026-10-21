import { expect, type Page } from '@playwright/test';
import { balanceOf, checkOrCall, signUp, standUp, test } from './helpers';

type Player = { page: Page; nickname: string; seat: number; en: boolean };

/** What a player is told, in the language they read the table in. */
const say = (p: Player, en: string, ko: string) => (p.en ? en : ko);
const chipsIn = async (page: Page, testId: string) => Number(((await page.getByTestId(testId).textContent()) ?? '').replace(/\D/g, ''));
const seatOf = (page: Page, nickname: string) => page.locator('[data-testid=table] [data-testid^="seat-"][data-state]').filter({ hasText: nickname });
const myTurn = (page: Page) => page.getByTestId('action-bar').isVisible().catch(() => false);

test('standing up mid-hand: asked first, folded at once on my turn or when it comes, the seat held until the hand ends', async ({ browser }) => {
  const users = [await signUp(browser), await signUp(browser), await signUp(browser)];
  // The first player reads the table in English, the others in Korean: chosen in the settings, as the account's own
  // choice (signing in sets the page to it, whatever this browser had saved).
  const first = users[0]!.page;
  await first.getByTestId('settings-open').click();
  const saved = first.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH');
  await first.getByLabel('언어', { exact: true }).selectOption('en');
  await saved;
  await first.keyboard.press('Escape');
  const ps: Player[] = [];
  for (const u of users) {
    await u.page.goto('/table/e2e-fold?sit=1');
    await expect(u.page.locator('html')).toHaveAttribute('lang', u === users[0] ? 'en' : 'ko');
    await u.page.getByTestId('buyin-confirm').click();
    await expect(u.page.getByTestId('buyin-confirm')).toHaveCount(0);
    const testId = (await seatOf(u.page, u.nickname).getAttribute('data-testid'))!;
    ps.push({ ...u, seat: Number(testId.replace('seat-', '')), en: u === users[0] });
  }
  const live = (p: Player) => p.page.locator('[data-testid=table] [data-testid^="seat-"][data-state=active]');

  // A hand all three are dealt into (one the first two started before the third sat down is played out first).
  await expect(async () => {
    if ((await live(ps[0]!).count()) < 3) for (const p of ps) await checkOrCall(p.page);
    await expect(live(ps[0]!)).toHaveCount(3, { timeout: 500 });
  }).toPass({ timeout: 60_000 });

  // My turn: standing up asks first, then folds and stands up at once while the hand goes on.
  let x: Player | undefined;
  await expect(async () => {
    for (const p of ps) if (await myTurn(p.page)) x = p;
    expect(x).toBeDefined();
  }).toPass({ timeout: 30_000 });
  const actor = x!;
  const [w, v] = ps.filter((p) => p !== actor) as [Player, Player];
  const stack = await chipsIn(actor.page, `stack-${actor.seat}`);
  const wallet = await balanceOf(actor.page);
  await actor.page.getByTestId('leave').click();
  const ask = actor.page.getByTestId('leave-ask');
  await expect(ask).toContainText(say(actor, 'Standing up now folds this hand.', '지금 일어나면 이번 핸드는 폴드됩니다.'));
  await expect(actor.page.getByTestId('leave')).toHaveAttribute('aria-expanded', 'true');
  await actor.page.getByTestId('leave-fold').click();
  await expect(ask).toHaveCount(0);
  await expect(seatOf(actor.page, actor.nickname)).toHaveCount(0);
  // Only what was not put in comes back, at once.
  await expect.poll(() => balanceOf(actor.page), { timeout: 15_000 }).toBe(wallet + stack);
  const next = actor.page.getByTestId('left-next');
  await expect(next).toContainText(say(actor, 'Keep watching this table or find another one.', '이 테이블을 계속 보거나 다른 테이블을 찾을 수 있습니다.'));
  for (const id of ['quick-another', 'stay-here', 'left-lobby']) await expect(next.getByTestId(id)).toBeVisible();
  // The seat stays out of reach until the hand ends, for everyone.
  for (const p of [actor, w, v]) await expect(p.page.getByTestId(`held-${actor.seat}`)).toBeVisible();
  await expect(actor.page.getByTestId(`sit-${actor.seat}`)).toHaveCount(0);
  await actor.page.screenshot({ path: 'test-results/fold-leave-left.png' });

  // Not my turn: the fold waits for it. Esc closes the question and gives the button back its focus.
  let turn: Player | undefined;
  await expect(async () => {
    for (const p of [w, v]) if (await myTurn(p.page)) turn = p;
    expect(turn).toBeDefined();
  }).toPass({ timeout: 30_000 });
  const acting = turn!;
  const waiting = acting === w ? v : w;
  await waiting.page.getByTestId('leave').click();
  const atTurn = say(waiting, 'You fold when your turn comes and stand up at once.', '차례가 오면 폴드하고 바로 일어납니다.');
  await expect(waiting.page.getByTestId('leave-ask')).toContainText(atTurn);
  await waiting.page.screenshot({ path: 'test-results/fold-leave-ask.png' });
  await waiting.page.keyboard.press('Escape');
  await expect(waiting.page.getByTestId('leave-ask')).toHaveCount(0);
  await expect(waiting.page.getByTestId('leave')).toBeFocused();
  const before = await balanceOf(waiting.page);
  await waiting.page.getByTestId('leave').click();
  await waiting.page.getByTestId('leave-fold').click();
  await expect(waiting.page.getByTestId('leaving-note')).toHaveText(atTurn);
  await expect(waiting.page.getByTestId('pre-actions')).toHaveCount(0);
  await expect(seatOf(waiting.page, waiting.nickname)).toHaveCount(1);

  // The other plays on; when the turn comes the fold is made and the player stands up.
  await expect(async () => {
    await checkOrCall(acting.page);
    await expect(seatOf(waiting.page, waiting.nickname)).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await expect(waiting.page.getByTestId('left-next')).toContainText(say(waiting, 'Keep watching this table or find another one.', '이 테이블을 계속 보거나 다른 테이블을 찾을 수 있습니다.'));
  await expect.poll(() => balanceOf(waiting.page), { timeout: 15_000 }).toBeGreaterThan(before);

  // The hand is over: both seats are free again.
  for (const seat of [actor.seat, waiting.seat]) await expect(actor.page.getByTestId(`sit-${seat}`)).toBeVisible({ timeout: 30_000 });
  // Watching on: the strip goes, the table stays.
  await actor.page.getByTestId('stay-here').click();
  await expect(actor.page.getByTestId('left-next')).toHaveCount(0);
  await expect(actor.page).toHaveURL(/\/table\/e2e-fold/);

  // Alone between hands, the last player stands up at once: nothing is asked.
  await acting.page.getByTestId('leave').click();
  await expect(seatOf(acting.page, acting.nickname)).toHaveCount(0);
  await expect(acting.page.getByTestId('leave-ask')).toHaveCount(0);

  // Every chip is back in a wallet.
  await expect.poll(async () => (await Promise.all(ps.map((p) => balanceOf(p.page)))).reduce((a, b) => a + b, 0), { timeout: 30_000 }).toBe(30_000);
});

test('standing up while asked: Cancel keeps the seat and the hand', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  // A table of its own: whoever the other test leaves sitting does not hold this one's hand.
  for (const p of [a.page, b.page]) {
    await p.goto('/table/e2e-fold2?sit=1');
    await p.getByTestId('buyin-confirm').click();
    await expect(p.getByTestId('buyin-confirm')).toHaveCount(0);
  }
  let asker: Page | undefined;
  await expect(async () => {
    for (const p of [a.page, b.page]) if (await myTurn(p)) asker = p;
    expect(asker).toBeDefined();
  }).toPass({ timeout: 30_000 });
  const me = asker === a.page ? a : b;
  await me.page.getByTestId('leave').click();
  await me.page.getByTestId('leave-cancel').click();
  await expect(me.page.getByTestId('leave-ask')).toHaveCount(0);
  await expect(me.page.getByTestId('leave')).toBeFocused();
  // A tap elsewhere closes it too.
  await me.page.getByTestId('leave').click();
  await expect(me.page.getByTestId('leave-ask')).toBeVisible();
  // (The table's name: always there, and does nothing when tapped. The pot is still empty before the flop.)
  await me.page.getByTestId('table-title').click();
  await expect(me.page.getByTestId('leave-ask')).toHaveCount(0);
  await expect(seatOf(me.page, me.nickname)).toHaveAttribute('data-state', 'active');
  await expect(me.page.getByTestId('action-bar')).toBeVisible();
  for (const p of [a.page, b.page]) await standUp(p);
  await expect.poll(async () => (await balanceOf(a.page)) + (await balanceOf(b.page)), { timeout: 30_000 }).toBe(20_000);
});
