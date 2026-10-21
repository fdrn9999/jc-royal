// The street reveals at a live table in Chrome (emulated phone and desktop, not devices): for every state that brings a
// flop, turn or river, what the page does with it, from the message coming in to the cards turned. One player sits with
// the bots of a 9-, 6- and 2-seat table and checks or calls while the table plays; with --watch a second player only
// watches. Numbers only (instrument.js keeps no card, message or name). Times are the page's own clock
// (performance.now), so nothing here is a difference between two machines' clocks.
//
// Usage (with the E2E server running: `node tests/e2e/server.mjs` after `pnpm --filter @jc/web build`):
//   node tests/perf/reveal-probe.mjs [--label before] [--tables e2e-nine,e2e-phones,e2e-sound]
//     [--profiles phone,slowphone,desktop] [--seconds 60] [--think 1200] [--watch] [--trace] [--fold]
// Per reveal (ms after the message came in): the page's handler, the first commit and what it rendered, the card put
// in the page, its turn starting and ending, the first sound; frames slower than 25 ms and the slowest one, long tasks
// and long animation frames from just before it to 1.5 s after. --trace adds the main thread's time by event in that
// window, from a Chrome trace lined up by the mark instrument.js leaves at each reveal.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, arg, browser, flag, IDLE, leave, openTable, r1, signUp, sit, SEATS } from './common.mjs';

const label = arg('label', 'reveal');
const out = arg('out', `test-results/perf/${label}.json`);
const seconds = Number(arg('seconds', '60'));
const tables = arg('tables', 'e2e-nine,e2e-phones,e2e-sound').split(',');
const profiles = arg('profiles', 'phone,slowphone,desktop').split(',');
const watch = flag('watch');
const trace = flag('trace');
// Checking or folding, a heads-up player folds most hands before the flop and the bots' streets are few; calling keeps
// the player in, so the table sees its turns and rivers (and now and then an all-in run-out). `--fold` is the first.
const calls = !flag('fold');
// How long the player looks at a turn before acting (ms from first seeing its action bar). A player acting before the
// street's cards have turned cuts their staging short (the next state ends it); `--think 0` is that fast player.
const think = Number(arg('think', '1200'));
const seen = new Map();

/** Checks or calls (the same key, C), pressing again when a big call asks for a second press; `--fold`: act(). */
async function play(p) {
  const bar = p.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) {
    seen.delete(p);
    return false;
  }
  if (!seen.has(p)) seen.set(p, Date.now());
  if (Date.now() - seen.get(p) < think) return false;
  seen.delete(p);
  if (!calls) return act(p);
  const c = bar.locator('button[aria-keyshortcuts="C"]');
  if (!(await c.isVisible().catch(() => false))) return act(p);
  await c.click({ timeout: 2_000 }).catch(() => {});
  return true;
}
const instrument = resolve(dirname(fileURLToPath(import.meta.url)), 'instrument.js');

/** Frames, tasks and work this long before a reveal and after it are its own. */
const BEFORE = 200;
const AFTER = 1_500;
/** A frame this long missed at least one 60 Hz frame. */
const SLOW_FRAME = 25;

const pct = (xs, q) => {
  const v = xs.filter((x) => x != null);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return r1(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};
const sum = (xs) => r1(xs.reduce((a, b) => a + b, 0));
const stats = (xs) => ({ n: xs.filter((x) => x != null).length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) });

