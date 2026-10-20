// Where a live table's paint time goes (Chrome emulation, not a device): which elements Chrome repaints while hands
// play, which animations keep running, and how much paint, layer and raster time is left with each suspect turned off
// by a stylesheet. The variants take turns on one page, round after round, so they see the same table and the same
// machine. Numbers and element labels only (tag, test id, classes): no card, name or message.
//
// Usage (E2E server running, as for table-perf.mjs):
//   node tests/perf/paint-probe.mjs [--table e2e-nine] [--profile desktop] [--seconds 12] [--rounds 2] [--variants as_is,no_glow]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { act, arg, base, browser, IDLE, leave, openTable, PROFILES, r1, signUp, sit } from './common.mjs';

async function openPage(path, name) {
  const pr = PROFILES[name];
  const ctx = await browser.newContext({ viewport: pr.viewport, deviceScaleFactor: pr.deviceScaleFactor, isMobile: pr.isMobile, hasTouch: pr.hasTouch });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  await p.goto(path.startsWith('about:') ? path : `${base}${path}`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: pr.cpu });
  return { ctx, p, cdp, errors, pr };
}

const table = arg('table', 'e2e-nine');
const profile = arg('profile', 'desktop');
const seconds = Number(arg('seconds', '12'));
const rounds = Number(arg('rounds', '2'));
const out = arg('out', `test-results/perf/paint-${table}-${profile}.json`);

// Each suspect, turned off.
const ALL = {
  as_is: '',
  no_glow: '.jc-winner,.jc-turn,.jc-pulse-gold,.animate-pulse,.jc-winner::after,.jc-turn::after,.jc-pulse-gold::after{animation:none!important}',
  no_blur: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  no_timer: '[data-tour=timer]{visibility:hidden!important}',
  no_card_anim: '.jc-flip-in,.jc-deal-in{animation:none!important}',
  // Halves, to narrow down what is left.
  still: '*,*::before,*::after{animation:none!important;transition:none!important}',
  no_table: '[data-testid=table]{visibility:hidden!important}',
  no_seats: '[data-testid=table] [data-testid^="seat-"]{visibility:hidden!important}',
  no_cards: '[data-testid=table] .jc-card{visibility:hidden!important}',
  no_chips: '[data-testid=table] .jc-chip-pile{visibility:hidden!important}',
  no_felt: '[data-testid=table] > .rounded-\\[50\\%\\]{visibility:hidden!important}',
  no_shadows: '[data-testid=table] *{box-shadow:none!important;filter:none!important}',
};
const variants = arg('variants', Object.keys(ALL).join(',')).split(',');

