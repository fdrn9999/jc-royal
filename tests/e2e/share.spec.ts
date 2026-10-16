import { expect, type Page } from '@playwright/test';
import { signUp, test } from './helpers';

/**
 * The share sheet and the clipboard are the browser's, so they are stood in for: `share` records what the page asked
 * to share (or is removed, as on most desktop browsers), the clipboard records what was copied.
 */
async function standIns(page: Page, opts: { share: boolean }) {
  await page.addInitScript((share) => {
    const w = window as unknown as { __shared: unknown[]; __copied: string[] };
    w.__shared = [];
    w.__copied = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: share ? async (d: unknown) => void w.__shared.push(d) : undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: share ? () => true : undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__copied.push(t) } });
  }, opts.share);
  await page.reload();
}

const recorded = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __shared: { title: string; text?: string; url: string }[]; __copied: string[] };
    return { __shared: w.__shared, __copied: w.__copied };
  });

test('the lobby shares the site, or copies its address where there is no share sheet', async ({ browser }) => {
  const { page } = await signUp(browser);
  const origin = new URL(page.url()).origin;

  await standIns(page, { share: false });
  await page.getByTestId('site-share').click();
  await expect(page.getByTestId('site-share-status')).toHaveText(/링크를 복사했습니다|Link copied/);
  expect((await recorded(page)).__copied).toEqual([`${origin}/`]);
  // The note goes away by itself.
  await expect(page.getByTestId('site-share-status')).toBeHidden({ timeout: 5_000 });

  await standIns(page, { share: true });
  await page.getByTestId('site-share').click();
  await expect(page.getByTestId('site-share-status')).toHaveText(/공유했습니다|Shared/);
  const [shared] = (await recorded(page)).__shared;
  expect(shared).toMatchObject({ title: 'JC ROYAL', url: `${origin}/` });
  expect(shared!.text).toBeTruthy();
});

test('a table invite in the table settings is the table address only, never a code', async ({ browser }) => {
  const { page } = await signUp(browser);
  const origin = new URL(page.url()).origin;
  await page.goto('/table/e2e-six?code=should-not-travel');
  await standIns(page, { share: false });
  const cancel = page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();

  await page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  const invite = page.getByTestId('table-invite');
  await expect(invite).toBeVisible();
  await expect(page.getByTestId('table-invite-url')).toHaveValue(`${origin}/table/e2e-six`);
  await page.getByTestId('table-invite-copy').click();
  await expect(page.getByTestId('table-invite-status')).toHaveText(/링크를 복사했습니다|Link copied/);
  expect((await recorded(page)).__copied).toEqual([`${origin}/table/e2e-six`]);
  await page.screenshot({ path: 'test-results/share-table-desktop.png', animations: 'disabled' });

  // No share sheet: Share copies too.
  await page.getByTestId('table-invite-share').click();
  expect((await recorded(page)).__copied).toEqual([`${origin}/table/e2e-six`, `${origin}/table/e2e-six`]);
});
