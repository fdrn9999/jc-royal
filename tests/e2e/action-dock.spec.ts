import { expect, type Page } from '@playwright/test';
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
 * The bet sizing has a button of its own at the dock's top right; Bet/Raise only ever bets the amount set. Open, shut,
 * and the amount kept between them, the toggle sends nothing and arms nothing; Bet/Raise bets the amount shown (the
 * two presses of a big bet, the amount on it pressed once too), never opens or shuts the sizing, and a double press
 * sends one action. An amount the server would refuse leaves Bet/Raise disabled, and shutting the sizing keeps it as
 * typed. The toggle's tip says it sets the amount. The next turn starts shut.
 */
test('bet sizing toggle: opening and shutting sends nothing, Bet/Raise always bets the amount set', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const aSent = actionsSent(a.page);
  await a.page.goto('/table/e2e-dock?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-dock?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  const barA = a.page.getByTestId('action-bar');
  const commit = barA.getByTestId('action-commit');
  const toggle = barA.getByTestId('action-dock-toggle');
  const panel = barA.locator('[data-raise-panel]');
  // A's turn with a bet or raise to make.
  await expect(async () => {
    if (await commit.isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(commit).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  await a.page.waitForTimeout(400); // past the appear guard
  const n = aSent.length;

  // Shut: the toggle says what it does, Bet/Raise shows the amount it bets (the minimum to start with).
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', /^(베팅 금액 설정 펼치기|Expand bet sizing)$/);
  await expect(toggle).toHaveAttribute('type', 'button');
  await expect(panel).toHaveCount(0);
  const kind = /^(벳|Bet) /.test((await commit.textContent()) ?? '') ? 'bet' : 'raise';
  const name = kind === 'bet' ? '(벳|Bet)' : '(레이즈|Raise to)';
  await expect(commit).toHaveText(new RegExp(`^${name} \\d`));
  const min = Number((await barA.getByTestId('action-dock-amount').textContent())!.replace(/\D/g, ''));
  expect(min).toBeGreaterThan(0);
  await expect(commit).toHaveText(new RegExp(`^${name} ${min.toLocaleString('en-US')}$`));
  // Hovered, its tip says it sets the amount (and its key): at its left inside the card, over none of the buttons.
  const tip = barA.getByTestId('action-dock-tip');
  await expect(tip).toHaveAttribute('role', 'tooltip');
  await expect(toggle).toHaveAttribute('aria-describedby', (await tip.getAttribute('id'))!);
  await expect(tip).toHaveText(/^(베팅 금액 조절|Adjust bet amount)R$/);
  await expect(tip).toHaveCSS('opacity', '0');
  await toggle.hover();
  await expect(tip).toHaveCSS('opacity', '1');
  const [tipBox, toggleBox, barBox, commitBox] = await Promise.all([tip, toggle, barA, commit].map((l) => l.boundingBox()));
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(toggleBox!.x);
  expect(tipBox!.x).toBeGreaterThanOrEqual(barBox!.x);
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(commitBox!.y);

  // Open: the amount field, the slider and the presets; its controls name the panel; nothing sent, nothing armed. The
  // tip goes once it is pressed, though the pointer is still on it.
  await toggle.click();
  await expect(tip).toHaveCSS('opacity', '0');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-label', /^(베팅 금액 설정 접기|Collapse bet sizing)$/);
  await expect(panel).toBeVisible();
  expect(await panel.getAttribute('id')).toBe(await toggle.getAttribute('aria-controls'));
  await expect(barA.getByRole('slider')).toBeVisible();
  await expect(barA.getByRole('button', { name: /^(최대|Max)$/ })).toBeVisible();
  // An amount under the minimum: Bet/Raise is disabled and says an amount is wanted; nothing is sent.
  const field = barA.getByTestId('action-amount');
  await field.fill('3');
  await expect(commit).toBeDisabled();
  await expect(commit).toHaveText(new RegExp(`^${name} (금액 설정 필요|Set an amount)$`));
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  // Shut with it under the minimum, it stays as typed (not moved to the minimum): Bet/Raise stays disabled.
  const needAmount = new RegExp(`^${name} (금액 설정 필요|Set an amount)$`);
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(commit).toBeDisabled();
  await expect(commit).toHaveText(needAmount);
  await expect(barA.getByTestId('action-dock-amount')).toHaveText(/^(금액 설정 필요|Set an amount)$/);
  await toggle.click();
  await expect(field).toHaveValue('3');
  // Over the maximum, shut with Escape: the same. Its toggle, focused from the keyboard, shows its tip.
  await field.fill('99999');
  await expect(commit).toBeDisabled();
  await expect(tip).toHaveCSS('opacity', '0'); // pressed, the pointer still on it: the tip stays away from the field
  await a.page.mouse.move(0, 0);
  await field.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(tip).toHaveCSS('opacity', '1');
  await expect(commit).toBeDisabled();
  await expect(commit).toHaveText(needAmount);
  await toggle.click();
  await expect(field).toHaveValue('99999');
  await a.page.waitForTimeout(300);
  expect(aSent.length).toBe(n);
  // 600 is over half of A's stack: a big bet, two presses.
  await field.fill('600');
  await expect(commit).toBeEnabled();
  await expect(commit).toHaveText(new RegExp(`^${name} 600$`));

  // Shut again: the amount stays, shown on the dock's top line and on Bet/Raise; still nothing sent or armed.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await expect(barA.getByTestId('action-dock-amount')).toHaveText('600');
  await expect(commit).toHaveText(new RegExp(`^${name} 600$`));
  await a.page.waitForTimeout(300);
  expect(aSent.length).toBe(n);

  // Bet/Raise, shut: the first press arms it (the panel stays shut), the second sends it once, even pressed twice at once.
  await commit.click();
  await expect(commit).toHaveText(/^(한 번 더|Press again).* 600$/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(aSent.length).toBe(n);
  await commit.evaluate((el: HTMLButtonElement) => {
    el.click();
    el.click();
  });
  await expect.poll(() => aSent.length).toBe(n + 1);
  expect(aSent.at(-1)).toMatchObject({ type: kind, amount: 600 });
  // The server took it: the turn moves on to B, and A's 600 is in front of A.
  await expect(barA).toBeHidden({ timeout: 10_000 });
  await a.page.waitForTimeout(500);
  expect(aSent.length).toBe(n + 1);
  const barB = b.page.getByTestId('action-bar');
  await expect(barB.getByRole('button', { name: /^(콜|Call)/ })).toBeVisible();

  // B calls (over half of B's stack: two presses); on A's next turn the sizing starts shut at the new minimum.
  await b.page.waitForTimeout(400);
  await barB.getByRole('button', { name: /^(콜|Call)/ }).click();
  await barB.getByRole('button', { name: /^(한 번 더|Press again)/ }).click();
  // The flop: B, first to act after it, has no call to make.
  await expect(barB.getByRole('button', { name: /^(콜|Call|한 번 더|Press again)/ })).toHaveCount(0, { timeout: 10_000 });
  await expect(async () => {
    if (await commit.isVisible().catch(() => false)) return;
    await checkOrCall(b.page);
    await expect(commit).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await expect(commit).not.toHaveText(/600$/);
  await expect(a.page.getByRole('alert')).toHaveCount(0);
});
