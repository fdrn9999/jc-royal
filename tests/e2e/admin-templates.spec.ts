import { expect, type Locator, type Page } from '@playwright/test';
import { formatMoment, formatPeriod } from '../../apps/admin/src/adminTemplates';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test, uid } from './helpers';
import { promoteSql } from '../support/grants';

/** The value a datetime-local input shows for a time, in the browser's time zone. */
const inputValue = (page: Page, ms: number) =>
  page.evaluate((at) => {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, ms);

/** Answers the password prompt if the console asks for it before `done` shows. */
async function reauthIfAsked(page: Page, done: Locator) {
  const ask = page.getByTestId('reauth-confirm');
  await expect(ask.or(done).first()).toBeVisible();
  if (await ask.isVisible()) {
    await page.getByRole('dialog').filter({ has: ask }).getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await ask.click();
  }
  await expect(done).toBeVisible();
}

/** The labels of a select's options, by the group they sit in ('' outside any). */
const groups = (select: Locator) =>
  select.evaluate((el) => Array.from((el as HTMLSelectElement).querySelectorAll('option')).filter((o) => !o.disabled).map((o) => [(o.parentElement as HTMLOptGroupElement).label ?? '', o.textContent ?? ''] as const));

test('reason templates: a chip memo follows the amount’s sign and reaches the member as recorded; a suspension reason that states a breach asks for what happened', async ({ browser }) => {
  const member = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);

  await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
  await page.getByPlaceholder(/검색|Search/).fill(member.nickname);
  await page.getByPlaceholder(/검색|Search/).press('Enter');
  await page.getByRole('link', { name: /상세|Details/ }).first().click();

  // No amount yet: nothing to offer, and the list says why.
  const memoList = page.getByTestId('chip-memo-template');
  await expect(memoList).toBeDisabled();
  await expect(memoList.locator('option').first()).toHaveText('금액을 먼저 입력하면 지급·차감에 맞는 메모가 나옵니다');

  // A grant offers grant memos only; the detail goes after the template.
  await page.getByTestId('chip-amount').fill('300');
  const grants = (await groups(memoList)).map(([, l]) => l);
  expect(grants).toContain('이벤트 보상 지급');
  expect(grants).not.toContain('중복 지급분 회수');
  await memoList.selectOption({ label: '이벤트 보상 지급' });
  await page.getByTestId('chip-memo').fill('10월 출석');
  await expect(page.getByTestId('chip-memo-final')).toHaveText('기록될 내용: 이벤트 보상 지급 - 10월 출석');
  await expect(page.getByTestId('chip-memo')).toHaveAttribute('placeholder', /상세/);

  // The sign flips: a grant memo no longer fits, so it goes, and only deduction memos are offered.
  await page.getByTestId('chip-amount').fill('-300');
  await expect(memoList).toHaveValue('');
  await expect(page.getByTestId('chip-memo')).toHaveValue('');
  await expect(page.getByTestId('chip-submit')).toBeDisabled();
  const deductions = (await groups(memoList)).map(([, l]) => l);
  expect(deductions).toContain('중복 지급분 회수');
  expect(deductions).not.toContain('이벤트 보상 지급');

  // Back to a grant, sent: the member's history and chip notice carry exactly what was recorded.
  await page.getByTestId('chip-amount').fill('300');
  await memoList.selectOption({ label: '이벤트 보상 지급' });
  await page.getByTestId('chip-memo').fill('10월 출석');
  await page.screenshot({ path: 'test-results/admin-tpl-chip-memo.png', fullPage: true });
  await page.getByTestId('chip-submit').click();
  await page.getByTestId('confirm-end').click();
  await reauthIfAsked(page, page.getByRole('cell', { name: '+300' }));
  await expect(page.getByTestId('history')).toContainText('+300 · 이벤트 보상 지급 - 10월 출석');
  await member.page.goto('/messages');
  await member.page.getByText('가상 칩 지급 안내').first().click();
  await expect(member.page.getByText(/이벤트 보상 지급 - 10월 출석/).first()).toBeVisible();

  // Suspension: a reason stating a breach is not enough alone; the detail is asked for, and typing by hand still works.
  const why = page.getByTestId('suspend-reason-template');
  await why.selectOption({ label: '부정행위 확인' });
  await expect(page.getByTestId('suspend-reason-need-detail')).toBeVisible();
  await page.getByTestId('suspend-reason').fill('같은 테이블 칩 몰아주기 3회');
  await expect(page.getByTestId('suspend-reason-need-detail')).toHaveCount(0);
  await expect(page.getByTestId('suspend-reason-final')).toHaveText('기록될 내용: 부정행위 확인 - 같은 테이블 칩 몰아주기 3회');
  await why.selectOption({ label: '직접 입력' });
  await page.getByTestId('suspend-reason').fill('E2E 직접 쓴 사유');
  await expect(page.getByTestId('suspend-reason')).toHaveValue('E2E 직접 쓴 사유');
  await expect(page.getByTestId('suspend-reason-final')).toHaveCount(0);
});

