import { expect, test } from '@playwright/test';
import { answerAll, CARD_ANSWERS, playScenario, sortBySwaps } from './academy-helpers';
import { balanceOf, checkOrCall, signUp } from './helpers';

// Engine-decided answers for Lesson 2's compare quiz, in question order (see data/handQuiz.ts).
const COMPARE = ['b', 'b', 'b', 'a', 'a', 'a', 'b', 'a', 'split', 'split', 'a'];

test('academy: onboarding, card lesson with wrong-then-right answers, progress restored per account', async ({ browser }) => {
  const a = await signUp(browser);
  const p = a.page;
  await p.getByRole('link', { name: /^(아카데미|Academy)$/ }).first().click();
  await expect(p.getByTestId('academy')).toBeVisible();
  await expect(p.getByTestId('academy-percent')).toHaveText('0%');
  await p.getByTestId('choose-cards').click();
  await expect(p.getByTestId('lesson-cards')).toBeVisible();

  // Three explanation steps, then the quiz (Next stays locked until it is solved).
  for (let i = 0; i < 3; i++) await p.getByTestId('lesson-next').click();
  await expect(p.getByTestId('lesson-finish')).toBeDisabled();

  // Wrong answer → explanation → retry on the same question.
  await p.locator('[data-pick="As"]').click();
  await expect(p.getByTestId('feedback-wrong')).toContainText(/스페이드|Spade/);
  await expect(p.getByTestId('quiz')).toHaveAttribute('data-question', 'c-heart');
  await answerAll(p, CARD_ANSWERS);
  await p.getByTestId('lesson-finish').click();
  await expect(p.getByTestId('lesson-done')).toBeVisible();

  // Progress survives a reload and is not shown to another account.
  await p.goto('/academy');
  await expect(p.getByTestId('toc-cards')).toContainText(/완료|Done/);
  await expect(p.getByTestId('academy-percent')).not.toHaveText('0%');
  await expect(p.getByTestId('academy-onboarding')).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId('toc-cards')).toContainText(/완료|Done/);
  const b = await signUp(browser);
  await b.page.goto('/academy');
  await expect(b.page.getByTestId('academy-percent')).toHaveText('0%');
  await expect(b.page.getByTestId('toc-cards')).not.toContainText(/완료|Done/);

  // Restart clears it.
  await p.goto('/academy/progress');
  await p.getByTestId('academy-reset').click();
  await p.getByTestId('academy-reset-confirm').click();
  await p.goto('/academy');
  await expect(p.getByTestId('academy-percent')).toHaveText('0%');
});

test('academy: hand comparison (engine-judged), drag sorting, hold’em streets, action demo', async ({ browser }) => {
  const { page: p } = await signUp(browser);
  await p.goto('/academy/hands?step=3');
  for (let i = 0; i < COMPARE.length; i++) {
    const q = p.getByTestId('quiz');
    await expect(q.locator(`[data-choice="${COMPARE[i]}"]`)).toBeEnabled();
    await q.locator(`[data-choice="${COMPARE[i]}"]`).click();
    await expect(p.getByTestId('feedback-correct')).toBeVisible();
    if (i < COMPARE.length - 1) await p.getByTestId('quiz-next').click();
  }
  await p.getByTestId('lesson-next').click();

  // Drag (pointer) the full house to the front, then finish with taps.
  const first = p.locator('[data-testid=sort-row] > :nth-child(1)');
  const second = p.locator('[data-testid=sort-row] > :nth-child(2)');
  const [b1, b2] = [await first.boundingBox(), await second.boundingBox()];
  await p.mouse.move(b2!.x + b2!.width / 2, b2!.y + b2!.height / 2);
  await p.mouse.down();
  await p.mouse.move(b1!.x + b1!.width / 2, b1!.y + 5, { steps: 8 });
  await p.mouse.up();
  await expect(first).toHaveAttribute('data-sort-item', '1');
  await sortBySwaps(p, [1, 3, 0, 2]);
  await p.getByTestId('lesson-finish').click();
  await expect(p.getByTestId('lesson-done')).toBeVisible();

  await p.goto('/academy/holdem?step=2');
  for (let i = 0; i < 4; i++) await p.getByTestId('stage-next').click();
  await expect(p.getByTestId('stage-board').locator('[data-card]')).toHaveCount(5);
  await expect(p.getByText(/승리!|You win/)).toBeVisible();

  await p.goto('/academy/actions?step=1');
  await p.locator('[data-situation=facing]').click();
  await expect(p.getByTestId('legal-list')).toContainText('raise 50');
  await p.waitForTimeout(400); // the ActionBar ignores taps right after it appears
  await p.getByTestId('action-bar').getByRole('button', { name: /^(콜|Call)/ }).click();
  await expect(p.getByTestId('demo-said')).toContainText('20');
});

