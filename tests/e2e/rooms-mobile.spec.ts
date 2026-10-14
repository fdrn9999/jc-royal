import { expect, test } from '@playwright/test';
import { balanceOf, signUp, widerThanDevice } from './helpers';

test('mobile: open a room by touch; the create dialog, the table header with the host button and the host dialog fit a 360px phone', async ({ browser }) => {
  const { page, nickname } = await signUp(browser, { mobile: true });
  const start = await balanceOf(page);
  await page.setViewportSize({ width: 360, height: 780 });

  const open = page.getByTestId('room-create-open');
  await expect(open).toBeVisible();
  expect((await open.boundingBox())!.x + (await open.boundingBox())!.width).toBeLessThanOrEqual(360);
  expect(await widerThanDevice(page)).toBe(false);
  await open.tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('room-name')).toHaveValue(new RegExp(nickname));
  await dialog.getByTestId('room-seats-9').tap();
  await dialog.getByTestId('room-bb-20').tap();
  await dialog.getByTestId('room-min').selectOption('50');
  await dialog.getByTestId('room-max').selectOption('50');
  await expect(dialog.getByTestId('room-create')).toBeEnabled();
  await dialog.getByTestId('room-max').selectOption('100');
  // Every choice is a full-size tap target and nothing spills sideways.
  for (const b of await dialog.getByRole('radio').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/room-create-mobile.png', animations: 'disabled' });
  await dialog.getByTestId('room-create').tap();

  await expect(page).toHaveURL(/\/table\/[\w-]+/);
  await page.getByTestId('buyin-confirm').tap();
  await expect(page.getByTestId('seat-0').getByTestId('host-mark')).toBeVisible();
  const manage = page.getByTestId('room-manage');
  await expect(manage).toBeVisible();
  const box = (await manage.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.height).toBeGreaterThanOrEqual(32);
  // The host opens settings from the room name, so the name keeps a readable width next to the header buttons.
  expect((await page.getByTestId('table-title').boundingBox())!.width).toBeGreaterThanOrEqual(80);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/room-table-mobile.png', animations: 'disabled' });

  await manage.tap();
  await expect(dialog.getByTestId('room-link')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/room-host-mobile.png', animations: 'disabled' });
  await dialog.getByTestId('room-close').tap();
  await dialog.getByTestId('room-close').tap();
  await expect(page.getByText(/테이블이 종료되었습니다|The table has been closed/)).toBeVisible();
  expect(await balanceOf(page)).toBe(start);
});
