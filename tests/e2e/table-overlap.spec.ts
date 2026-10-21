import { expect, type Browser, type Page } from '@playwright/test';
import { setAccountPrefs, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';

/**
 * What lies round the player's own seat at a live table, with bots in the other seats: the wallet, the reaction button
 * and its tray, the action bar and the raise panel, on the screens the table is played on, from the smallest phone
 * still in use to a full HD desktop, phones held upright and on their side (Chrome emulation, not devices). Waiting (the
 * status line with the wallet), with the tray open, on the turn, with the raise panel open and, on a phone, with the
 * chat open. Each pair that must not meet is measured as drawn: their boxes may not overlap, a tap at their middle must
 * reach them, and they lie on the screen. A big wallet and a long nickname too.
 */
interface Screen {
  name: string;
  viewport: { width: number; height: number };
  touch?: boolean;
  locale?: 'en';
}
const PHONE = { touch: true };
const SCREENS: Screen[] = [
  { name: '320x568', viewport: { width: 320, height: 568 }, ...PHONE },
  { name: '360x640', viewport: { width: 360, height: 640 }, ...PHONE },
  { name: '375x667', viewport: { width: 375, height: 667 }, ...PHONE },
  { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE },
  { name: '430x932', viewport: { width: 430, height: 932 }, ...PHONE },
  { name: '768x1024', viewport: { width: 768, height: 1024 }, ...PHONE },
  { name: '1024x768', viewport: { width: 1024, height: 768 } },
  { name: '1366x768', viewport: { width: 1366, height: 768 } },
  { name: '1920x1080', viewport: { width: 1920, height: 1080 } },
  { name: '844x390-side', viewport: { width: 844, height: 390 }, ...PHONE },
  { name: '667x375-side', viewport: { width: 667, height: 375 }, ...PHONE },
];
const pick = (...names: string[]) => SCREENS.filter((s) => names.includes(s.name));

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}
interface Probe {
  boxes: Record<string, Box>;
  /** Pairs that must not meet and do, by the smaller side of what they share (px). */
  overlaps: string[];
  /** What a tap at the middle of a piece reaches when it is not that piece. */
  covered: string[];
  /** Pieces off the screen, by how far. */
  offscreen: string[];
  /** The reaction button's own size, as drawn (w×h). */
  react: string | null;
}

/**
 * The pieces round my seat and the ones they must keep clear of. `mine`: my seat's index. The wallet is the status
 * line's amount (its own testid; before it had one, the line's span that names it); the reaction control is what the
 * eye finds (before: a badge drawn at my plate's corner, over a button the size of the plate).
 */
