import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

/** Every visible control inside `box` lies within the phone's width, and the page does not scroll sideways. */
async function fitsPhone(page: Page, box: Locator) {
  expect(await widerThanDevice(page)).toBe(false);
  const width = page.viewportSize()!.width;
  const out = await box.evaluate(
    (el, w) =>
      Array.from(el.querySelectorAll('select, input, textarea, button, [role=alert], [role=group], p'))
        .filter((x) => (x as HTMLElement).offsetParent !== null)
        .map((x) => ({ id: x.getAttribute('data-testid') ?? x.tagName, r: x.getBoundingClientRect() }))
        .filter(({ r }) => r.left < -0.5 || r.right > w + 0.5)
        .map(({ id, r }) => `${id} ${Math.round(r.left)}..${Math.round(r.right)}`),
    width,
  );
  expect(out, 'controls past the screen edge').toEqual([]);
}

test('on a phone: the template list, the values it asks for, the replace question and the preview fit the screen in messages, notices, maintenance and a chip memo', async ({ browser }) => {
  test.setTimeout(120_000);
  const member = await signUp(browser, { mobile: true });
  const op = await signUp(browser, { mobile: true });
  sql(promoteSql(`email = '${op.email}'`));
  const page = await adminLogin(browser, op.email, { mobile: true });

  // Messages: a template with long blanks, then the question before a hand-edited text is replaced.
  await page.goto(`${ADMIN}/messages`);
  await page.getByTestId('msg-category').selectOption('sanction');
  await page.getByTestId('msg-tpl-select').selectOption({ label: '이용 제한 안내' });
  await expect(page.getByTestId('msg-tpl-var-sanctionReason')).toBeVisible();
  await page.getByTestId('msg-tpl-var-sanctionReason').fill('같은 테이블에서 여러 계정으로 칩을 한 계정에 몰아준 정황이 반복되어 운영 정책 제5조에 따라 검토했습니다');
  await page.getByTestId('msg-body').fill(`${await page.getByTestId('msg-body').inputValue()}\n손으로 덧붙인 줄`);
  await page.getByTestId('msg-tpl-select').selectOption({ label: '이용 제한 해제 안내' });
  await expect(page.getByTestId('msg-tpl-replace')).toBeVisible();
  await expect(page.getByTestId('msg-missing')).toBeVisible();
  await page.getByTestId('msg-preview').locator('summary').click();
  await fitsPhone(page, page.locator('main'));
  await page.screenshot({ path: 'test-results/admin-tpl-mobile-message.png', fullPage: true });
  await page.getByTestId('msg-tpl-replace-no').click();
  await expect(page.getByTestId('msg-body')).toHaveValue(/손으로 덧붙인 줄/);

  // A service notice: grouped list, the four fields filled, the values in one column, the timing notes.
  await page.goto(`${ADMIN}/service`);
  await page.getByTestId('notice-new').click();
  const form = page.getByTestId('notice-form');
  await form.getByTestId('notice-kind').selectOption('urgent');
  await form.getByTestId('notice-tpl-select').selectOption({ label: '서비스 장애 안내' });
  await form.getByTestId('notice-inbox').check();
  await form.getByTestId('notice-preview').locator('summary').click();
  await expect(form.getByTestId('notice-tpl-var-incidentTime')).toBeVisible();
  await fitsPhone(page, page.getByRole('dialog'));
  await page.screenshot({ path: 'test-results/admin-tpl-mobile-notice.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();

  // Maintenance: the message written from the form's times, and the reason list.
  await page.getByTestId('maint-new').click();
  await page.getByTestId('maint-tpl-select').selectOption({ label: '긴급 점검' });
  await expect(page.getByTestId('maint-msg-ko')).toHaveValue(/\(KST\)/);
  await page.getByTestId('maint-reason-template').selectOption({ label: '긴급 서버 점검' });
  await fitsPhone(page, page.getByTestId('maint-form'));
  await page.getByTestId('maint-form').screenshot({ path: 'test-results/admin-tpl-mobile-maintenance.png' });
  await page.getByTestId('maint-form').getByRole('button', { name: '취소', exact: true }).click();

  // A chip memo: the list beside the detail, and what will be recorded, at full length.
  await page.goto(`${ADMIN}/users`);
  await page.getByPlaceholder(/검색|Search/).fill(member.nickname);
  await page.getByPlaceholder(/검색|Search/).press('Enter');
  await page.getByRole('link', { name: /상세|Details/ }).first().click();
  await page.getByTestId('chip-amount').fill('-500');
  await page.getByTestId('chip-memo-template').selectOption({ label: '중복 지급분 회수' });
  await page.getByTestId('chip-memo').fill('10월 출석 이벤트 보상이 두 번 지급된 몫');
  await expect(page.getByTestId('chip-memo-final')).toHaveText('기록될 내용: 중복 지급분 회수 - 10월 출석 이벤트 보상이 두 번 지급된 몫');
  await page.getByTestId('chip-memo').scrollIntoViewIfNeeded();
  await fitsPhone(page, page.locator('#member-chips'));
  await page.locator('#member-chips').screenshot({ path: 'test-results/admin-tpl-mobile-chip.png' });
});
