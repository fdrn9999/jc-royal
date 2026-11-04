import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { idOf, seedHands } from './hand-review-seed';
import { signUp, sitWith, test, uid, widerThanDevice } from './helpers';
import { measurePage, type PageIssue } from './page-layout';
import { measureTable, smallTargets } from './table-layout';

/**
 * Every screen of the site and the console on the nine sizes of the visual check (docs/TEST_REPORT.md 'V3 8단계'):
 * phones upright (320×568 to 430×932) and on their side (667×375, 812×375), a tablet on its side (1024×768), all with
 * touch, and two desktops. Each page is looked at the same way (page-layout.ts) with the page at its top and at its
 * foot: nothing wider than the screen, no control or text past it, no text cut off, nothing over a control, no two
 * controls or two lines of text on each other, touch targets of 40 px, an open dialog inside the screen. The table is looked at with the
 * table's own check (table-layout.ts), as table-phones.spec.ts does. Each test lists all it found before it fails, and
 * leaves a screenshot of each screen in test-results/sweep. A screen is looked at loaded: no request to the API still
 * out and no socket still opening, nothing new asked for while it is measured, and nothing refused or failed (a test
 * fails at once on one, for what it would look at is a card's error instead).
 */
interface Size {
  width: number;
  height: number;
  touch: boolean;
}
const SIZES: Size[] = [
  { width: 320, height: 568, touch: true },
  { width: 360, height: 640, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 430, height: 932, touch: true },
  { width: 667, height: 375, touch: true },
  { width: 812, height: 375, touch: true },
  { width: 1024, height: 768, touch: true },
  { width: 1440, height: 900, touch: false },
  { width: 1920, height: 1080, touch: false },
];
const sizeName = (s: Size) => `${s.width}x${s.height}`;
const OUT = 'test-results/sweep';

interface Found extends PageIssue {
  screen: string;
  size: string;
  at: 'top' | 'bottom';
}

/** What was refused or failed on a page since it was last looked at. */
const troubles = new WeakMap<Page, string[]>();
const pathOf = (url: string) => new URL(url).pathname;

/** What a watched page has asked for: its API requests still out, how many requests and sockets it has started, and its sockets still opening. */
interface Asked {
  out: string[];
  started: number;
  opening: number;
}
const askedOf = (p: Page) => p.evaluate(() => (window as unknown as { __asked?: () => Asked }).__asked?.() ?? null);
/** What keeps a page from counting as loaded. */
const busy = (a: Asked | null) => (a ? [...a.out, ...(a.opening ? [`${a.opening} socket(s) opening`] : [])] : ['the page is not watched']);

/**
 * Watches what `p` asks of the API, and its sockets, from now on (look() needs it). What is still out is counted by the
 * page itself, for its own document: a page left behind sends its last requests as it goes (presence, settings, with
 * `keepalive`), and the browser does not always tell how those ended.
 */
async function watch(p: Page) {
  await p.addInitScript(() => {
    const real = window.fetch.bind(window);
    const out: string[] = [];
    let started = 0;
    let opening = 0;
    (window as unknown as { __asked: () => Asked }).__asked = () => ({ out: [...out], started, opening });
    // A socket is opening until its first frame (the hub's hello, the table's state) or its end: what that frame sets
    // off (the realtime hello has the screens read again) has started by the time it counts as open.
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        started++;
        opening++;
        let open = true;
        const done = () => {
          if (open) opening--;
          open = false;
        };
        for (const t of ['message', 'close', 'error']) this.addEventListener(t, done, { once: true });
      }
    };
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (!path.startsWith('/api/')) return real(input, init);
      out.push(path);
      started++;
      try {
        const res = await real(input, init);
        // Answered once its body is read too (a clone, so the page still reads it).
        await res.clone().arrayBuffer().catch(() => undefined);
        return res;
      } finally {
        out.splice(out.indexOf(path), 1);
      }
    };
  });
  const trouble: string[] = [];
  const api = (r: Request) => pathOf(r.url()).startsWith('/api/');
  p.on('requestfailed', (r) => {
    // Given up by the page itself (it was left, or a newer request took over): not a failure.
    const why = r.failure()?.errorText ?? '';
    if (api(r) && !why.includes('ERR_ABORTED')) trouble.push(`${r.method()} ${pathOf(r.url())}: ${why}`);
  });
  p.on('response', (r) => {
    if (api(r.request()) && (r.status() === 429 || r.status() >= 500)) trouble.push(`${r.request().method()} ${pathOf(r.url())}: ${r.status()}`);
  });
  p.on('websocket', (ws) => ws.on('socketerror', (e) => trouble.push(`socket ${pathOf(ws.url())}: ${e}`)));
  troubles.set(p, trouble);
  return p;
}

