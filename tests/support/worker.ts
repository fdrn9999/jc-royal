/** Starts/stops a real `wrangler dev` (workerd) instance with both workers and persistent local state. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// import.meta.dirname is percent-encoded for non-ASCII paths under vitest; tests run from the repo root.
export const root = process.cwd();
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');

export interface TestTable {
  id: string;
  maxSeats: 2 | 6 | 9;
  sb: number;
  bb: number;
  min: number;
  max: number;
  turnSeconds?: number;
  isPrivate?: boolean;
  joinCode?: string;
  allowSpectators?: boolean;
  beginner?: boolean;
  entryBlocked?: boolean;
}

/** Tables seeded for integration tests (admin API arrives in Phase 7). */
export const TABLES: TestTable[] = [
  { id: 'it-admin-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-board-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-admin-1', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000 },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `it-hu-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000 })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `it-six-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 2000 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-fast-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 2 })),
  { id: 'it-private', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, isPrivate: true, joinCode: 'royal-777' },
  { id: 'it-nospec', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, allowSpectators: false },
  { id: 'it-report-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-report-1', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-invite-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-invite-1', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  { id: 'it-invite-priv', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, isPrivate: true, joinCode: 'invite-42' },
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-restart-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  { id: 'it-stats-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  // Delivery: commands whose answer a closed connection lost, sent again on the next one.
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-link-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Quick play: each group has a big blind no other table uses, so a filter on it sees only that group.
  { id: 'it-qp-a-beg', maxSeats: 6, sb: 13, bb: 26, min: 260, max: 2600, beginner: true },
  { id: 'it-qp-a-reg', maxSeats: 6, sb: 13, bb: 26, min: 260, max: 2600 },
  { id: 'it-qp-b-hu', maxSeats: 2, sb: 17, bb: 34, min: 340, max: 3400 },
  { id: 'it-qp-b-six', maxSeats: 6, sb: 17, bb: 34, min: 340, max: 3400 },
  { id: 'it-qp-c-priv', maxSeats: 6, sb: 21, bb: 42, min: 420, max: 4200, isPrivate: true, joinCode: 'qp-secret' },
  { id: 'it-qp-c-blocked', maxSeats: 6, sb: 21, bb: 42, min: 420, max: 4200, entryBlocked: true },
  { id: 'it-qp-d-full', maxSeats: 2, sb: 29, bb: 58, min: 580, max: 5800 },
  { id: 'it-qp-e-rich', maxSeats: 6, sb: 33, bb: 66, min: 20000, max: 40000 },
  { id: 'it-qp-f-a', maxSeats: 6, sb: 41, bb: 82, min: 820, max: 8200 },
  { id: 'it-qp-f-b', maxSeats: 6, sb: 41, bb: 82, min: 820, max: 8200 },
  // Top-ups: heads-up tables, plus tables with a huge minimum where one player sits alone to empty a wallet.
  ...Array.from({ length: 6 }, (_, i) => ({ id: `it-topup-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-topup-drain-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 9000, max: 9900 })),
];

async function sha256b64url(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('base64url');
}

export async function prepareState(state: string, tables: TestTable[] = TABLES) {
  rmSync(state, { recursive: true, force: true });
  const mig = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc'], { cwd: root, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error(`migration failed: ${mig.stderr || mig.stdout}`);
  const rows: string[] = [];
  for (const t of tables) {
    const code = t.joinCode ? `'${await sha256b64url(`${t.id}:${t.joinCode}`)}'` : 'NULL';
    rows.push(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, join_code_hash, allow_spectators, beginner, entry_blocked) VALUES ('${t.id}', '${t.id}', ${t.maxSeats}, ${t.sb}, ${t.bb}, ${t.min}, ${t.max}, ${t.turnSeconds ?? 20}, ${t.isPrivate ? 1 : 0}, ${code}, ${t.allowSpectators === false ? 0 : 1}, ${t.beginner ? 1 : 0}, ${t.entryBlocked ? 1 : 0});`,
    );
  }
  const file = resolve(state, '..', `seed-${Date.now()}.sql`);
  writeFileSync(file, rows.join('\n'));
  const seed = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', state, '-c', 'apps/api/wrangler.jsonc', '--file', file], { cwd: root, encoding: 'utf8' });
  rmSync(file, { force: true });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);
}

export interface RunningWorker {
  url: string;
  child: ChildProcess;
  log: () => string;
  stop: () => Promise<void>;
}

async function waitHealthy(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`worker did not become healthy at ${url}`);
}

/** Local secrets come from .dev.vars (gitignored); create them from the examples when absent (e.g. CI). */
export function ensureDevVars() {
  for (const app of ['apps/api', 'apps/game-worker']) {
    const target = resolve(root, app, '.dev.vars');
    if (!existsSync(target)) copyFileSync(resolve(root, app, '.dev.vars.example'), target);
  }
}

export async function startWorker(port: number, state: string): Promise<RunningWorker> {
  ensureDevVars();
  const child = spawn(
    process.execPath,
    [
      wrangler, 'dev',
      '-c', 'apps/api/wrangler.jsonc',
      '-c', 'apps/game-worker/wrangler.jsonc',
      '--persist-to', state,
      '--port', String(port),
      '--inspector-port', String(port + 1000),
      '--var', 'PBKDF2_ITERATIONS:1000',
      '--var', 'RATE_LIMIT_IP_SCALE:1000',
      '--var', 'ADMIN_BOOTSTRAP_TOKEN:test-bootstrap-token-0123456789',
      // Members' rooms with nobody seated close after 8 s here (10 min in production).
      '--var', 'MEMBER_IDLE_CLOSE_MS:8000',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(url, 90_000);
  } catch (e) {
    console.error(log.slice(-4000));
    child.kill();
    throw e;
  }
  return {
    url,
    child,
    log: () => log,
    stop: async () => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