test('academy practice: real table UI offline — no socket, wallet unchanged, scenario completes', async ({ browser }) => {
  const { page: p } = await signUp(browser);
  const before = await balanceOf(p);
  const ledgerBefore = await p.evaluate(async () => ((await (await fetch('/api/me/ledger')).json()) as unknown[]).length);
  const sockets: string[] = [];
  p.on('websocket', (ws) => sockets.push(ws.url()));
  await p.goto('/academy/practice');
  await p.getByTestId('scenario-A').click();
  await expect(p.getByTestId('practice-table')).toBeVisible();
  // Off-script action is refused with coaching, nothing happens.
  await expect(p.getByTestId('action-bar')).toBeVisible({ timeout: 15_000 });
  await p.waitForTimeout(400);
  await p.getByTestId('action-bar').getByRole('button', { name: /^(레이즈|Raise)$/ }).click();
  await p.getByTestId('action-bar').getByRole('button', { name: /^(레이즈|Raise) \d/ }).click();
  await expect(p.getByTestId('coach')).toContainText(/다른 액션|try this instead/);
  await playScenario(p, [{ action: /^(체크|Check)$/ }, { action: /^(체크|Check)$/ }]);
  await expect(p.getByTestId('practice-done')).toBeVisible({ timeout: 30_000 });

  // Scenario F asks for the winner before revealing it; the engine decides.
  await p.goto('/academy/practice/F');
  await expect(p.getByTestId('practice-question')).toBeVisible({ timeout: 30_000 });
  await p.getByTestId('practice-question').locator('[data-choice=me]').click();
  await expect(p.getByTestId('practice-question')).toContainText(/아쉬워요|Not quite/);
  await p.getByTestId('practice-question').locator('[data-choice=opp]').click();
  await p.getByTestId('practice-continue').click();
  await expect(p.getByTestId('practice-done')).toBeVisible();

  expect(sockets).toEqual([]);
  expect(await balanceOf(p)).toBe(before);
  await p.goto('/academy/practice');
  await expect(p.getByTestId('scenario-A')).toContainText(/완료|Done/);
  await expect(p.getByTestId('scenario-F')).toContainText(/완료|Done/);
  // Practice hands never reach the real hand history or the ledger.
  const get = (u: string) => p.evaluate(async (url) => (await (await fetch(url)).json()) as unknown[], u);
  expect(await get('/api/me/hands')).toEqual([]);
  expect((await get('/api/me/ledger')).length).toBe(ledgerBefore);
});

test('real table: hand chart opens without dropping the game; beginner mode shows the current hand', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  await a.page.goto('/academy');
  await a.page.getByTestId('beginner-toggle').check();
  await a.page.goto('/table/e2e-academy?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-academy');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();

  await expect(a.page.getByTestId('current-hand')).toBeVisible({ timeout: 20_000 });
  await expect(a.page.getByTestId('stage-note')).toBeVisible();
  await a.page.getByTestId('hand-chart-open').click();
  await expect(a.page.getByTestId('hand-chart')).toBeVisible();
  await expect(a.page.getByTestId('hand-chart').locator('[data-testid^=rank-]')).toHaveCount(10);
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByTestId('hand-chart')).toHaveCount(0);
  // Still connected and playable: the hand goes on.
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    await expect(a.page.getByTestId('board').locator('[data-card]')).toHaveCount(3, { timeout: 500 });
  }).toPass({ timeout: 40_000 });
  await expect(a.page.getByTestId('current-hand')).toBeVisible();
  // Player B (beginner mode off) sees none of it.
  await expect(b.page.getByTestId('current-hand')).toHaveCount(0);
});
