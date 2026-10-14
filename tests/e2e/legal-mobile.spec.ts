import { expect, test } from '@playwright/test';
import { widerThanDevice } from './helpers';

test('mobile: privacy policy, terms and the sign-up agreements fit the phone', async ({ page }) => {
  for (const path of ['/privacy', '/terms']) {
    await page.goto(path);
    await expect(page.getByTestId('legal-draft')).toBeVisible();
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      expect(await widerThanDevice(page), `${path} at ${width}px`).toBe(false);
      // The header keeps both tabs and the language switch on screen.
      for (const name of ['개인정보 처리방침', '이용약관']) {
        const box = (await page.getByRole('link', { name, exact: true }).boundingBox())!;
        expect(box.x + box.width, `${name} at ${width}px`).toBeLessThanOrEqual(width);
      }
      const en = (await page.getByRole('button', { name: 'EN' }).boundingBox())!;
      expect(en.x + en.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `test-results/legal-mobile${path.replace('/', '-')}.png`, fullPage: true });
  }

  await page.goto('/register');
  await page.getByRole('button', { name: '보기', exact: true }).tap();
  await expect(page.getByTestId('consent-policy-link')).toBeVisible();
  expect(await widerThanDevice(page)).toBe(false);
  const footer = page.getByRole('navigation', { name: '개인정보 처리방침 / 이용약관' });
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.getByRole('link', { name: '이용약관' })).toBeVisible();
  await page.screenshot({ path: 'test-results/legal-mobile-register.png', fullPage: true });
});
