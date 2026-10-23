// Live table performance in Chrome (emulated phone and desktop, not devices): one player sits with the bots of a 9-, 6-
// and 2-seat table and checks or folds while the table is measured. Writes numbers only (instrument.js keeps no card,
// message or name). The same run before and after a change, on the same machine, is what compares them.
//
// Usage (with the E2E server running: `node tests/e2e/server.mjs` after `pnpm --filter @jc/web build`):
//   node tests/perf/table-perf.mjs [--base http://127.0.0.1:8798] [--out test-results/perf/run.json] [--label before]
//     [--tables e2e-nine,e2e-phones,e2e-sound] [--profiles phone,slowphone,desktop] [--seconds 40] [--trace]
//     [--style variant.css]
// `--style` adds a stylesheet to the measured page: the same build with one rule turned off, to see what that rule costs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, arg, browser, flag, IDLE, leave, openTable, r1, signUp, sit, SEATS } from './common.mjs';

const label = arg('label', 'run');
const out = arg('out', `test-results/perf/${label}.json`);
const seconds = Number(arg('seconds', '40'));
const tables = arg('tables', 'e2e-nine,e2e-phones,e2e-sound').split(',');
const profiles = arg('profiles', 'phone,slowphone,desktop').split(',');
const style = arg('style', '');
const instrument = resolve(dirname(fileURLToPath(import.meta.url)), 'instrument.js');

const METRICS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'Nodes', 'JSEventListeners'];
async function metrics(cdp) {
  // After a collection, so the heap and the listener count are what is still held, not garbage waiting.
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.filter((x) => METRICS.includes(x.name)).map((x) => [x.name, x.value]));
}

const pct = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10;
};
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;

function summarize(raw, m0, m1, wall) {
  const dur = wall / 1000;
  const frames = (ph) => raw.frames.filter((f) => ph === undefined || f[2] === ph).map((f) => f[1]);
  const frameStats = (ph) => {
    const d = frames(ph);
    const time = sum(d) / 1000;
    return {
      n: d.length,
      fps: time ? r1(d.length / time) : null,
      p50: pct(d, 0.5),
      p95: pct(d, 0.95),
      p99: pct(d, 0.99),
      max: pct(d, 1),
      over34: d.filter((x) => x > 34).length,
      over50: d.filter((x) => x > 50).length,
      over100: d.filter((x) => x > 100).length,
    };
  };
  const commits = (ph) => raw.commits.filter((c) => ph === undefined || c[2] === ph);
  const phaseTime = (ph) => sum(frames(ph)) / 1000;
  const commitStats = (ph) => {
    const c = commits(ph);
    const t = ph === undefined ? dur : phaseTime(ph);
    return { n: c.length, perSec: t ? r1(c.length / t) : null, renderedMean: c.length ? r1(sum(c.map((x) => x[1])) / c.length) : 0, renderedP95: pct(c.map((x) => x[1]), 0.95), renderedMax: pct(c.map((x) => x[1]), 1), renderedPerSec: t ? r1(sum(c.map((x) => x[1])) / t) : null };
  };
  const invokers = {};
  for (const l of raw.loaf) for (const s of l.scripts) invokers[s.invoker] = r1((invokers[s.invoker] ?? 0) + s.dur);
  const acks = {};
  for (const [k, v] of raw.acks) (acks[k] ??= []).push(v);
  const d = (k) => m1[k] - m0[k];
  return {
    seconds: r1(dur),
    frames: { all: frameStats(), hand: frameStats(0), between: frameStats(1) },
    longTasks: { n: raw.longtasks.length, totalMs: sum(raw.longtasks.map((x) => x[1])), max: pct(raw.longtasks.map((x) => x[1]), 1), p95: pct(raw.longtasks.map((x) => x[1]), 0.95) },
    longAnimationFrames: {
      n: raw.loaf.length,
      blockingMs: sum(raw.loaf.map((x) => x.blocking)),
      styleLayoutMs: sum(raw.loaf.map((x) => x.style)),
      forcedLayoutMs: sum(raw.loaf.flatMap((x) => x.scripts.map((s) => s.forced))),
      topInvokers: Object.entries(invokers).sort((a, b) => b[1] - a[1]).slice(0, 8),
    },
    commits: { all: commitStats(), hand: commitStats(0), between: commitStats(1), hookMs: sum(raw.commits.map((c) => c[3])) },
    renderedBy: Object.entries(raw.labels).sort((a, b) => b[1] - a[1]).slice(0, 16),
    ws: { ...raw.ws, stateAvgBytes: raw.ws.states ? Math.round(raw.ws.stateBytes / raw.ws.states) : 0, statesPerSec: r1(raw.ws.states / dur) },
    receiveToCommit: { n: raw.toCommit.length, p50: pct(raw.toCommit, 0.5), p95: pct(raw.toCommit, 0.95), max: pct(raw.toCommit, 1) },
    receiveToFrame: { n: raw.toFrame.length, p50: pct(raw.toFrame, 0.5), p95: pct(raw.toFrame, 0.95), max: pct(raw.toFrame, 1) },
    ack: Object.fromEntries(Object.entries(acks).map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), max: pct(v, 1) }])),
    browser: {
      layouts: d('LayoutCount'),
      layoutsPerSec: r1(d('LayoutCount') / dur),
      styleRecalcs: d('RecalcStyleCount'),
      styleRecalcsPerSec: r1(d('RecalcStyleCount') / dur),
      layoutMs: r1(d('LayoutDuration') * 1000),
      styleMs: r1(d('RecalcStyleDuration') * 1000),
      scriptMs: r1(d('ScriptDuration') * 1000),
      taskMs: r1(d('TaskDuration') * 1000),
      mainThreadBusy: `${r1((d('TaskDuration') / dur) * 100)}%`,
      heapMB: [r1(m0.JSHeapUsedSize / 2 ** 20), r1(m1.JSHeapUsedSize / 2 ** 20)],
      nodes: [m0.Nodes, m1.Nodes],
      listeners: [m0.JSEventListeners, m1.JSEventListeners],
    },
  };
}

