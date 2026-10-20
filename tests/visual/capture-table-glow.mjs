// Visual grounding for the table's breathing glows (my seat's ring on my turn, the turn banner, the winner's plate) at a
// few moments of their breath, with motion and under reduced motion (Chrome emulation, not a device). Screenshots of
// the table only: they are for review, and a hand's cards on them are the player's own or a showdown's.
//
// Usage (E2E server running, as for tests/perf): node tests/visual/capture-table-glow.mjs [--table e2e-sound]
//   [--out test-results/visual/glow] [--views phone,desktop] [--motions no-preference,reduce] [--repeat 1] [--old-glow]
import { mkdirSync } from 'node:fs';
import { act, arg, base, browser, IDLE, leave, seatsShown, SEATS, signUp, sit } from '../perf/common.mjs';

const table = arg('table', 'e2e-sound');
const out = arg('out', 'test-results/visual/glow');
const views = arg('views', 'phone,desktop').split(',');
const motions = arg('motions', 'no-preference,reduce').split(',');
// Whole-table shots on the turn, a second apart.
const repeat = Number(arg('repeat', '1'));
// The glows as they were before they moved to a layer of their own (animated box-shadows), to compare against.
const OLD_GLOW = `
@keyframes old-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(230, 197, 107, 0.5); } 50% { box-shadow: 0 0 0 6px rgba(230, 197, 107, 0); } }
@keyframes old-winner { 0%, 100% { box-shadow: 0 0 0 2px var(--t-winner), 0 0 22px rgba(243, 221, 155, 0.45); } 50% { box-shadow: 0 0 0 2px var(--t-winner), 0 0 36px rgba(243, 221, 155, 0.75); } }
@keyframes old-turn { 0%, 100% { box-shadow: 0 0 0 2px var(--color-gold-400), 0 0 10px rgba(230, 197, 107, 0.35); } 50% { box-shadow: 0 0 0 2px var(--color-gold-400), 0 0 18px rgba(230, 197, 107, 0.7); } }
.jc-pulse-gold, .jc-winner, .jc-turn { isolation: auto !important; }
.jc-pulse-gold::after, .jc-winner::after, .jc-turn::after { content: none !important; }
.jc-pulse-gold { animation: old-pulse 1.6s ease-in-out infinite; }
.jc-winner { box-shadow: none; animation: old-winner 1.4s ease-in-out infinite; }
.jc-turn { box-shadow: 0 0 0 2px var(--color-gold-400), 0 0 12px rgba(230, 197, 107, 0.45); animation: old-turn 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .jc-pulse-gold, .jc-winner, .jc-turn { animation: none; } }`;
const oldGlow = process.argv.includes('--old-glow');
mkdirSync(out, { recursive: true });

const home = await signUp();
await sit(home, table);
await home.goto(IDLE);
const state = await home.context().storageState();
const shots = [];

for (const motion of motions) {
  for (const view of [
    { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  ].filter((v) => views.includes(v.name))) {
    const ctx = await browser.newContext({ storageState: state, viewport: view.viewport, deviceScaleFactor: view.deviceScaleFactor, isMobile: view.isMobile, hasTouch: view.hasTouch, reducedMotion: motion });
    const p = await ctx.newPage();
    await p.goto(`${base}/table/${table}`);
    if (oldGlow) await p.addStyleTag({ content: OLD_GLOW });
    await seatsShown(p, SEATS[table]);
    const tag = `${view.name}-${motion === 'reduce' ? 'reduced' : 'motion'}`;
    // My turn: the plate's ring at three moments of its 1.8s breath, then the banner (desktop: not in the seat).
    const bar = p.getByTestId('action-bar');
    await bar.waitFor({ timeout: 120_000 });
    const plate = p.locator('.jc-turn').first();
    await plate.waitFor({ timeout: 10_000 });
    const seat = p.locator('[data-testid^="seat-"]', { has: plate });
    for (const at of [0, 450, 900]) {
      if (at) await p.waitForTimeout(450);
      const f = `${out}/turn-${tag}-${at}ms.png`;
      await seat.screenshot({ path: f, animations: 'allow' });
      shots.push(f);
    }
    const banner = p.getByTestId('turn-banner');
    if (await banner.isVisible().catch(() => false)) {
      const f = `${out}/banner-${tag}.png`;
      await banner.screenshot({ path: f, animations: 'allow' });
      shots.push(f);
    }
    // The first page shot after element shots can draw a blurred plate black (Chrome's capture, not the page: it came
    // with the old glows too, and never on the shots after it): one thrown away first.
    await p.screenshot({ animations: 'allow' });
    for (let i = 0; i < repeat; i++) {
      if (i) await p.waitForTimeout(1_000);
      const f = `${out}/table-turn-${tag}${repeat > 1 ? `-${i}` : ''}.png`;
      await p.screenshot({ path: f, animations: 'allow' });
      shots.push(f);
    }
    // A winner's plate: the hand played out (check or fold) until a seat wins.
    const winner = p.locator('.jc-winner').first();
    for (let i = 0; i < 120 && !(await winner.isVisible().catch(() => false)); i++) {
      await act(p);
      await p.waitForTimeout(500);
    }
    if (await winner.isVisible().catch(() => false)) {
      const won = p.locator('[data-testid^="seat-"]', { has: winner });
      for (const at of [0, 700]) {
        if (at) await p.waitForTimeout(700);
        const g = `${out}/winner-${tag}-${at}ms.png`;
        await won.screenshot({ path: g, animations: 'allow' });
        shots.push(g);
      }
    }
    await ctx.close();
  }
}
await leave(home, table);
console.log(shots.join('\n'));
await browser.close();
