import { expect } from '@playwright/test';
import { ADMIN, adminLogin, iso, seedStats, sql, today } from './analytics-helpers';
import { signUp, test } from './helpers';

test('operations stats: empty until a day is rolled up, then totals, trends and a table by day, week and month in Korean and English', async ({ browser }) => {
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'admin' WHERE email = '${op.email}'`);
  // Nothing rolled up yet: every account in this run was created today, and today is rolled up tomorrow.
  sql(`DELETE FROM daily_stats WHERE day = 0`);
  const page = await adminLogin(browser, op.email);
  await page.getByRole('link', { name: /^운영 통계$|^Operations stats$/ }).click();
  await expect(page).toHaveURL(`${ADMIN}/stats`);
  await expect(page.getByTestId('stats-empty')).toContainText('아직 집계된 날짜가 없습니다');

  seedStats();
  await page.getByTestId('stats-reload').click();
  // The last 30 days, 14 of them rolled up.
  const t = today();
  await expect(page.getByTestId('stats-range')).toContainText(`${iso(t - 30)} – ${iso(t - 1)}`);
  await expect(page.getByTestId('stats-day')).toHaveAttribute('aria-pressed', 'true');
  const totals = page.getByTestId('stats-totals');
  await expect(totals).toContainText('활성 회원 (일 평균)');
  await expect(totals).toContainText('주간 30 · 월간 60');
  await expect(page.getByTestId('stats-hands-day')).toHaveText('50');
  await expect(page.getByTestId('stats-peak')).toHaveText('5');
  await expect(page.getByTestId('stats-reports')).toHaveText('14');
  // First games: the sign-up days whose week has passed (7 of the 14), every one of them within a week.
  await expect(page.getByTestId('stats-activation')).toHaveText('100%');
  await expect(page.getByTestId('stats-share').locator('[data-share=hands] [role=img]')).toHaveAttribute('aria-label', '핸드: 공식 테이블 80%, 회원 방 20%');
  await expect(page.getByTestId('stats-academy')).toContainText('50%');
  await expect(page.getByTestId('chart-active').locator('[role=img] span')).toHaveCount(30);
  await expect(page.getByTestId('stats-hourly').locator('[role=img]')).toHaveAttribute('aria-label', '시간대별 동시 착석: 20시에 최대 5');

  // The table: newest day first; days before the first rolled-up one are marked, not shown as zero activity.
  const rows = page.getByTestId('stats-table').locator('tbody tr');
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toHaveAttribute('data-period', iso(t - 1));
  // Within a day / within a week: a sign-up day once its week has passed; the last seven days have none yet.
  await expect(page.locator(`[data-period="${iso(t - 8)}"]`)).toContainText('50% / 100%');
  await expect(page.locator(`[data-period="${iso(t - 7)}"]`).locator('td').nth(6)).toHaveText('—');
  await expect(page.locator(`[data-period="${iso(t - 20)}"]`)).toContainText('집계 전');

  // Weeks and months; the choice is kept in the address, so a reload or a shared link opens the same view.
  await page.getByTestId('stats-week').click();
  await expect(page).toHaveURL(`${ADMIN}/stats?unit=week`);
  await expect(page.getByTestId('stats-week')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(12);
  await page.reload();
  await expect(page.getByTestId('stats-week')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(12);
  await page.getByTestId('stats-month').click();
  await expect(page).toHaveURL(`${ADMIN}/stats?unit=month`);
  await expect(rows).toHaveCount(12);
  await expect(rows.first()).toHaveAttribute('data-period', `${iso(t - 1).slice(0, 7)}-01`);
  await page.getByTestId('stats-day').click();
  await expect(page).toHaveURL(`${ADMIN}/stats`);
  await expect(rows).toHaveCount(30);

  // English.
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Operations stats' })).toBeVisible();
  await expect(totals).toContainText('WAU 30 · MAU 60');
  await expect(page.getByTestId('stats-table').locator('thead')).toContainText('DAU');
  await expect(page.locator(`[data-period="${iso(t - 20)}"]`)).toContainText('Not rolled up');
  await expect(page.getByTestId('stats-share').locator('[data-share=hands] [role=img]')).toHaveAttribute('aria-label', 'Hands: Official tables 80%, Member rooms 20%');
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByRole('heading', { name: '운영 통계' })).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-stats.png', fullPage: true });
});
