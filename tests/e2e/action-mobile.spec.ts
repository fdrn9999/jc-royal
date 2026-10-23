import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test } from './helpers';

function actionsSent(page: Page) {
  const sent: { type: string; amount?: number }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"t":"action"')) sent.push(JSON.parse(payload) as { type: string; amount?: number });
    }),
  );
  return sent;
}

test('mobile: a big call needs a second tap, and moving the bet amount cancels an armed all-in', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aSent = actionsSent(a.page);
  await a.page.goto('/table/e2e-keys-touch?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();
  await b.page.goto('/table/e2e-keys-touch?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  const barA = a.page.getByTestId('action-bar');
  const barB = b.page.getByTestId('action-bar');
  const callA = barA.getByRole('button', { name: /^(콜|Call|한 번 더|Press again)/ });
  const amountOf = async () => Number(((await callA.textContent({ timeout: 1000 })) ?? '').replace(/\D/g, ''));
  // B raises to 600 (two clicks: half of B's stack or more); A then faces a call of more than half of A's 1,000.
  await expect(async () => {
    if (await callA.isVisible().catch(() => false)) {
      if ((await amountOf()) >= 500) return;
      await checkOrCall(a.page);
    } else if (await barB.isVisible().catch(() => false)) {
      await b.page.waitForTimeout(400);
      await barB.getByTestId('action-dock-toggle').click();
      await barB.getByRole('textbox').fill('600');
      await barB.getByTestId('action-commit').click();
      await barB.getByTestId('action-commit').click();
    } else {
      await checkOrCall(a.page);
    }
    expect(await amountOf()).toBeGreaterThanOrEqual(500);
  }).toPass({ timeout: 40_000 });
  await a.page.waitForTimeout(400);

  const before = aSent.length;
  await callA.tap();
  await expect(callA).toHaveText(/^(한 번 더|Press again)/);
  expect(aSent.length).toBe(before);
  await callA.tap();
  await expect.poll(() => aSent.length).toBe(before + 1);
  expect(aSent.at(-1)!.type).toBe('call');

  // Next street, A to act with a bet window: Max is all-in and needs two taps.
  const commit = barA.getByTestId('action-commit');
  await expect(async () => {
    if (/^(벳|Bet) /.test((await commit.textContent({ timeout: 500 }).catch(() => '')) ?? '')) return;
    await checkOrCall(b.page);
    await expect(commit).toHaveText(/^(벳|Bet) /, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await a.page.waitForTimeout(400);
  const n = aSent.length;
  // The dock's own toggle opens the sizing and sends nothing; tapping it twice more closes and reopens it.
  const toggleA = barA.getByTestId('action-dock-toggle');
  await toggleA.tap();
  await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
  await toggleA.tap();
  await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
  await toggleA.tap();
  await expect(barA.locator('[data-raise-panel]')).toBeVisible();
  expect(aSent.length).toBe(n);
  await barA.getByRole('button', { name: /^(최대|Max)$/ }).tap();
  await commit.tap();
  await expect(commit).toHaveText(/^(한 번 더|Press again)/);
  // Changing the amount, even back to the same all-in, cancels the first tap.
  await barA.getByRole('button', { name: '- 10' }).tap();
  await expect(commit).not.toHaveText(/^(한 번 더|Press again)/);
  await barA.getByRole('button', { name: '+ 10' }).tap();
  // Read once, not with a retrying expect: an arm left over would expire by itself within the expect timeout.
  await a.page.waitForTimeout(150);
  expect(await commit.textContent()).toMatch(/^(올인|All-in)/);
  await commit.tap();
  await expect(commit).toHaveText(/^(한 번 더|Press again)/);
  expect(aSent.length).toBe(n);
  await commit.tap();
  await expect.poll(() => aSent.length).toBe(n + 1);
  expect(aSent.at(-1)!.type).toBe('allin');
});
