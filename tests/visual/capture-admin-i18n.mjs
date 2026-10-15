// Visual grounding for the admin console's languages (real Chrome), against the E2E server (tests/e2e/server.mjs on
// 8798) and the built admin console (vite preview on 5174, JC_API_ORIGIN=http://127.0.0.1:8798). Every page is opened
// in Korean and English at 1440 and 390 px; it prints the Latin words left on the Korean pages (outside the small
// monospace codes), the Hangul left on the English pages, and the horizontal overflow.
// Usage: node tests/visual/capture-admin-i18n.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  return d1(['--command', command]);
}

function d1(args) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
// A second reporter and a severity, so the report statistics list a repeatedly reported member.
await call('/api/reports', { targetType: 'post', targetId: post.body.id, reason: 'abuse' }, { cookie: owner.cookie });
sql(`UPDATE reports SET severity = 'high' WHERE target_id = '${post.body.id}' AND reason = 'spam'`);
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
// A planned maintenance window and three notices (shown now, scheduled, ended), for the notices page's cards and badges.
const day = 86_400_000;
const at = Date.now();
sql(`INSERT INTO maintenance_windows (id, starts_at, ends_at, block_login, message_ko, message_en, created_by) VALUES ('vis-mt-${stamp}', ${at + 2 * day}, ${at + 2 * day + 7_200_000}, 1, '서버 점검', 'Server upkeep', '${owner.id}')`);
sql(`INSERT INTO service_notices (id, kind, title_ko, title_en, body_ko, body_en, starts_at, ends_at, created_by) VALUES
  ('vis-n1-${stamp}', 'urgent', '결제 지연 안내', 'Delayed top-ups', '일부 충전이 늦어지고 있습니다.', 'Some top-ups are slow.', ${at - 3_600_000}, ${at + day}, '${owner.id}'),
  ('vis-n2-${stamp}', 'maintenance', '정기 점검', 'Planned upkeep', NULL, NULL, ${at + day}, NULL, '${owner.id}'),
  ('vis-n3-${stamp}', 'general', '새 테이블', 'New tables', NULL, NULL, ${at - 3 * day}, ${at - day}, '${owner.id}')`);
// Refused attempts on the audit log (the failure audit writes these; seeded so the failed filter has rows to show).
sql(`INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, ip, outcome, created_at) VALUES
  ('vis-af1-${stamp}', '${owner.id}', 'user.suspend.failed', 'user', '${players[0].id}', '{"status":403,"code":"forbidden","message":"only a super admin can suspend administrators","route":"POST /api/admin/users/:id/suspend"}', '127.0.0.1', 'failed', ${at - 120_000}),
  ('vis-af2-${stamp}', '${owner.id}', 'admin.access_denied', NULL, NULL, '{"status":403,"code":"forbidden","message":"super admin only","route":"GET /api/admin/users/export"}', '127.0.0.1', 'failed', ${at - 60_000})`);
