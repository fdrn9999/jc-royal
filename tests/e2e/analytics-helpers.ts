import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Browser } from '@playwright/test';
import { PASSWORD } from './helpers';

export const ADMIN = 'http://localhost:5174';
const DAY = 86_400_000;
/** The statistics day (Korean time), as the API counts it. */
export const today = () => Math.floor((Date.now() + 9 * 3_600_000) / DAY);
export const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
export function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

/** Days rolled up in the seeded statistics: the 14 days before today, each with the same numbers. */
export const SEEDED_DAYS = 14;

/**
 * Writes rolled-up days straight into daily_stats (the rollup itself is covered by tests/integration/admin-analytics):
 * per day 2 sign-ups, 10 active members (6 returning), 50 hands (40 on official tables), 10 seats of 30 minutes,
 * a concurrency peak of 5 at 20:00, 1 report handled in 2 hours, and 4 lessons started of which 2 completed.
 */
export function seedStats() {
  const t = today();
  const rows: [number, string, number][] = [[0, 'rolled_from', t - SEEDED_DAYS], [0, 'rolled_through', t - 1], [0, 'activity_since', t - SEEDED_DAYS]];
  const perDay: [string, number][] = [
    ['signups', 2], ['cohort_play_1d', 1], ['cohort_play_7d', 2], ['dau', 10], ['returning', 6], ['wau', 30], ['mau', 60],
    ['hands_official', 40], ['hands_member', 10], ['tables_official', 2], ['tables_member', 1],
    ['seats_official', 8], ['seats_member', 2], ['seat_ms_official', 8 * 1_800_000], ['seat_ms_member', 2 * 1_800_000],
    ['peak', 5], ['peak_h20', 5], ['peak_h21', 3], ['reports', 1], ['handled', 1], ['handle_ms', 7_200_000],
    ['ac_lesson_start', 4], ['ac_lesson_done', 2],
  ];
  for (let d = t - SEEDED_DAYS; d < t; d++) for (const [m, n] of perDay) rows.push([d, m, n]);
  sql(`INSERT OR REPLACE INTO daily_stats (day, metric, n) VALUES ${rows.map(([d, m, n]) => `(${d}, '${m}', ${n})`).join(', ')}`);
}

/** Opens the admin console as `email` (an administrator) and waits for the dashboard. */
export async function adminLogin(browser: Browser, email: string, opts: { mobile?: boolean } = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  return page;
}
