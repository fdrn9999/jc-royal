import { expect, type Locator, type Page } from '@playwright/test';
import { checkOrCall, signUp, test } from './helpers';

/** Actions this page sends over its table socket, in order. */
function actionsSent(page: Page) {
  const sent: { type: string; amount?: number }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"t":"action"')) sent.push(JSON.parse(payload) as { type: string; amount?: number });
    }),
  );
  return sent;
}

/**
 * Whether a button shows its first-press label right now. Read once after the render settles: a retrying expect
 * would also pass once an arm left by a stray key expires by itself.
 */
async function armedNow(page: Page, button: Locator) {
  await page.waitForTimeout(150);
  return /^(한 번 더|Press again)/.test((await button.textContent()) ?? '');
}

/** Opens the bet sizing, types `to` and bets it; the first press only arms a raise of half the stack or more. */
async function raiseTo(page: Page, sent: unknown[], to: number) {
  const bar = page.getByTestId('action-bar');
  await page.waitForTimeout(400); // past the appear guard
  await bar.getByTestId('action-dock-toggle').click();
  await bar.getByRole('textbox').fill(String(to));
  const commit = bar.getByTestId('action-commit');
  const n = sent.length;
  await commit.click();
  await expect(commit).toHaveText(/^(한 번 더|Press again)/);
  expect(sent.length).toBe(n);
  await commit.click();
  await expect.poll(() => sent.length).toBe(n + 1);
}

test('keyboard shortcuts: same two-press confirmation as a tap, no repeats, nothing from chat or dialogs, one action per turn', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const aSent = actionsSent(a.page);
  const bSent = actionsSent(b.page);
  await a.page.goto('/table/e2e-keys?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-keys?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  const barA = a.page.getByTestId('action-bar');
  const callA = barA.getByRole('button', { name: /^(콜|Call|한 번 더|Press again)/ });
  // A faces B's raise to 600: calling puts more than half of A's 1,000 in.
  await expect(async () => {
    if (await callA.isVisible().catch(() => false)) {
      if (Number(((await callA.textContent()) ?? '').replace(/\D/g, '')) >= 500) return;
      await checkOrCall(a.page);
    } else if (await b.page.getByTestId('action-bar').isVisible().catch(() => false)) {
      await raiseTo(b.page, bSent, 600);
    } else {
      await checkOrCall(a.page);
    }
    expect(Number(((await callA.textContent({ timeout: 1000 })) ?? '').replace(/\D/g, ''))).toBeGreaterThanOrEqual(500);
  }).toPass({ timeout: 40_000 });
  expect(bSent.at(-1)).toMatchObject({ type: 'raise', amount: 600 });
  await a.page.waitForTimeout(400);
  const before = aSent.length;

  // Letters typed into the chat stay in the chat.
  const chat = a.page.getByRole('textbox', { name: /채팅|Chat/ });
  await chat.click();
  await a.page.keyboard.type('cf');
  await expect(chat).toHaveValue('cf');
  expect(await armedNow(a.page, callA)).toBe(false);
  await chat.fill('');
  // While a dialog is open, keys belong to it.
  await a.page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  await expect(a.page.getByRole('dialog')).toBeVisible();
  await a.page.keyboard.press('c');
  await a.page.keyboard.press('f');
  expect(await armedNow(a.page, callA)).toBe(false);
  await a.page.keyboard.press('Escape');
  await expect(a.page.getByRole('dialog')).toHaveCount(0);
  await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Browser shortcuts are not table shortcuts.
  await a.page.keyboard.press('Control+c');
  expect(await armedNow(a.page, callA)).toBe(false);
  expect(aSent.length).toBe(before);

  // C on a big call arms it like the first tap; holding the key down does not confirm it.
  await a.page.keyboard.down('c');
  await expect(callA).toHaveText(/^(한 번 더|Press again)/);
  await a.page.keyboard.down('c');
  await a.page.keyboard.down('c');
  await a.page.keyboard.up('c');
  await a.page.waitForTimeout(300);
  expect(aSent.length).toBe(before);
  await a.page.keyboard.press('c');
  await expect.poll(() => aSent.length).toBe(before + 1);
  expect(aSent.at(-1)!.type).toBe('call');

  // Next street, A to act with a free check.
  const checkA = barA.getByRole('button', { name: /^(체크|Check)$/ });
  await expect(async () => {
    if (await checkA.isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(checkA).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await a.page.waitForTimeout(400);
  const n = aSent.length;
  // R opens the bet sizing and never bets; Escape closes it from its amount field, sending nothing, and its toggle has
  // the focus. The amount typed stays, and Bet still bets it.
  const toggleA = barA.getByTestId('action-dock-toggle');
  await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
  await a.page.keyboard.press('r');
  await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
  const amountA = barA.getByTestId('action-amount');
  await amountA.fill('300');
  await amountA.press('Escape');
  await expect(barA.locator('[data-raise-panel]')).toHaveCount(0);
  await expect(toggleA).toBeFocused();
  await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
  await expect(barA.getByTestId('action-commit')).toHaveText(/^(벳|Bet) 300$/);
  await a.page.keyboard.press('r');
  await a.page.keyboard.press('r');
  await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
  await a.page.waitForTimeout(300);
  expect(aSent.length).toBe(n);
  expect(await armedNow(a.page, barA.getByTestId('action-commit'))).toBe(false);
  // F with a free check only arms the fold.
  await a.page.keyboard.press('f');
  await expect(barA.getByRole('button', { name: /폴드|Fold/ })).toHaveText(/^(한 번 더|Press again)/);
  expect(aSent.length).toBe(n);
  // Two key events in the same moment (before the bar re-renders) send one check.
  await a.page.evaluate(() => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC' }));
  });
  await expect.poll(() => aSent.length).toBe(n + 1);
  await a.page.waitForTimeout(500);
  expect(aSent.length).toBe(n + 1);
  expect(aSent.at(-1)!.type).toBe('check');
  await expect(a.page.getByRole('alert')).toHaveCount(0);
});
