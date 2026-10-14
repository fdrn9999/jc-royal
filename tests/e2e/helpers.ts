import { expect, type Browser, type Page } from '@playwright/test';

let n = 0;
export function uid(prefix: string) {
  n += 1;
  return `${prefix}${Date.now().toString(36).slice(-5)}${n}`;
}

/** Signs up through the real UI and lands on the lobby. */
export async function signUp(browser: Browser, opts: { mobile?: boolean } = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const nickname = uid('p');
  const email = `${nickname}@e2e.dev`;
  await page.goto('/register');
  // Split email field: local part + domain picker ("직접입력" for other domains).
  await page.getByLabel(/이메일 아이디|Email name/).fill(nickname);
  await page.getByLabel(/이메일 도메인|Email domain/).selectOption('__custom__');
  await page.getByLabel(/도메인 직접 입력|^Domain$/).fill('e2e.dev');
  await page.getByLabel(/닉네임|Nickname/).fill(nickname);
  await page.getByLabel(/비밀번호|Password/).fill('password123');
  await expect(page.getByText(/사용 가능한 닉네임|Nickname available/)).toBeVisible();
  await page.getByRole('button', { name: /회원가입|Create account/ }).click();
  await expect(page).toHaveURL(/\/$/);
  return { page, email, nickname };
}

/** Clicks check or call when it is this page's turn. Returns true if it acted. */
export async function checkOrCall(page: Page): Promise<boolean> {
  const bar = page.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  const call = bar.getByRole('button', { name: /^(콜|Call)/ });
  if (await check.isVisible().catch(() => false)) await check.click();
  else if (await call.isVisible().catch(() => false)) await call.click();
  else return false;
  await page.waitForTimeout(250);
  return true;
}

/** Wallet balance as reported by the server for this page's session. */
export async function balanceOf(page: Page): Promise<number> {
  return page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { balance: number }).balance);
}
