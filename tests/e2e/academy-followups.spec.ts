import { expect, type Browser } from '@playwright/test';
import { answerAll, CARD_ANSWERS } from './academy-helpers';
import { balanceOf, checkOrCall, PASSWORD, signUp, test } from './helpers';

async function loginOnNewDevice(browser: Browser, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel(/^(이메일|Email)$/).fill(email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /^(로그인|Log in)$/ }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

test('academy sync: progress and badges follow the account to another device', async ({ browser }) => {
  const a = await signUp(browser);
  await a.page.goto('/academy/cards?step=3');
  await answerAll(a.page, CARD_ANSWERS);
  const saved = a.page.waitForResponse((r) => r.url().endsWith('/api/academy/progress') && r.request().method() === 'PUT' && r.ok());
  await a.page.getByTestId('lesson-finish').click();
  await saved;

  const other = await loginOnNewDevice(browser, a.email);
  await other.goto('/academy');
  await expect(other.getByTestId('toc-cards')).toContainText(/완료|Done/);
  await expect(other.locator('[data-badge=card-reader]')).toHaveAttribute('data-earned', '1');
  await other.goto('/me');
  await expect(other.getByTestId('badges').locator('[data-badge=first-step]')).toBeVisible();
});

test('academy badges: progress edited in the browser is kept but earns nothing; real study after a restart does', async ({ browser }) => {
  const { page: p } = await signUp(browser);
  await p.goto('/academy');
  await expect(p.getByTestId('badges-note')).toContainText(/공식 수료증이 아니며|not certificates/);
  const badgesNow = () => p.evaluate(async () => ((await (await fetch('/api/academy/badges')).json()) as { badge: string }[]).map((b) => b.badge).sort());

  // Every lesson "finished" in 1970 on step 3, all scenarios, three review sets without a single answer.
  const id = await p.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const done = (at: number) => ({ startedAt: at, completedAt: at, step: 3 });
  const forged = {
    v: 2,
    updatedAt: Date.now(),
    lessons: { cards: done(1), hands: done(2), holdem: done(3), actions: done(4), practice: done(5) },
    practice: Object.fromEntries([...'ABCDEFGH'].map((s) => [s, 1])),
    quiz: { correct: 0, wrong: 0 },
    review: { sessions: 3, best: 8 },
    onboarded: true,
  };
  await p.evaluate(([k, v]) => localStorage.setItem(k!, v!), [`jc.academy:${id}`, JSON.stringify(forged)]);
  const pushed = p.waitForResponse((r) => r.url().endsWith('/api/academy/progress') && r.request().method() === 'PUT');
  await p.reload();
  expect((await (await pushed).json()).badges).toEqual([]);
  const stored = await p.evaluate(async () => ((await (await fetch('/api/academy/progress')).json()) as { data: { lessons: { cards: { completedAt: number } } } }).data);
  expect(stored.lessons.cards.completedAt).toBe(1); // synced as the account's own progress, just not rewarded
  await expect(p.locator('[data-badge]')).toHaveCount(7);
  await expect(p.locator('[data-badge][data-earned="1"]')).toHaveCount(0);
  expect(await badgesNow()).toEqual([]);

  await p.goto('/academy/progress');
  await p.getByTestId('academy-reset').click();
  await p.getByTestId('academy-reset-confirm').click();
  await p.goto('/academy/cards?step=3');
  await answerAll(p, CARD_ANSWERS);
  await p.getByTestId('lesson-finish').click();
  await expect(p.getByTestId('lesson-done')).toBeVisible();
  await expect.poll(badgesNow, { timeout: 15_000 }).toEqual(['card-reader', 'first-step']);
});

test('compare quiz explains a wrong pick with the deciding cards; review page targets the weak topic', async ({ browser }) => {
  const { page: p } = await signUp(browser);
  await p.goto('/academy/hands?step=3');
  // Q1: one pair vs two pair — B wins. Pick A on purpose.
  await expect(p.getByTestId('quiz').locator('[data-choice=a]')).toBeEnabled();
  await p.getByTestId('quiz').locator('[data-choice=a]').click();
  await expect(p.getByTestId('feedback-wrong')).toContainText(/투페어|two pair/);
  await expect(p.getByTestId('compare-why')).toBeVisible();
  await p.goto('/academy/review');
  await expect(p.getByTestId('weak-topics').locator('[data-topic=hand-order]')).toBeVisible();
  await p.getByTestId('start-review').click();
  await expect(p.getByTestId('quiz-prompt')).toBeVisible();
  await expect(p.getByTestId('quiz')).toContainText(/문제 1\/8|Question 1\/8/);
  await p.goto('/academy/review?mode=random');
  await expect(p.getByTestId('quiz-prompt')).toBeVisible();
});

test('free practice: rule-based bots, any legal action, several hands, still offline', async ({ browser }) => {
  const { page: p } = await signUp(browser);
  const before = await balanceOf(p);
  const sockets: string[] = [];
  p.on('websocket', (ws) => sockets.push(ws.url()));
  await p.goto('/academy/practice');
  await p.getByTestId('scenario-free').click();
  await p.locator('[data-bots="2"]').click();
  await p.getByTestId('free-start').click();
  await expect(p.getByTestId('free-table')).toBeVisible();
  for (let hand = 0; hand < 2; hand++) {
    await expect(async () => {
      if (await p.getByTestId('free-result').isVisible().catch(() => false)) return;
      const bar = p.getByTestId('action-bar');
      if (await bar.isVisible().catch(() => false)) {
        await p.waitForTimeout(400);
        // Free play accepts whatever legal action the player chooses.
        const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
        const pass = bar.getByRole('button', { name: /^(체크|Check|콜|Call)/ });
        await ((await pass.count()) ? pass.first() : fold).click();
        // A big call asks for a second tap (risky-action guard); confirm it before the arm expires.
        const again = bar.getByRole('button', { name: /^(한 번 더|Tap again)/ });
        if (await again.first().isVisible().catch(() => false)) await again.first().click();
      }
      await expect(p.getByTestId('free-result')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 60_000 });
    await p.getByTestId('free-next').click();
  }
  await expect(p.getByTestId('free-table')).toContainText(/핸드 3|Hand 3/);
  expect(sockets).toEqual([]);
  expect(await balanceOf(p)).toBe(before);
});

test('real game links: beginner table tag + filter, first-hands coaching after a lesson', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  await expect(a.page.getByTestId('lobby-table').filter({ hasText: 'E2E Rookie' }).getByTestId('beginner-badge')).toBeVisible();
  await a.page.getByRole('tab', { name: /^(입문|Beginner)$/ }).click();
  await expect(a.page.getByTestId('lobby-table')).toHaveCount(1);

  // Finish lesson 1, then play: coaching tips appear on A's turn and can be switched off.
  await a.page.goto('/academy/cards?step=3');
  await answerAll(a.page, CARD_ANSWERS);
  await a.page.getByTestId('lesson-finish').click();
  await a.page.goto('/table/e2e-coach?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-coach');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();
  await expect(async () => {
    if (await a.page.getByTestId('action-bar').isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(a.page.getByTestId('action-bar')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  await expect(a.page.getByTestId('coach-tip')).toBeVisible();
  await expect(b.page.getByTestId('coach-tip')).toHaveCount(0); // B never took a lesson
  await a.page.getByTestId('coach-off').click();
  await expect(a.page.getByTestId('coach-tip')).toHaveCount(0);
});
