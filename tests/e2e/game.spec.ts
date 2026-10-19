import { expect } from '@playwright/test';
import { balanceOf, checkOrCall, signUp, test } from './helpers';

test('two browsers: join, buy in, play a hand to showdown, refresh, stand up with refund', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  expect(await balanceOf(a.page)).toBe(10000);

  // A joins from the lobby card → buy-in dialog opens automatically.
  await a.page.getByTestId('lobby-table').filter({ hasText: 'E2E Heads-up' }).getByRole('button', { name: /참여|Join/ }).click();
  await a.page.getByTestId('buyin-confirm').click();
  await expect(a.page.getByTestId('seat-0')).toHaveAttribute('data-state', /waiting|active/);

  await b.page.goto('/table/e2e-hu');
  await b.page.locator('[data-testid^=sit-]').first().click();
  await b.page.getByTestId('buyin-confirm').click();

  // A new chat line re-runs the chat list's scroll effect; the table must keep running
  // (Chrome's scrollIntoView returns a Promise, which must not become an effect cleanup).
  const chat = a.page.getByRole('textbox', { name: /채팅|Chat/ });
  await chat.fill('gl hf');
  await chat.press('Enter');
  for (const p of [a.page, b.page]) await expect(p.getByText('gl hf')).toBeVisible();

  // The hand starts automatically; each player sees exactly two face-up cards of their own.
  for (const p of [a.page, b.page]) await expect(p.getByTestId('board')).toBeVisible();
  await expect(async () => {
    const own = await a.page.locator('[data-testid=seat-0] [data-card]').count();
    expect(own).toBe(2);
  }).toPass({ timeout: 15_000 });
  // A never sees B's card faces before showdown.
  expect(await a.page.locator('[data-testid=seat-1] [data-card]').count()).toBe(0);

  // Play check/call to showdown.
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    await expect(a.page.getByText(/승리|Winner/).first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 60_000 });
  // Five board cards at showdown. Auto-muck always applies: a winning hand is turned over for the table, a losing one
  // stays face down for the other player (its owner may still show it) — a split turns both over.
  await expect(a.page.locator('[data-testid=board] [data-card]')).toHaveCount(5);
  const won = async (seat: number) => (await a.page.getByTestId(`seat-${seat}`).getByText(/승리|Winner/).count()) > 0;
  const [aWon, bWon] = [await won(0), await won(1)];
  expect(aWon || bWon).toBe(true);
  await expect(a.page.locator('[data-testid=seat-1] [data-card]')).toHaveCount(bWon ? 2 : 0);
  await expect(b.page.locator('[data-testid=seat-0] [data-card]')).toHaveCount(aWon ? 2 : 0);

  // Table chips are conserved.
  const stack = async (page: typeof a.page, seat: number) => Number(((await page.getByTestId(`stack-${seat}`).textContent()) ?? '0').replace(/[^\d]/g, ''));
  const total = (await stack(a.page, 0)) + (await stack(a.page, 1));
  const buyIns = 10000 - (await balanceOf(a.page)) + 10000 - (await balanceOf(b.page));
  expect(total).toBe(buyIns);

  // Refresh keeps the seat and stack (server state is authoritative).
  const before = await stack(a.page, 0);
  await a.page.reload();
  await expect(a.page.getByTestId('seat-0')).toBeVisible();
  await expect(a.page.getByTestId('leave')).toBeVisible();
  expect(await stack(a.page, 0)).toBeGreaterThan(0);
  const walletBefore = await balanceOf(a.page);

  // Stand up → remaining stack returns to the wallet (immediately, or after the current hand).
  await a.page.getByTestId('leave').click();
  await expect(async () => {
    expect(await balanceOf(a.page)).toBeGreaterThan(walletBefore);
  }).toPass({ timeout: 45_000 });
  expect(before).toBeGreaterThan(0);

  // My page: the showdown A played is a pot of at least both big blinds, shown apart from the single-hand profit.
  await a.page.goto('/me');
  const statValue = async (label: RegExp) => Number(((await a.page.getByText(label).locator('xpath=..').locator('.font-mono').textContent()) ?? '').replace(/[^\d]/g, ''));
  await expect(a.page.getByText(/^(참여한 최대 팟|Largest pot played)$/)).toBeVisible();
  expect(await statValue(/^(참여한 최대 팟|Largest pot played)$/)).toBeGreaterThanOrEqual(20);
  await expect(a.page.getByText(/^(한 핸드 최대 획득|Biggest single-hand win)$/)).toBeVisible();
  await a.page.screenshot({ path: 'test-results/me-stats-desktop.png', fullPage: true });
});
