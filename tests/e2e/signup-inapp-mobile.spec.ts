import { devices, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { PASSWORD, test, uid } from './helpers';

/**
 * Sign-up in in-app browsers (KakaoTalk, Instagram), emulated: Chromium with the apps' Android WebView user agents on a
 * Pixel 7. This is not the real apps; it covers the mechanisms that kept the button off there (values that reach a
 * field without the events React listens to, late or failed checks, a page reloaded on the way back from Mail).
 */
const UA = {
  kakao: 'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36;KAKAOTALK 2410830',
  instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 350.0.0.42.89 Android (34/14; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; ko_KR; 641123490)',
};
test.use({ userAgent: UA.kakao, locale: 'ko-KR' });

const field = {
  local: (p: Page) => p.getByLabel('이메일 아이디'),
  nickname: (p: Page) => p.getByLabel('닉네임', { exact: true }),
  birth: (p: Page) => p.getByLabel('생년월일', { exact: true }),
  password: (p: Page) => p.getByLabel('비밀번호', { exact: true }),
  confirm: (p: Page) => p.getByLabel('비밀번호 확인', { exact: true }),
  all: (p: Page) => p.getByLabel('전체 동의'),
  privacy: (p: Page) => p.getByLabel(/개인정보 수집·이용에 동의합니다/),
};
const submit = (p: Page) => p.getByTestId('signup-submit');
const why = (p: Page) => p.getByTestId('signup-why');
const verified = (p: Page) => p.getByText('인증 완료', { exact: true });

async function sendCode(page: Page, local: string) {
  await field.local(page).fill(local);
  await page.getByLabel('이메일 도메인').selectOption('__custom__');
  await page.getByLabel('도메인 직접 입력').fill('e2e.dev');
  await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
  return ((await page.getByTestId('dev-code').textContent()) ?? '').match(/\d{6}/)![0];
}

async function enterCode(page: Page, code: string) {
  await page.getByLabel('인증번호', { exact: true }).fill(code);
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(verified(page)).toBeVisible();
}

/**
 * Puts a value in a field the way autofill, a password manager or a date picker in a WebView may: through the native
 * setter (React's value tracker never hears of it) with only `change`, only `blur`, or no event at all.
 */
async function inject(locator: Locator, value: string, how: 'none' | 'change' | 'blur') {
  await locator.evaluate(
    (el, [v, how]) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
      if (how === 'change') el.dispatchEvent(new Event('change', { bubbles: true }));
      if (how === 'blur') {
        el.dispatchEvent(new FocusEvent('blur'));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      }
    },
    [value, how] as const,
  );
}

async function fillRest(page: Page, nickname: string) {
  await field.nickname(page).fill(nickname);
  await field.birth(page).fill('1990-01-01');
  await field.password(page).fill(PASSWORD);
  await field.confirm(page).fill(PASSWORD);
  await field.all(page).check();
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();
}

function countRegisters(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/register') seen.n++;
  });
  return seen;
}

/** A member made through the API, for a nickname that is already taken. */
async function existingMember(request: APIRequestContext) {
  const nickname = uid('dup');
  const email = `${nickname}@e2e.dev`;
  const headers = { Origin: 'http://127.0.0.1:8798' };
  const sent = await (await request.post('/api/auth/email-verification/request', { headers, data: { email, locale: 'ko' } })).json();
  const proof = await (await request.post('/api/auth/email-verification/confirm', { headers, data: { email, code: sent.devCode } })).json();
  const r = await request.post('/api/auth/register', {
    headers,
    data: { email, password: PASSWORD, nickname, birthDate: '1990-01-01', locale: 'ko', agreements: { age14: true, privacy: true }, emailVerificationToken: proof.verificationToken },
  });
  expect(r.ok(), `${r.status()} ${await r.text()}`).toBe(true);
  return nickname;
}

