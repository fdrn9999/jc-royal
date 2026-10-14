// Visual grounding for board / notices / hand review / inbox (real Chrome).
// Usage: node tests/visual/capture-community.mjs [base] — expects the admin owner@visual.dev from capture-admin.mjs.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8787';
const ADMIN_ORIGIN = 'http://localhost:5174';
const out = 'tests/visual/out-community';
mkdirSync(out, { recursive: true });
const stamp = Date.now().toString(36);

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    store: (res) => res.headers.getSetCookie().forEach((sc) => { const [p] = sc.split(';'); const i = p.indexOf('='); cookies.set(p.slice(0, i), p.slice(i + 1)); }),
    all: () => [...cookies],
  };
}
async function call(j, origin, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Origin: origin, Cookie: j.header(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  j.store(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function player(name) {
  const j = jar();
  const r = await call(j, 'http://localhost:5173', 'POST', '/api/auth/register', { email: `${name}-${stamp}@visual.dev`, password: 'password123', nickname: `${name}${stamp.slice(-4)}` });
  return { j, me: r.body };
}

// 1. Admin: notice + broadcast message
const admin = jar();
console.log('admin login', (await call(admin, ADMIN_ORIGIN, 'POST', '/api/admin/auth/login', { email: 'owner@visual.dev', password: 'password123' })).status);
await call(admin, ADMIN_ORIGIN, 'POST', '/api/admin/board/notices', { title: '[공지] JC ROYAL 그랜드 오픈 이벤트', body: '오픈 기념으로 매일 출석 시 가상 칩 1,000개를 드립니다.\n모든 칩은 현금 가치가 없는 플레이 전용 칩입니다.' });

// 2. Two players play one hand to showdown over WebSocket
const a = await player('mina');
const b = await player('joon');
await call(admin, ADMIN_ORIGIN, 'POST', '/api/admin/messages', { userIds: [a.me.id, b.me.id], category: 'event', title: '그랜드 오픈 이벤트 안내', body: '이번 주말 하이롤러 테이블이 열립니다.' });

function sock(p) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/tables/dev-hu-1`, { headers: { Cookie: p.j.header(), Origin: 'http://localhost:5173' } });
    const s = { ws, state: null };
    ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.t === 'state') s.state = m.state; });
    ws.addEventListener('open', () => setTimeout(() => resolve(s), 300));
  });
}
const sa = await sock(a);
const sb = await sock(b);
sa.ws.send(JSON.stringify({ t: 'sit', reqId: `r${stamp}a1`, seatIndex: 0, buyIn: 1000 }));
sb.ws.send(JSON.stringify({ t: 'sit', reqId: `r${stamp}b1`, seatIndex: 1, buyIn: 1000 }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 200; i++) {
  await wait(150);
  const st = sa.state;
  if (st?.hand?.stage === 'settled') break;
  for (const s of [sa, sb]) {
    const v = s.state;
    if (v?.hand && v.you.legal.length && v.hand.actorSeat === v.you.seatIndex) {
      const check = v.you.legal.find((o) => o.type === 'check');
      s.ws.send(JSON.stringify({ t: 'action', intentId: `i${stamp}${i}${v.you.seatIndex}`, handId: v.hand.id, seq: v.hand.seq, type: check ? 'check' : 'call' }));
    }
  }
}
await wait(800);
for (const s of [sa, sb]) s.ws.send(JSON.stringify({ t: 'leave', reqId: `r${stamp}l${Math.random()}` }));
await wait(500);
sa.ws.close();
sb.ws.close();
const hands = (await call(a.j, 'http://localhost:5173', 'GET', '/api/me/hands')).body;
console.log('hands played', hands.length);

// 3. Browser as player A
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(a.j.all().map(([name, value]) => ({ name, value, url: base })));
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${base}/board/write`);
await page.getByLabel(/제목|Title/).fill('AK 오프수트 체크다운, 리버에서 벳 했어야 할까요?');
await page.getByLabel(/내용|Text/).fill('헤즈업에서 끝까지 체크로 갔습니다.\n턴에서 탑페어가 됐는데 밸류벳을 놓친 것 같아요. 의견 부탁드립니다!');
await page.getByTestId('pick-hands').click();
await page.locator('input[type=checkbox]').first().check();
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/01-hand-picker.png` });
await page.getByRole('button', { name: /확인|Confirm/ }).last().click();
await page.getByTestId('publish').click();
await page.getByTestId('post-title').waitFor();
await page.getByPlaceholder(/댓글|comment/i).fill('좋은 질문이네요. 저라면 리버 1/2팟 벳!');
await page.getByRole('button', { name: /댓글 등록|Comment/ }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/02-post-detail.png`, fullPage: true });

await page.goto(`${base}/board`);
await page.waitForSelector('[data-testid=notice-row]');
await page.screenshot({ path: `${out}/03-board-list.png` });
await page.goto(`${base}/messages`);
await page.waitForSelector('[data-testid=message]');
await page.locator('[data-testid=message] button').first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/04-inbox.png` });
await page.goto(`${base}/me`);
await page.waitForTimeout(1200);
await page.locator('[data-testid=my-posts]').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/05-mypage-posts.png` });

const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
await m.addCookies(a.j.all().map(([name, value]) => ({ name, value, url: base })));
const mp = await m.newPage();
await mp.goto(`${base}/board`);
await mp.waitForSelector('[data-testid=notice-row]');
await mp.screenshot({ path: `${out}/06-board-mobile.png` });
await mp.locator('[data-testid=post-row]').first().click();
await mp.getByTestId('post-title').waitFor();
await mp.waitForTimeout(500);
await mp.screenshot({ path: `${out}/07-post-mobile.png`, fullPage: true });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(JSON.stringify({ errors, mobileOverflow: overflow }));
await browser.close();
