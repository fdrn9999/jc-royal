import { expect } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

test('mobile: the share button and the table invite fit a 360px phone and open the share sheet', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  await page.setViewportSize({ width: 360, height: 780 });
  const origin = new URL(page.url()).origin;
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: unknown) => void w.__shared.push(d) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
  await page.reload();

  const share = page.getByTestId('site-share');
  await expect(share).toBeVisible();
  const box = (await share.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.height).toBeGreaterThanOrEqual(40);
  // The search box keeps a usable width beside it.
  expect((await page.getByRole('textbox', { name: /검색|Search/ }).boundingBox())!.width).toBeGreaterThanOrEqual(150);
  expect(await widerThanDevice(page)).toBe(false);
  await share.tap();
  await expect(page.getByTestId('site-share-status')).toHaveText(/공유했습니다|Shared/);
  expect(await widerThanDevice(page)).toBe(false);
  await page.screenshot({ path: 'test-results/share-lobby-mobile.png', animations: 'disabled' });
  expect(await page.evaluate(() => (window as unknown as { __shared: { url: string }[] }).__shared.map((s) => s.url))).toEqual([`${origin}/`]);

  await page.goto('/table/e2e-six');
  const cancel = page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ });
  if (await cancel.isVisible().catch(() => false)) await cancel.tap();
  await page.getByRole('button', { name: /^(설정|Settings)$/ }).tap();
  await expect(page.getByTestId('table-invite')).toBeVisible();
  for (const id of ['table-invite-url', 'table-invite-copy', 'table-invite-share']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(360);
  }
  expect((await page.getByTestId('table-invite-url').boundingBox())!.width).toBeGreaterThanOrEqual(100);
  expect(await widerThanDevice(page)).toBe(false);
  await page.getByTestId('table-invite-share').tap();
  await expect(page.getByTestId('table-invite-status')).toHaveText(/공유했습니다|Shared/);
  await page.screenshot({ path: 'test-results/share-table-mobile.png', animations: 'disabled' });
  const shared = await page.evaluate(() => (window as unknown as { __shared: { title: string; text: string; url: string }[] }).__shared);
  expect(shared.at(-1)).toMatchObject({ title: 'E2E Six', url: `${origin}/table/e2e-six` });
  expect(shared.at(-1)!.text).toContain('E2E Six');
});
