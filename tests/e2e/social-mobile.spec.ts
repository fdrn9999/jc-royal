import { expect, test, type Page } from '@playwright/test';
import { signUp, widerThanDevice } from './helpers';

test('mobile: play together from the friends list; the table picker fits and every row is a full-width tap target', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aId = (await call<{ id: string }>(a.page, '/api/auth/me')).id;
  const bId = (await call<{ id: string }>(b.page, '/api/auth/me')).id;
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  const overflow = () => widerThanDevice(a.page);

  await a.page.goto('/friends');
  const item = a.page.getByTestId('friend-item').filter({ hasText: b.nickname });
  const invite = item.getByTestId('friend-invite');
  await expect(invite).toBeVisible();
  const box = (await invite.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(32);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await overflow()).toBe(false);
  await invite.tap();
  const picker = a.page.getByTestId('invite-picker');
  const row = picker.getByTestId('invite-table').filter({ hasText: 'E2E Rookie' });
  await expect(row).toBeVisible();
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  expect(rowBox.x).toBeGreaterThanOrEqual(0);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(390);
  expect(await overflow()).toBe(false);
  await a.page.screenshot({ path: 'test-results/mobile-invite-picker.png', animations: 'disabled' });
  await row.tap();
  await expect(a.page.getByRole('status')).toContainText('E2E Rookie');

  await a.page.goto(`/friends/${bId}`);
  await expect(a.page.getByTestId('dm-invite')).toContainText('E2E Rookie');
  expect(await overflow()).toBe(false);
});

async function call<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}

test('mobile: report a 1:1 message and block by touch; dialogs fit the screen', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  const aId = (await call<{ id: string }>(a.page, '/api/auth/me')).id;
  const bId = (await call<{ id: string }>(b.page, '/api/auth/me')).id;
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  await call(b.page, `/api/dm/${aId}`, { text: '모바일에서 신고할 메시지' });
  const overflow = () => widerThanDevice(a.page);
  const inside = async (testId: string) => {
    const box = (await a.page.getByTestId(testId).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  };

  await a.page.goto(`/friends/${bId}`);
  await a.page.getByTestId('dm-theirs').getByRole('button', { name: /신고할 메시지/ }).tap();
  const report = a.page.getByTestId('dm-report');
  await expect(report).toBeVisible();
  const tapBox = (await report.boundingBox())!;
  expect(tapBox.height).toBeGreaterThanOrEqual(28);
  await report.tap();
  await expect(a.page.getByTestId('report-form')).toContainText('모바일에서 신고할 메시지');
  await inside('report-form');
  expect(await overflow()).toBe(false);
  await a.page.screenshot({ path: 'test-results/mobile-dm-report.png', animations: 'disabled' });
  await a.page.getByRole('radio', { name: /욕설|Abuse/ }).tap();
  await a.page.getByTestId('report-submit').tap();
  await expect(a.page.getByTestId('report-done')).toBeVisible();
  await a.page.getByTestId('report-done').getByRole('button').tap();

  await a.page.getByTestId('dm-block').tap();
  await expect(a.page.getByTestId('block-confirm')).toBeVisible();
  await inside('block-confirm');
  expect(await overflow()).toBe(false);
  await a.page.screenshot({ path: 'test-results/mobile-block-confirm.png', animations: 'disabled' });
  await a.page.getByTestId('block-confirm-yes').tap();
  await expect(a.page.getByTestId('dm-blocked')).toBeVisible();
  await inside('dm-blocked');
  expect(await overflow()).toBe(false);
});