test('message templates: a template writes the title and body, blanks stop the send until filled, text changed by hand is asked about first, a category change keeps the text, and the member gets what was shown', async ({ browser }) => {
  const member = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  await page.goto(`${ADMIN}/messages`);
  await page.getByLabel('이메일·닉네임·ID 검색').fill(member.nickname);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('button', { name: `${member.nickname} +` }).click();

  const select = page.getByTestId('msg-tpl-select');
  const title = page.getByTestId('msg-title');
  const body = page.getByTestId('msg-body');
  const send = page.getByTestId('send-message');

  // A notice template: the answer is a blank the admin fills; until then it cannot go.
  await select.selectOption({ label: '고객지원 답변' });
  await expect(title).toHaveValue('[JC ROYAL] 문의 답변 안내');
  await expect(body).toHaveValue(/문의하신 내용에 대해 안내드립니다\.\n\n\{answer\}/);
  await expect(page.getByTestId('msg-missing')).toContainText('답변');
  await expect(send).toBeDisabled();
  await page.getByTestId('msg-tpl-var-answer').fill('지급은 이벤트 종료 후 3일 안에 이뤄집니다.');
  await expect(body).toHaveValue(/지급은 이벤트 종료 후 3일 안에 이뤄집니다\./);
  await expect(page.getByTestId('msg-missing')).toHaveCount(0);
  await expect(send).toBeEnabled();

  // Changed by hand, then another template: asked first, and keeping it keeps every word.
  await body.fill(`${await body.inputValue()}\n추신: E2E 손으로 쓴 줄`);
  await select.selectOption({ label: '문의 접수 안내' });
  await expect(page.getByTestId('msg-tpl-replace')).toContainText('문의 접수 안내');
  await page.getByTestId('msg-tpl-replace-no').click();
  await expect(page.getByTestId('msg-tpl-replace')).toHaveCount(0);
  await expect(body).toHaveValue(/추신: E2E 손으로 쓴 줄/);

  // Another category offers its own templates; the text stays as it was, now the admin's own.
  await page.getByTestId('msg-category').selectOption('event');
  await expect(select).toHaveValue('');
  await expect(title).toHaveValue('[JC ROYAL] 문의 답변 안내');
  await expect(body).toHaveValue(/추신: E2E 손으로 쓴 줄/);
  const events = (await groups(select)).map(([, l]) => l);
  expect(events).toEqual(['이벤트 당첨 안내', '이벤트 보상 지급 안내', '이벤트 참여 안내', '이벤트 종료 안내', '이벤트 보상 정정', '직접 작성']);

  // Replacing it is the admin's call; the reward is only what they write.
  await select.selectOption({ label: '이벤트 당첨 안내' });
  await page.getByTestId('msg-tpl-replace-yes').click();
  await expect(title).toHaveValue('[이벤트] 이벤트 당첨 안내');
  await expect(body).not.toHaveValue(/추신/);
  await expect(page.getByTestId('msg-missing')).toContainText('이벤트명');
  await expect(page.getByTestId('msg-missing')).toContainText('보상');
  await page.getByTestId('msg-tpl-var-eventName').fill('E2E 가을 이벤트');
  await page.getByTestId('msg-tpl-var-reward').fill('칩 5,000개');

  // In English the values are asked for in English; back in Korean the Korean ones are kept.
  await page.getByTestId('msg-tpl-lang').selectOption('en');
  await expect(title).toHaveValue('[Event] You Won!');
  await expect(page.getByTestId('msg-missing')).toBeVisible();
  await expect(send).toBeDisabled();
  await page.getByTestId('msg-tpl-lang').selectOption('ko');
  await expect(title).toHaveValue('[이벤트] 이벤트 당첨 안내');
  await expect(body).toHaveValue(/■ 이벤트명\nE2E 가을 이벤트\n\n■ 보상\n칩 5,000개/);
  await expect(page.getByTestId('msg-missing')).toHaveCount(0);
  await page.getByTestId('msg-preview').locator('summary').click();
  await expect(page.getByTestId('msg-preview')).toContainText('E2E 가을 이벤트');
  await page.screenshot({ path: 'test-results/admin-tpl-message.png', fullPage: true });

  // Sent through the same confirmation; the form starts afresh after it.
  await send.click();
  await expect(page.getByTestId('send-summary')).toContainText('1명에게 쪽지를 보냅니다');
  await page.getByTestId('send-confirm').click();
  await expect(page.getByTestId('feedback')).toHaveText('1명에게 발송했습니다.');
  await expect(select).toHaveValue('');
  await expect(title).toHaveValue('');
  await member.page.goto('/messages');
  await member.page.getByText('[이벤트] 이벤트 당첨 안내').first().click();
  await expect(member.page.getByText(/칩 5,000개/).first()).toBeVisible();
});

