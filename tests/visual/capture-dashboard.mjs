// Visual grounding for the admin live dashboard (real Chrome), against the E2E server (tests/e2e/server.mjs on 8798)
// and the built admin console (vite preview on 5174, JC_API_ORIGIN=http://127.0.0.1:8798).
// Usage: PW_CHANNEL=chrome node tests/visual/capture-dashboard.mjs (OUT_DIR to change where the screenshots go)
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const api = 'http://127.0.0.1:8798';
const admin = 'http://localhost:5174';
const web = 'http://localhost:5173';
const out = process.env.OUT_DIR ?? 'tests/visual/out-dashboard';
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
  return { email, cookie: r.cookie, id: r.body.id };
}

function socket(cookie, tableId) {
  const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/tables/${tableId}`, { headers: { Cookie: cookie, Origin: web } });
  const opened = new Promise((ok, fail) => {
    ws.addEventListener('message', () => ok(ws), { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  return opened;
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

// Owner (admin) and some table activity: three players seated at the six-max table, one spectator.
const owner = await member('owner');
const boot = (await call('/api/admin/auth/bootstrap', { token: 'e2e-bootstrap-token-0123456789', email: owner.email }, { origin: admin })).status;
console.log('bootstrap', boot);
// A second run against the same state: the first owner exists already, so promote this one directly.
if (boot === 409) sql(`UPDATE users SET role = 'super_admin' WHERE nickname = '${`owner${stamp}`.slice(0, 14)}'`);
const players = await Promise.all(['ann', 'bob', 'cy'].map((n) => member(n)));
const sockets = [];
for (const [i, p] of players.entries()) {
  const ws = await socket(p.cookie, 'e2e-six');
  const answered = new Promise((ok) => ws.addEventListener('message', (m) => { const x = JSON.parse(String(m.data)); if (x.t === 'ack' || x.t === 'error') ok(x); }));
  ws.send(JSON.stringify({ t: 'sit', seatIndex: i, buyIn: 300, reqId: `sit-${stamp}-${i}` }));
  console.log('sit', i, JSON.stringify(await answered).slice(0, 160));
  sockets.push(ws);
}
const watcher = await member('dee');
sockets.push(await socket(watcher.cookie, 'e2e-six'));
// A report and the counters of the last hour (the rooms and the API write these as things happen).
const post = await call('/api/board/posts', { title: `visual report ${stamp}`, body: 'spam body' }, { cookie: players[0].cookie });
console.log('report', (await call('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'spam', detail: 'visual' }, { cookie: watcher.cookie })).status);
const now = Date.now();
const rows = [];
for (let m = 1; m < 60; m += 1) {
  const bucket = Math.floor((now - m * 60_000) / 60_000) * 60_000;
  if (m % 7 === 0) rows.push(`(${bucket}, 'ws_drop', ${1 + (m % 3)})`);
  if (m % 5 === 0) rows.push(`(${bucket}, 'ws_retry', ${1 + (m % 4)})`);
  if (m === 12 || m === 41) rows.push(`(${bucket}, 'room_error', 1)`);
  if (m === 3) rows.push(`(${bucket}, 'api_error', 2)`);
}
sql(`INSERT INTO ops_metrics (bucket, metric, n) VALUES ${rows.join(', ')} ON CONFLICT (bucket, metric) DO UPDATE SET n = n + excluded.n`);
sql(`INSERT INTO reconciliation_events (id, scope, subject_id, expected, actual, created_at) VALUES ('vis-${stamp}', 'table', 'e2e-six', 1000, 990, ${now - 2 * 3_600_000})`);
await new Promise((r) => setTimeout(r, 6000));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];
const result = {};
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(admin);
await page.getByLabel(/이메일|Email/).fill(owner.email);
await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
const firstLive = page.waitForResponse((r) => r.url().includes('/api/admin/ops/live'));
await page.getByRole('button', { name: /로그인|Log in/ }).click();
const liveBody = await (await firstLive).json();
result.cost = { rowsRead: liveBody.rowsRead, d1LatencyMs: liveBody.server.d1LatencyMs };
result.dbSize = sql(
  "SELECT (SELECT COUNT(*) FROM tables) AS tables, (SELECT COUNT(*) FROM tables WHERE status IN ('open','closing')) AS active, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM ops_metrics) AS ops, (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM table_sessions WHERE status = 'seated') AS seated",
);
result.dbSize = JSON.parse(result.dbSize)[0].results[0];
await page.getByTestId('dashboard').waitFor();
await page.getByTestId('totals').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/01-ko-desktop.png`, fullPage: true });
await page.getByRole('button', { name: 'EN' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/02-en-desktop.png`, fullPage: true });
result.enText = (await page.locator('main').innerText()).slice(0, 4000);
await page.getByRole('button', { name: '한국어' }).click();

for (const [name, w, h] of [['03-ko-mobile', 390, 844], ['05-ko-768', 768, 1024]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, storageState: await ctx.storageState() });
  const m = await c.newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(admin);
  await m.getByTestId('totals').waitFor();
  await m.waitForTimeout(500);
  await m.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  result[`${name}-overflow`] = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (name === '03-ko-mobile') {
    await m.getByRole('button', { name: 'EN' }).click();
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${out}/04-en-mobile.png`, fullPage: true });
    result['04-en-mobile-overflow'] = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await m.getByRole('button', { name: '한국어' }).click();
  }
  await c.close();
}
result.koText = (await page.locator('main').innerText()).slice(0, 4000);
for (const ws of sockets) ws.close();
console.log(JSON.stringify({ errors, ...result }, null, 1));
await browser.close();