test('in-app: the button follows each step, edits after verification keep it, a double tap signs up once', async ({ page }) => {
  const registers = countRegisters(page);
  await page.goto('/register');
  await expect(submit(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(why(page)).toHaveText('이메일을 입력해 주세요.');
  // Nothing about the in-app browser until it has trouble.
  await expect(page.getByTestId('signup-inapp')).toHaveCount(0);

  const local = uid('ia');
  await enterCode(page, await sendCode(page, local));
  await expect(why(page)).toHaveText(/닉네임을 확인해 주세요/);
  await fillRest(page, local);
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');
  await expect(why(page)).toHaveText('');
  await page.screenshot({ path: 'test-results/signup-inapp-ready.png', fullPage: true });

  // Other fields edited after the code step: the verification stays, the button comes back once they hold again.
  const other = uid('ib');
  await field.nickname(page).fill(other);
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();
  await field.password(page).fill('Another1!');
  await expect(why(page)).toHaveText('비밀번호가 일치하지 않습니다.');
  await field.confirm(page).fill('Another1!');
  await expect(verified(page)).toBeVisible();
  await expect(field.local(page)).toBeDisabled();
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');

  // Two taps before React draws the busy state: one request.
  await submit(page).evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(500);
  expect(registers.n).toBe(1);
});

test('in-app: autofill, password managers and date pickers that skip React events still count', async ({ page }) => {
  await page.goto('/register');
  const local = uid('af');
  await enterCode(page, await sendCode(page, local));
  // Each value arrives without the input event React needs.
  await inject(field.nickname(page), local, 'none');
  await inject(field.birth(page), '1990-01-01', 'blur');
  await inject(field.password(page), PASSWORD, 'none');
  await inject(field.confirm(page), PASSWORD, 'change');
  await field.all(page).check();
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');
  // The password rules show the autofilled value as met.
  await expect(page.locator('li', { hasText: /8자 이상/ })).toHaveClass(/text-success/);
  await submit(page).click();
  await expect(page).toHaveURL(/\/$/);
});

test('in-app: a blocked tap says why, moves to the field and offers the default browser', async ({ page, request }) => {
  const registers = countRegisters(page);
  await page.goto('/register');
  const local = uid('bl');
  // Everything but the email code.
  await field.local(page).fill(local);
  await page.getByLabel('이메일 도메인').selectOption('__custom__');
  await page.getByLabel('도메인 직접 입력').fill('e2e.dev');
  await fillRest(page, local);
  await expect(why(page)).toHaveText('이메일 인증을 완료해 주세요.');
  await expect(why(page)).toHaveClass(/text-ink-400/);
  await submit(page).click({ force: true });
  await expect(why(page)).toHaveClass(/text-\[#f3b0b2\]/);
  await expect(page.getByRole('button', { name: '인증번호 받기', exact: true })).toBeFocused();
  const help = page.getByTestId('signup-inapp');
  await expect(help).toBeVisible();
  await expect(help.getByTestId('signup-inapp-open')).toBeVisible(); // KakaoTalk has a way out
  await expect(help.getByTestId('signup-inapp-copy')).toBeVisible();
  await page.screenshot({ path: 'test-results/signup-inapp-blocked.png', fullPage: true });
  expect(registers.n).toBe(0);

  await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
  await enterCode(page, ((await page.getByTestId('dev-code').textContent()) ?? '').match(/\d{6}/)![0]);
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');

  // Each missing condition is named, one at a time.
  await field.confirm(page).fill('Password123?');
  await expect(why(page)).toHaveText('비밀번호가 일치하지 않습니다.');
  await field.confirm(page).fill(PASSWORD);
  await field.birth(page).fill(`${new Date().getFullYear() - 10}-06-15`);
  await expect(why(page)).toHaveText('만 14세 이상만 가입할 수 있습니다.');
  await expect(page.getByText('만 14세 미만은 가입할 수 없습니다.')).toBeVisible();
  await field.birth(page).fill('1990-01-01');
  await field.privacy(page).uncheck();
  await expect(why(page)).toHaveText('필수 약관에 동의해 주세요.');
  await field.privacy(page).check();
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');

  // A nickname someone already has.
  await field.nickname(page).fill(await existingMember(request));
  await expect(why(page)).toHaveText('사용할 수 없는 닉네임입니다.');
  await expect(page.getByText('이미 사용 중인 닉네임입니다.')).toBeVisible();
  await expect(submit(page)).toHaveAttribute('aria-disabled', 'true');
  await submit(page).click({ force: true });
  await expect(field.nickname(page)).toBeFocused();
  expect(registers.n).toBe(0);
});

test('in-app: a late nickname answer never wins, a failed check blocks with a retry, an unread policy is retried', async ({ page }) => {
  const base = uid('rc').slice(0, 12);
  // The earlier spelling answers last, and says "taken".
  await page.route('**/api/auth/nickname-available**', async (route) => {
    const nick = new URL(route.request().url()).searchParams.get('nickname');
    if (nick === base) {
      await new Promise((r) => setTimeout(r, 2500));
      return route.fulfill({ json: { available: false } });
    }
    return route.continue();
  });
  await page.goto('/register');
  await field.nickname(page).fill(base);
  await page.waitForTimeout(500); // the check for `base` has gone out
  await field.nickname(page).fill(`${base}z`);
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();
  await page.waitForTimeout(2600); // the late answer arrives
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();
  await expect(page.getByText('이미 사용 중인 닉네임입니다.')).toHaveCount(0);

  // No answer is not a yes.
  await page.unroute('**/api/auth/nickname-available**');
  await page.route('**/api/auth/nickname-available**', (route) => route.abort());
  await field.nickname(page).fill(`${base}y`);
  await expect(page.getByText('닉네임을 확인하지 못했습니다.')).toBeVisible();
  await expect(why(page)).toHaveText(/닉네임 중복 확인에 실패했습니다|이메일/);
  await page.unroute('**/api/auth/nickname-available**');
  await page.getByTestId('signup-nick-retry').click();
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();

  // Sign-up settings that could not be read: the email step waits for them, it is never skipped.
  const other = await page.context().newPage();
  await other.route('**/api/auth/signup-options', (route) => route.abort());
  await other.goto('/register');
  const retry = other.getByTestId('signup-policy-retry');
  await expect(retry).toBeVisible();
  await expect(other.getByText('가입 설정을 불러오지 못했습니다.', { exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: '인증번호 받기', exact: true })).toHaveCount(0);
  await expect(submit(other)).toHaveAttribute('aria-disabled', 'true');
  await expect(why(other)).toHaveText('가입 설정을 불러오지 못했습니다. 다시 시도해 주세요.');
  await expect(other.getByTestId('signup-inapp')).toBeVisible();
  await other.screenshot({ path: 'test-results/signup-inapp-policy-failed.png', fullPage: true });
  await other.unroute('**/api/auth/signup-options');
  await retry.click();
  await expect(other.getByRole('button', { name: '인증번호 받기', exact: true })).toBeVisible();
});

test('in-app: leaving for Mail and coming back, or a reload, keeps the email step', async ({ page }) => {
  await page.goto('/register');
  const local = uid('rl');
  const code = await sendCode(page, local);
  await field.nickname(page).fill(local);
  await field.birth(page).fill('1990-01-01');
  await expect(page.getByText('사용 가능한 닉네임입니다.')).toBeVisible();

  // The WebView reloads the page on the way back: the code box, the address and what was typed come back.
  await page.reload();
  await expect(page.getByLabel('인증번호', { exact: true })).toBeVisible();
  await expect(page.getByText(`${local}@e2e.dev(으)로 6자리 인증번호를 보냈습니다.`)).toBeVisible();
  await expect(field.nickname(page)).toHaveValue(local);
  await expect(field.birth(page)).toHaveValue('1990-01-01');
  await enterCode(page, code);

  // Switching apps without a reload.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForTimeout(1500);
  await expect(verified(page)).toBeVisible();

  // A reload after the code step: still verified; the password is never kept, so that is what it asks for.
  await page.reload();
  await expect(verified(page)).toBeVisible();
  await expect(field.password(page)).toHaveValue('');
  await expect(why(page)).toHaveText('비밀번호 조건을 충족해 주세요.');
  await expect(submit(page)).toHaveAttribute('aria-disabled', 'true');
  await field.password(page).fill(PASSWORD);
  await field.confirm(page).fill(PASSWORD);
  await field.all(page).check();
  await expect(submit(page)).not.toHaveAttribute('aria-disabled');
  await submit(page).click();
  await expect(page).toHaveURL(/\/$/);
});

test('in-app: storage lost with a code already sent goes to the code box instead of "wait a minute"', async ({ page }) => {
  await page.goto('/register');
  const local = uid('ls');
  const code = await sendCode(page, local);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByLabel('인증번호', { exact: true })).toHaveCount(0);
  await page.getByLabel('이메일 도메인').selectOption('__custom__');
  await field.local(page).fill(local);
  await page.getByLabel('도메인 직접 입력').fill('e2e.dev');
  await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
  await expect(page.getByLabel('인증번호', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await enterCode(page, code);
});

test('in-app help: Instagram gets its own guidance, a regular browser gets none', async ({ browser }) => {
  for (const [name, userAgent] of [['instagram', UA.instagram], ['chrome', devices['Pixel 7'].userAgent]] as const) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], userAgent, locale: 'ko-KR' });
    const page = await ctx.newPage();
    await page.goto('/register');
    await expect(why(page)).toHaveText('이메일을 입력해 주세요.');
    await submit(page).click({ force: true });
    await expect(why(page)).toHaveClass(/text-\[#f3b0b2\]/);
    if (name === 'instagram') {
      await expect(page.getByTestId('signup-inapp')).toBeVisible();
      await expect(page.getByText(/외부 브라우저에서 열기/)).toBeVisible();
      await expect(page.getByTestId('signup-inapp-open')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/signup-inapp-instagram.png', fullPage: true });
    } else {
      await expect(page.getByTestId('signup-inapp')).toHaveCount(0);
    }
    await ctx.close();
  }
});
