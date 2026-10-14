// E2E server: fresh local D1/DO state + real workerd (api + game workers) serving the built web app.
// Requires `pnpm --filter @jc/web build` (done by the Playwright config's webServer command).
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const state = resolve(root, 'tests/.state/e2e');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
rmSync(state, { recursive: true, force: true });
const run = (args) => {
  const r = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
};
run(['d1', 'migrations', 'apply', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc']);
const seed = resolve(root, 'tests/.state/e2e-seed.sql');
writeFileSync(
  seed,
  `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES
   ('e2e-hu', 'E2E Heads-up', 2, 5, 10, 100, 1000, 30), ('e2e-six', 'E2E Six', 6, 5, 10, 100, 1000, 30);`,
);
run(['d1', 'execute', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc', '--file', seed]);
const child = spawn(
  process.execPath,
  [wrangler, 'dev', '-c', 'apps/api/wrangler.jsonc', '-c', 'apps/game-worker/wrangler.jsonc', '--persist-to', state, '--port', '8798', '--inspector-port', '9798',
    '--var', 'PBKDF2_ITERATIONS:1000', '--var', 'RATE_LIMIT_IP_SCALE:1000', '--var', 'ADMIN_BOOTSTRAP_TOKEN:e2e-bootstrap-token-0123456789'],
  { cwd: root, stdio: 'inherit' },
);
const stop = () => child.kill();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