/** Main-thread and raster time by event name, from a short Chrome trace (inclusive durations, nested events overlap). */
function traceSummary(buf) {
  const ev = JSON.parse(buf.toString('utf8')).traceEvents ?? [];
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
  const want = new Set(['RunTask', 'FunctionCall', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RasterTask', 'GPUTask', 'ParseHTML', 'MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'ScheduleStyleRecalculation']);
  const by = {};
  for (const e of ev) {
    if (e.ph !== 'X' || !want.has(e.name)) continue;
    const th = names.get(`${e.pid}:${e.tid}`) ?? '?';
    const group = th === 'CrRendererMain' ? 'main' : /Compositor(TileWorker|Worker)|Raster/i.test(th) ? 'raster' : /Compositor/.test(th) ? 'compositor' : /GPU|Viz|CrGpuMain/i.test(th) ? 'gpu' : null;
    if (!group) continue;
    const k = `${group}:${e.name}`;
    by[k] = (by[k] ?? 0) + (e.dur ?? 0) / 1000;
  }
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r1(v)]));
}

async function waitForRaise(p, ms) {
  const bar = p.getByTestId('action-bar');
  const raise = bar.getByTestId('action-dock-toggle');
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

const report = {
  label,
  when: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim().length > 0,
  chrome: browser.version(),
  cpu: `${cpus()[0]?.model} ×${cpus().length}`,
  note: 'Chrome emulation on one PC (headless), not phones. phone = 390×844 DPR 3, 4× CPU throttling; slowphone = 375×667 DPR 2, 6×.',
  style: style || null,
  runs: [],
};

const home = await signUp();
for (const id of tables) {
  await sit(home, id);
  // One page at the table at a time, and the only page drawing: each measured page opens its own.
  await home.goto(IDLE);
  const state = await home.context().storageState();
  for (const name of profiles) {
    const { ctx, p, cdp, errors, pr } = await openTable(state, id, name, instrument);
    if (style) await p.addStyleTag({ content: readFileSync(style, 'utf8') });
    await p.waitForTimeout(3_000);

    // 1. Watching the table play (the player checks or folds on their turns).
    const m0 = await metrics(cdp);
    await p.evaluate(() => window.__jcPerf.reset());
    const t0 = Date.now();
    let acted = 0;
    while (Date.now() - t0 < seconds * 1000) {
      if (await act(p)) acted++;
      await p.waitForTimeout(600);
    }
    const wall = Date.now() - t0;
    const raw = await p.evaluate(() => window.__jcPerf);
    const m1 = await metrics(cdp);
    const play = { ...summarize(raw, m0, m1, wall), acted };

    // 2. The raise panel opened and closed three times on the player's turn.
    let panel = null;
    const raise = await waitForRaise(p, 120_000);
    if (raise) {
      const n0 = await metrics(cdp);
      await p.evaluate(() => window.__jcPerf.reset());
      const s0 = Date.now();
      for (let i = 0; i < 3; i++) {
        await raise.click();
        await p.waitForTimeout(700);
        await raise.click();
        await p.waitForTimeout(700);
      }
      const wall2 = Date.now() - s0;
      const raw2 = await p.evaluate(() => window.__jcPerf);
      panel = summarize(raw2, n0, await metrics(cdp), wall2);
      await act(p);
    }

    // 3. A short trace for where the main thread and raster time go.
    let trace = null;
    if (flag('trace')) {
      await browser.startTracing(p, { categories: ['devtools.timeline', 'v8'] });
      const s0 = Date.now();
      while (Date.now() - s0 < 12_000) {
        await act(p);
        await p.waitForTimeout(600);
      }
      trace = traceSummary(await browser.stopTracing());
    }

    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    report.runs.push({ table: id, seats: SEATS[id], profile: name, cpuThrottle: pr.cpu, play, panel, trace, errors });
    console.log(`${id} ${name}: fps ${play.frames.all.fps} p95 ${play.frames.all.p95}ms >50ms ${play.frames.all.over50} longTasks ${play.longTasks.n} commits/s ${play.commits.all.perSec} rendered/s ${play.commits.all.renderedPerSec} layouts/s ${play.browser.layoutsPerSec} busy ${play.browser.mainThreadBusy}`);
    await ctx.close();
  }
  await leave(home, id);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
await browser.close();