/** Fails if anything the page asked for was refused or failed since this was last asked. */
function noTrouble(p: Page, what: string) {
  const trouble = troubles.get(p);
  if (!trouble) throw new Error(`${what}: the page is not watched`);
  expect(trouble.splice(0), `${what}: refused or failed`).toEqual([]);
}

/**
 * Nothing asked for and nothing out for 300 ms (a card may ask only once another's answer, or the realtime hello, is in),
 * and nothing refused or failed. How many requests and sockets the page had started by then.
 */
async function settled(p: Page, what: string) {
  let started = 0;
  await expect(async () => {
    const a = await askedOf(p);
    expect(busy(a), `${what}: still loading`).toEqual([]);
    await p.waitForTimeout(300);
    const b = await askedOf(p);
    expect(busy(b), `${what}: still loading`).toEqual([]);
    expect(b!.started, `${what}: asked for more`).toBe(a!.started);
    started = b!.started;
  }).toPass({ timeout: 20_000 });
  noTrouble(p, what);
  return started;
}

/**
 * When the pages of the test now running were loaded. The server lets a member open 30 sockets a minute, and read some
 * cards 30 times a minute (My Page's referral and challenges, on every load of it): a test reloading faster than that
 * looks at refused cards. Each test's member loads at most 25 pages in any 60 s.
 */
const loads: number[] = [];
async function paced(p: Page) {
  for (;;) {
    const now = Date.now();
    while (loads.length && loads[0]! <= now - 60_000) loads.shift();
    if (loads.length < 25) break;
    await p.waitForTimeout(loads[0]! + 60_000 - now + 50);
  }
  loads.push(Date.now());
}

/** One page for touch screens and one for desktops, signed in as `state` (or not), resized to each size in turn. */
async function pages(browser: Browser, state?: Awaited<ReturnType<BrowserContext['storageState']>>) {
  // A new member for each test: its loads paced afresh.
  loads.length = 0;
  const open = async (touch: boolean) => {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
    return await watch(await ctx.newPage());
  };
  const touch = await open(true);
  const desk = await open(false);
  return async (s: Size) => {
    const p = s.touch ? touch : desk;
    await p.setViewportSize({ width: s.width, height: s.height });
    return p;
  };
}

/** The page scrolled to its foot (or the open dialog's content to its foot). */
const toFoot = (p: Page) =>
  p.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog][aria-modal=true]')).at(-1);
    const boxes = d ? [d, ...Array.from(d.querySelectorAll('*'))] : [document.scrollingElement!];
    for (const b of boxes) if (b.scrollHeight > b.clientHeight + 1) b.scrollTop = b.scrollHeight;
  });

/** Sheets seen, for the report: the dialog's panel on each size. */
const sheets: Record<string, unknown> = {};
const shortenedSeen: Record<string, string[]> = {};

/**
 * Looks at the screen once what it loads after its heading is in (no spinner left: a bar with a value, a challenge's
 * progress, is no spinner), at its top and at its foot, and keeps a screenshot of the top.
 */
