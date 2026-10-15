// Visual grounding for the admin console's languages (real Chrome), against the E2E server (tests/e2e/server.mjs on
// 8798) and the built admin console (vite preview on 5174, JC_API_ORIGIN=http://127.0.0.1:8798). Every page is opened
// in Korean and English at 1440 and 390 px; it prints the Latin words left on the Korean pages (outside the small
// monospace codes), the Hangul left on the English pages, and the horizontal overflow.
// Usage: node tests/visual/capture-admin-i18n.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const api = 'http://127.0.0.1:8798';
const admin = 'http://localhost:5174';
const web = 'http://localhost:5173';
const out = process.env.OUT_DIR ?? 'tests/visual/out-admin-i18n';
mkdirSync(out, { recursive: true });
const PASSWORD = 'Password123!';
const stamp = Date.now().toString(36);

async function call(path, body, { origin = web, cookie } = {}) {
  const res = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json().catch(() => null), cookie: set };
}

async function member(name) {
  const email = `${name}-${stamp}@visual.dev`;
  const sent = await call('/api/auth/email-verification/request', { email });
  const proof = await call('/api/auth/email-verification/confirm', { email, code: sent.body.devCode });
  const r = await call('/api/auth/register', { email, password: PASSWORD, nickname: `${name}${stamp}`.slice(0, 14), birthDate: '1990-01-01', agreements: { age14: true, privacy: true }, emailVerificationToken: proof.body.verificationToken });
  if (r.status !== 201) throw new Error(`register ${r.status} ${JSON.stringify(r.body)}`);
  return { email, cookie: r.cookie, id: r.body.id, nickname: `${name}${stamp}`.slice(0, 14) };
}

function socket(cookie, tableId) {
  const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/tables/${tableId}`, { headers: { Cookie: cookie, Origin: web } });
  return new Promise((ok, fail) => {
    ws.addEventListener('message', () => ok(ws), { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
}

function sql(command) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--json', '--command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

// Owner (super admin), two seated players, a report, Academy statistics and a reconciliation row, so the pages
// show the badges, tables and codes this check is about.
const owner = await member('owner');
const boot = (await call('/api/admin/auth/bootstrap', { token: 'e2e-bootstrap-token-0123456789', email: owner.email }, { origin: admin })).status;
if (boot === 409) sql(`UPDATE users SET role = 'super_admin' WHERE id = '${owner.id}'`);
const players = await Promise.all(['ann', 'bob'].map((n) => member(n)));
const sockets = [];
for (const [i, p] of players.entries()) {
  const ws = await socket(p.cookie, 'e2e-six');
  const answered = new Promise((ok) => ws.addEventListener('message', (m) => { const x = JSON.parse(String(m.data)); if (x.t === 'ack' || x.t === 'error') ok(x); }));
  ws.send(JSON.stringify({ t: 'sit', seatIndex: i, buyIn: 300, reqId: `sit-${stamp}-${i}` }));
  await answered;
  sockets.push(ws);
}
const post = await call('/api/board/posts', { title: `visual report ${stamp}`, body: 'spam body' }, { cookie: players[0].cookie });
await call('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'spam', detail: 'visual' }, { cookie: players[1].cookie });
const events = [
  { kind: 'lesson', id: 'cards', phase: 'start' },
  { kind: 'lesson', id: 'cards', phase: 'complete' },
  { kind: 'scenario', id: 'E', phase: 'start' },
  { kind: 'question', id: 'c-heart', correct: false },
  { kind: 'question', id: 'h-kicker', correct: false },
  { kind: 'question', id: 'r-pos-3', correct: false },
  { kind: 'question', id: 'practice:E:1', correct: true },
  { kind: 'question', id: 'review:split', correct: false },
];
console.log('academy events', (await call('/api/academy/events', { events }, { cookie: players[0].cookie })).status);
sql(`INSERT INTO reconciliation_events (id, scope, subject_id, expected, actual, created_at) VALUES ('vis-i18n-${stamp}', 'user_ledger', '${players[0].id}', 1000, 990, ${Date.now() - 3_600_000})`);
// A wallet changed outside the ledger, for the reconciliation evidence and its correction form.
sql(`UPDATE users SET balance = balance + 250 WHERE id = '${players[1].id}'`);
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(admin);
await page.getByLabel(/이메일|Email/).fill(owner.email);
await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
await page.getByRole('button', { name: /로그인|Log in/ }).click();
await page.getByTestId('dashboard').waitFor();

await page.goto(`${admin}/hands`);
await page.waitForTimeout(900);
const handHref = await page.locator('main a[href^="/hands/"]').first().getAttribute('href', { timeout: 3000 }).catch(() => null);
const handId = handHref ? decodeURIComponent(handHref.slice('/hands/'.length)) : null;
const routes = ['/', '/users', `/users/${players[0].id}`, '/tables', '/tables/e2e-six', '/hands', ...(handHref ? [handHref] : []), '/ledger', '/economy', '/reconcile', '/audit', '/academy', '/reports', '/board', '/messages'];

// Dynamic values (nicknames, e-mails, ids, the brand) are not UI words.
const ignore = new RegExp(`${stamp}|@visual\\.dev|^JC$|^ROYAL$|^ADMIN$|^EN$|^e2e|^E2E`, 'i');
const result = {};
for (const lang of ['ko', 'en']) {
  await page.getByRole('button', { name: lang === 'ko' ? '한국어' : 'EN' }).click().catch(() => {});
  for (const route of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(admin + route);
    await page.waitForTimeout(900);
    if (await page.getByTestId('reauth-confirm').isVisible().catch(() => false)) {
      await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
      await page.getByTestId('reauth-confirm').click();
      await page.waitForTimeout(900);
    }
    if (route === '/reconcile') {
      await page.getByTestId('run-reconcile').click();
      await page.getByTestId('rec-row').filter({ hasText: players[1].id }).getByTestId('rec-evidence-toggle').click();
      await page.getByTestId('rec-evidence').waitFor();
      await page.waitForTimeout(600);
    }
    const name = `${lang}-${route.replace(/\//g, '_').replace(/[^a-z0-9_-]/gi, '') || '_'}`;
    await page.screenshot({ path: `${out}/${name}-1440.png`, fullPage: true });
    const words = await page.evaluate((isKo) => {
      const found = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || el.closest('.font-mono, script, style, [aria-hidden="true"]')) continue;
        const text = n.textContent ?? '';
        for (const w of text.match(isKo ? /[A-Za-z][A-Za-z_.:-]+/g : /[가-힣]+/g) ?? []) found.add(w);
      }
      for (const el of document.querySelectorAll('input[placeholder], [aria-label], [title]')) {
        if (el.closest('.font-mono')) continue;
        for (const a of ['placeholder', 'aria-label']) for (const w of (el.getAttribute(a) ?? '').match(isKo ? /[A-Za-z][A-Za-z_.:-]+/g : /[가-힣]+/g) ?? []) found.add(`${a}:${w}`);
      }
      return [...found];
    }, lang === 'ko');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (lang === 'ko' || route === '/' || route.startsWith('/hands/')) await page.screenshot({ path: `${out}/${name}-390.png`, fullPage: true });
    result[`${lang} ${route}`] = { leftover: words.filter((w) => !ignore.test(w.replace(/^(placeholder|aria-label):/, '')) && !(lang === 'en' && w === '한국어')), overflow: [wide, narrow] };
  }
}
for (const ws of sockets) ws.close();
console.log(JSON.stringify({ errors, handId: handId ?? null, result }, null, 1));
await browser.close();
