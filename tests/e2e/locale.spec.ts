import { expect } from '@playwright/test';
import { signUp, test } from './helpers';

// English is its own chunk (apps/web/src/lib/i18n-en.ts): downloaded only by someone who reads English.
const englishChunk = (url: string) => /\/assets\/i18n-en-[^/]+\.js$/.test(url);

test('Korean visitors never download English; someone who saved English opens in English', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (englishChunk(r.url())) fetched.push(r.url());
  });

  await page.goto('/login');
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  expect(fetched).toEqual([]);

  await page.evaluate(() => localStorage.setItem('jc.locale', 'en'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  expect(fetched).toHaveLength(1);
});

test('choosing English in the settings switches the page at once, and back', async ({ browser }) => {
  const { page } = await signUp(browser);
  await expect(page.getByRole('heading', { name: '테이블 로비' })).toBeVisible();

  await page.getByTestId('settings-open').click();
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Table Lobby' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByLabel('Language', { exact: true }).selectOption('ko');
  await expect(page.getByRole('heading', { name: '테이블 로비' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
});

test('a link that asks for English (?lang=en, as its preview was) opens in English for someone with no saved language', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login?lang=en');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // A saved choice wins over the link.
  await page.evaluate(() => localStorage.setItem('jc.locale', 'ko'));
  await page.reload();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
});
