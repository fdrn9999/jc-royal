// A player's own presses at a live table in Chrome (emulated phone and desktop, not devices): for every check or call
// pressed in the action bar, how long until the frame that showed it (the browser's Event Timing), what React rendered
// for it and the frame it fell in. One player sits with the bots of a 9-, 6- and 2-seat table, as in reveal-probe.mjs.
// Numbers only (instrument.js keeps no card, message or name), on the page's own clock.
//
// Usage (with the E2E server running: `node tests/e2e/server.mjs` after `pnpm --filter @jc/web build`):
//   node tests/perf/press-probe.mjs [--label press] [--tables e2e-nine,e2e-phones,e2e-sound]
//     [--profiles phone,slowphone,desktop] [--seconds 60] [--think 1200]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, arg, browser, IDLE, leave, openTable, r1, signUp, sit, SEATS } from './common.mjs';

const label = arg('label', 'press');
const out = arg('out', `test-results/perf/${label}.json`);
const seconds = Number(arg('seconds', '60'));
const tables = arg('tables', 'e2e-nine,e2e-phones,e2e-sound').split(',');
const profiles = arg('profiles', 'phone,slowphone,desktop').split(',');
const think = Number(arg('think', '1200'));
const seen = new Map();
const instrument = resolve(dirname(fileURLToPath(import.meta.url)), 'instrument.js');

/** Checks or calls (key C) once the bar has been up `think` ms; a big call's second press is a press of its own. */
async function play(p) {
  const bar = p.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) {
    seen.delete(p);
    return false;
  }
  if (!seen.has(p)) seen.set(p, Date.now());
  if (Date.now() - seen.get(p) < think) return false;
  seen.delete(p);
  const c = bar.locator('button[aria-keyshortcuts="C"]');
  if (!(await c.isVisible().catch(() => false))) return act(p);
  await c.click({ timeout: 2_000 }).catch(() => {});
  return true;
}

const pct = (xs, q) => {
  const v = xs.filter((x) => x != null);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return r1(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};
const stats = (xs) => ({ n: xs.filter((x) => x != null).length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) });

/** One press: the click's Event Timing entry, the commits in the 300 ms after it and the frame it fell in. */
function one(raw, at) {
  // Matched by when its handlers began (when instrument.js saw the press): a slow pointerdown before it moves that, not
  // the input's own time.
  const began = (e) => Math.abs(e.start + e.delay - at);
  const ev = raw.events.filter((e) => e.name === 'click' && began(e) < 30).sort((a, b) => began(a) - began(b))[0];
  const commits = raw.commits.filter((c) => c[0] >= at && c[0] < at + 300);
  const first = commits[0];
  const rendered = {};
  for (const c of commits) for (const [k, v] of Object.entries(c[4] ?? {})) rendered[k] = (rendered[k] ?? 0) + v;
  const frame = raw.frames.find((f) => f[0] > at);
  // A state the server sent within the press's frame (its answer, or the street it ended) is drawn in it too.
  const state = raw.reveals.some((r) => r.at >= at && r.at < (frame?.[0] ?? at + 50));
  const lo = raw.loaf.filter((x) => x.start <= at && x.start + x.dur >= at);
  return {
    // Event Timing: the input to the frame painted after its handlers (rounded by the browser to 8 ms) and its parts.
    toPaint: ev ? ev.dur : null,
    inputDelay: ev ? r1(ev.delay) : null,
    handlers: ev ? r1(ev.run) : null,
    toFirstCommit: first ? r1(first[0] - at) : null,
    firstRendered: first ? first[1] : null,
    commitMs: first ? r1(first[3]) : null,
    commits: commits.length,
    rendered: commits.reduce((a, c) => a + c[1], 0),
    seatsRendered: Object.entries(rendered).filter(([k]) => k.startsWith('#seat-')).reduce((a, [, v]) => a + v, 0),
    frame: frame ? r1(frame[1]) : null,
    streetInFrame: state,
    loafScripts: lo.flatMap((x) => x.scripts).sort((a, b) => b.dur - a.dur).slice(0, 3),
    loafStyleLayout: r1(lo.reduce((a, x) => a + x.style, 0)),
    topRendered: Object.entries(rendered).sort((a, b) => b[1] - a[1]).slice(0, 8),
    timeline: commits.map((c) => [r1(c[0] - at), c[1]]),
  };
}

const report = {
  label,
  when: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim().length > 0,
  chrome: browser.version(),
  note: 'Chrome emulation on one PC (headless), not phones. phone = 390×844 DPR 3, 4× CPU throttling; slowphone = 375×667 DPR 2, 6×.',
  think,
  runs: [],
};

const home = await signUp();
for (const id of tables) {
  await sit(home, id);
  await home.goto(IDLE);
  const state = await home.context().storageState();
  for (const name of profiles) {
    const opened = await openTable(state, id, name, instrument).catch((e) => ({ failed: String(e?.message ?? e) }));
    if (opened.failed) {
      report.runs.push({ table: id, seats: SEATS[id], profile: name, failed: opened.failed });
      console.log(`${id} ${name}: not measured (${opened.failed})`);
      continue;
    }
    const { ctx, p, cdp, errors, pr } = opened;
    await p.waitForTimeout(3_000);
    await p.evaluate(() => window.__jcPerf.reset());
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await play(p);
      await p.waitForTimeout(400);
    }
    await p.waitForTimeout(500);
    const raw = await p.evaluate(() => window.__jcPerf);
    const presses = raw.presses.map((at) => one(raw, at));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const keys = ['toPaint', 'inputDelay', 'handlers', 'toFirstCommit', 'firstRendered', 'commitMs', 'rendered', 'seatsRendered', 'frame'];
    const summary = Object.fromEntries(keys.map((k) => [k, stats(presses.map((x) => x[k]))]));
    report.runs.push({ table: id, seats: SEATS[id], profile: name, cpuThrottle: pr.cpu, summary, presses, errors });
    console.log(`${id} ${name}: presses ${presses.length} toPaint p50 ${summary.toPaint.p50} p95 ${summary.toPaint.p95} max ${summary.toPaint.max} · handlers p95 ${summary.handlers.p95} · first commit rendered p50 ${summary.firstRendered.p50} (${summary.commitMs.p95} ms p95) · seats p50 ${summary.seatsRendered.p50} · frame p95 ${summary.frame.p95}`);
    await ctx.close();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
  await leave(home, id);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
await browser.close();