function probe(page: Page, mine: string): Promise<Probe> {
  return page.evaluate((mine) => {
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const els = new Map<string, Element>();
    const put = (id: string, el: Element | null | undefined) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') return;
      els.set(id, el);
    };
    const stack = document.querySelector('[data-testid=table-stack]');
    put('wallet', document.querySelector('[data-testid=wallet]') ?? Array.from(stack?.querySelectorAll('span') ?? []).find((s) => /^(보유 칩|Balance) /.test(s.textContent ?? '')));
    const opener = document.querySelector('[data-testid=react-open]');
    const badge = opener?.nextElementSibling?.matches('span[aria-hidden]') ? opener.nextElementSibling : null;
    put('react', badge ?? opener);
    put('tray', document.querySelector('[data-testid=react-tray]'));
    put('action-bar', document.querySelector('[data-testid=action-bar]'));
    put('pre-actions', document.querySelector('[data-testid=pre-actions]'));
    put('leave', document.querySelector('[data-testid=leave]'));
    put('topup-open', document.querySelector('[data-testid=topup-open]'));
    put('autotop', document.querySelector('[data-testid=autotop-badge], [data-testid=rebuy-badge]'));
    const seat = document.querySelector(`[data-testid="seat-${mine}"]`);
    seat?.querySelectorAll('.jc-card').forEach((c, k) => put(`my-card-${k}`, c));
    put('my-stack', document.querySelector(`[data-testid="stack-${mine}"]`));
    put('my-name', seat?.querySelector('[data-testid=member-name]'));
    put('my-bet', document.querySelector(`[data-testid="bet-${mine}"]`));
    for (const other of Array.from(document.querySelectorAll('[data-testid=table] [data-testid^="seat-"][data-state]'))) {
      const i = other.getAttribute('data-testid')!.slice(5);
      if (i === mine) continue;
      put(`seat-${i}`, other);
      put(`bet-${i}`, document.querySelector(`[data-testid="bet-${i}"]`));
    }
    put('board', document.querySelector('[data-testid=board]'));
    put('pot', document.querySelector('[data-testid=pot]'));

    // What may not meet what. Mine: my cards, my stack, my name and my bet (the badge sat on my plate, so not the plate).
    const MINE = /^my-/;
    const TABLE = /^(my-|seat-|bet-|board$|pot$)/;
    const CONTROLS = /^(action-bar|pre-actions|leave|topup-open|autotop)$/;
    const rules: [string, RegExp][] = [
      ['wallet', new RegExp(`${TABLE.source}|^react$|^tray$|${CONTROLS.source}`)],
      ['react', new RegExp(`${MINE.source}|^seat-|^bet-|^tray$|${CONTROLS.source}`)],
      ['tray', new RegExp(`${TABLE.source}|${CONTROLS.source}`)],
    ];
    const box = (e: Element) => e.getBoundingClientRect();
    const overlap = (p: DOMRect, q: DOMRect) => {
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      return w > 1 && h > 1 ? Math.round(Math.min(w, h)) : 0;
    };
    const overlaps: string[] = [];
    for (const [a, re] of rules) {
      const ea = els.get(a);
      if (!ea) continue;
      for (const [b, eb] of els) {
        if (b === a || !re.test(b)) continue;
        // The tray belongs to the button it opens from: it may lie by it, never over it (checked from the button's side).
        if (a === 'tray' && b === 'react') continue;
        const px = overlap(box(ea), box(eb));
        if (px) overlaps.push(`${a}×${b} ${px}px`);
      }
    }
    // A tap at the middle: the wallet's text, the reaction button (before: at its badge, where the eye says to tap; the
    // badge itself takes no taps, the plate's button under it does), each of the tray's reactions.
    const covered: string[] = [];
    const reach = (id: string, el: Element, target: Element) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > vw - 1 || y > vh - 1) return;
      const hit = document.elementFromPoint(x, y);
      if (hit && !target.contains(hit)) covered.push(`${id} by ${hit.closest('[data-testid]')?.getAttribute('data-testid') ?? hit.tagName.toLowerCase()}`);
    };
    const wallet = els.get('wallet');
    if (wallet) reach('wallet', wallet, wallet.parentElement!);
    const react = els.get('react');
    if (react && opener) reach('react', react, opener);
    document.querySelectorAll('[data-testid=react-tray] button').forEach((b) => reach(b.getAttribute('data-testid') ?? 'tray-button', b, b));
    const offscreen: string[] = [];
    for (const id of ['wallet', 'react', 'tray', 'leave', 'action-bar']) {
      const el = els.get(id);
      if (!el) continue;
      const r = box(el);
      const out = Math.max(-r.left, r.right - vw, -r.top, r.bottom - vh, 0);
      if (out > 0.5) offscreen.push(`${id} ${Math.round(out)}px`);
    }
    const boxes: Record<string, Box> = {};
    for (const [id, el] of els) {
      const r = box(el);
      boxes[id] = { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    }
    const own = opener?.getBoundingClientRect();
    return { boxes, overlaps, covered, offscreen, react: own ? `${Math.round(own.width)}×${Math.round(own.height)}` : null };
  }, mine);
}

/** Checks, else folds: the player keeps their chips through every screen. */
async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  const check = bar.getByRole('button', { name: /^(체크|Check)$/ });
  if (await check.isVisible().catch(() => false)) {
    await check.click().catch(() => {});
    return;
  }
  const fold = bar.getByRole('button', { name: /^(폴드|Fold)$/ });
  if (await fold.isVisible().catch(() => false)) await fold.click().catch(() => {});
}

interface Found {
  screen: string;
  state: string;
  probe: Probe;
}

/**
 * Sits down at `table` with `seats` taken (bots fill the rest), then opens it on each screen in turn and looks at it in
 * each state. Returns what was found, everything measured written next to the test's screenshots.
 */