async function look(p: Page, s: Size, screen: string, found: Found[]) {
  for (const at of ['top', 'bottom'] as const) {
    const what = `${screen} ${sizeName(s)} ${at}`;
    // At the foot, what scrolling there asked for (a next page of a list) answered too.
    if (at === 'bottom') await toFoot(p);
    // Looked at again if the page asked for anything while it was (a poll, what a late hello reads again): the screen
    // may have changed under the measure. Anything refused or failed by the end of the look fails it.
    const since = Date.now();
    let r: Awaited<ReturnType<typeof measurePage>>;
    for (;;) {
      const started = await settled(p, what);
      await expect(p.locator('[role=progressbar]:not([aria-valuenow])')).toHaveCount(0);
      await p.waitForTimeout(at === 'top' ? 300 : 250);
      r = await measurePage(p, { width: s.width, height: s.height, touch: s.touch, at });
      if (at === 'top') await p.screenshot({ path: `${OUT}/${screen}-${sizeName(s)}.png`, animations: 'disabled' });
      const after = await askedOf(p);
      noTrouble(p, what);
      if (!busy(after).length && after!.started === started) break;
      expect(Date.now() - since, `${what}: the page kept asking for more while it was looked at`).toBeLessThan(60_000);
    }
    for (const i of r.issues) found.push({ ...i, screen, size: sizeName(s), at });
    if (r.shortened.length) shortenedSeen[`${screen} ${sizeName(s)} ${at}`] = r.shortened;
    if (r.sheet && at === 'top') sheets[`${screen} ${sizeName(s)}`] = r.sheet;
  }
  // Back to the top, the open dialog's content too: the next size is looked at from its top.
  await p.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog][aria-modal=true]')).at(-1);
    for (const b of d ? [d, ...Array.from(d.querySelectorAll('*'))] : []) b.scrollTop = 0;
    document.scrollingElement?.scrollTo(0, 0);
  });
}

/** Writes what a test found (and the shortened text and sheets seen) beside its screenshots, then fails on any issue. */
function report(name: string, found: Found[]) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ found, shortened: shortenedSeen, sheets }, null, 2));
  for (const k of Object.keys(sheets)) delete sheets[k];
  for (const k of Object.keys(shortenedSeen)) delete shortenedSeen[k];
  const lines = found.map((f) => `${f.screen} ${f.size} ${f.at}: ${f.kind} ${f.what} (${f.how})`);
  expect(lines, `${name}: layout issues`).toEqual([]);
}

/** A member with a hand history and a public profile to visit: the villain of their seeded hands. */
async function member(browser: Browser) {
  // A nickname of wide letters, near the 16 allowed: it is what stretches a header.
  const hero = await signUp(browser, { nick: '가나다라마바사아' });
  const villain = await signUp(browser);
  const heroId = await idOf(hero.page);
  const villainId = await idOf(villain.page);
  seedHands(heroId, villainId);
  const state = await hero.page.context().storageState();
  await hero.page.context().close();
  await villain.page.context().close();
  return { state, villainId };
}

/** Opens `path` and waits for its heading (or `ready`). */
async function visit(p: Page, path: string, ready?: string) {
  await paced(p);
  await p.goto(path);
  await expect(ready ? p.getByTestId(ready).first() : p.locator('h1').first()).toBeVisible();
}

test('visual sweep: the lobby and its room dialog on nine screens', async ({ browser }) => {
  test.setTimeout(300_000);
  const { state } = await member(browser);
  const at = await pages(browser, state);
  const found: Found[] = [];
  for (const s of SIZES) {
    const p = await at(s);
    await visit(p, '/', 'lobby-table');
    await look(p, s, 'lobby', found);
    const open = p.getByTestId('room-create-open-wide');
    await ((await open.isVisible()) ? open : p.getByTestId('room-create-open')).click();
    await expect(p.getByRole('dialog')).toBeVisible();
    await look(p, s, 'lobby-room-create', found);
    await p.keyboard.press('Escape');
  }
  report('lobby', found);
});

