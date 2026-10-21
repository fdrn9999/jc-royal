// What the table measurements share: a player signed up on the E2E server, sat at a bot table, acting on their turns.
import { chromium } from '@playwright/test';

export const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : (process.argv[i + 1] ?? dflt);
};
export const flag = (name) => process.argv.includes(`--${name}`);
export const base = arg('base', 'http://127.0.0.1:8798');
export const SEATS = { 'e2e-nine': 9, 'e2e-phones': 6, 'e2e-sound': 2 };
export const PROFILES = {
  // A mid-range phone: the main thread four times slower than this PC (Chrome's CPU throttling).
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpu: 4 },
  // A low-end phone: six times slower, an SE-sized screen.
  slowphone: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, cpu: 6 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpu: 1 },
};
const PASSWORD = 'Password123!';

export const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });

export async function signUp() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const nickname = `perf${Date.now().toString(36).slice(-6)}`;
  await page.goto(`${base}/register`);
  await page.getByLabel(/이메일 아이디|Email name/).fill(nickname);
  await page.getByLabel(/이메일 도메인|Email domain/).selectOption('__custom__');
  await page.getByLabel(/도메인 직접 입력|^Domain$/).fill('e2e.dev');
  await page.getByRole('button', { name: /^(인증번호 받기|Send code)$/ }).click();
  const code = ((await page.getByTestId('dev-code').textContent()) ?? '').match(/\d{6}/)[0];
  await page.getByLabel(/^(인증번호|Verification code)$/).fill(code);
  await page.getByRole('button', { name: /^(확인|Verify)$/ }).click();
  await page.getByText(/^(인증 완료|Verified)$/).waitFor();
  await page.getByLabel(/닉네임|Nickname/).fill(nickname);
  await page.getByLabel(/^(생년월일|Date of birth)$/).fill('1990-01-01');
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByLabel(/^(비밀번호 확인|Confirm password)$/).fill(PASSWORD);
  await page.getByLabel(/전체 동의|Agree to all/).check();
  await page.getByText(/사용 가능한 닉네임|Nickname available/).waitFor();
  await page.getByRole('button', { name: /회원가입|Create account/ }).click();
  await page.waitForURL(`${base}/`);
  return page;
}

/**
 * Stands up the measuring players an interrupted run left at the table (perf… members of this E2E server, who keep
 * the seat a run needs), signing in as each.
 */
async function freeSeats(page, id) {
  const names = await page.locator('[data-testid=table] [data-testid^="seat-"]:not(:has([data-testid=bot-badge])) [data-testid=member-name]').allTextContents();
  const left = [...new Set(names.flatMap((n) => n.match(/perf[a-z0-9]{6}/) ?? []))];
  for (const nickname of left) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${base}/login`);
    await p.getByLabel(/^(이메일|Email)$/).fill(`${nickname}@e2e.dev`);
    await p.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
    await p.locator('form').getByRole('button', { name: /로그인|Log in|Sign in/ }).click();
    await p.waitForURL((u) => !u.pathname.startsWith('/login'));
    await leave(p, id);
    await ctx.close();
  }
  return left.length;
}

export async function sit(page, id) {
  await page.goto(`${base}/table/${id}?sit=1`);
  const confirm = page.getByTestId('buyin-confirm');
  const offered = await confirm.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!offered) {
    if (!(await freeSeats(page, id))) throw new Error(`no seat to take at ${id}`);
    // A player standing up mid-hand keeps the seat until the hand ends.
    for (let i = 0; ; i++) {
      await page.goto(`${base}/table/${id}?sit=1`);
      if (await confirm.waitFor({ timeout: 5_000 }).then(() => true, () => false)) break;
      if (i === 12) throw new Error(`no seat came free at ${id}`);
    }
  }
  await page.getByRole('dialog').locator('input[type="range"]').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await confirm.click();
  await confirm.waitFor({ state: 'detached' });
}

/** Stands up from the table, so the next table's seat is the only one. */
export async function leave(page, id) {
  await page.goto(`${base}/table/${id}`);
  await page.getByTestId('leave').click().catch(() => {});
  // Mid-hand, standing up folds the hand and the button asks first.
  await page.getByTestId('leave-fold').click({ timeout: 1_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  await page.goto(`${base}/`);
}

/** Checks, else folds. Returns whether it acted. */
export async function act(p) {
  const bar = p.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  for (const name of [/^(체크|Check)$/, /^(폴드|Fold)$/]) {
    const b = bar.getByRole('button', { name });
    if (await b.isVisible().catch(() => false)) {
      await b.click({ timeout: 2_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

export async function seatsShown(p, n) {
  const seats = p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  for (let i = 0; i < 180; i++) {
    if ((await seats.count()) === n) return;
    await p.waitForTimeout(500);
  }
  throw new Error(`expected ${n} seats`);
}

/** A page of the signed-in player at the table, in a profile's emulation, with its CPU slowed as the profile says. */
export async function openTable(state, id, name, init) {
  const pr = PROFILES[name];
  const ctx = await browser.newContext({ storageState: state, viewport: pr.viewport, deviceScaleFactor: pr.deviceScaleFactor, isMobile: pr.isMobile, hasTouch: pr.hasTouch });
  if (init) await ctx.addInitScript({ path: init });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  await p.goto(`${base}/table/${id}`);
  await seatsShown(p, SEATS[id]);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: pr.cpu });
  return { ctx, p, cdp, errors, pr };
}

export const r1 = (x) => Math.round(x * 10) / 10;

/**
 * The signed-in player's own page waits here while a table is measured: a browser trace records every page the browser
 * draws (a lobby left open in another context once made most of a table's "paint"), and pages of one site can share a
 * renderer, so only the measured page may draw.
 */
export const IDLE = 'about:blank';
