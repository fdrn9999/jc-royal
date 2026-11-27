import { expect } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';
import { expectPlaying, expectSilent, watchBgm } from './bgm-helpers';

test('mobile: 방 만들기의 배경 음악 선택이 360px 화면 안에서 탭할 수 있고, 미리 듣기가 되며, 고른 곡이 테이블에서 난다', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page } = await signUp(browser, { mobile: true });
  await page.addInitScript(watchBgm);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await page.getByTestId('room-create-open').tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/배경 음악 \(BGM\)|Background music \(BGM\)/)).toBeVisible();
  // Each choice: inside the screen, and tall enough for a thumb.
  for (const id of ['black-table-rhythm', 'tournament', 'none']) {
    const opt = dialog.getByTestId(`room-bgm-${id}`);
    await opt.scrollIntoViewIfNeeded();
    const box = (await opt.boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(360);
    expect(box.height, id).toBeGreaterThanOrEqual(40);
  }
  await dialog.getByTestId('room-bgm-tournament').tap();
  await expect(dialog.getByTestId('room-bgm-tournament')).toHaveAttribute('aria-checked', 'true');
  const preview = dialog.getByTestId('room-bgm-preview');
  expect((await preview.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await preview.tap();
  await expectPlaying(page, 'tournament');
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/bgm-room-create-mobile.png', animations: 'disabled' });
  await preview.tap();
  await expectSilent(page);
  await dialog.getByTestId('room-create').tap();
  await expect(page).toHaveURL(/\/table\/[\w-]+/);
  await page.getByTestId('buyin-confirm').tap();
  await expect(page.getByTestId('seat-0').getByTestId('host-mark')).toBeVisible();
  await expectPlaying(page, 'tournament');
  await page.screenshot({ path: 'test-results/bgm-table-mobile.png' });
});