// Operations stats: 90 rolled-up days (and the markers saying so), written straight into daily_stats so the stats page
// draws its charts, share bars, hourly profile and table without a real rollup (tests/integration covers that).
{
  const KST = 9 * 3_600_000;
  const today = Math.floor((at + KST) / day);
  let s = 7;
  const rnd = (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4_294_967_296) * n);
  };
  const rows = [[0, 'rolled_from', today - 90], [0, 'rolled_through', today - 1], [0, 'activity_since', today - 30]];
  for (let d = today - 90; d < today; d++) {
    const busy = (d + 3) % 7 >= 5 ? 1.5 : 1; // weekends
    const signups = rnd(5);
    rows.push([d, 'signups', signups], [d, 'hands_official', Math.round((40 + rnd(120)) * busy)], [d, 'hands_member', 10 + rnd(50)], [d, 'tables_official', 2 + rnd(4)], [d, 'tables_member', 1 + rnd(3)]);
    for (const room of ['official', 'member']) {
      const seats = 6 + rnd(24);
      rows.push([d, `seats_${room}`, seats], [d, `seat_ms_${room}`, seats * (15 + rnd(40)) * 60_000]);
    }
    let peak = 0;
    for (let h = 0; h < 24; h++) {
      const n = Math.round(((h >= 19 || h <= 1 ? 10 : h >= 12 ? 5 : 1) + rnd(4)) * busy);
      peak = Math.max(peak, n);
      rows.push([d, `peak_h${String(h).padStart(2, '0')}`, n]);
    }
    rows.push([d, 'peak', peak]);
    const reports = rnd(3);
    if (reports) rows.push([d, 'reports', reports], [d, 'handled', reports], [d, 'handle_ms', reports * (1 + rnd(30)) * 3_600_000]);
    if (signups && d < today - 8) {
      const first = rnd(signups + 1);
      rows.push([d, 'cohort_play_1d', first], [d, 'cohort_play_7d', Math.min(signups, first + rnd(3))]);
    }
    if (d >= today - 30) {
      const dau = 8 + rnd(18);
      rows.push([d, 'dau', dau], [d, 'returning', dau - rnd(4)], [d, 'wau', Math.min(40, dau + 10 + (d - today + 30) * 2)], [d, 'mau', Math.min(70, dau + 20 + (d - today + 30) * 2)]);
    }
    if (d >= today - 10) rows.push([d, 'ac_lesson_start', 4 + rnd(6)], [d, 'ac_lesson_done', 2 + rnd(3)], [d, 'ac_scenario_start', 2 + rnd(4)], [d, 'ac_scenario_done', 1 + rnd(2)], [d, 'ac_answer', 20 + rnd(30)], [d, 'ac_correct', 12 + rnd(8)]);
  }
  const file = resolve(out, 'stats-seed.sql');
  writeFileSync(file, `INSERT OR REPLACE INTO daily_stats (day, metric, n) VALUES\n${rows.map(([d, m, n]) => `(${d}, '${m}', ${n})`).join(',\n')};\n`);
  d1(['--file', file]);
}
// Two finished hands on a closed table, so the hands list has rows, a member filter and a detail page to open.
sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status) VALUES ('vis-h-${stamp}', 'vis-${stamp}', 6, 10, 20, 400, 2000, 'closed')`);
sql(`INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES
  ('vis-h-${stamp}-1', 'vis-h-${stamp}', 1, ${at - 7_200_000}, ${at - 7_100_000}, '["As","Kd","7h","7c","2s"]', 400, '1', '{"actions":[],"engine":""}'),
  ('vis-h-${stamp}-2', 'vis-h-${stamp}', 2, ${at - 3_600_000}, ${at - 3_500_000}, '["Qs","Jd","3c"]', 120, '1', '{"actions":[],"engine":""}')`);
sql(`INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES
  ('vis-h-${stamp}-1', '${players[0].id}', 0, '["Ah","Ad"]', 1000, 1200, 200, 400, 1, ${at - 7_100_000}), ('vis-h-${stamp}-1', '${players[1].id}', 1, '["Kc","Qc"]', 1000, 800, -200, 0, 1, ${at - 7_100_000}),
  ('vis-h-${stamp}-2', '${players[0].id}', 0, '["9h","8h"]', 1000, 940, -60, 0, 0, ${at - 3_500_000}), ('vis-h-${stamp}-2', '${players[1].id}', 1, '["Tc","Td"]', 1000, 1060, 60, 120, 0, ${at - 3_500_000})`);
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
const routes = ['/', '/stats', '/stats?unit=month', '/users', `/users/${players[0].id}`, '/tables', '/tables/e2e-six', '/hands', ...(handHref ? [handHref] : []), '/ledger', '/economy', '/reconcile', '/audit', '/audit?outcome=failed#detail', `/audit?targetType=user&targetId=${players[0].id}`, '/security', `/users/${players[0].id}#chips`, `/users/${players[0].id}#suspend`, `/users/${players[0].id}#role`, '/tables/e2e-six#close', '/academy', '/reports', '/reports?view=stats', '/board', '/messages', '/service',
  // Console states: a member's ledger and hands, nobody found, nothing matching, a failed load, and the confirmations.
  `/ledger?member=${players[0].nickname}`, `/ledger?member=nobody${stamp}`, `/hands?member=${encodeURIComponent(players[0].email)}`, '/tables#empty', '/ledger#offline', '/board#delete', '/messages#send', '/reports#decide'];

