import { expect, type Page } from '@playwright/test';
import { setAccountPrefs, signUp, sitWith, standUp, test, widerThanDevice } from './helpers';
import { measureTable } from './table-layout';

/**
 * A beginner's aids at a live table, with bots in the other seats: the street's note, my current hand, the "you can"
 * line and its help, beside the turn's controls. On every screen the table is played on, phones upright and on their
 * side and a desktop at 125% and 150% zoom (its window less wide in CSS pixels, drawn finer), in Korean and English:
 * none of their text is cut (an ellipsis, a box too small for it, a parent that clips it or scrolls it out of sight;
 * only the guide's own body scrolls, `data-scroll`), each lies on the screen, and nothing of the dock covers a piece of
 * the table (measureTable). The guide opened from the "?" (a panel over the page) lies on the screen under the header,
 * its title and close button in sight, and covers none of the turn's controls, my cards or the turn's label.
 */
interface Screen {
  name: string;
  viewport: { width: number; height: number };
  scale?: number;
  touch?: boolean;
  locale?: 'en';
}
const PHONE = { touch: true };
const SCREENS: Screen[] = [
  { name: '320x568', viewport: { width: 320, height: 568 }, ...PHONE },
  { name: '320x568-en', viewport: { width: 320, height: 568 }, ...PHONE, locale: 'en' },
  { name: '360x640', viewport: { width: 360, height: 640 }, ...PHONE },
  { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE },
  { name: '390x844-en', viewport: { width: 390, height: 844 }, ...PHONE, locale: 'en' },
  { name: '430x932', viewport: { width: 430, height: 932 }, ...PHONE },
  { name: '768x1024', viewport: { width: 768, height: 1024 }, ...PHONE },
  { name: '1280x720', viewport: { width: 1280, height: 720 } },
  { name: '1280x720-125', viewport: { width: 1024, height: 576 }, scale: 1.25 },
  { name: '1280x720-150', viewport: { width: 853, height: 480 }, scale: 1.5 },
  { name: '1440x900', viewport: { width: 1440, height: 900 } },
  { name: '1440x900-en', viewport: { width: 1440, height: 900 }, locale: 'en' },
  { name: '1920x1080', viewport: { width: 1920, height: 1080 } },
  { name: '844x390-side', viewport: { width: 844, height: 390 }, ...PHONE },
  { name: '568x320-side', viewport: { width: 568, height: 320 }, ...PHONE },
];
const TABLE = 'e2e-dock-bots';

interface Cut {
  what: string;
  how: string;
}

/** Each line of text in the dock and the guide as drawn: cut short (ellipsis, clipped by a box round it) or off the screen. */
function cuts(page: Page): Promise<Cut[]> {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('[data-testid=table-stack], [data-testid=action-help]'));
    if (!roots.length) return [];
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const hidden = (e: Element) => {
      for (let x: Element | null = e; x; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.clipPath !== 'none' || (cs.clip !== 'auto' && cs.clip !== '')) return true;
      }
      return false;
    };
    const name = (e: Element) => {
      const id = e.closest('[data-testid]')?.getAttribute('data-testid') ?? '?';
      return `${id}:"${(e.textContent ?? '').trim().slice(0, 40)}"`;
    };
    const found: { what: string; how: string }[] = [];
    for (const e of roots.flatMap((r) => Array.from(r.querySelectorAll('*')))) {
      const own = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own || hidden(e)) continue;
      const range = document.createRange();
      range.selectNodeContents(e);
      const t = range.getBoundingClientRect();
      if (t.width < 1 || t.height < 1) continue;
      const cs = getComputedStyle(e);
      if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) found.push({ what: name(e), how: `ellipsis ${e.scrollWidth}>${e.clientWidth}` });
      if (Number(cs.webkitLineClamp) > 0 && e.scrollHeight > e.clientHeight + 1) found.push({ what: name(e), how: `line-clamp ${e.scrollHeight}>${e.clientHeight}` });
      for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) {
        const o = getComputedStyle(x);
        if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
        const r = x.getBoundingClientRect();
        const box = { l: r.left + x.clientLeft, t: r.top + x.clientTop, r: r.left + x.clientLeft + x.clientWidth, b: r.top + x.clientTop + x.clientHeight };
        const past = Math.max(box.l - t.left, t.right - box.r, box.t - t.top, t.bottom - box.b);
        if (past > 1) {
          const scrolls = /auto|scroll/.test(o.overflowY) && x.scrollHeight > x.clientHeight + 1;
          // The guide's body scrolls what it has no room for: that is its way, not a cut.
          if (scrolls && x.hasAttribute('data-scroll')) break;
          found.push({ what: name(e), how: `${scrolls ? 'scrolled out of' : 'clipped by'} ${x.getAttribute('data-testid') ?? x.tagName.toLowerCase() + '.' + (x.className.toString().split(' ')[0] ?? '')} by ${Math.round(past)}px` });
          break;
        }
      }
      const off = Math.max(-t.left, t.right - vw, -t.top, t.bottom - vh);
      if (off > 1) found.push({ what: name(e), how: `off the screen by ${Math.round(off)}px` });
    }
    return found;
  });
}

