import { expect, test } from '@playwright/test';
import { PASSWORD, uid } from './helpers';

const rule = (page: import('@playwright/test').Page, label: RegExp) => page.locator('li', { hasText: label });

test('sign-up form: email code, live password rules, eye toggle, birth date, consents', async ({ page }) => {
  await page.goto('/register');
  const submit = page.getByRole('button', { name: /회원가입|Create account/ });
  await expect(submit).toBeDisabled();

  // Email code: wrong code shows the remaining attempts, the right one locks the address.
  const local = uid('f');
  await page.getByLabel(/이메일 아이디|Email name/).fill(`${local}@gmail.com`);
  await expect(page.getByText(/이메일 인증을 완료해 주세요|Verify your email first/)).toBeVisible();
  await page.getByRole('button', { name: /^(인증번호 받기|Send code)$/ }).click();
  await expect(page.getByText(/남은 시간 \d+:\d{2}|Expires in \d+:\d{2}/)).toBeVisible();
  await expect(page.getByRole('button', { name: /초 후 다시 받기|Resend in/ })).toBeDisabled();
  const code = ((await page.getByTestId('dev-code').textContent()) ?? '').match(/\d{6}/)![0];
  await page.getByLabel(/^(인증번호|Verification code)$/).fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: /^(확인|Verify)$/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: /남은 시도 4회|4 tries left/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/signup-code-sent.png', fullPage: true });
  await page.getByLabel(/^(인증번호|Verification code)$/).fill(code);
  await page.getByLabel(/^(인증번호|Verification code)$/).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /인증 완료|Verified/ })).toBeVisible();
  await expect(page.getByLabel(/이메일 아이디|Email name/)).toBeDisabled();

  await page.getByLabel(/닉네임|Nickname/).fill(local);

  // Birth date: under 14 is refused on the spot.
  const birth = page.getByLabel(/^(생년월일|Date of birth)$/);
  const tenYearsAgo = `${new Date().getFullYear() - 10}-06-15`;
  await birth.fill(tenYearsAgo);
  await expect(page.getByText(/만 14세 미만은 가입할 수 없습니다|must be 14 or older/)).toBeVisible();
  await birth.fill('1990-01-01');
  await expect(page.getByText(/만 14세 미만은 가입할 수 없습니다|must be 14 or older/)).toHaveCount(0);

  // Password rules turn green one by one.
  const pw = page.getByLabel(/^(비밀번호|Password)$/);
  await pw.fill('abc');
  await expect(rule(page, /영문 소문자|Lowercase letter/)).toHaveClass(/text-success/);
  await expect(rule(page, /영문 대문자|Uppercase letter/)).toHaveClass(/text-ink-400/);
  await expect(rule(page, /8자 이상|8\+ characters/)).toContainText(/미충족|not met/);
  await pw.fill('abcDEF12');
  await expect(rule(page, /특수문자|Symbol/)).toHaveClass(/text-ink-400/);
  await expect(rule(page, /8자 이상|8\+ characters/)).toHaveClass(/text-success/);
  await page.screenshot({ path: 'test-results/signup-rules-partial.png', fullPage: true });
  await pw.fill(PASSWORD);
  for (const r of [/8자 이상|8\+ characters/, /영문 대문자|Uppercase/, /영문 소문자|Lowercase/, /^숫자|Number/, /특수문자|Symbol/]) {
    await expect(rule(page, r)).toHaveClass(/text-success/);
  }

  // Eye button shows and hides the value.
  await expect(pw).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: /비밀번호 보기|Show password/ }).first().click();
  await expect(pw).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: /비밀번호 숨기기|Hide password/ }).first().click();
  await expect(pw).toHaveAttribute('type', 'password');

  // Confirmation must match.
  const confirm = page.getByLabel(/^(비밀번호 확인|Confirm password)$/);
  await confirm.fill('Password123?');
  await expect(rule(page, /비밀번호 일치|Passwords match/)).toHaveClass(/text-ink-400/);
  await confirm.fill(PASSWORD);
  await expect(rule(page, /비밀번호 일치|Passwords match/)).toHaveClass(/text-success/);
  await expect(submit).toBeDisabled();

  // Consents: "agree to all" ticks both, unticking one clears it; the notice expands in place.
  const all = page.getByLabel(/전체 동의|Agree to all/);
  const age = page.getByLabel(/만 14세 이상입니다|I am 14 years of age/);
  const privacy = page.getByLabel(/개인정보 수집·이용에 동의합니다|I agree to the collection/);
  await all.check();
  await expect(age).toBeChecked();
  await expect(privacy).toBeChecked();
  await privacy.uncheck();
  await expect(all).not.toBeChecked();
  await expect(submit).toBeDisabled();
  const view = page.getByRole('button', { name: /^(보기|View)$/ });
  await view.click();
  await expect(page.getByRole('button', { name: /^(접기|Hide)$/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/생년월일/).first()).toBeVisible();
  await privacy.check();
  await expect(all).toBeChecked();
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: 'test-results/signup-ready.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/signup-ready-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

  await submit.click();
  await expect(page).toHaveURL(/\/$/);
});