test('visual sweep: My Page, its four tabs and the delete dialog, on nine screens', async ({ browser }) => {
  test.setTimeout(420_000);
  const { state } = await member(browser);
  const at = await pages(browser, state);
  const found: Found[] = [];
  for (const s of SIZES) {
    const p = await at(s);
    for (const tab of ['dashboard', 'history', 'activity', 'account']) {
      await visit(p, `/me?tab=${tab}`, `me-panel-${tab}`);
      await expect(p.getByTestId('me-header')).toBeVisible();
      await look(p, s, `me-${tab}`, found);
      // What a closed <details> holds is not drawn (page-layout.ts): each one in the tab opened, the tab looked at again
      // (the stats glossary, the invite guide, recent challenges).
      const closed = p.getByTestId(`me-panel-${tab}`).locator('details:not([open]) > summary');
      if (await closed.count()) {
        for (let n = await closed.count(); n > 0; n--) await closed.first().click();
        await expect(closed).toHaveCount(0);
        // Each click scrolled its box into view: looked at from the page's top again.
        await p.evaluate(() => document.scrollingElement?.scrollTo(0, 0));
        await look(p, s, `me-${tab}-open`, found);
      }
    }
    await p.getByTestId('me-panel-account').getByRole('button', { name: /^(회원 탈퇴|Delete account)$/ }).click();
    await expect(p.getByRole('dialog')).toBeVisible();
    await look(p, s, 'me-delete', found);
    await p.keyboard.press('Escape');
  }
  report('me', found);
});

const MEMBER_PAGES: [string, (villain: string) => string][] = [
  ['player', (v) => `/players/${v}`],
  ['leaderboard', () => '/leaderboard'],
  ['tournaments', () => '/tournaments'],
  ['friends', () => '/friends'],
  ['notifications', () => '/notifications'],
  ['board', () => '/board'],
  ['messages', () => '/messages'],
  ['academy', () => '/academy'],
  ['hands', () => '/me/hands'],
];

for (const half of [0, 1]) {
  const list = MEMBER_PAGES.filter((_, i) => i % 2 === half);
  test(`visual sweep: ${list.map(([n]) => n).join(', ')} on nine screens`, async ({ browser }) => {
    test.setTimeout(480_000);
    const { state, villainId } = await member(browser);
    const at = await pages(browser, state);
    const found: Found[] = [];
    for (const s of SIZES) {
      const p = await at(s);
      for (const [screen, path] of list) {
        await visit(p, path(villainId));
        await look(p, s, screen, found);
      }
    }
    report(`pages-${half}`, found);
  });
}

test('visual sweep: logging in and signing up, as a guest, on nine screens', async ({ browser }) => {
  test.setTimeout(240_000);
  const at = await pages(browser);
  const found: Found[] = [];
  for (const s of SIZES) {
    const p = await at(s);
    await p.goto('/login');
    await expect(p.getByLabel(/^(비밀번호|Password)$/)).toBeVisible();
    await look(p, s, 'login', found);
    await p.goto('/register');
    await expect(p.getByLabel(/닉네임|Nickname/)).toBeVisible();
    await look(p, s, 'register', found);
  }
  report('guest', found);
});

async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) return check.click().catch(() => {});
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
}