const MAIN = ['FunctionCall', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit'];

function summary(ev) {
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
  const main = {};
  let raster = 0;
  let gpu = 0;
  let paints = 0;
  const byNode = new Map();
  for (const e of ev) {
    if (e.ph !== 'X') continue;
    const th = names.get(`${e.pid}:${e.tid}`) ?? '';
    const ms = (e.dur ?? 0) / 1000;
    if (th === 'CrRendererMain' && MAIN.includes(e.name)) {
      main[e.name] = (main[e.name] ?? 0) + ms;
      if (e.name === 'Paint') {
        paints++;
        const d = e.args?.data ?? {};
        const id = d.nodeId;
        if (id) {
          // The clip: the area repainted (a quad, px), and the layer it is painted into.
          const q = d.clip ?? [];
          const area = q.length === 8 ? `${Math.round(Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]))}x${Math.round(Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]))}` : '?';
          const n = byNode.get(id) ?? { ms: 0, n: 0, area, layer: d.layerId ?? null };
          n.ms += ms;
          n.n++;
          byNode.set(id, n);
        }
      }
    } else if (/Compositor(TileWorker|Worker)|Raster/i.test(th) && e.name === 'RasterTask') raster += ms;
    else if (/GPU|Viz|CrGpuMain/i.test(th) && e.name === 'GPUTask') gpu += ms;
  }
  return { main: Object.fromEntries(Object.entries(main).map(([k, v]) => [k, r1(v)])), raster: r1(raster), gpu: r1(gpu), paints, byNode };
}

// --invalidations: also why Chrome repaints (its invalidation tracking: which element, for what reason), by count.
const invalidations = process.argv.includes('--invalidations');
function invalidated(ev) {
  const by = new Map();
  for (const e of ev) {
    if (!/InvalidationTracking$/.test(e.name)) continue;
    const d = e.args?.data ?? {};
    const k = `${e.name.replace('InvalidationTracking', '')} | ${d.nodeName ?? '?'} | ${d.reason ?? d.invalidationList?.[0]?.classes?.join?.(' ') ?? d.extraData ?? ''}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
}

/** A label for a painted element: its tag, test id and first classes. */
async function label(cdp, backendId) {
  try {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId: backendId });
    const a = {};
    for (let i = 0; i < (node.attributes ?? []).length; i += 2) a[node.attributes[i]] = node.attributes[i + 1];
    const cls = (a.class ?? '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
    return `${node.nodeName.toLowerCase()}${a['data-testid'] ? `#${a['data-testid'].replace(/\d+/g, 'N')}` : ''}${cls ? `.${cls}` : ''}`;
  } catch (e) {
    return `(node ${backendId}: ${String(e.message ?? e).slice(0, 60)})`;
  }
}

/** The animations running now, by name and element (the page's own document.getAnimations()). */
const running = () =>
  document.getAnimations().filter((x) => x.playState === 'running').map((x) => {
    const el = x.effect?.target;
    const tid = el?.closest?.('[data-testid]')?.getAttribute('data-testid')?.replace(/\d+/g, 'N') ?? '';
    const name = x.animationName ?? x.transitionProperty ?? 'waapi';
    const iter = x.effect?.getTiming?.().iterations;
    return `${name}${iter === Infinity ? '(infinite)' : ''} @${el?.tagName?.toLowerCase() ?? '?'}${tid ? `#${tid}` : ''}`;
  });

/** The same with each animation's timing and its element's place (which seat, which card), for a closer look. */
const timings = () =>
  document.getAnimations().filter((x) => x.playState === 'running' && x.effect?.getTiming?.().iterations !== Infinity).map((x) => {
    const el = x.effect?.target;
    const t = x.effect.getTiming();
    const seat = el?.closest?.('[data-testid^="seat-"]');
    return {
      name: x.animationName ?? x.transitionProperty ?? 'waapi',
      el: `${el?.tagName?.toLowerCase()}.${[...(el?.classList ?? [])].slice(0, 5).join('.')}`,
      seat: seat?.getAttribute('data-testid') ?? null,
      seatState: seat?.getAttribute('data-state') ?? null,
      delay: Math.round(t.delay),
      duration: Math.round(Number(t.duration)),
      fill: t.fill,
      currentTime: Math.round(Number(x.currentTime)),
      inlineDelay: el?.style?.animationDelay || null,
    };
  });

// --control <path>: the same windows on another page (signed out, no table), to tell the table's paint from the
// browser's own.
const control = arg('control', null);
const home = control ? null : await signUp();
if (home) {
  await sit(home, table);
  await home.goto(IDLE);
}
const { ctx, p, cdp, errors, pr } = home ? await openTable(await home.context().storageState(), table, profile) : await openPage(control, profile);
await cdp.send('DOM.getDocument', { depth: 0 });
await p.waitForTimeout(3_000);
await p.evaluate(() => document.head.append(Object.assign(document.createElement('style'), { id: 'paint-probe' })));

// --on-turn: each round is one of the player's turns, the variants taking turns while the player waits to act (the same
// table state for each), and the player acts after the last.
const onTurn = process.argv.includes('--on-turn');
async function myTurn(ms) {
  const bar = p.getByTestId('action-bar');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await bar.getByRole('button', { name: /^(체크|Check|폴드|Fold)$/ }).first().isVisible().catch(() => false)) return true;
    await p.waitForTimeout(300);
  }
  return false;
}
const glowing = () => document.querySelectorAll('.jc-turn,.jc-winner,.jc-pulse-gold').length;

const windows = [];
const anims = {};
const closer = [];
for (let r = 0; r < rounds; r++) {
  if (onTurn && !(await myTurn(120_000))) throw new Error('no turn came');
  for (const v of variants) {
    await p.evaluate((css) => (document.getElementById('paint-probe').textContent = css), ALL[v]);
    await p.waitForTimeout(onTurn ? 400 : 1_000);
    const glows = await p.evaluate(glowing);
    await browser.startTracing(p, { categories: ['devtools.timeline', ...(invalidations ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])] });
    const s0 = Date.now();
    while (Date.now() - s0 < seconds * 1000) {
      if (!onTurn) await act(p);
      if (v === 'as_is') {
        for (const a of await p.evaluate(running)) anims[a] = (anims[a] ?? 0) + 1;
        if (closer.length < 6) closer.push(await p.evaluate(timings));
      }
      await p.waitForTimeout(600);
    }
    const wall = (Date.now() - s0) / 1000;
    const ev = JSON.parse((await browser.stopTracing()).toString('utf8')).traceEvents ?? [];
    const t = summary(ev);
    if (invalidations) t.invalidations = invalidated(ev);
    const top = [...t.byNode.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12);
    const nodes = [];
    for (const [id, n] of top) nodes.push([await label(cdp, id), r1(n.ms), n.n, n.area, n.layer]);
    const perSec = (x) => r1(x / wall);
    windows.push({ round: r, variant: v, seconds: r1(wall), mainMsPerSec: Object.fromEntries(Object.entries(t.main).map(([k, x]) => [k, perSec(x)])), rasterMsPerSec: perSec(t.raster), gpuMsPerSec: perSec(t.gpu), paintsPerSec: perSec(t.paints), glows, topPainted: nodes, ...(t.invalidations ? { invalidations: t.invalidations } : {}) });
    console.log(`${r} ${v} (glows ${glows}): main ${r1(Object.values(t.main).reduce((a, x) => a + x, 0) / wall)}ms/s paint ${perSec(t.main.Paint ?? 0)}ms/s prePaint ${perSec(t.main.PrePaint ?? 0)} layerize ${perSec(t.main.Layerize ?? 0)} raster ${perSec(t.raster)} gpu ${perSec(t.gpu)} paints/s ${perSec(t.paints)}`);
  }
  if (onTurn) await act(p);
}

const mean = (v, f) => r1(windows.filter((w) => w.variant === v).reduce((a, w) => a + f(w), 0) / rounds);
const byVariant = Object.fromEntries(
  variants.map((v) => [v, { paint: mean(v, (w) => w.mainMsPerSec.Paint ?? 0), prePaint: mean(v, (w) => w.mainMsPerSec.PrePaint ?? 0), layerize: mean(v, (w) => w.mainMsPerSec.Layerize ?? 0), script: mean(v, (w) => w.mainMsPerSec.FunctionCall ?? 0), raster: mean(v, (w) => w.rasterMsPerSec), gpu: mean(v, (w) => w.gpuMsPerSec), paintsPerSec: mean(v, (w) => w.paintsPerSec) }]),
);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
await ctx.close();
if (home) await leave(home, table);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ table, profile, cpuThrottle: pr.cpu, chrome: browser.version(), note: 'Chrome emulation on one PC (headless), not phones. ms per second of wall time, from devtools.timeline traces.', byVariant, animationsSeen: Object.entries(anims).sort((a, b) => b[1] - a[1]), animationTimings: closer, windows, errors }, null, 2));
console.log(JSON.stringify(byVariant, null, 1));
console.log(`wrote ${out}`);
await browser.close();