test('notice, maintenance and board templates: blanks block saving, sending at save is said plainly, the maintenance times follow the form while edits by hand stay, and no template touches the controls', async ({ browser }) => {
  test.setTimeout(150_000);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email);
  const stopAll = () =>
    page.evaluate(async () => {
      const r = (await (await fetch('/api/admin/service/maintenance')).json()) as { items: { id: string; state: string }[] };
      for (const w of r.items)
        if (w.state === 'active' || w.state === 'scheduled')
          await fetch(`/api/admin/service/maintenance/${w.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'E2E cleanup' }) });
    });

  try {
    await page.goto(`${ADMIN}/service`);
    await expect(page.getByTestId('maintenance-panel')).toBeVisible();

    // ── Service notice: an urgent one lists the incident templates first and fills all four fields.
    await page.getByTestId('notice-new').click();
    const form = page.getByTestId('notice-form');
    await form.getByTestId('notice-kind').selectOption('urgent');
    const noticeSelect = form.getByTestId('notice-tpl-select');
    const listed = await groups(noticeSelect);
    expect(listed.filter(([g]) => g === '이 종류에 맞는 템플릿').map(([, l]) => l)).toEqual(['서비스 장애 안내', '서비스 정상화 안내', '긴급 점검 안내']);
    expect(listed.map(([, l]) => l)).toContain('신규 기능 안내');
    await noticeSelect.selectOption({ label: '서비스 장애 안내' });
    await expect(form.getByTestId('notice-title-ko')).toHaveValue('[안내] JC ROYAL 서비스 이용 장애 안내');
    await expect(form.getByTestId('notice-title-en')).toHaveValue('[Notice] JC ROYAL Service Disruption');
    await expect(form.getByTestId('notice-body-ko')).toHaveValue(/■ 장애 발생 시각\n\{incidentTime\}/);
    // Unknown facts are blanks, never guessed; saving waits for them.
    await expect(form.getByTestId('notice-missing')).toContainText('장애 발생 시각');
    await expect(page.getByTestId('notice-save')).toBeDisabled();
    await form.getByTestId('notice-tpl-var-incidentTime').fill('2026-10-28 11:40 (KST)');
    await form.getByTestId('notice-tpl-var-affectedServices').fill('테이블 입장');
    await form.getByTestId('notice-tpl-var-affectedServicesEn').fill('Joining tables');
    await form.getByTestId('notice-tpl-var-status').fill('원인을 확인하고 있습니다.');
    await form.getByTestId('notice-tpl-var-statusEn').fill('We are looking into the cause.');
    await expect(form.getByTestId('notice-missing')).toHaveCount(0);
    await expect(form.getByTestId('notice-body-en')).toHaveValue(/■ Affected\nJoining tables/);
    await expect(page.getByTestId('notice-save')).toBeEnabled();

    // Scheduled for later with messages ticked: they go out at saving, and the form says so before it is saved.
    await form.getByTestId('notice-start').fill(await inputValue(page, Date.now() + 3 * 3600_000));
    await form.getByTestId('notice-inbox').check();
    await expect(form).toContainText('주의: 쪽지는 공지 예약 시각이 아니라 저장 시점에 즉시 발송됩니다.');
    await expect(form.getByTestId('notice-later-warn')).toContainText('지금 저장하는 즉시 나갑니다');
    await form.getByTestId('notice-preview').locator('summary').click();
    await page.screenshot({ path: 'test-results/admin-tpl-notice.png', fullPage: true });

    // A maintenance notice has no times of its own: the period is a value the admin types, like any other.
    await form.getByTestId('notice-kind').selectOption('maintenance');
    await form.getByTestId('notice-tpl-select').selectOption({ label: '정기 점검 안내' });
    await expect(form.getByTestId('notice-tpl-var-period')).toBeVisible();
    await expect(form.getByTestId('notice-tpl-var-periodEn')).toBeVisible();
    await form.getByTestId('notice-tpl-var-period').fill('2026년 10월 29일 02:00 ~ 04:00 (KST)');
    await expect(form.getByTestId('notice-body-ko')).toHaveValue(/■ 점검 일정\n2026년 10월 29일 02:00 ~ 04:00 \(KST\)/);

    // Long values in a template can write more than a notice holds: it is said, field by field, and saving waits. Nothing is cut.
    await form.getByTestId('notice-kind').selectOption('general');
    await form.getByTestId('notice-tpl-select').selectOption({ label: '이벤트 안내' });
    await form.getByTestId('notice-tpl-var-eventName').fill('E2E 가을 이벤트');
    await form.getByTestId('notice-tpl-var-eventNameEn').fill('E2E Autumn Event');
    await form.getByTestId('notice-tpl-var-eventPeriod').fill('2026-11-01 ~ 2026-11-07');
    await form.getByTestId('notice-tpl-var-participation').fill('참'.repeat(1000));
    await form.getByTestId('notice-tpl-var-reward').fill('상'.repeat(1000));
    await form.getByTestId('notice-tpl-var-participationEn').fill('Play any table.');
    await form.getByTestId('notice-tpl-var-rewardEn').fill('5,000 chips');
    await expect(form.getByTestId('notice-missing')).toHaveCount(0);
    await expect(form.getByTestId('notice-too-long-bodyKo')).toContainText('내용 (한국어, 선택): 2,000자까지 보낼 수 있는데 지금');
    await expect(form.getByTestId('notice-too-long-bodyEn')).toHaveCount(0);
    expect((await form.getByTestId('notice-body-ko').inputValue()).length).toBeGreaterThan(2000);
    await expect(page.getByTestId('notice-save')).toBeDisabled();
    await form.getByTestId('notice-too-long').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/admin-tpl-notice-too-long.png' });
    await form.getByTestId('notice-tpl-var-reward').fill('칩 5,000개');
    await expect(form.getByTestId('notice-too-long')).toHaveCount(0);
    await expect(form.getByTestId('notice-body-ko')).toHaveValue(new RegExp(`■ 참여 방법\\n${'참'.repeat(1000)}\\n\\n■ 보상\\n칩 5,000개`));
    await expect(page.getByTestId('notice-save')).toBeEnabled();
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    await expect(form).toHaveCount(0);

    // ── Maintenance: the message's times come from the form, the reason from its own list.
    const start = Math.floor((Date.now() + 2 * 3600_000) / 60_000) * 60_000;
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-start').fill(await inputValue(page, start));
    await page.getByTestId('maint-end').fill(await inputValue(page, start + 3600_000));
    await page.getByTestId('maint-tpl-select').selectOption({ label: '정기 점검' });
    const ko = page.getByTestId('maint-msg-ko');
    const en = page.getByTestId('maint-msg-en');
    await expect(ko).toHaveValue(new RegExp(`■ 점검 일정\\n${formatPeriod(start, start + 3600_000, 'ko').replace(/[()]/g, '\\$&')}`));
    await expect(en).toHaveValue(new RegExp(`■ Maintenance Period\\n${formatPeriod(start, start + 3600_000, 'en').replace(/[()]/g, '\\$&')}`));
    // The times are written, not asked for; what was done is.
    await expect(page.getByTestId('maint-tpl-var-period')).toHaveCount(0);
    await page.getByTestId('maint-tpl-var-maintenanceDetails').fill('데이터베이스 업그레이드');
    await page.getByTestId('maint-tpl-var-maintenanceDetailsEn').fill('Database upgrade');
    await expect(page.getByTestId('maint-missing')).toHaveCount(0);
    // A line added by hand, then the end moved: the times follow, the line stays.
    await ko.fill(`${await ko.inputValue()}\n로비와 게시판 읽기는 계속 이용하실 수 있습니다.`);
    await page.getByTestId('maint-end').fill(await inputValue(page, start + 2 * 3600_000));
    await expect(ko).toHaveValue(new RegExp(formatPeriod(start, start + 2 * 3600_000, 'ko').replace(/[()]/g, '\\$&')));
    await expect(ko).toHaveValue(/로비와 게시판 읽기는 계속 이용하실 수 있습니다\./);
    await expect(ko).not.toHaveValue(new RegExp(formatPeriod(start, start + 3600_000, 'ko').replace(/[()]/g, '\\$&')));
    await expect(en).toHaveValue(new RegExp(formatPeriod(start, start + 2 * 3600_000, 'en').replace(/[()]/g, '\\$&')));
    // The template decided nothing else: sign-in pausing is as it was.
    await expect(page.getByTestId('maint-block-login')).not.toBeChecked();
    const reason = page.getByTestId('maint-reason-template');
    const scheduleReasons = (await groups(reason)).map(([, l]) => l);
    expect(scheduleReasons).toContain('정기 서버 점검');
    expect(scheduleReasons).not.toContain('점검 시간 연장');
    await reason.selectOption({ label: '정기 서버 점검' });
    await expect(page.getByTestId('maint-reason-final')).toHaveText('기록될 내용: 정기 서버 점검');
    // A detail, then the console in English: the reason keeps the wording it was written in and its detail, and more typing adds to it.
    await page.getByTestId('maint-reason').fill('DB 2차');
    await page.locator('header').getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByTestId('maint-reason')).toHaveValue('DB 2차');
    await expect(page.getByTestId('maint-reason-final')).toHaveText('Will be recorded as: 정기 서버 점검 - DB 2차');
    await page.getByTestId('maint-reason').fill('DB 2차 작업');
    await expect(page.getByTestId('maint-reason-final')).toHaveText('Will be recorded as: 정기 서버 점검 - DB 2차 작업');
    await page.locator('header').getByRole('button', { name: '한국어', exact: true }).click();
    await expect(page.getByTestId('maint-reason-final')).toHaveText('기록될 내용: 정기 서버 점검 - DB 2차 작업');
    await page.getByTestId('maint-preview').locator('summary').click();
    await page.screenshot({ path: 'test-results/admin-tpl-maintenance.png', fullPage: true });
    await page.getByTestId('maint-save').click();
    await expect(page.getByRole('dialog')).toContainText('정기 서버 점검');
    await page.getByTestId('maint-confirm').click();
    await reauthIfAsked(page, page.getByTestId('maint-current'));
    await expect(page.getByTestId('maint-current')).toContainText(/점검 예정|Scheduled/);
    const saved = await page.evaluate(async () => ((await (await fetch('/api/admin/service/maintenance')).json()) as { items: { state: string; messageKo: string | null; blockLogin: boolean }[] }).items.find((w) => w.state === 'scheduled')!);
    expect(saved.messageKo).toContain('로비와 게시판 읽기는 계속 이용하실 수 있습니다.');
    expect(saved.messageKo).not.toMatch(/\{[A-Za-z]+\}/);
    expect(saved.blockLogin).toBe(false);

    // Editing it offers change reasons, and the extension message names the new end from the form.
    await page.getByTestId('maint-edit').click();
    expect((await groups(page.getByTestId('maint-reason-template'))).map(([, l]) => l)).toContain('점검 시간 연장');
    await page.getByTestId('maint-tpl-select').selectOption({ label: '점검 연장' });
    await page.getByTestId('maint-tpl-replace-yes').click();
    await expect(ko).toHaveValue(new RegExp(`■ 변경된 종료 예정 시각\\n${formatMoment(start + 2 * 3600_000, 'ko').replace(/[()]/g, '\\$&')}`));
    await page.getByTestId('maint-form').getByRole('button', { name: '취소', exact: true }).click();

    // Cancelling offers cancel reasons and says no notice goes out by itself.
    const stop = page.getByTestId('maint-stop-reason-template');
    const cancelReasons = (await groups(stop)).map(([, l]) => l);
    expect(cancelReasons).toContain('점검 일정 취소');
    expect(cancelReasons).not.toContain('점검 작업 완료');
    await expect(page.getByTestId('maint-stop-note')).toContainText('회원에게 취소 안내가 자동으로 가지 않습니다');
    await stop.selectOption({ label: '점검 일정 취소' });
    await page.getByTestId('maint-stop').click();
    await page.getByTestId('maint-confirm').click();
    await expect(page.getByTestId('maint-new')).toBeVisible();

    // ── Board notice: one language at a time; a title changed by hand is asked about before another language replaces it.
    const mark = uid('tpl');
    await page.goto(`${ADMIN}/board`);
    await page.getByTestId('new-notice').click();
    const board = page.getByTestId('board-notice-form');
    await board.getByTestId('board-tpl-select').selectOption({ label: '게임 이용 안내' });
    await expect(board.getByTestId('board-notice-title')).toHaveValue('[안내] JC ROYAL 이용 안내');
    await expect(page.getByTestId('board-notice-save')).toBeDisabled();
    await board.getByTestId('board-tpl-var-guideDetails').fill('테이블 오른쪽 아래의 도움말 단추를 누르면 규칙을 볼 수 있습니다.');
    await expect(page.getByTestId('board-notice-save')).toBeEnabled();
    await board.getByTestId('board-notice-title').fill(`[안내] JC ROYAL 이용 안내 ${mark}`);
    await board.getByTestId('board-tpl-lang').selectOption('en');
    await expect(board.getByTestId('board-tpl-replace')).toBeVisible();
    await board.getByTestId('board-tpl-replace-no').click();
    await expect(board.getByTestId('board-notice-title')).toHaveValue(`[안내] JC ROYAL 이용 안내 ${mark}`);
    await page.screenshot({ path: 'test-results/admin-tpl-board.png', fullPage: true });
    await page.getByTestId('board-notice-save').click();
    await page.getByTestId('board-q').fill(mark);
    await page.getByTestId('board-q').press('Enter');
    await expect(page.getByTestId('board-row').filter({ hasText: mark })).toHaveCount(1);
  } finally {
    await stopAll();
  }
});
