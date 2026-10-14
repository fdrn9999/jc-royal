// Bundle guard: the offline poker engine must stay in the lazy Academy chunk, never in the
// entry bundle every visitor downloads. Run after `pnpm --filter @jc/web build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'apps/web/dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/src="\/assets\/(index-[^"]+\.js)"/)?.[1];
if (!entry) throw new Error('entry chunk not found in index.html');
// Chunks the page preloads next to the entry (code shared with lazy pages) are downloaded up front too.
const initial = [entry, ...[...html.matchAll(/rel="modulepreload"[^>]*href="\/assets\/([^"]+\.js)"/g)].map((m) => m[1])];
const files = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
// String literals that only exist in poker-engine-ts / the HandEngine adapter.
const ENGINE_MARKERS = ['double-last-bet', 'chip conservation violated'];
const has = (f, m) => readFileSync(join(dist, 'assets', f), 'utf8').includes(m);
const problems = [];
for (const f of initial) for (const m of ENGINE_MARKERS) if (has(f, m)) problems.push(`initial chunk ${f} contains engine code ("${m}")`);
const engineChunks = files.filter((f) => !initial.includes(f) && ENGINE_MARKERS.every((m) => has(f, m)));
if (engineChunks.length === 0) problems.push('no lazy chunk contains the engine (academy chunk missing?)');
const kb = Math.round(initial.reduce((n, f) => n + statSync(join(dist, 'assets', f)).size, 0) / 1024);
const LIMIT_KB = 650;
if (kb > LIMIT_KB) problems.push(`entry bundle ${kb} KB exceeds ${LIMIT_KB} KB`);
console.log(`entry ${initial.join(' + ')}: ${kb} KB; engine in: ${engineChunks.join(', ') || '—'}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ bundle guard passed');