async function walk(browser: Browser, table: string, seats: number, screens: Screen[], o: { nick?: string; wallet?: number } = {}) {
  const { page, nickname } = await signUp(browser, o.nick ? { nick: o.nick } : {});
  await sitWith(page, table, 1000);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(seats, { timeout: 120_000 });
  const state = await page.context().storageState();
  await page.goto('/');
  const found: Found[] = [];

  for (const sc of screens) {
    const touch = !!sc.touch;
    const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    if (sc.locale === 'en') await p.addInitScript(() => localStorage.setItem('jc.locale', 'en'));
    // A big wallet and English as the account's own choice (signing in sets the page to it), as the page is told them:
    // only what it shows, nothing is paid, taken or saved.
    if (o.wallet || sc.locale)
      await p.route('**/api/auth/me', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), ...(o.wallet ? { balance: o.wallet } : {}), ...(sc.locale ? { locale: sc.locale } : {}) } });
      });
    await p.goto(`/table/${table}`);
    await expect(filled(p)).toHaveCount(seats);
    await expect(p.locator('html')).toHaveAttribute('lang', sc.locale ?? 'ko');
    const mine = (await filled(p).filter({ has: p.getByText(nickname, { exact: true }) }).getAttribute('data-testid'))!.slice(5);
    const bar = p.getByTestId('action-bar');
    const shot = (state: string) => p.screenshot({ path: test.info().outputPath(`overlap-${table}-${sc.name}${sc.locale ? `-${sc.locale}` : ''}-${state}.png`) });
    const look = async (state: string) => {
      const r = await probe(p, mine);
      found.push({ screen: sc.name + (sc.locale ? `-${sc.locale}` : ''), state, probe: r });
      expect(await widerThanDevice(p), `${sc.name} ${state}: page wider than the screen`).toBe(false);
      await shot(state);
      return r;
    };
    // Off my turn, as long as it stays so while measured (else play it and look again).
    const offTurn = async (state: string, before?: () => Promise<void>) => {
      await expect(async () => {
        if (await bar.isVisible()) await act(p);
        await expect(bar).toBeHidden({ timeout: 2_000 });
        await before?.();
        const at = found.length;
        await look(state);
        if (await bar.isVisible()) {
          found.splice(at);
          throw new Error('my turn came while measuring');
        }
      }).toPass({ timeout: 120_000 });
    };

    await offTurn('waiting');
    const opener = p.getByTestId('react-open');
    if (await opener.count()) {
      await offTurn('tray', async () => {
        if (!(await p.getByTestId('react-tray').isVisible())) await (touch ? opener.tap() : opener.click());
        await expect(p.getByTestId('react-tray')).toBeVisible({ timeout: 2_000 });
      });
      await p.keyboard.press('Escape');
      await expect(p.getByTestId('react-tray')).toHaveCount(0);
    }
    // On my turn: the bar, then the raise panel when the turn offers it.
    await expect(bar).toBeVisible({ timeout: 120_000 });
    await p.waitForTimeout(400);
    await look('turn');
    const raise = bar.locator('button[aria-expanded]');
    if (await raise.isVisible()) {
      await raise.click();
      await expect(bar.getByTestId('action-commit')).toBeVisible();
      await p.waitForTimeout(200);
      await look('raise');
      await raise.click();
    }
    await act(p);
    // A phone's chat covers the table: what is typed is on top of everything.
    if (sc.viewport.width < 1024) {
      await p.getByRole('button', { name: /^(채팅|Chat)$/ }).click();
      const input = p.getByTestId('chat-input');
      await expect(input).toBeVisible();
      const hit = await input.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      });
      found.push({ screen: sc.name, state: 'chat', probe: { boxes: {}, overlaps: [], covered: hit ? [] : ['chat-input'], offscreen: [], react: null } });
      await shot('chat');
      await p.getByRole('button', { name: /^(닫기|Close)$/ }).first().click();
    }
    await ctx.close();
  }

  await page.goto(`/table/${table}`);
  await expect(filled(page)).toHaveCount(seats);
  await standUp(page);
  await page.context().close();
  return found;
}

/** Every pair that met, as one list, after writing everything measured for the report (TEST_REPORT). */
async function report(name: string, found: Found[]) {
  const issues = found.flatMap((f) => [...f.probe.overlaps, ...f.probe.covered.map((c) => `covered ${c}`), ...f.probe.offscreen.map((c) => `offscreen ${c}`)].map((x) => `${f.screen} ${f.state}: ${x}`));
  await test.info().attach(`${name}.json`, { body: JSON.stringify({ issues, found }, null, 1), contentType: 'application/json' });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('test-results/overlap', { recursive: true });
  writeFileSync(`test-results/overlap/${name}.json`, JSON.stringify({ issues, found }, null, 1));
  expect(issues, name).toEqual([]);
}

test('6인 테이블, 휴대폰부터 FHD까지 11개 화면: 지갑·반응 버튼·트레이·액션바가 내 카드와 좌석, 서로를 가리지 않는다', async ({ browser }) => {
  test.setTimeout(1_200_000);
  await report('six', await walk(browser, 'e2e-ov6', 6, SCREENS));
});

