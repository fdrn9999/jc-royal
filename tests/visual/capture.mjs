// Visual grounding: drives the real app in Chrome and saves screenshots for review.
// Usage: node tests/visual/capture.mjs [baseUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8787';
const out = process.argv[3] ?? 'tests/visual/out';
mkdirSync(out, { recursive: true });
const stamp = Date.now().toString(36);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];

async function newUser(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/register`);
  await page.getByLabel(/이메일|Email/).fill(`${name}-${stamp}@visual.dev`);
  await page.getByLabel(/닉네임|Nickname/).fill(`${name}${stamp.slice(-4)}`);
  await page.getByLabel(/비밀번호|Password/).fill('password123');
  await page.getByRole('button', { name: /회원가입|Create account/ }).click();
  await page.waitForURL(`${base}/`);
  return page;
}

const shots = [];
async function shot(page, name) {
  const file = `${out}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
}

// Auth screens (logged out)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/login`);
  await p.waitForTimeout(400);
  await shot(p, '01-login-mobile');
  await ctx.close();
}

const a = await newUser('alice', { width: 1440, height: 900 });
await a.waitForSelector('[data-testid=lobby-table]');
await a.waitForTimeout(300);
await shot(a, '02-lobby-desktop');

const b = await newUser('bob', { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
await b.waitForSelector('[data-testid=lobby-table]');
await shot(b, '03-lobby-mobile');

// Alice joins Royal Lounge via the lobby "Join" button → buy-in modal opens.
await a.goto(`${base}/table/dev-royal-6?sit=1`);
await a.getByTestId('buyin-confirm').click();
await a.waitForSelector('[data-testid=seat-0][data-state]');
await a.waitForTimeout(500);
await shot(a, '04-table-desktop-seated-waiting');
const boardBefore = await a.getByTestId('board').boundingBox();

await b.goto(`${base}/table/dev-royal-6`);
await b.waitForSelector('[data-testid=table]');
await b.locator('[data-testid^=sit-]').first().click();
await b.getByTestId('buyin-confirm').click();
// wait for hand to start
await a.waitForSelector('[data-testid=action-bar], [data-testid=board] [data-card]', { timeout: 15000 }).catch(() => {});
await a.waitForTimeout(1200);
const boardAfter = await a.getByTestId('board').boundingBox();
const boardShift = boardBefore && boardAfter ? { dx: boardAfter.x - boardBefore.x, dy: boardAfter.y - boardBefore.y } : null;
await shot(a, '05-table-desktop-preflop');
await b.waitForTimeout(300);
await shot(b, '06-table-mobile-preflop');

// Play: whoever has the action bar checks/calls until the board shows 3+ cards.
async function step(page) {
  const bar = page.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  const call = bar.getByRole('button', { name: /^(콜|Call)/ });
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) await check.click();
  else if (await call.isVisible().catch(() => false)) await call.click();
  else return false;
  await page.waitForTimeout(500);
  return true;
}
for (let i = 0; i < 12; i++) {
  const n = await a.locator('[data-testid=board] [data-card]').count();
  if (n >= 3) break;
  (await step(a)) || (await step(b));
  await a.waitForTimeout(400);
}
await a.waitForTimeout(800);
await shot(a, '07-table-desktop-flop');
await shot(b, '08-table-mobile-flop');

// Raise panel open on whichever player acts
for (const p of [a, b]) {
  const bar = p.getByTestId('action-bar');
  if (await bar.isVisible().catch(() => false)) {
    const r = bar.getByRole('button', { name: /^(레이즈|벳|Raise|Bet)$/ });
    if (await r.isVisible().catch(() => false)) {
      await r.click();
      await p.waitForTimeout(300);
      await shot(p, p === a ? '09-raise-panel-desktop' : '09-raise-panel-mobile');
    }
  }
}

// Finish hand by check/call to showdown
for (let i = 0; i < 20; i++) {
  if (!((await step(a)) || (await step(b)))) await a.waitForTimeout(500);
  if (await a.getByText(/승리|Winner/).first().isVisible().catch(() => false)) break;
}
await a.waitForTimeout(900);
await shot(a, '10-table-desktop-result');
await shot(b, '11-table-mobile-result');

// Tablet portrait + theme
const tabletCtx = await browser.newContext({ viewport: { width: 768, height: 1024 }, storageState: await a.context().storageState() });
const t = await tabletCtx.newPage();
await t.goto(`${base}/table/dev-royal-6`);
await t.waitForSelector('[data-testid=table]');
await t.waitForTimeout(1000);
await shot(t, '12-table-tablet');
for (const theme of ['emerald', 'crimson', 'sapphire']) {
  await t.evaluate((th) => {
    localStorage.setItem('jc.prefs', JSON.stringify({ theme: th, fourColor: false }));
    document.documentElement.dataset.theme = th;
  }, theme);
  await t.waitForTimeout(200);
  await shot(t, `13-theme-${theme}`);
}

// My page
await a.goto(`${base}/me`);
await a.waitForTimeout(1200);
await shot(a, '14-mypage-desktop');
await b.goto(`${base}/me`);
await b.waitForTimeout(1200);
await shot(b, '15-mypage-mobile');

// overflow check on mobile
const overflow = await b.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(JSON.stringify({ shots: shots.length, errors, mobileHorizontalOverflow: overflow, boardShift }, null, 1));
await browser.close();
