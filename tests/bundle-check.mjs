// Bundle guard: the offline poker engine must stay in the lazy Academy chunk, never in the
// entry bundle every visitor downloads. Run after `pnpm --filter @jc/web build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'apps/web/dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/src="\/assets\/(index-[^"]+\.js)"/)?.[1];
if (!entry) throw new Error('entry chunk not found in index.html');
const files = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
// String literals that only exist in poker-engine-ts / the HandEngine adapter.
const ENGINE_MARKERS = ['double-last-bet', 'chip conservation violated'];
const has = (f, m) => readFileSync(join(dist, 'assets', f), 'utf8').includes(m);
const problems = [];
for (const m of ENGINE_MARKERS) if (has(entry, m)) problems.push(`entry ${entry} contains engine code ("${m}")`);
const engineChunks = files.filter((f) => f !== entry && ENGINE_MARKERS.every((m) => has(f, m)));
if (engineChunks.length === 0) problems.push('no lazy chunk contains the engine (academy chunk missing?)');
const kb = Math.round(statSync(join(dist, 'assets', entry)).size / 1024);
const LIMIT_KB = 650;
if (kb > LIMIT_KB) problems.push(`entry bundle ${kb} KB exceeds ${LIMIT_KB} KB`);
console.log(`entry ${entry}: ${kb} KB; engine in: ${engineChunks.join(', ') || '—'}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ bundle guard passed');
