import { expect, type Page, type Route } from '@playwright/test';
import { ADMIN, adminLogin, seedStats, sql, today } from './analytics-helpers';
import { idOf, seedHands } from './hand-review-seed';
import { signUp, test } from './helpers';

/** The hands listed, by the letter seedHands gave them. */
const listed = (page: Page, ids: Record<string, string>) =>
  page
    .getByTestId('hand-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-hand')))
    .then((xs) => xs.map((x) => Object.keys(ids).find((k) => ids[k] === x) ?? x));

test('hand review: filter my hands on the server, bookmark and tag them, keep a private memo that a save from another tab cannot silently overwrite, and see pot odds where the record settles them', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const ids = seedHands(await idOf(a.page), await idOf(b.page));
  const page = a.page;

  // My Page → all hands: newest first.
  await page.goto('/me');
  await page.getByTestId('me-all-hands').click();
  await expect(page).toHaveURL('/me/hands');
  await expect(page.getByRole('heading', { name: '내 핸드 기록' })).toBeVisible();
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'B', 'C', 'D']);

  // Filters go to the server and into the address, so a reload keeps them.
  await page.getByTestId('hands-position').selectOption('BTN');
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'C']);
  await page.getByTestId('hands-result').selectOption('up');
  await expect.poll(() => listed(page, ids)).toEqual(['C']);
  await expect(page).toHaveURL('/me/hands?position=BTN&result=up');
  await page.reload();
  await expect.poll(() => listed(page, ids)).toEqual(['C']);
  await page.getByTestId('hands-reset').click();
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'B', 'C', 'D']);
  await page.getByTestId('hands-pot').selectOption('100');
  await expect(page.getByText('팟 크기는 그 테이블의 지금 빅 블라인드로 셉니다.')).toBeVisible();
  await expect.poll(() => listed(page, ids)).toEqual(['C']);
  await page.getByTestId('hands-pot').selectOption('');
  await page.getByTestId('hands-period').selectOption('7');
  await expect.poll(() => listed(page, ids)).toEqual(['A', 'B', 'C']);
  await page.getByTestId('hands-period').selectOption('all');
  await page.getByTestId('hands-position').selectOption('CO');
  await expect(page.getByTestId('hands-empty')).toHaveText('조건에 맞는 핸드가 없습니다.');
  await page.getByTestId('hands-reset').click();

  // A bookmark from the list saves on the spot.
  const rowB = page.locator(`[data-testid=hand-row][data-hand="${ids.B}"]`);
  await rowB.getByTestId('hand-bookmark').click();
  await expect(rowB.getByTestId('hand-bookmark')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('hands-bookmarked').check();
  await expect.poll(() => listed(page, ids)).toEqual(['B']);
  await page.screenshot({ path: test.info().outputPath('hands-desktop.png'), fullPage: true });
  await page.getByTestId('hands-reset').click();

  // Hand A: tags save as they are pressed, the memo on its button.
  await page.locator(`[data-testid=hand-row][data-hand="${ids.A}"]`).getByRole('link').click();
  await expect(page).toHaveURL(`/me/hands/${ids.A}`);
  const note = page.getByTestId('hand-note');
  await expect(note).toContainText('북마크·태그·메모는 나만 볼 수 있습니다.');
  const memo = page.getByTestId('hand-memo');
  const save = page.getByTestId('hand-memo-save');
  const status = page.getByTestId('hand-memo-status');
  await expect(save).toBeDisabled();
  // The tag's answer comes back only after typing has begun: it must not wipe what is being typed.
  const slow = async (r: Route) => {
    await new Promise((ok) => setTimeout(ok, 1_000));
    await r.continue();
  };
  await page.route(`**/api/me/hands/${ids.A}/note`, slow, { times: 1 });
  const review = note.locator('[data-tag=review]');
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await memo.fill('턴 베팅에 너무 쉽게 접었다');
  await expect(review).toBeEnabled();
  await expect(memo).toHaveValue('턴 베팅에 너무 쉽게 접었다');
  await expect(status).toHaveText('저장하지 않은 메모가 있습니다.');
  // Typing on while the memo saves stays, as unsaved.
  await page.route(`**/api/me/hands/${ids.A}/note`, slow, { times: 1 });
  const answered = page.waitForResponse((r) => r.url().endsWith('/note') && r.request().method() === 'PUT');
  await save.click();
  await memo.fill('턴 베팅에 너무 쉽게 접었다 (베팅 크기 확인)');
  await answered;
  await expect(save).toHaveText('메모 저장');
  await expect(memo).toHaveValue('턴 베팅에 너무 쉽게 접었다 (베팅 크기 확인)');
  await expect(status).toHaveText('저장하지 않은 메모가 있습니다.');
  await save.click();
  await expect(status).toHaveText('저장되었습니다.');

  // Pot odds for my two calls and the fold, each against the pot it faced, and what the figure leaves out.
  const odds = page.getByTestId('pot-odds');
  await expect(odds).toHaveText(['팟 15 · 콜 5 · 팟 오즈 3 : 1 · 필요 승률 25%', '팟 40 · 콜 20 · 팟 오즈 2 : 1 · 필요 승률 33%', '팟 100 · 콜 40 · 팟 오즈 2.5 : 1 · 필요 승률 29%']);
  await expect(page.getByTestId('pot-odds-note')).toContainText('상대의 추가 행동과 이후 베팅은 고려하지 않습니다.');
  await expect(page.getByTestId('hand-lessons').locator('[data-link=call]')).toHaveAttribute('href', '/academy/practice/B');
  // The other player won without a showdown: their cards stay hidden.
  const detail = await page.evaluate(async (id) => (await (await fetch(`/api/me/hands/${id}`)).json()) as { players: { isYou: boolean; holeCards: string[] | null }[] }, ids.A);
  expect(detail.players.find((p) => !p.isYou)!.holeCards).toBeNull();

  // Another tab saves first: this tab's save is refused, its draft kept, the saved memo shown and loadable.
  const other = await page.context().newPage();
  await other.goto(`/me/hands/${ids.A}`);
  await other.getByTestId('hand-memo').fill('다른 창에서 쓴 메모');
  await other.getByTestId('hand-memo-save').click();
  await expect(other.getByTestId('hand-memo-status')).toHaveText('저장되었습니다.');
  await other.close();
  await memo.fill('이 창에서 고친 메모');
  await save.click();
  const conflict = page.getByTestId('hand-memo-conflict');
  await expect(conflict).toContainText('다른 기기나 창에서 메모가 바뀌었습니다.');
  await expect(conflict).toContainText('다른 창에서 쓴 메모');
  await expect(memo).toHaveValue('이 창에서 고친 메모');
  await note.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('hand-note-conflict.png'), fullPage: true });
  await page.getByTestId('hand-memo-load').click();
  await expect(memo).toHaveValue('다른 창에서 쓴 메모');
  await expect(conflict).toBeHidden();

  // Back on the list: the tag and the memo mark, and the tag filter.
  await page.goto('/me/hands?tag=review');
  await expect.poll(() => listed(page, ids)).toEqual(['A']);
  const rowA = page.locator(`[data-testid=hand-row][data-hand="${ids.A}"]`);
  await expect(rowA).toContainText('복습');
  await expect(rowA.getByTestId('hand-memo-mark')).toBeVisible();

  // In English.
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My hands' })).toBeVisible();
  await expect(rowA).toContainText('Review');
  await page.goto(`/me/hands/${ids.A}`);
  await expect(page.getByTestId('pot-odds').first()).toHaveText('Pot 15 · call 5 · pot odds 3 : 1 · equity needed 25%');
  await expect(page.getByTestId('hand-note')).toContainText('Only you can see your bookmarks, tags and memo.');

  // The operator sees how much the feature is used and how saves fail, never what was written.
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'admin' WHERE email = '${op.email}'`);
  seedStats();
  const y = today() - 1;
  sql(
    `INSERT OR REPLACE INTO daily_stats (day, metric, n) VALUES (${y}, 'hn_bookmark', 3), (${y}, 'hn_tag', 2), (${y}, 'hn_memo', 1), (${y}, 'hn_fail_conflict', 1), (${y}, 'hn_fail_invalid', 0), (${y}, 'hn_fail_notfound', 0), (${y}, 'hn_fail_limit', 0), (${y}, 'hn_fail_error', 0)`,
  );
  const admin = await adminLogin(browser, op.email);
  await admin.goto(`${ADMIN}/stats`);
  const panel = admin.getByTestId('stats-hand-notes');
  await expect(admin.getByTestId('stats-hn-saved')).toHaveText('6');
  await expect(panel).toContainText('북마크 3 · 태그 2 · 메모 1');
  await expect(admin.getByTestId('stats-hn-failed')).toHaveText('1');
  await expect(panel).toContainText('충돌 1 · 입력 오류 0 · 대상 없음 0 · 요청 제한 0 · 서버 오류 0');
  await expect(admin.getByTestId('stats-hn-now')).toHaveText(/^[1-9]\d*$/);
  await expect(admin.getByText(/내용·태그 종류·회원·핸드는 표시하지 않고 개수만 셉니다/)).toBeVisible();
  await expect(admin.locator('body')).not.toContainText('다른 창에서 쓴 메모');
  await panel.scrollIntoViewIfNeeded();
  await admin.screenshot({ path: test.info().outputPath('admin-hand-notes.png') });
  sql(`DELETE FROM daily_stats WHERE day = ${y} AND metric GLOB 'hn_*'`);
});
