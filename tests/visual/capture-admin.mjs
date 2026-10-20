// Visual grounding for the admin console (real Chrome).
// Usage: node tests/visual/capture-admin.mjs [apiBase] [adminBase] [bootstrapToken]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const api = process.argv[2] ?? 'http://localhost:8787';
const adminBase = process.argv[3] ?? 'http://localhost:5174';
const token = process.argv[4] ?? 'local-dev-bootstrap-token-change-me';
const out = 'tests/visual/out-admin';
mkdirSync(out, { recursive: true });
const stamp = Date.now().toString(36);
// Fixed owner account: bootstrap only succeeds once per database.
const email = 'owner@visual.dev';

const PASSWORD = 'Password123!';
const web = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
const post = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers: web, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

// player account to promote (email code is returned as devCode outside production)
const sent = await post('/api/auth/email-verification/request', { email });
let r;
if (sent.status === 200) {
  const proof = await post('/api/auth/email-verification/confirm', { email, code: sent.body.devCode });
  r = await post('/api/auth/register', { email, password: PASSWORD, nickname: 'owner', birthDate: '1990-01-01', agreements: { age14: true, privacy: true }, emailVerificationToken: proof.body?.verificationToken });
  console.log('register', r.status);
} else console.log('register skipped', sent.status, sent.body?.error?.code);
r = await fetch(`${api}/api/admin/auth/bootstrap`, { method: 'POST', headers: { Origin: adminBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, email }) });
r = await fetch(`${api}/api/admin/auth/bootstrap`, { method: 'POST', headers: { Origin: adminBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, email }) });
console.log('bootstrap', r.status, await r.text());

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(adminBase);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/01-login.png` });
await page.getByLabel(/이메일|Email/).fill(email);
await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
await page.getByRole('button', { name: /로그인|Log in/ }).click();
await page.getByTestId('dashboard').waitFor();
await page.screenshot({ path: `${out}/02-dashboard.png` });

await page.getByRole('link', { name: /테이블|Tables/ }).first().click();
await page.getByTestId('create-table').click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/03-create-table.png` });
await page.keyboard.press('Escape');

await page.getByRole('link', { name: /^회원$|^Users$/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/04-users.png` });
await page.getByRole('link', { name: /상세|Details/ }).first().click();
await page.waitForTimeout(600);
// chip adjustment → password re-confirmation modal
await page.getByLabel(/금액|Amount/).fill('250');
await page.getByLabel(/메모|Memo/).fill('visual check');
await page.getByRole('button', { name: /^확인$|^Confirm$/ }).first().click();
await page.getByTestId('reauth-confirm').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/05-reauth.png` });
await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
await page.getByTestId('reauth-confirm').click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/06-user-detail.png` });

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(adminBase);
await m.waitForTimeout(800);
await m.screenshot({ path: `${out}/07-dashboard-mobile.png` });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(JSON.stringify({ errors, mobileOverflow: overflow }));
await browser.close();
