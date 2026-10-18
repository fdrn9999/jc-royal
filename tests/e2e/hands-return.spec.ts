import { expect, type Page } from '@playwright/test';
import { sql } from './analytics-helpers';
import { idOf, seedHands } from './hand-review-seed';
import { signUp, test } from './helpers';

const HOUR = 3_600_000;

/** `n` finished heads-up hands of `hero` on a closed table, every fifth one from the big blind, the rest on the button. */
function seedMany(hero: string, villain: string, n: number) {
  const key = `e2e-hr-${hero.slice(0, 8)}`;
  const now = Date.now();
  const hands = Array.from({ length: n }, (_, i) => ({ id: `${key}-${String(i).padStart(2, '0')}`, at: now - (i + 1) * HOUR, pos: i % 5 === 4 ? 'BB' : 'BTN', net: i % 2 ? 20 : -10 }));
  const player = (h: string, user: string, seat: number, pos: string, net: number, at: number) =>
    `('${h}', '${user}', ${seat}, '["Ah","5d"]', 1000, ${1000 + net}, ${net}, ${net > 0 ? 40 : 0}, NULL, NULL, NULL, 0, ${at}, '${pos}', 0, 0, 0, ${net > 0 ? 40 : 0})`;
  sql(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${key}', 'E2E Hand Return', 2, 5, 10, 100, 1000, 'closed', 'official');` +
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ` +
      hands.map((h, i) => `('${h.id}', '${key}', ${i + 1}, ${h.at - 60_000}, ${h.at}, '["2c","3d","4h","5s","6c"]', 40, 'e2e', '{"actions":[]}')`).join(', ') +
      ';' +
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at, position, vpip, pfr, saw_flop, pot_won) VALUES ` +
      hands.flatMap((h) => [player(h.id, hero, 0, h.pos, h.net, h.at), player(h.id, villain, 1, h.pos === 'BB' ? 'BTN' : 'BB', -h.net, h.at)]).join(', ') +
      ';',
  );
  return hands;
}

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

test('hand list → a hand → back: the same filter, as many hands as were loaded, and the same place; the hand opens at its top', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const hands = seedMany(await idOf(a.page), await idOf(b.page), 30);
  const btn = hands.filter((h) => h.pos === 'BTN');
  const page = a.page;
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto('/me/hands');
  await page.getByTestId('hands-position').selectOption('BTN');
  await expect(page).toHaveURL('/me/hands?position=BTN');
  const rows = page.getByTestId('hand-row');
  await expect(rows).toHaveCount(20);
  await page.getByTestId('hands-more').click();
  await expect(rows).toHaveCount(btn.length);

  // Well down the list: the 22nd hand.
  const pick = btn[21]!;
  const row = page.locator(`[data-testid=hand-row][data-hand="${pick.id}"]`);
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const y = await scrollY(page);
  expect(y).toBeGreaterThan(500);

  for (const way of ['link', 'browser'] as const) {
    await row.getByRole('link').click();
    await expect(page).toHaveURL(`/me/hands/${pick.id}`);
    // A new page opens at its top, not as far down as the list was.
    await expect.poll(() => scrollY(page)).toBe(0);
    const back = page.getByTestId('hand-back');
    await expect(back).toHaveText('← 내 핸드 기록');
    if (way === 'link') await back.click();
    else await page.goBack();
    await expect(page).toHaveURL('/me/hands?position=BTN');
    await expect(page.getByTestId('hands-position')).toHaveValue('BTN');
    await expect(rows).toHaveCount(btn.length);
    await expect.poll(() => scrollY(page)).toBe(y);
    await expect(row).toBeInViewport();
  }

  // From My Page, the hand goes back to My Page.
  await page.goto('/me');
  await page.getByTestId('hand-row').first().getByRole('link').click();
  await expect(page.getByTestId('hand-back')).toHaveText('← 마이페이지');
  await page.getByTestId('hand-back').click();
  await expect(page).toHaveURL('/me');

  // Opened directly (a shared address), back goes to My Page.
  await page.goto(`/me/hands/${pick.id}`);
  await expect(page.getByTestId('hand-back')).toHaveAttribute('href', '/me');
});

test('a hand → the lesson or practice it points to → back: the hand again; a lesson opened directly goes back to the Academy', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const ids = seedHands(await idOf(a.page), await idOf(b.page));
  const page = a.page;
  await page.goto(`/me/hands/${ids.A}`);
  const lessons = page.getByTestId('hand-lessons');

  await lessons.locator('[data-link=no-showdown]').click();
  await expect(page).toHaveURL('/academy/holdem?step=0');
  // Its steps keep where it was opened from.
  await page.getByTestId('lesson-next').click();
  await expect(page).toHaveURL('/academy/holdem?step=1');
  await expect(page.getByTestId('lesson-back')).toHaveText('← 핸드로 돌아가기');
  await page.getByTestId('lesson-back').click();
  await expect(page).toHaveURL(`/me/hands/${ids.A}`);

  await lessons.locator('[data-link=fold]').click();
  await expect(page).toHaveURL('/academy/practice/D');
  await expect(page.getByTestId('practice-back')).toHaveAttribute('aria-label', '핸드로 돌아가기');
  await page.getByTestId('practice-back').click();
  await expect(page).toHaveURL(`/me/hands/${ids.A}`);

  await page.goto('/academy/holdem');
  await expect(page.getByTestId('lesson-back')).toHaveText('← 아카데미');
  await expect(page.getByTestId('lesson-back')).toHaveAttribute('href', '/academy');
});