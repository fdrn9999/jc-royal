import { expect, type Page } from '@playwright/test';
import { balanceOf, signUp, test } from './helpers';

/** The tables quick play has sent this page to so far, from the table page's URL. */
const triedIn = (page: Page) => (new URL(page.url()).searchParams.get('quick') ?? '').split(',').slice(2);

test('quick play: filters find a free seat, nothing is paid before the buy-in, and a lost seat offers the next table', async ({ browser }) => {
  // E2E Quick A and B are the only 2-seat tables at 7/14.
  const a = await signUp(browser);
  const panel = a.page.getByTestId('quick-play');
  await panel.getByTestId('quick-seats-2').click();
  await panel.getByTestId('quick-blind').selectOption('14');
  // Blind levels follow the table size: no 6-seat table plays 7/14, so the blind goes back to any.
  await panel.getByTestId('quick-seats-6').click();
  await expect(panel.getByTestId('quick-blind')).toHaveValue('0');
  await panel.getByTestId('quick-seats-2').click();
  await panel.getByTestId('quick-blind').selectOption('14');
  await a.page.screenshot({ path: 'test-results/quick-play-desktop.png' });
  await panel.getByTestId('quick-go').click();
  await expect(a.page).toHaveURL(/\/table\/e2e-quick-a\?/);
  await expect(a.page.getByTestId('buyin-confirm')).toBeVisible();
  expect(await balanceOf(a.page)).toBe(10000);
  await a.page.getByTestId('buyin-confirm').click();
  await expect.poll(() => balanceOf(a.page)).toBe(8600);

  // B is sent to the other seat at A's table (players already seated rank first) and opens the buy-in dialog...
  const b = await signUp(browser);
  await b.page.getByTestId('quick-seats-2').click();
  await b.page.getByTestId('quick-blind').selectOption('14');
  await b.page.getByTestId('quick-go').click();
  await expect(b.page).toHaveURL(/\/table\/e2e-quick-a\?/);
  await expect(b.page.getByTestId('buyin-confirm')).toBeVisible();

  // ...but C takes that seat first.
  const c = await signUp(browser);
  await c.page.goto('/table/e2e-quick-a?sit=1');
  await c.page.getByTestId('buyin-confirm').click();
  await expect.poll(() => balanceOf(c.page)).toBe(8600);

  // The room refuses B's seat: no chips move, and B is offered the next table instead of an error.
  await b.page.getByTestId('buyin-confirm').click();
  const missed = b.page.getByTestId('quick-missed');
  await expect(missed).toBeVisible();
  await expect(b.page.getByTestId('buyin-confirm')).toHaveCount(0);
  expect(await balanceOf(b.page)).toBe(10000);
  await b.page.screenshot({ path: 'test-results/quick-missed-desktop.png' });
  await missed.getByTestId('quick-another').click();
  await expect(b.page).toHaveURL(/\/table\/e2e-quick-b\?/);
  expect(triedIn(b.page)).toEqual(['e2e-quick-a', 'e2e-quick-b']);
  await expect(missed).toHaveCount(0);
  await b.page.getByTestId('buyin-confirm').click();
  await expect.poll(() => balanceOf(b.page)).toBe(8600);

  // A quick play link that arrives after the table filled up: the banner at once, and here nothing is left to find.
  await b.page.goto('/table/e2e-quick-a?sit=1&quick=2,14,e2e-quick-a');
  await expect(missed).toBeVisible();
  await expect(b.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await missed.getByTestId('quick-another').click();
  await expect(missed.getByTestId('quick-miss')).toHaveAttribute('data-code', 'no_table');
  await expect(missed).toContainText(/조건에 맞는 공개 테이블이 없습니다|No public table matches/);
  expect(await balanceOf(b.page)).toBe(8600);
});
