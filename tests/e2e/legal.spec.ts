import { expect } from '@playwright/test';
import { PASSWORD, signUp, test } from './helpers';

test('privacy policy and terms are public drafts in Korean and English, linked from the footers and sign-up', async ({ page }) => {
  // Signed out: the sign-in page footer links to both pages.
  await page.goto('/login');
  const footer = page.getByRole('navigation', { name: '개인정보 처리방침 / 이용약관' });
  await footer.getByRole('link', { name: '개인정보 처리방침' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  const privacy = page.getByTestId('legal-privacy');
  await expect(privacy.getByRole('heading', { level: 1 })).toHaveText('개인정보 처리방침');
  await expect(page.getByTestId('legal-draft')).toBeVisible();
  // Points left for legal review are shown as such instead of being decided.
  expect(await page.getByTestId('legal-review').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('legal-review').first()).toContainText('[검토 필요]');
  await expect(privacy).toContainText('1:1 대화');
  await page.screenshot({ path: 'test-results/legal-privacy-ko.png', fullPage: true });

  await page.getByRole('link', { name: '이용약관', exact: true }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByTestId('legal-terms').getByRole('heading', { level: 1 })).toHaveText('이용약관');

  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByTestId('legal-terms').getByRole('heading', { level: 1 })).toHaveText('Terms of Service');
  await expect(page.getByTestId('legal-review').first()).toContainText('[Needs legal review]');
  await page.screenshot({ path: 'test-results/legal-terms-en.png', fullPage: true });
  await page.getByRole('link', { name: 'Privacy Policy', exact: true }).click();
  await expect(page.getByTestId('legal-privacy')).toContainText('1:1 messages');

  // Sign-up: the policy and terms open in a new tab, so a half-filled form is kept.
  await page.goto('/register');
  const terms = page.getByTestId('consent-terms-link');
  await expect(terms).toHaveAttribute('target', '_blank');
  await expect(terms).toHaveAttribute('href', '/terms');
  await page.getByRole('button', { name: /^View$/ }).click();
  const full = page.getByTestId('consent-policy-link');
  await expect(full).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([page.context().waitForEvent('page'), full.click()]);
  await expect(tab).toHaveURL(/\/privacy$/);
  await expect(tab.getByTestId('legal-privacy')).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
  await page.screenshot({ path: 'test-results/legal-register-consent.png', fullPage: true });
});

test('account deletion explains what is removed, and the board shows the author as a withdrawn member', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  await a.page.goto('/board/write');
  await a.page.getByLabel(/^(제목|Title)$/).fill('탈퇴 전에 쓴 글');
  await a.page.getByLabel(/내용|Text/).fill('본문');
  await a.page.getByTestId('publish').click();
  await expect(a.page.getByTestId('post-title')).toHaveText('탈퇴 전에 쓴 글');
  const url = a.page.url();

  // The signed-in shell has the same footer links.
  await expect(a.page.getByRole('navigation', { name: '개인정보 처리방침 / 이용약관' })).toBeVisible();

  await a.page.goto('/me');
  await a.page.getByRole('button', { name: '회원 탈퇴' }).click();
  const dialog = a.page.getByRole('dialog');
  await expect(dialog).toContainText('1:1 대화(상대방 쪽 포함)');
  await expect(dialog).toContainText('"탈퇴한 회원" 이름으로 남습니다');
  await a.page.screenshot({ path: 'test-results/legal-delete-confirm.png', animations: 'disabled' });
  await dialog.locator('input[type="password"]').fill(PASSWORD);
  await dialog.getByRole('button', { name: '회원 탈퇴' }).click();
  await expect(a.page).toHaveURL(/\/login$/);

  await b.page.goto(url);
  await expect(b.page.getByTestId('post-title')).toHaveText('탈퇴 전에 쓴 글');
  await expect(b.page.getByTestId('author-withdrawn').first()).toHaveText('탈퇴한 회원');
  await expect(b.page.getByText(a.nickname)).toHaveCount(0);
  await expect(b.page.getByText(/deleted-/)).toHaveCount(0);
  await b.page.goto('/board');
  await expect(b.page.getByTestId('author-withdrawn').first()).toBeVisible();
  await expect(b.page.getByText(/deleted-/)).toHaveCount(0);
});
