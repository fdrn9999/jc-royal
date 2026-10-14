import { expect, test } from '@playwright/test';

test('register: email = local part + domain picker with direct input', async ({ page }) => {
  await page.goto('/register');
  const local = page.getByLabel(/이메일 아이디|Email name/);
  const domain = page.getByLabel(/이메일 도메인|Email domain/);
  // No domain is preselected: the address stays incomplete until one is picked.
  await expect(domain).toHaveValue('');
  await expect(domain.locator('option:checked')).toHaveText(/선택하세요|Select/);
  await expect(page.getByLabel(/도메인 직접 입력|^Domain$/)).toHaveCount(0);
  const send = page.getByRole('button', { name: /인증번호 받기|Send code/ });
  await local.fill('royal.player');
  await expect(send).toBeDisabled();
  await domain.selectOption('naver.com');
  await expect(send).toBeEnabled();
  // Pasting a full address fills both parts.
  await local.fill('royal.player@gmail.com');
  await expect(local).toHaveValue('royal.player');
  await expect(domain).toHaveValue('gmail.com');
  await domain.selectOption('__custom__');
  await page.getByLabel(/도메인 직접 입력|^Domain$/).fill('jcroyal.kr');
  await page.screenshot({ path: 'test-results/register-email.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/register-email-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