test('9인과 2인 테이블: 이웃 좌석이 가까워도 지갑·반응 버튼·트레이가 겹치지 않는다', async ({ browser }) => {
  test.setTimeout(1_200_000);
  const nine = await walk(browser, 'e2e-ov9', 9, pick('320x568', '390x844', '768x1024', '1366x768', '844x390-side'));
  const two = await walk(browser, 'e2e-ov2', 2, pick('360x640', '1024x768', '1920x1080', '667x375-side'));
  await report('nine-two', [...nine, ...two]);
});

/**
 * The column at a short screen's side scrolls when what it holds is taller than the screen. With the beginner aids above
 * the turn's buttons on a phone held sideways, opening the raise panel makes it so (asserted, else this proves nothing):
 * the bar and the panel lie whole on the screen and every control of them takes a tap at its middle, and what was
 * scrolled up is still there to scroll back to.
 */
test('가로 휴대폰에서 오른쪽 열이 화면보다 길어도: 내 차례의 버튼과 레이즈 패널은 잘리지 않고 위의 줄은 스크롤로 닿는다', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  await setAccountPrefs(page, { beginner: true });
  await sitWith(page, 'e2e-ov2', 1000);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(2, { timeout: 120_000 });
  const state = await page.context().storageState();
  await page.goto('/');
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto('/table/e2e-ov2');
  await expect(filled(p)).toHaveCount(2);
  const bar = p.getByTestId('action-bar');
  const raise = bar.locator('button[aria-expanded]');

  // A turn that offers a raise (else play it and wait for the next), the panel open.
  await expect(async () => {
    await expect(bar).toBeVisible({ timeout: 30_000 });
    if (!(await raise.isVisible())) {
      await act(p);
      throw new Error('no raise on this turn');
    }
  }).toPass({ timeout: 180_000 });
  await raise.tap();
  await expect(bar.getByTestId('action-commit')).toBeVisible();
  await p.waitForTimeout(200);

  const seen = await p.evaluate(() => {
    const col = document.querySelector('[data-testid=table-stack]')!;
    const bar = document.querySelector('[data-testid=action-bar]')!;
    const vh = innerHeight;
    const c = col.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const missed = Array.from(bar.querySelectorAll('button, input'))
      .filter((e) => {
        const b = e.getBoundingClientRect();
        if (b.width < 1) return false;
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !hit || !e.contains(hit);
      })
      .map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? e.tagName);
    return { overflows: col.scrollHeight > col.clientHeight + 1, scrolled: col.scrollTop, barTop: r.top - c.top, barBelow: r.bottom - Math.min(vh, c.bottom), missed };
  });
  await p.screenshot({ path: test.info().outputPath('overlap-column-667x375-beginner-raise.png') });
  // Scrolled back to the top, the column's first line is in it again.
  const firstBack = await p.evaluate(() => {
    const col = document.querySelector('[data-testid=table-stack]')!;
    col.scrollTop = 0;
    const first = Array.from(col.children).find((k) => k.getBoundingClientRect().height > 1 && getComputedStyle(k).clipPath === 'none');
    return first ? Math.round(first.getBoundingClientRect().top - col.getBoundingClientRect().top) : -1;
  });
  await p.screenshot({ path: test.info().outputPath('overlap-column-667x375-beginner-raise-top.png') });
  console.log(`column ${JSON.stringify({ ...seen, firstBack })}`);
  expect(seen.overflows, 'the column is taller than the screen here, else this proves nothing').toBe(true);
  expect(seen.barBelow, 'the bar ends inside the screen').toBeLessThanOrEqual(0.5);
  expect(seen.barTop, 'the bar starts inside the column').toBeGreaterThanOrEqual(-0.5);
  expect(seen.missed, 'every control of the bar and the panel takes a tap at its middle').toEqual([]);
  expect(seen.scrolled, 'what is above the bar was scrolled up').toBeGreaterThan(0);
  expect(firstBack, 'and is reached by scrolling back').toBeGreaterThanOrEqual(0);

  await ctx.close();
  await page.goto('/table/e2e-ov2');
  await expect(filled(page)).toHaveCount(2);
  await standUp(page);
  await page.context().close();
});

test('큰 지갑 잔액과 긴 닉네임, 한국어와 영어: 지갑이 줄바꿈 없이 자기 자리에 있고 반응 버튼과 겹치지 않는다', async ({ browser }) => {
  test.setTimeout(1_200_000);
  const screens = [...pick('320x568', '390x844', '768x1024', '1366x768'), { name: '320x568', viewport: { width: 320, height: 568 }, touch: true, locale: 'en' as const }];
  await report('big', await walk(browser, 'e2e-ov6', 6, screens, { nick: '가나다라마바사아', wallet: 9_876_543_210 }));
});
