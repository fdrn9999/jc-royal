// Where the time goes when the raise panel opens and closes on the player's turn (Chrome emulation on one PC, not a
// phone): each press is recorded with Chrome's JS sampling profiler, and the long tasks and React commits it caused are
// listed with the functions that ran longest (self time), and how many places the table and the player's seat were
// drawn in, read at every frame (2: it moved once; --places, a run of its own as reading them costs time). Function names
// are readable only in an unminified build (`pnpm --filter @jc/web exec vite build --minify false`); a minified build
// still gives the times. The E2E server reads the built files when it starts: restart it after a build.
//
// Usage (with the E2E server running): node tests/perf/panel-probe.mjs [--table e2e-nine] [--profile phone]
//   [--presses 6] [--places] [--out test-results/perf/panel-probe.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, arg, browser, IDLE, leave, openTable, r1, signUp, sit } from './common.mjs';

const table = arg('table', 'e2e-nine');
const profile = arg('profile', 'phone');
const presses = Number(arg('presses', '6'));
const countPlaces = process.argv.includes('--places');
const out = arg('out', `test-results/perf/panel-probe-${table}-${profile}.json`);
const instrument = resolve(dirname(fileURLToPath(import.meta.url)), 'instrument.js');

/** Self time per function (name, file and line) in a CPU profile, the longest first. */
function selfTimes(prof, top = 14) {
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  prof.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const file = (f.url.split('/').pop() ?? '').replace(/-[A-Za-z0-9_-]{8}\.js$/, '.js');
    const k = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const busy = [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k));
  return { busyMs: r1(busy.reduce((a, [, v]) => a + v, 0)), totalMs: r1(total), top: busy.sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, r1(v)]) };
}

async function waitForRaise(p, ms) {
  const bar = p.getByTestId('action-bar');
  const raise = bar.locator('button[aria-expanded]');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await bar.isVisible().catch(() => false)) {
      await p.waitForTimeout(400);
      if (await raise.isVisible().catch(() => false)) return raise;
      await act(p);
    }
    await p.waitForTimeout(400);
  }
  return null;
}

const home = await signUp();
await sit(home, table);
await home.goto(IDLE);
const state = await home.context().storageState();
const { ctx, p, cdp, errors, pr } = await openTable(state, table, profile, instrument);
await p.waitForTimeout(3_000);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });

const report = { table, profile, cpuThrottle: pr.cpu, note: 'Chrome emulation on one PC, not a phone.', presses: [], errors };
const raise = await waitForRaise(p, 120_000);
if (!raise) throw new Error('no raise button came up');
const mine = await p.evaluate(() => [...document.querySelectorAll('[data-testid=table] [data-testid^="seat-"][data-state]')].find((e) => e.querySelector('[data-testid^="timer"], [data-tour=timer]'))?.getAttribute('data-testid') ?? null);
for (let i = 0; i < presses; i++) {
  const t0 = await p.evaluate(() => (window.__jcPerf.reset(), performance.now()));
  // Where the table and the player's seat are drawn, read at every frame: each different place counts once. Reading
  // them lays the page out at every frame, which the profile then counts: asked for apart (--places).
  if (countPlaces) await p.evaluate((seat) => {
    const read = () =>
      [document.querySelector('[data-testid=table]'), seat && document.querySelector(`[data-testid="${seat}"]`)]
        .map((e) => {
          const r = e?.getBoundingClientRect();
          return r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(',') : '-';
        })
        .join('|');
    const steps = (window.__steps = [read()]);
    const tick = () => {
      const now = read();
      if (now !== steps[steps.length - 1]) steps.push(now);
      if (window.__steps === steps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, mine);
  await cdp.send('Profiler.start');
  await raise.click();
  await p.waitForTimeout(900);
  const { profile: prof } = await cdp.send('Profiler.stop');
  const places = countPlaces
    ? await p.evaluate(() => {
        const n = window.__steps.length;
        window.__steps = undefined;
        return n;
      })
    : null;
  const raw = await p.evaluate(() => window.__jcPerf);
  const frames = raw.frames.map((f) => f[1]);
  const entry = {
    press: i,
    opens: i % 2 === 0,
    // Where the table was, then each place it moved to: 2 when it moves once.
    places,
    longTasks: raw.longtasks.filter((x) => x[0] >= t0).map((x) => r1(x[1])),
    maxFrame: frames.length ? r1(Math.max(...frames)) : null,
    commits: raw.commits.map((c) => ({ at: r1(c[0] - t0), rendered: c[1] })),
    loaf: raw.loaf.map((l) => ({ at: r1(l.start - t0), dur: r1(l.dur), style: r1(l.style), scripts: l.scripts })),
    js: selfTimes(prof),
  };
  report.presses.push(entry);
  console.log(`press ${i} (${entry.opens ? 'open' : 'close'}): places ${places} longTasks ${JSON.stringify(entry.longTasks)} maxFrame ${entry.maxFrame} commits ${entry.commits.length} [${entry.commits.map((c) => c.rendered).join(',')}] js busy ${entry.js.busyMs}ms`);
  for (const [k, v] of entry.js.top.slice(0, 8)) console.log(`    ${v}ms  ${k}`);
}
await act(p);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
await ctx.close();
await leave(home, table);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
await browser.close();
