/**
 * Boots the real Workers runtime (wrangler dev / workerd) against a fresh local
 * D1 + Durable Object state, so integration tests exercise the deployed code path.
 * Set TEST_BASE_URL to reuse an already running server instead.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// import.meta.dirname is percent-encoded for non-ASCII paths under vitest; tests run from the repo root.
const root = process.cwd();
const port = Number(process.env.TEST_PORT ?? 8799);
const state = resolve(root, 'tests/.state');
let child: ChildProcess | undefined;

async function waitHealthy(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker did not become healthy at ${url}`);
}

export async function setup() {
  if (process.env.TEST_BASE_URL) return;
  rmSync(state, { recursive: true, force: true });
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const mig = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (mig.status !== 0) throw new Error(`migration failed: ${mig.stderr || mig.stdout}`);
  const configs = ['-c', 'apps/api/wrangler.jsonc'];
  if (existsSync(resolve(root, 'apps/game-worker/wrangler.jsonc'))) configs.push('-c', 'apps/game-worker/wrangler.jsonc');
  child = spawn(process.execPath, [wrangler, 'dev', ...configs, '--persist-to', state, '--port', String(port), '--var', 'PBKDF2_ITERATIONS:1000', '--var', 'RATE_LIMIT_IP_SCALE:1000'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(url, 90_000);
  } catch (e) {
    console.error(log.slice(-4000));
    throw e;
  }
  process.env.TEST_BASE_URL = url;
}

export async function teardown() {
  if (!child) return;
  child.kill();
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
}
