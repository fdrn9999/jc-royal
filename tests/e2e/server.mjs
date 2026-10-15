// E2E server: fresh local D1/DO state + real workerd (api + game workers) serving the built web app.
// Requires `pnpm --filter @jc/web build` (done by the Playwright config's webServer command).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const state = resolve(root, 'tests/.state/e2e');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
rmSync(state, { recursive: true, force: true });
for (const app of ['apps/api', 'apps/game-worker']) {
  const target = resolve(root, app, '.dev.vars');
  if (!existsSync(target)) copyFileSync(resolve(root, app, '.dev.vars.example'), target);
}
const run = (args) => {
  const r = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
};
run(['d1', 'migrations', 'apply', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc']);
const seed = resolve(root, 'tests/.state/e2e-seed.sql');
writeFileSync(
  seed,
  `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES
   ('e2e-hu', 'E2E Heads-up', 2, 5, 10, 100, 1000, 30), ('e2e-six', 'E2E Six', 6, 5, 10, 100, 1000, 30), ('e2e-touch', 'E2E Touch', 2, 5, 10, 100, 1000, 30), ('e2e-academy', 'E2E Academy', 2, 5, 10, 100, 1000, 30), ('e2e-coach', 'E2E Coach', 2, 5, 10, 100, 1000, 30), ('e2e-social', 'E2E Social', 6, 5, 10, 100, 1000, 30);
   INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, beginner) VALUES ('e2e-rookie', 'E2E Rookie', 6, 1, 2, 20, 200, 30, 1);
   INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds) VALUES ('e2e-together', 'E2E Together', 2, 5, 10, 100, 1000, 30), ('e2e-reconnect', 'E2E Reconnect', 2, 5, 10, 100, 1000, 30),
   ('e2e-keys', 'E2E Keys', 2, 5, 10, 100, 1000, 30), ('e2e-keys-touch', 'E2E Keys Touch', 2, 5, 10, 100, 1000, 30),
   ('e2e-quick-a', 'E2E Quick A', 2, 7, 14, 140, 1400, 30), ('e2e-quick-b', 'E2E Quick B', 2, 7, 14, 140, 1400, 30), ('e2e-quick-m', 'E2E Quick Mobile', 2, 9, 18, 180, 1800, 30),
   ('e2e-topup', 'E2E Top-up', 2, 5, 10, 100, 1000, 30), ('e2e-topup-m', 'E2E Top-up Mobile', 2, 5, 10, 100, 1000, 30), ('e2e-topup-open', 'E2E Top-up Open', 2, 5, 10, 100, 1000, 30), ('e2e-topup-drain', 'E2E Top-up Drain', 2, 50, 100, 9000, 9900, 30),
   ('e2e-rebuy', 'E2E Rebuy', 2, 5, 10, 100, 1000, 30), ('e2e-stats', 'E2E Stats', 2, 5, 10, 100, 1000, 30), ('e2e-stats-m', 'E2E Stats Mobile', 2, 5, 10, 100, 1000, 30),
   ('e2e-resend', 'E2E Resend', 2, 5, 10, 100, 1000, 30), ('e2e-pre', 'E2E Pre-action', 2, 5, 10, 100, 1000, 30), ('e2e-muck', 'E2E Muck', 2, 5, 10, 100, 1000, 30), ('e2e-replay', 'E2E Replay', 2, 5, 10, 100, 1000, 30),
   ('e2e-kick', 'E2E Emergency', 2, 5, 10, 100, 1000, 30), ('e2e-maint', 'E2E Maintenance', 2, 5, 10, 100, 1000, 30), ('e2e-close', 'E2E Close', 2, 5, 10, 100, 1000, 30);
   INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, allow_spectators) VALUES
   ('e2e-lobby-full', 'E2E Lobby Hidden', 2, 3, 6, 60, 600, 30, 0), ('e2e-lobby-fav', 'E2E Lobby Fav', 6, 3, 6, 60, 600, 30, 1), ('e2e-lobby-m', 'E2E Lobby Mobile', 2, 3, 6, 60, 600, 30, 0);
   INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, join_code_hash, allow_spectators) VALUES
   ('e2e-secret', 'E2E Secret', 6, 5, 10, 100, 1000, 30, 1, '${createHash('sha256').update('e2e-secret:secret-77').digest('base64url')}', 1),
   ('e2e-vault', 'E2E Vault', 6, 5, 10, 100, 1000, 30, 1, '${createHash('sha256').update('e2e-vault:vault-88').digest('base64url')}', 0);`,
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