/** The guide open: on the screen and under the header, its title and close button in sight, over none of what the turn needs. */
function guide(page: Page, nickname: string): Promise<string[]> {
  return page.evaluate((nick) => {
    const g = document.querySelector('[data-testid=action-help]');
    if (!g) return ['guide not open'];
    const found: string[] = [];
    const r = g.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) found.push(`guide off the screen ${JSON.stringify(r)}`);
    const header = document.querySelector('header')?.getBoundingClientRect();
    if (header && r.top < header.bottom - 0.5) found.push(`guide over the header by ${Math.round(header.bottom - r.top)}px`);
    const seen = (e: Element | null, what: string) => {
      if (!e) return found.push(`${what} missing`);
      const b = e.getBoundingClientRect();
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!at || !(e === at || e.contains(at))) found.push(`${what} hidden under ${at?.closest('[data-testid]')?.getAttribute('data-testid') ?? at?.tagName}`);
    };
    seen(g.querySelector('[data-testid=action-help-close]'), 'close button');
    seen(g.querySelector('b'), 'title');
    const seat = Array.from(document.querySelectorAll('[data-testid=table] [data-testid^="seat-"][data-state]')).find((x) => x.querySelector('[data-testid=member-name]')?.textContent?.includes(nick));
    const keep: [string, Element | null | undefined][] = [
      ['action-bar', document.querySelector('[data-testid=action-bar]')],
      ['time-bank', document.querySelector('[data-testid=time-bank]')],
      ['turn-banner', document.querySelector('[data-testid=turn-banner]')],
      ...Array.from(seat?.querySelectorAll('.jc-card') ?? []).map((c, k) => [`my card ${k}`, c] as [string, Element]),
    ];
    for (const [what, e] of keep) {
      if (!e) continue;
      const b = e.getBoundingClientRect();
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (w > 0.5 && h > 0.5) found.push(`guide covers ${what} by ${Math.round(w)}x${Math.round(h)}`);
    }
    return found;
  }, nickname);
}

async function act(p: Page) {
  const bar = p.getByTestId('action-bar');
  for (const name of [/^(체크|Check)$/, /^(콜|Call)/, /^(폴드|Fold)$/]) {
    const b = bar.getByRole('button', { name });
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.click().catch(() => {});
    const again = bar.getByRole('button', { name: /^(한 번 더|Press again)/ });
    if (await again.isVisible().catch(() => false)) await again.click().catch(() => {});
    return;
  }
}