test('visual sweep: a table with bots, waiting, on the turn, raising, and a bot’s card with its HUD, on nine screens', async ({ browser }) => {
  test.setTimeout(900_000);
  const { page, nickname } = await signUp(browser);
  await sitWith(page, 'e2e-sweep', 1000);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(3, { timeout: 120_000 });
  const state = await page.context().storageState();
  await page.goto('/');
  const found: Found[] = [];
  const table = (s: Size, state: string, r: Awaited<ReturnType<typeof measureTable>>, small: string[]) => {
    for (const i of r.issues) found.push({ kind: i.kind === 'clipped' ? 'cut' : i.kind === 'truncated' ? 'cut' : i.kind === 'astray' ? 'offscreen' : i.kind, what: i.item, how: `${i.by ?? ''} ${i.px ?? ''}`.trim(), screen: `table-${state}`, size: sizeName(s), at: 'top' });
    for (const t of small) found.push({ kind: 'small', what: t, how: 'action bar', screen: `table-${state}`, size: sizeName(s), at: 'top' });
  };
  for (const s of SIZES) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: s.width, height: s.height }, isMobile: s.touch, hasTouch: s.touch, reducedMotion: 'reduce' });
    const p = await watch(await ctx.newPage());
    await p.goto('/table/e2e-sweep');
    await expect(filled(p)).toHaveCount(3);
    const bar = p.getByTestId('action-bar');
    const shot = (what: string) => p.screenshot({ path: `${OUT}/table-${what}-${sizeName(s)}.png`, animations: 'disabled' });
    const wide = async (what: string) => {
      if (await widerThanDevice(p)) found.push({ kind: 'hscroll', what: 'page', how: 'wider than the screen', screen: `table-${what}`, size: sizeName(s), at: 'top' });
    };

    await expect(async () => {
      if (await bar.isVisible()) await act(p);
      await expect(bar).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
    await p.waitForTimeout(300);
    table(s, 'waiting', await measureTable(p), []);
    await wide('waiting');
    await shot('waiting');

    const raise = bar.getByTestId('action-dock-toggle');
    await expect(async () => {
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await p.waitForTimeout(400);
      if (!(await raise.isVisible())) {
        await act(p);
        throw new Error('no raise offered');
      }
    }).toPass({ timeout: 240_000 });
    table(s, 'turn', await measureTable(p), await smallTargets(p));
    await wide('turn');
    await shot('turn');
    await raise.click();
    await expect(p.locator('[data-raise-panel]')).toBeVisible();
    await p.waitForTimeout(300);
    table(s, 'raise', await measureTable(p), await smallTargets(p));
    await wide('raise');
    await shot('raise');
    await act(p);

    // A bot's card, with its HUD (marked as a bot's), as a sheet on a phone and a dialog on a desktop.
    const bot = p.locator(`[data-testid^="seat-pick-"]:not([aria-label="${nickname}"])`).first();
    await bot.click();
    const card = p.getByTestId('bot-card');
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid=seat-hud], [data-testid=seat-hud-hidden]').first()).toBeVisible();
    await look(p, s, 'table-hud', found);
    await p.keyboard.press('Escape');
    await ctx.close();
  }
  report('table', found);
});

test('visual sweep: the console’s permanent delete dialog on nine screens', async ({ browser }) => {
  test.setTimeout(420_000);
  const writer = await signUp(browser);
  const title = `E2E 화면 점검 ${uid('p')}`;
  await writer.page.evaluate(
    async (t) => fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, body: 'E2E 본문' }) }),
    title,
  );
  const boss = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${boss.email}'`);
  const found: Found[] = [];
  for (const touch of [true, false]) {
    const page = await watch(await adminLogin(browser, boss.email, { mobile: touch }));
    await page.goto(`${ADMIN}/board`);
    await page.getByTestId('board-q').fill(title);
    await page.getByTestId('board-q').press('Enter');
    await page.getByTestId('board-row').filter({ hasText: title }).getByTestId('post-delete').click();
    await page.getByTestId('delete-mode-purge').check();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page.getByTestId('purge-plan')).toHaveAttribute('data-deletable', 'true');
    for (const s of SIZES.filter((x) => x.touch === touch)) {
      await page.setViewportSize({ width: s.width, height: s.height });
      await look(page, s, 'admin-purge', found);
    }
    await page.context().close();
  }
  report('admin', found);
});
