// Visual grounding for a winner's voluntary show (web reveal.ts, Seat.tsx): two members at the E2E server's e2e-show
// table; B folds, A wins the hand uncontested and shows both cards; B's page (phone or desktop, with motion or reduced
// motion; Chrome emulation, not a device) is caught at moments of the slide by pausing its animations, then at rest, and
// A's own page at rest. Also checks the cards at rest lie clear of the board and every seat, inside the screen.
//
// Usage (E2E server running, as for tests/perf): node tests/visual/capture-reveal.mjs [--out test-results/visual/reveal]
//   [--views phone,desktop] [--motions no-preference,reduce]
import { mkdirSync, writeFileSync } from 'node:fs';
import { arg, base, browser, IDLE, leave, signUp, sit } from '../perf/common.mjs';

const table = 'e2e-show';
const out = arg('out', 'test-results/visual/reveal');
const views = arg('views', 'phone,desktop').split(',');
const motions = arg('motions', 'no-preference,reduce').split(',');
mkdirSync(out, { recursive: true });

const VIEWS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

async function click(p, names) {
  const bar = p.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  for (const name of names) {
    const b = bar.getByRole('button', { name });
    if (await b.isVisible().catch(() => false)) {
      await b.click({ timeout: 2_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** The cards at rest against the board and the seats (their own boxes, not what they hold), as drawn on the page. */
function restCheck(p) {
  return p.evaluate(() => {
    const crosses = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const group = document.querySelector('[data-testid^="reveal-"]');
    if (!group) return null;
    const cards = [...group.querySelectorAll('.jc-card')].map((c) => c.getBoundingClientRect());
    const board = document.querySelector('[data-testid=board]').getBoundingClientRect();
    const seats = [...document.querySelectorAll('[data-testid=table] [data-testid^="seat-"][data-state]')].map((s) => ({ id: s.dataset.testid, r: s.getBoundingClientRect() }));
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    return {
      reveal: group.dataset.testid,
      cards: cards.map((r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })),
      boardCard: Math.round(document.querySelector('[data-testid=board] .jc-card').getBoundingClientRect().width),
      overBoard: cards.some((r) => crosses(r, board)),
      overSeats: seats.filter((s) => cards.some((r) => crosses(r, s.r))).map((s) => s.id),
      inside: cards.every((r) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh),
    };
  });
}

const a = await signUp();
const b = await signUp();
await sit(a, table);
await sit(b, table);
const bState = await b.context().storageState();
await b.goto(IDLE);
const results = [];

for (const motion of motions)
  for (const view of views) {
    const tag = `${view}-${motion === 'reduce' ? 'reduced' : 'motion'}`;
    const ctx = await browser.newContext({ storageState: bState, ...VIEWS[view], reducedMotion: motion });
    const p = await ctx.newPage();
    await p.goto(`${base}/table/${table}`);
    await p.locator('[data-testid=table] [data-testid^="seat-"][data-state]').nth(1).waitFor({ timeout: 30_000 });
    const mine = a.locator('[data-testid^="seat-"]:has([data-testid="show-cards"])');
    // Each animation that starts in a winner's reveal is held at its start, to be set to moments of it below.
    await p.evaluate(() => {
      window.__held = [];
      document.addEventListener('animationstart', (e) => {
        if (!(e.target instanceof Element) || !e.target.closest('[data-testid^="reveal-"]')) return;
        for (const x of e.target.getAnimations()) if (!window.__held.includes(x)) (x.pause(), window.__held.push(x));
      });
    });
    let shown = false;
    for (let i = 0; i < 400 && !shown; i++) {
      // A won uncontested: show both cards.
      if ((await mine.locator('.jc-winner').count().catch(() => 0)) > 0 && (await a.getByTestId('show-card-both').isVisible().catch(() => false))) {
        await a.getByTestId('show-card-both').click();
        shown = true;
        break;
      }
      // B folds where it would have to call (its small blind) and checks where it may; A checks or calls. So A wins
      // B's small blind uncontested every other hand.
      const check = await p.getByTestId('action-bar').getByRole('button', { name: /^(체크|Check)$/ }).isVisible().catch(() => false);
      (await click(p, [check ? /^(체크|Check)$/ : /^(폴드|Fold)$/])) || (await click(a, [/^(체크|Check)$/, /^(콜|Call)/]));
      await p.waitForTimeout(300);
    }
    if (!shown) throw new Error(`${tag}: A never won a hand to show`);
    const group = p.locator('[data-testid^="reveal-"]');
    await group.locator('[data-card]').first().waitFor({ timeout: 5_000 });
    const frames = [];
    if (motion !== 'reduce') {
      // The slide (and the cards' flip in it), held as it started.
      await p.waitForFunction(() => window.__held.length > 0, null, { timeout: 3_000 }).catch(() => {});
      const held = await p.evaluate(() => window.__held.map((x) => x.animationName ?? '?'));
      for (const t of [0, 120, 280, 450, 700]) {
        await p.evaluate((ms) => window.__held.forEach((x) => (x.currentTime = ms)), t);
        const f = `${out}/slide-${tag}-${t}ms.png`;
        await p.screenshot({ path: f, animations: 'allow' });
        frames.push(f);
      }
      await p.evaluate(() => window.__held.forEach((x) => x.finish()));
      results.push({ tag, held });
    }
    await p.waitForTimeout(300);
    const rest = `${out}/rest-${tag}.png`;
    await p.screenshot({ path: rest, animations: 'disabled' });
    const own = `${out}/winner-own-${tag}.png`;
    await a.screenshot({ path: own, animations: 'disabled' });
    results.push({ tag, frames, rest, own, check: await restCheck(p), ownCheck: await restCheck(a) });
    // The next deal takes them away.
    const gone = await group.waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false);
    results.push({ tag, goneAtNextDeal: gone });
    await ctx.close();
  }

await leave(a, table);
const bPage = await (await browser.newContext({ storageState: bState })).newPage();
await leave(bPage, table);
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
