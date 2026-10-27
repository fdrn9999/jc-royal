import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { PASSWORD, signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

const ADMIN = 'http://localhost:5174';

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

test('integrity signs: a pair whose chips went one way is listed with its hands, a review opens a report in the queue, and nobody is suspended by it', async ({ browser }) => {
  test.setTimeout(180_000);
  const giver = await signUp(browser);
  const taker = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));

  // 12 hands at a closed cash table within the week: the giver gives up 30 big blinds without a showdown each time, the
  // taker the only winner.
  const tag = `e2e-integ-${Date.now().toString(36)}`;
  const at = Date.now() - 3_600_000;
  const seat = (h: string, email: string, i: number, n: number, net: number) =>
    `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) SELECT '${h}', id, ${n}, '[]', 1000, ${1000 + net}, ${net}, ${Math.max(0, net + 300)}, 0, ${at + i} FROM users WHERE email = '${email}'`;
  sql(
    [
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${tag}', '${tag}', 6, 5, 10, 200, 2000, 'closed', 'official')`,
      ...Array.from({ length: 12 }, (_, i) => [
        `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ('${tag}-h${i}', '${tag}', ${i + 1}, ${at - 60_000 + i}, ${at + i}, '[]', 300, 'test', '[]')`,
        seat(`${tag}-h${i}`, giver.email, i, 0, -300),
        seat(`${tag}-h${i}`, taker.email, i, 1, 300),
      ]).flat(),
    ].join('; '),
  );

  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(ADMIN);
    await page.getByLabel(/이메일|Email/).fill(op.email);
    await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await page.getByRole('button', { name: /로그인|Log in/ }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await page.getByRole('link', { name: /^신고 관리$|^Reports$/ }).click();

    // The signals tab of the report queue: the pair, giver first, its signs and the hands to look at.
    await page.getByTestId('report-view-signals').click();
    await expect(page).toHaveURL(/view=signals/);
    await expect(page.getByTestId('report-view-signals')).toHaveAttribute('aria-selected', 'true');
    const pair = page.getByTestId('integrity-pair').filter({ hasText: giver.nickname }).filter({ hasText: taker.nickname });
    await expect(pair).toHaveCount(1);
    await expect(pair).toContainText(new RegExp(`${giver.nickname}\\s*→\\s*${taker.nickname}`));
    await expect(pair).toContainText('한쪽으로 쏠린 칩');
    await expect(pair).toContainText('쇼다운 없이 내준 큰 팟');
    await expect(pair).toContainText('360 BB');
    await expect(pair.getByTestId('integrity-hand')).toHaveCount(10);
    await expect(pair.getByTestId('integrity-hand').first()).toContainText('30 BB · 쇼다운 없음');
    await expect(page.getByTestId('integrity-signals')).toContainText('누구도 정지·동결하지 않습니다');
    await page.screenshot({ path: 'test-results/admin-integrity.png', fullPage: true });

    // A review needs a reason without personal data; it opens a report and the pair points at it.
    await pair.getByTestId('integrity-review').click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('integrity-review-confirm') });
    await expect(dialog).toContainText(giver.nickname);
    await expect(dialog.getByTestId('integrity-review-confirm')).toBeDisabled();
    await dialog.getByTestId('integrity-review-reason').fill('연락처 010-1234-5678');
    await dialog.getByTestId('integrity-review-confirm').click();
    await expect(dialog.getByRole('alert')).toContainText('개인정보');
    await dialog.getByTestId('integrity-review-reason').fill('E2E 한쪽으로 쏠린 칩 확인');
    await dialog.getByTestId('integrity-review-confirm').click();
    await expect(page.getByRole('status').filter({ hasText: `${taker.nickname} 회원의 검토 신고를 접수했습니다` })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(pair.getByTestId('integrity-review')).toHaveCount(0);

    // The review in the queue: a cheating report on the taker, with the evidence it was opened on, and no one suspended.
    await pair.getByTestId('integrity-reviewing').click();
    await expect(page).toHaveURL(new RegExp(`userId=`));
    const item = page.getByTestId('report-item').filter({ hasText: 'E2E 한쪽으로 쏠린 칩 확인' });
    await expect(item).toHaveCount(1);
    const evidence = item.getByTestId('report-signal');
    await expect(evidence).toContainText(`${giver.nickname} → ${taker.nickname}`);
    await expect(evidence).toContainText('360 BB');
    await expect(evidence).toContainText('쇼다운 없음');
    await expect(item).not.toContainText('정지됨');
    await expect(item.getByTestId('report-sanctions')).toContainText('정지·강제 연결 종료 이력이 없습니다');
    await page.screenshot({ path: 'test-results/admin-integrity-report.png', fullPage: true });

    // English, and a phone-width window: the signals and the review fit.
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(item.getByTestId('report-signal')).toContainText('no showdown');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await widerThanDevice(page)).toBe(false);
    await page.getByTestId('report-view-signals').click();
    await expect(pair.getByTestId('integrity-reviewing')).toHaveText('See the open review');
    await expect(pair).toContainText('Chips going one way');
    expect(await widerThanDevice(page)).toBe(false);
    const box = await pair.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await page.screenshot({ path: 'test-results/admin-integrity-mobile-en.png', fullPage: true });
    await page.getByRole('button', { name: '한국어', exact: true }).click();
  } finally {
    sql(`DELETE FROM hand_players WHERE hand_id LIKE '${tag}-%'; DELETE FROM hands WHERE id LIKE '${tag}-%'; DELETE FROM tables WHERE id = '${tag}'`);
  }
});
