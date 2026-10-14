// Visual grounding for the Academy: drives the real app and saves screenshots.
// Usage: node tests/visual/capture-academy.mjs [baseUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = process.argv[3] ?? 'tests/visual/out-academy';
mkdirSync(out, { recursive: true });
const stamp = Date.now().toString(36);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];

async function user(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/register`);
  await page.getByLabel(/이메일 아이디|Email name/).fill(`${name}${stamp}`);
  await page.getByLabel(/이메일 도메인|Email domain/).selectOption('__custom__');
  await page.getByLabel(/도메인 직접 입력|^Domain$/).fill('visual.dev');
  await page.getByLabel(/닉네임|Nickname/).fill(`${name}${stamp.slice(-4)}`);
  await page.getByLabel(/비밀번호|Password/).fill('password123');
  await page.getByRole('button', { name: /회원가입|Create account/ }).click();
  await page.waitForURL(`${base}/`);
  return page;
}
const shot = async (page, name, full = false) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const report = [];

for (const [tag, vp, opts] of [
  ['m', { width: 375, height: 667 }, { isMobile: true, hasTouch: true }],
  ['d', { width: 1366, height: 860 }, {}],
]) {
  const p = await user(`ac${tag}`, vp, opts);
  await shot(p, `${tag}-00-lobby`);
  await p.goto(`${base}/academy`);
  await shot(p, `${tag}-01-academy`, true);
  for (const [lesson, steps] of [['cards', 4], ['hands', 5], ['holdem', 5], ['actions', 4]]) {
    for (let s = 0; s < steps; s++) {
      await p.goto(`${base}/academy/${lesson}?step=${s}`);
      await shot(p, `${tag}-${lesson}-${s}`, true);
      if (await overflow(p)) report.push(`overflow ${tag} ${lesson} step ${s}`);
    }
  }
  // Follow-ups: a wrong compare answer, review, progress, badges on My Page, free practice.
  await p.goto(`${base}/academy/hands?step=3`);
  await p.locator('[data-testid=quiz] [data-choice=a]').click();
  await shot(p, `${tag}-compare-wrong`, true);
  for (const [path, name] of [['/academy/review', 'review'], ['/academy/progress', 'progress'], ['/me', 'me']]) {
    await p.goto(`${base}${path}`);
    await shot(p, `${tag}-${name}`, true);
    if (await overflow(p)) report.push(`overflow ${tag} ${name}`);
  }
  await p.goto(`${base}/academy/practice/free`);
  await shot(p, `${tag}-free-setup`);
  await p.getByTestId('free-start').click();
  await p.waitForTimeout(2500);
  await shot(p, `${tag}-free-table`);
  if (await overflow(p)) report.push(`overflow ${tag} free`);
  for (const id of ['C', 'G']) {
    await p.goto(`${base}/academy/practice/${id}`);
    await p.waitForTimeout(1500);
    await shot(p, `${tag}-practice-${id}-start`);
    if (await overflow(p)) report.push(`overflow ${tag} practice ${id}`);
  }
  await p.context().close();
}
console.log(JSON.stringify({ report, errors }, null, 2));
await browser.close();