// Dynamic values (nicknames, e-mails, ids, the brand) are not UI words.
const ignore = new RegExp(`${stamp}|@visual\\.dev|^JC$|^ROYAL$|^ADMIN$|^EN$|^e2e|^E2E`, 'i');
const result = {};
for (const lang of ['ko', 'en']) {
  await page.getByRole('button', { name: lang === 'ko' ? '한국어' : 'EN' }).click().catch(() => {});
  for (const route of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [path, step] = route.split('#');
    // A load that cannot reach the server: the list says so with a retry, and the banner says the server is away.
    const ledgerApi = (u) => u.pathname === '/api/admin/ledger';
    if (step === 'offline') await page.route(ledgerApi, (r) => r.abort('internetdisconnected'));
    await page.goto(admin + path);
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
    // Change previews: the dialog opens with what would change; nothing is applied (closed with Escape afterwards).
    if (step === 'chips') {
      await page.getByTestId('chip-amount').fill('500');
      await page.getByLabel(/^메모$|^Memo$/).first().fill('visual');
      await page.getByTestId('chip-submit').click();
    }
    if (step === 'suspend') {
      await page.locator('form:has([data-testid="suspend"]) input').fill('visual check');
      await page.getByTestId('suspend').click();
    }
    if (step === 'role') await page.getByTestId('role-admin').click();
    if (step === 'chips' || step === 'suspend' || step === 'role') await page.getByTestId('change-preview').waitFor();
    if (step === 'close') {
      await page.getByTestId('close-table').click();
      await page.getByTestId('close-preview').waitFor();
    }
    if (step === 'detail') {
      await page.getByTestId('audit-detail-toggle').first().click();
      await page.getByTestId('audit-detail').waitFor();
    }
    if (step === 'empty') {
      await page.getByTestId('table-q').fill('no-such-table');
      await page.getByTestId('table-q').press('Enter');
      await page.getByTestId('list-empty').waitFor();
    }
    if (step === 'offline') await page.getByTestId('load-error').waitFor();
    if (step === 'delete') {
      await page.getByTestId('post-delete').first().click();
      await page.getByTestId('post-delete-text').waitFor();
    }
    if (step === 'send') {
      await page.locator('main form input').first().fill(players[0].nickname);
      await page.locator('main form button[type="submit"]').first().click();
      await page.getByRole('button', { name: `${players[0].nickname} +` }).click();
      await page.getByLabel(/^제목$|^Title$/).fill('visual');
      await page.getByLabel(/^내용$|^Body$/).fill('visual');
      await page.getByTestId('send-message').click();
      await page.getByTestId('send-summary').waitFor();
    }
    if (step === 'decide') {
      await page.getByTestId('report-resolve').first().click();
      await page.getByTestId('report-preview').waitFor();
    }
    if (step) await page.waitForTimeout(400);
    const name = `${lang}-${route.replace(/\//g, '_').replace(/[^a-z0-9_-]/gi, '') || '_'}`;
    await page.screenshot({ path: `${out}/${name}-1440.png`, fullPage: true });
    const words = await page.evaluate((isKo) => {
      const found = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || el.closest('.font-mono, script, style, [aria-hidden="true"]')) continue;
        const text = n.textContent ?? '';
        for (const w of text.match(isKo ? /[A-Za-z][A-Za-z0-9_.:-]+/g : /[가-힣]+/g) ?? []) found.add(w);
      }
      for (const el of document.querySelectorAll('input[placeholder], [aria-label], [title]')) {
        if (el.closest('.font-mono')) continue;
        for (const a of ['placeholder', 'aria-label']) for (const w of (el.getAttribute(a) ?? '').match(isKo ? /[A-Za-z][A-Za-z0-9_.:-]+/g : /[가-힣]+/g) ?? []) found.add(`${a}:${w}`);
      }
      // Visible Hangul on a badge drawn in the monospace font (inherited from a code cell) spaces its words apart.
      for (const badge of document.querySelectorAll('span.rounded-full')) {
        const texts = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT);
        for (let n = texts.nextNode(); n; n = texts.nextNode()) {
          const el = n.parentElement;
          if (!el || el.closest('.sr-only, [aria-hidden="true"]') || !/[가-힣]/.test(n.textContent ?? '')) continue;
          if (/mono/i.test(getComputedStyle(el).fontFamily)) found.add(`mono-badge:${badge.textContent}`);
        }
      }
      return [...found];
    }, lang === 'ko');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (lang === 'ko' || route === '/' || route === '/service' || route.startsWith('/hands/') || route.startsWith('/security') || step) await page.screenshot({ path: `${out}/${name}-390.png`, fullPage: true });
    if (step && step !== 'detail') await page.keyboard.press('Escape');
    if (step === 'offline') await page.unroute(ledgerApi);
    result[`${lang} ${route}`] = { leftover: words.filter((w) => !ignore.test(w.replace(/^(placeholder|aria-label):/, '')) && !(lang === 'en' && w === '한국어')), overflow: [wide, narrow] };
  }
}
for (const ws of sockets) ws.close();
console.log(JSON.stringify({ errors, handId: handId ?? null, result }, null, 1));
await browser.close();