/** One reveal: what happened in the page from the message to the cards turned. */
function one(raw, r, nextAt) {
  const end = Math.min(r.at + AFTER, nextAt ?? Infinity);
  const after = (xs, from = r.at, to = end) => xs.filter((x) => x[0] >= from && x[0] < to);
  const commits = after(raw.commits);
  const first = commits[0];
  const board = after(raw.board, r.at, r.at + 2_500);
  const inserts = board.filter((b) => b[1] === 'insert');
  const ins = inserts[0];
  const starts = board.filter((b) => b[1] === 'start');
  const start = starts[0];
  const ends = board.filter((b) => b[1] === 'end');
  const sound = after(raw.sounds, r.at, r.at + 2_500)[0];
  const frames = raw.frames.filter((f) => f[0] >= r.at - BEFORE && f[0] < end);
  const flip = start ? raw.frames.filter((f) => f[0] >= start[0] && f[0] < (ends.at(-1)?.[0] ?? start[0] + 600)) : [];
  const lt = raw.longtasks.filter((x) => x[0] + x[1] >= r.at - BEFORE && x[0] < end);
  const lo = raw.loaf.filter((x) => x.start + x.dur >= r.at - BEFORE && x.start < end);
  const rendered = {};
  for (const c of commits) for (const [k, v] of Object.entries(c[4] ?? {})) rendered[k] = (rendered[k] ?? 0) + v;
  return {
    stages: r.stages.join('+'),
    bytes: r.bytes,
    cues: r.cues,
    handler: r.handler == null ? null : r1(r.handler),
    toFirstCommit: first ? r1(first[0] - r.at) : null,
    commits: commits.length,
    rendered: sum(commits.map((c) => c[1])),
    renderedFirst: first ? first[1] : null,
    seatsRendered: Object.entries(rendered).filter(([k]) => k.startsWith('#seat-')).reduce((a, [, v]) => a + v, 0),
    cardsRendered: rendered['div.jc-card'] ?? 0,
    toInsert: ins ? r1(ins[0] - r.at) : null,
    toFlipStart: start ? r1(start[0] - r.at) : null,
    toFlipEnd: ends.length ? r1(ends.at(-1)[0] - r.at) : null,
    flips: ends.length,
    // A card's turn started again after it began (the card gone back to its first frame mid-turn): more starts than
    // cards put in the page.
    restarts: Math.max(0, starts.length - inserts.length),
    toSound: sound ? r1(sound[0] - r.at) : null,
    slowFrames: frames.filter((f) => f[1] > SLOW_FRAME).length,
    worstFrame: frames.length ? r1(Math.max(...frames.map((f) => f[1]))) : null,
    flipSlowFrames: flip.filter((f) => f[1] > SLOW_FRAME).length,
    flipWorstFrame: flip.length ? r1(Math.max(...flip.map((f) => f[1]))) : null,
    longTasks: lt.length,
    longTaskMax: lt.length ? r1(Math.max(...lt.map((x) => x[1]))) : 0,
    loafBlocking: sum(lo.map((x) => x.blocking)),
    loafStyleLayout: sum(lo.map((x) => x.style)),
    loafScripts: lo.flatMap((x) => x.scripts).sort((a, b) => b.dur - a.dur).slice(0, 3),
    topRendered: Object.entries(rendered).sort((a, b) => b[1] - a[1]).slice(0, 6),
    // The timeline itself (ms after the message): commits and what each rendered, board card events, sounds.
    timeline: {
      commits: commits.map((c) => [r1(c[0] - r.at), c[1]]),
      board: board.map((b) => [r1(b[0] - r.at), b[1]]),
      sounds: after(raw.sounds, r.at, r.at + 2_500).map((x) => r1(x[0] - r.at)),
      slow: frames.filter((f) => f[1] > SLOW_FRAME).map((f) => [r1(f[0] - r.at), r1(f[1])]),
    },
  };
}

function summarize(list) {
  const by = {};
  for (const x of list) (by[x.stages] ??= []).push(x);
  const keys = ['handler', 'toFirstCommit', 'commits', 'rendered', 'renderedFirst', 'seatsRendered', 'cardsRendered', 'toInsert', 'toFlipStart', 'toFlipEnd', 'restarts', 'toSound', 'slowFrames', 'worstFrame', 'flipSlowFrames', 'flipWorstFrame', 'longTasks', 'longTaskMax', 'loafBlocking', 'loafStyleLayout'];
  return Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, Object.fromEntries([['n', xs.length], ...keys.map((m) => [m, stats(xs.map((x) => x[m]))])])]));
}

