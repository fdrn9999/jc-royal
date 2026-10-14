import { expect, type Page } from '@playwright/test';

type Press = 'click' | 'tap';
const press = async (page: Page, sel: string, how: Press) => {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  await (how === 'tap' ? el.tap() : el.click());
};

/** Brings the sort row into `target` (item indexes, strongest first) using tap-to-swap. */
export async function sortBySwaps(page: Page, target: number[], how: Press = 'click') {
  for (let i = 0; i < target.length; i++) {
    const order = await page.locator('[data-testid=sort-row] [data-sort-item]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-sort-item'))));
    const j = order.indexOf(target[i]!);
    if (j === i) continue;
    await press(page, `[data-testid=sort-row] > :nth-child(${i + 1})`, how);
    await press(page, `[data-testid=sort-row] > :nth-child(${j + 1})`, how);
  }
  await press(page, '[data-testid=sort-check]', how);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
}

/** Lesson 1 quiz answers in question order. */
export const CARD_ANSWERS: ({ pick: string } | { choice: string } | { sort: number[] })[] = [
  { pick: '7h' },
  { pick: 'As' },
  { pick: 'Kc' },
  { pick: '5d' },
  { pick: 'Ac' },
  { choice: 'eq' },
  { sort: [1, 3, 2, 0] },
  { sort: [3, 2, 0, 4, 1] },
];

export async function answerAll(page: Page, answers: typeof CARD_ANSWERS, how: Press = 'click') {
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i]!;
    if ('pick' in a) await press(page, `[data-pick="${a.pick}"]`, how);
    else if ('choice' in a) await press(page, `[data-testid=quiz] [data-choice="${a.choice}"]`, how);
    else await sortBySwaps(page, a.sort, how);
    await expect(page.getByTestId('feedback-correct')).toBeVisible();
    if (i < answers.length - 1) await press(page, '[data-testid=quiz-next]', how);
  }
}

/** Plays a guided practice scenario by pressing whatever the coach asks for. */
export async function playScenario(page: Page, plan: { action: RegExp; raise?: boolean }[], how: Press = 'click') {
  const bar = page.getByTestId('action-bar');
  const coach = page.getByTestId('coach');
  for (const step of plan) {
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400); // ActionBar ignores taps right after it appears
    const before = await coach.textContent();
    if (step.raise) {
      await press(page, '[data-testid=action-bar] button[aria-expanded]', how);
      const confirm = bar.getByRole('button', { name: /^(레이즈|Raise|벳|Bet) \d/ });
      await (how === 'tap' ? confirm.tap() : confirm.click());
    } else {
      const btn = bar.getByRole('button', { name: step.action });
      await (how === 'tap' ? btn.tap() : btn.click());
    }
    // The next street may hand the turn straight back: wait for the coach to move on instead.
    await expect.poll(async () => (await coach.textContent()) !== before || !(await bar.isVisible()), { timeout: 10_000 }).toBe(true);
  }
}
