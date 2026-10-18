import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

const DAY = 86_400_000;
const shot = (name: string) => `test-results/me-numbers-${name}.png`;
/**
 * The figures are drawn in the device's own monospace font (the app names JetBrains Mono but doesn't load it). Windows
 * has Consolas, 0.55em a digit; phones, Macs and Linux have 0.6em (Droid Sans Mono, SF Mono, Menlo, DejaVu Sans Mono).
 * Courier New and Liberation Mono are 0.6em as well, so the page is measured the way a phone draws it on any machine.
 */
const PHONE_MONO = `:root { --font-mono: 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', monospace; }`;

/**
 * Every box in the page whose content runs out of it (drawn past its edge, or cut off by it), innermost only. What is
 * meant to scroll or to end in an ellipsis, a field's own text, a chart, and what only a screen reader hears don't count.
 */
function overflowing(page: Page) {
  return page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('main *')).filter((e) => {
      const cs = getComputedStyle(e);
      if (cs.display === 'inline' || cs.display === 'contents' || cs.display === 'none') return false;
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.textOverflow === 'ellipsis') return false;
      if (cs.clipPath !== 'none' || (cs.clip !== 'auto' && cs.clip !== '')) return false;
      if (e.matches('input, textarea, select') || e.closest('svg')) return false;
      return e.scrollWidth > e.clientWidth + 1;
    });
    return hit
      .filter((e) => !hit.some((d) => d !== e && e.contains(d)))
      .map((e) => `${e.closest('[data-testid]')?.getAttribute('data-testid') ?? '?'}: "${e.textContent!.trim().slice(0, 24)}" +${e.scrollWidth - e.clientWidth}px`);
  });
}

test('the Me page on a phone keeps nine- and ten-digit amounts inside their boxes, whole and exact', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await page.addInitScript((css) => {
    document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: css })));
  }, PHONE_MONO);

  // A wallet of 123,456,789 chips, through an adjustment the ledger records (the books stay balanced).
  const id = await page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const big = 123_456_789;
  sql(
    `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, memo, created_at) VALUES ('e2e-big-${id}', '${id}', 'admin_adjust', ${big - 10_000}, ${big}, 'e2e-big-${id}', 'e2e', ${Date.now()}); UPDATE users SET balance = ${big} WHERE id = '${id}'`,
  );
  // Statistics as large as a long-time player's: no test plays that many hands, so the page is shown them.
  await page.route('**/api/me/stats', async (route) => {
    const r = await route.fetch();
    const j = (await r.json()) as { positions: object[] };
    const ratio = { n: 456_789, of: 1_234_567 };
    await route.fulfill({
      response: r,
      json: {
        ...j,
        handsPlayed: 1_234_567,
        handsWon: 456_789,
        winRate: 37,
        totalWon: 9_876_543_210,
        netChips: -123_456_789,
        largestPot: 987_654_321,
        avgPot: 12_345_678,
        biggestWin: 123_456_789,
        vpip: ratio,
        pfr: ratio,
        raiseShare: ratio,
        wtsd: ratio,
        wsd: ratio,
        positions: j.positions.map((p, i) => ({ ...p, hands: 205_761, vpip: 45_678, pfr: 23_456, net: i % 2 ? 123_456_789 : -123_456_789 })),
      },
    });
  });
  await page.route('**/api/me/stats/trend?*', async (route) => {
    const u = new URL(route.request().url());
    const tz = Number(u.searchParams.get('tz'));
    const today = Math.floor((Date.now() + tz * 60_000) / DAY);
    const points = [5, 3, 1].map((k, i) => ({ day: new Date((today - k) * DAY).toISOString().slice(0, 10), hands: 12_345, net: i % 2 ? 123_456_789 : -123_456_789 }));
    await route.fulfill({ json: { days: Number(u.searchParams.get('days')), tz, points } });
  });

  const check = async (w: number, h: number, name: string) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/me');
    // Digits as wide as a phone's.
    const digit = await page.evaluate(() => {
      const s = Object.assign(document.createElement('span'), { className: 'font-mono', textContent: '0123456789' });
      s.style.fontSize = '100px';
      document.body.append(s);
      const em = s.getBoundingClientRect().width / 1000;
      s.remove();
      return em;
    });
    expect(digit, 'a digit of the monospace font, in em').toBeCloseTo(0.6, 2);
    // Every amount whole and exact (a wrap between digit groups adds nothing to the text).
    await expect(page.getByTestId('refill-wallet')).toHaveText('123,456,789');
    await expect(page.getByTestId('refill-tables')).toHaveText('0');
    await expect(page.getByTestId('refill-total')).toHaveText('123,456,789');
    await expect(page.getByTestId('me-balance')).toHaveText('123,456,789');
    const stats = page.getByTestId('stats');
    await expect(stats).toContainText('9,876,543,210');
    await expect(stats).toContainText('-123,456,789');
    await expect(page.getByTestId('stats-pos-BB')).toContainText('+123,456,789');
    await expect(page.getByTestId('stats-trend-summary')).toBeVisible();
    await expect(page.getByTestId('ledger')).toContainText('123,456,789');
    expect(await overflowing(page), `${name}: amounts run out of their boxes`).toEqual([]);
    expect(await widerThanDevice(page)).toBe(false);
    await page.getByTestId('refill-card').screenshot({ path: shot(`refill-${name}`) });
    await stats.screenshot({ path: shot(`stats-${name}`) });
  };

  for (const [w, h] of [
    [360, 740],
    [375, 667],
    [390, 844],
  ] as const) {
    await check(w, h, String(w));
    // A row each on a phone: the amount on its label's line, the rows one above another.
    const wallet = (await page.getByTestId('refill-wallet').boundingBox())!;
    const total = (await page.getByTestId('refill-total').boundingBox())!;
    expect(total.y).toBeGreaterThan(wallet.y + wallet.height);
  }
  // From 640 wide the three tiles side by side again.
  await check(768, 1024, '768');
  const wallet = (await page.getByTestId('refill-wallet').boundingBox())!;
  const total = (await page.getByTestId('refill-total').boundingBox())!;
  expect(Math.abs(total.y - wallet.y)).toBeLessThan(2);
  expect(total.x).toBeGreaterThan(wallet.x + wallet.width);

  // English, on the narrowest phone.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByTestId('settings-open').click();
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Free chip refill', { exact: true })).toBeVisible();
  await expect(page.getByTestId('refill-card')).toContainText('Wallet');
  await expect(page.getByTestId('refill-total')).toHaveText('123,456,789');
  expect(await overflowing(page), 'en: amounts run out of their boxes').toEqual([]);
  expect(await widerThanDevice(page)).toBe(false);
  await page.getByTestId('refill-card').screenshot({ path: shot('refill-360-en') });
});