/** The main thread's time by event in each reveal's window, from a trace lined up by instrument.js's marks. */
function traceWindows(buf) {
  const ev = JSON.parse(buf.toString('utf8')).traceEvents ?? [];
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
  const marks = ev.filter((e) => e.name === 'jc-reveal' && e.cat?.includes('blink.user_timing')).map((e) => e.ts);
  const want = new Set(['RunTask', 'FunctionCall', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RasterTask', 'MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'ParseHTML', 'HitTest']);
  const main = ev.filter((e) => e.ph === 'X' && want.has(e.name) && /CrRendererMain|Compositor|Raster|GPU|Viz/.test(names.get(`${e.pid}:${e.tid}`) ?? ''));
  return [...new Set(marks)].map((ts) => {
    const by = {};
    let longest = 0;
    for (const e of main) {
      if (e.ts + (e.dur ?? 0) < ts - BEFORE * 1000 || e.ts > ts + AFTER * 1000) continue;
      const th = names.get(`${e.pid}:${e.tid}`) ?? '';
      const group = th === 'CrRendererMain' ? 'main' : /Raster/i.test(th) ? 'raster' : /Compositor/.test(th) ? 'compositor' : 'gpu';
      const k = `${group}:${e.name}`;
      by[k] = (by[k] ?? 0) + (e.dur ?? 0) / 1000;
      if (group === 'main' && e.name === 'RunTask') longest = Math.max(longest, (e.dur ?? 0) / 1000);
    }
    return { longestTask: r1(longest), ...Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, r1(v)])) };
  });
}

const report = {
  label,
  when: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim().length > 0,
  chrome: browser.version(),
  cpu: `${cpus()[0]?.model} ×${cpus().length}`,
  note: 'Chrome emulation on one PC (headless), not phones. phone = 390×844 DPR 3, 4× CPU throttling; slowphone = 375×667 DPR 2, 6×.',
  watch,
  policy: calls ? 'check or call' : 'check or fold',
  think,
  runs: [],
};

function save() {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
}

const home = await signUp();
// Watching: a second player opens the table without a seat, while the first one plays at it.
const viewer = watch ? await signUp() : null;
for (const id of tables) {
  await sit(home, id);
  if (!watch) await home.goto(IDLE);
  const state = await (viewer ?? home).context().storageState();
  if (viewer) await viewer.goto(IDLE);
  for (const name of profiles) {
    // A table that will not open as expected is noted, and the run goes on. A seat short is most often the player's own,
    // busted calling every street in the last run: they buy in again first.
    const open = () => openTable(state, id, name, instrument).catch((e) => ({ failed: String(e?.message ?? e) }));
    let opened = await open();
    if (opened.failed) {
      await sit(home, id).catch(() => {});
      if (!watch) await home.goto(IDLE);
      opened = await open();
    }
    if (opened.failed) {
      report.runs.push({ table: id, seats: SEATS[id], profile: name, failed: opened.failed });
      console.log(`${id} ${name}: not measured (${opened.failed})`);
      continue;
    }
    const { ctx, p, cdp, errors, pr } = opened;
    await p.waitForTimeout(3_000);
    await p.evaluate(() => window.__jcPerf.reset());
    if (trace) await browser.startTracing(p, { categories: ['devtools.timeline', 'blink.user_timing'] });
    const t0 = Date.now();
    let acted = 0;
    while (Date.now() - t0 < seconds * 1000) {
      if (await play(watch ? home : p)) acted++;
      await p.waitForTimeout(400);
    }
    const windows = trace ? traceWindows(await browser.stopTracing()) : null;
    const raw = await p.evaluate(() => window.__jcPerf);
    const reveals = raw.reveals.map((r, i) => one(raw, r, raw.reveals[i + 1]?.at));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    report.runs.push({ table: id, seats: SEATS[id], profile: name, cpuThrottle: pr.cpu, acted, summary: summarize(reveals), reveals, trace: windows, errors });
    const s = summarize(reveals);
    for (const [k, v] of Object.entries(s))
      console.log(`${id} ${name} ${k}: n ${v.n} handler p95 ${v.handler.p95} firstCommit p95 ${v.toFirstCommit.p95} rendered p50 ${v.rendered.p50} seats p50 ${v.seatsRendered.p50} insert p50 ${v.toInsert.p50} flip ${v.toFlipStart.p50}→${v.toFlipEnd.p50} restarts max ${v.restarts.max} slowFrames p95 ${v.slowFrames.p95} worst max ${v.worstFrame.max} flipWorst max ${v.flipWorstFrame.max} longTasks max ${v.longTasks.max}`);
    await ctx.close();
    // Written after every run, so a run that fails later keeps the ones before it.
    save();
  }
  await leave(home, id);
}

save();
console.log(`wrote ${out}`);
await browser.close();
