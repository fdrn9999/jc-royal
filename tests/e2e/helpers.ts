import { test as base, expect, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Closes the contexts a test opened with browser.newContext() (signUp, admin) when it ends. The worker keeps one
 * browser for the whole run, so contexts left open kept polling and holding sockets, and about twenty tests in
 * Chrome failed page loads with net::ERR_INSUFFICIENT_RESOURCES.
 */
export const test = base.extend<{ closeContexts: void }>({
  closeContexts: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts());      await use();
      await Promise.all(browser.contexts().filter((c) => !before.has(c)).map((c) => c.close()));
    },
    { auto: true },
  ],
});

/** Meets the password policy (letter, digit, symbol, 8+). */
export const PASSWORD = 'Password123!';

let n = 0;
export function uid(prefix: string) {
  n += 1;
  return `${prefix}${Date.now().toString(36).slice(-5)}${n}`;
}

/**
 * Whether the page is wider than the phone. A mobile browser widens its layout to fit wide content (and
 * window.innerWidth grows with it), so this compares with the device width the context was opened with.
 */
export async function widerThanDevice(page: Page) {
  const width = page.viewportSize()!.width;
  return page.evaluate((w) => document.documentElement.scrollWidth > w + 1, width);
}

/**
 * Signs up through the real UI and lands on the lobby. `ref` opens a referral link (/register?ref=…) instead, and
 * `beforeSubmit` looks at the filled form before it is sent.
 */
export async function signUp(browser: Browser, opts: { mobile?: boolean; ref?: string; beforeSubmit?: (page: Page) => Promise<void> } = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const nickname = uid('p');
  const email = `${nickname}@e2e.dev`;
  await page.goto(opts.ref ? `/register?ref=${encodeURIComponent(opts.ref)}` : '/register');
  // Split email field: local part + domain picker ("직접입력" for other domains).
  await page.getByLabel(/이메일 아이디|Email name/).fill(nickname);
  await page.getByLabel(/이메일 도메인|Email domain/).selectOption('__custom__');
  await page.getByLabel(/도메인 직접 입력|^Domain$/).fill('e2e.dev');
  // Email code step: outside production the API returns the code and the page shows it.
  await page.getByRole('button', { name: /^(인증번호 받기|Send code)$/ }).click();
  const code = ((await page.getByTestId('dev-code').textContent()) ?? '').match(/\d{6}/)?.[0];
  expect(code).toBeTruthy();
  await page.getByLabel(/^(인증번호|Verification code)$/).fill(code!);
  await page.getByRole('button', { name: /^(확인|Verify)$/ }).click();
  await expect(page.getByText(/^(인증 완료|Verified)$/)).toBeVisible();
  await page.getByLabel(/닉네임|Nickname/).fill(nickname);
  await page.getByLabel(/^(생년월일|Date of birth)$/).fill('1990-01-01');
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByLabel(/^(비밀번호 확인|Confirm password)$/).fill(PASSWORD);
  await page.getByLabel(/전체 동의|Agree to all/).check();
  await expect(page.getByText(/사용 가능한 닉네임|Nickname available/)).toBeVisible();
  await opts.beforeSubmit?.(page);
  await page.getByRole('button', { name: /회원가입|Create account/ }).click();
  await expect(page).toHaveURL(/\/$/);
  return { page, email, nickname };
}

/**
 * Clicks check or call when it is this page's turn. Returns true if it acted. The buttons stay disabled while this
 * page's last action waits for its answer: a click then would wait for them to come back, and once the answer passes
 * the turn on, they come back only after the other page acts — which the caller, waiting on this click, never gets to.
 */
export async function checkOrCall(page: Page): Promise<boolean> {
  const bar = page.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  const call = bar.getByRole('button', { name: /^(콜|Call)/ });
  const button = (await check.isVisible().catch(() => false)) ? check : (await call.isVisible().catch(() => false)) ? call : null;
  if (!button || !(await button.isEnabled().catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(250);
  return true;
}

/** Plays one hand check/call to showdown, then both players stand up before the next hand and get their chips back. */
export async function playOneHand(a: Page, b: Page) {
  await expect(async () => {
    (await checkOrCall(a)) || (await checkOrCall(b));
    await expect(a.getByText(/승리|Winner/).first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 60_000 });
  const before = await Promise.all([a, b].map((p) => balanceOf(p)));
  for (const p of [a, b]) await p.getByTestId('leave').click();
  for (const [i, p] of [a, b].entries()) await expect.poll(() => balanceOf(p), { timeout: 45_000 }).toBeGreaterThan(before[i]!);
}

/** Moves a range input the way a drag does (React only sees an input event from the native value setter). */
export async function setRange(range: Locator, value: number) {
  await range.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Opens the table's buy-in dialog and sits down with the given amount. */
export async function sitWith(page: Page, tableId: string, buyIn: number) {
  await page.goto(`/table/${tableId}?sit=1`);
  const confirm = page.getByTestId('buyin-confirm');
  await expect(confirm).toBeVisible();
  await setRange(page.getByRole('dialog').locator('input[type="range"]'), buyIn);
  await expect(confirm).toContainText(buyIn.toLocaleString('en-US'));
  await confirm.click();
  await expect(confirm).toHaveCount(0);
}

/** Wallet balance as reported by the server for this page's session. */
export async function balanceOf(page: Page): Promise<number> {
  return page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { balance: number }).balance);
}

/**
 * Sets synced settings of the account signed in on this page, as another device would (they are the account's, not the
 * device's); the page shows them once it reads the account's settings, on its next load at the latest.
 */
export async function setAccountPrefs(page: Page, prefs: Record<string, unknown>) {
  const status = await page.evaluate(async (p) => {
    const me = (await (await fetch('/api/auth/me')).json()) as { id: string };
    const s = (await (await fetch(`/api/me/settings?for=${me.id}`)).json()) as { epoch: number; rev: number };
    const body = { user: me.id, epoch: s.epoch, base: s.rev, prefs: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { v, ago: 0 }])) };
    const r = await fetch('/api/me/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.status;
  }, prefs);
  expect(status).toBe(200);
}