test('beginner aids: nothing in the dock is cut or off the screen, nothing covers the table, on every screen', async ({ browser }) => {
  test.setTimeout(1_500_000);
  const { page, nickname } = await signUp(browser);
  await setAccountPrefs(page, { beginner: true });
  await sitWith(page, TABLE, 200);
  const filled = (p: Page) => p.locator('[data-testid=table] [data-testid^="seat-"][data-state]');
  await expect(filled(page)).toHaveCount(4, { timeout: 120_000 });
  const state = await page.context().storageState();
  await page.goto('/');
  const report: string[] = [];
  const scene: string[] = [];

  for (const sc of SCREENS) {
    await test.step(sc.name, async () => {
      const touch = !!sc.touch;
      const ctx = await browser.newContext({ storageState: state, viewport: sc.viewport, deviceScaleFactor: sc.scale ?? (touch ? 2 : 1), isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      if (sc.locale === 'en')
        await p.route('**/api/auth/me', async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const res = await route.fetch();
          await route.fulfill({ response: res, json: { ...(await res.json()), locale: 'en' } });
        });
      await p.goto(`/table/${TABLE}`);
      await expect(filled(p)).toHaveCount(4);
      await expect(p.locator('html')).toHaveAttribute('lang', sc.locale ?? 'ko');
      const bar = p.getByTestId('action-bar');
      const look = async (what: string) => {
        const c = await cuts(p);
        const t = await measureTable(p);
        const wide = await widerThanDevice(p);
        for (const x of c) report.push(`${sc.name} ${what}: ${x.what} ${x.how}`);
        for (const x of t.issues) {
          // The guide the player opened lies over the table (other seats, the board): what it must not cover, guide() says.
          // What else covers the same piece is judged without it (a pot's chips over a seat's line beside the guide).
          const by = 'by' in x && typeof x.by === 'string' ? x.by.split(' | ') : [];
          const rest = by.filter((b) => !b.startsWith('action-help>'));
          if (x.kind === 'covered' && by.length && !rest.length) continue;
          // Pieces of the table over each other (the scene's own layout, where the screen leaves it less than it needs, aids or not) are listed apart.
          const own = x.kind === 'overlap' || (x.kind === 'covered' && rest.length > 0 && rest.every((b) => /^(seat-\d+|pot|bet-\d+|board)>/.test(b)));
          (own ? scene : report).push(`${sc.name} ${what}: table ${JSON.stringify(x)}`);
        }
        if (wide) report.push(`${sc.name} ${what}: page wider than the screen`);
        await p.screenshot({ path: test.info().outputPath(`beginner-${sc.name}-${what}.png`) });
      };
      // Waiting: the street's note and my hand.
      await expect(async () => {
        if (await bar.isVisible()) await act(p);
        await expect(bar).toBeHidden({ timeout: 2_000 });
        await expect(p.getByTestId('stage-note')).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 120_000 });
      await look('waiting');
      // My turn: the "you can" line, then its help open, then the raise panel.
      await expect(bar).toBeVisible({ timeout: 120_000 });
      await p.waitForTimeout(400);
      await look('turn');
      const toggle = p.getByTestId('action-help-toggle');
      if (await toggle.isVisible()) {
        await (touch ? toggle.tap() : toggle.click());
        await expect(p.getByTestId('action-help')).toBeVisible();
        await p.waitForTimeout(200);
        await look('help');
        for (const x of await guide(p, nickname)) report.push(`${sc.name} help: ${x}`);
        // Its close button closes it; the "?" opens it again, and closes it.
        const close = p.getByTestId('action-help-close');
        await (touch ? close.tap() : close.click());
        await expect(p.getByTestId('action-help')).toHaveCount(0);
        await (touch ? toggle.tap() : toggle.click());
        await expect(p.getByTestId('action-help')).toBeVisible();
        await (touch ? toggle.tap() : toggle.click());
        await expect(p.getByTestId('action-help')).toHaveCount(0);
      }
      const raise = bar.getByTestId('action-dock-toggle');
      if (await raise.isVisible()) {
        await raise.click();
        await expect(bar.locator('[data-raise-panel]')).toBeVisible();
        await p.waitForTimeout(200);
        await look('raise');
        await raise.click();
      }
      await act(p);
      await ctx.close();
    });
  }

  await page.goto(`/table/${TABLE}`);
  await standUp(page);
  await page.context().close();
  console.log(`beginner dock report (${report.length}):\n${report.join('\n')}`);
  // Not the aids': reported for the table's layout (TEST_REPORT), not failed here.
  console.log(`table scene overlaps, aids aside (${scene.length}):\n${scene.join('\n')}`);
  test.info().annotations.push({ type: 'table scene overlaps', description: scene.join('\n') || 'none' });
  expect(report).toEqual([]);
});
