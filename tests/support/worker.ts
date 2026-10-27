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
  /** Table bots allowed here (an official table), with these settings; the service-wide policy still has to turn them on. */
  bots?: { level?: 'easy' | 'normal' | 'hard' | 'expert'; minHumans?: number; max?: number; fillTo?: number; yieldSeat?: boolean };
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
  // Automatic rebuy and top-up policies: heads-up tables and one for three players (long turns keep the clock out of
  // it), plus tables to empty a wallet as above.
  ...Array.from({ length: 7 }, (_, i) => ({ id: `it-autotop-${i}`, maxSeats: (i === 1 ? 6 : 2) as 2 | 6, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-autotop-drain-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 9000, max: 9900 })),
  // Pre-actions: three players, so one can choose while another is to act. Long turns keep the clock out of it.
  ...Array.from({ length: 6 }, (_, i) => ({ id: `it-pre-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Showdown muck (always on): heads-up, so a checked-down hand has one covered loser.
  ...Array.from({ length: 2 }, (_, i) => ({ id: `it-muck-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Showing cards after a hand: six seats, so a third player can sit down during a hand without being dealt in.
  ...Array.from({ length: 2 }, (_, i) => ({ id: `it-show-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Operations dashboard: connection counters, a room failure and an action sent again.
  ...Array.from({ length: 3 }, (_, i) => ({ id: `it-ops-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Emergency controls: forced disconnects (a suspended player's open socket) and paused tables.
  ...Array.from({ length: 6 }, (_, i) => ({ id: `it-emg-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Member management: a hand played so the member page has a recent table and activity to show.
  { id: 'it-member-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Chip economy: a session the room does not hold (reconciliation, stale sessions) and a cash-out that fails.
  ...Array.from({ length: 3 }, (_, i) => ({ id: `it-econ-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Service maintenance: tables that stop dealing and seating while it runs, and one with a waitlist.
  ...Array.from({ length: 5 }, (_, i) => ({ id: `it-mt-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  { id: 'it-mt-wl', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Two administrators doing the same thing at once (a suspension, a close) while a hand runs; one edits a table's
  // settings while the other blocks its entry.
  ...Array.from({ length: 5 }, (_, i) => ({ id: `it-conc-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Leaving mid-hand: three players, long turns so only the players (and the room's fold for a leaver) act.
  { id: 'it-leave-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Standing up at once after a fold (fold-leave.test.ts): long turns, so only the players and the room act; one
  // heads-up table.
  ...Array.from({ length: 15 }, (_, i) => ({ id: `it-fold-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  { id: 'it-fold-hu', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Administrator permissions: a table whose settings a plain administrator changes.
  { id: 'it-perm-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Staff marks: a member whose role changes while seated, heads-up so one fold ends a hand for the history.
  { id: 'it-role-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // VIP members: a member made VIP, recolored and ended while seated in a hand, heads-up with long turns.
  { id: 'it-vip-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Reports and blocks against staff: members report players they share this table with.
  { id: 'it-staff-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  // Link previews: a public table no other file closes (admin.test.ts closes it-admin-0, and the files run in any order).
  { id: 'it-og-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000 },
  // Quick reactions: seated players and a spectator; long turns keep the clock out of it.
  ...Array.from({ length: 3 }, (_, i) => ({ id: `it-react-${i}`, maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Free refill: chips on a table (a hand's bets included), a table whose room holds no seat D1 has open, and one member
  // seated at two tables.
  ...Array.from({ length: 4 }, (_, i) => ({ id: `it-refill-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Table bots (off until bots.test.ts turns the policy on): heads-up, a six-seat table three bots fill, short stacks
  // all in for side pots (a three-big-blind minimum no admin could set, so an easy bot calls), a seat given up to a member waiting,
  // the emergency stop, and a buy-in larger than the fund has left.
  ...Array.from({ length: 2 }, (_, i) => ({ id: `it-bot-hu-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: {} })),
  { id: 'it-bot-six', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: { level: 'easy', max: 3, fillTo: 4 } },
  { id: 'it-bot-pot', maxSeats: 6, sb: 5, bb: 10, min: 30, max: 1000, turnSeconds: 60, bots: { level: 'easy', max: 1, fillTo: 3 } },
  { id: 'it-bot-yield', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: { yieldSeat: true } },
  { id: 'it-bot-stop', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: { level: 'hard' } },
  { id: 'it-bot-fund', maxSeats: 2, sb: 50, bb: 100, min: 10000, max: 10000, turnSeconds: 60, bots: {} },
  // A level changed while a bot plays a hand (it applies from the next one).
  { id: 'it-bot-level', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: { level: 'normal' } },
  // A bot's own level and style set while it plays (from the next hand), then the same accounts at another table.
  ...Array.from({ length: 2 }, (_, i) => ({ id: `it-bot-prof-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60, bots: { level: 'normal' as const } })),
  // A bot's own buy-in: 100 to 2000 chips, so the default (100 big blinds, 1000) sits inside and 300 big blinds is cut down.
  { id: 'it-bot-buyin', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 2000, turnSeconds: 60, bots: { level: 'normal' } },
  // Referral rewards: a new member plays the hand the policy asks for, heads-up so one fold ends it.
  { id: 'it-ref-0', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  // Account settings: the auto-muck an older device still saves, and an administrator's reset, while the member sits
  // here (the table is told of neither); quick saves one after another.
  ...Array.from({ length: 2 }, (_, i) => ({ id: `it-set-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  // Time bank: heads-up with long turns, so only the bank moves a deadline; and a short turn that still runs out.
  ...Array.from({ length: 5 }, (_, i) => ({ id: `it-tb-${i}`, maxSeats: 2 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 })),
  { id: 'it-tb-fast', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 3 },
  // Social policy: reactions turned off and limited while players sit; a staff member's badge hidden and shown again
  // (heads-up, so one fold ends a hand for the history).
  { id: 'it-social-0', maxSeats: 6, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
  { id: 'it-social-1', maxSeats: 2, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 },
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
    const b = t.bots;
    const bots = b ? `1, '${b.level ?? 'normal'}', ${b.minHumans ?? 1}, ${b.max ?? 1}, ${b.fillTo ?? 2}, ${b.yieldSeat === false ? 0 : 1}` : `0, 'normal', 1, 1, 2, 1`;
    rows.push(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, join_code_hash, allow_spectators, beginner, entry_blocked, bots_enabled, bot_level, bot_min_humans, bot_max, bot_fill_to, bot_yield) VALUES ('${t.id}', '${t.id}', ${t.maxSeats}, ${t.sb}, ${t.bb}, ${t.min}, ${t.max}, ${t.turnSeconds ?? 20}, ${t.isPrivate ? 1 : 0}, ${code}, ${t.allowSpectators === false ? 0 : 1}, ${t.beginner ? 1 : 0}, ${t.entryBlocked ? 1 : 0}, ${bots});`,
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

/** Whether anything answers HTTP at this address; a refused or stalled connection counts as no. */
async function answers(url: string) {
  try {
    await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills wrangler and the workerd it runs at once, like a crash of the whole server: on Windows the process tree, elsewhere
 * the process group wrangler leads (it is spawned detached). Killing wrangler alone leaves workerd serving the port on
 * Linux, and a restart's health check then reaches the old process, which never reloaded anything.
 */
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * A Web Push (VAPID) key pair made for this run, in memory only (never written to a file): the test worker sends pushes
 * with it, and the tests subscribe with its public half. A new pair every time a worker starts.
 */
async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: raw, privateKey: d! };
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
  const url = `http://127.0.0.1:${port}`;
  // A server left on the port would pass the health check below in place of this one.
  if (await answers(url)) throw new Error(`port ${port} is still served by an earlier worker`);
  const vapid = await vapidKeys();
  // Pushes go to the local stand-in global-setup started (tests/support/push-sink.ts), never to a push service.
  const sink = process.env.TEST_PUSH_SINK;
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
      '--var', `VAPID_PUBLIC_KEY:${vapid.publicKey}`,
      '--var', `VAPID_PRIVATE_KEY:${vapid.privateKey}`,
      ...(sink ? ['--var', `PUSH_SINK_URL:${sink}`] : []),
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      detached: process.platform !== 'win32',
    },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  try {
    await waitHealthy(url, 90_000);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`wrangler dev exited (${child.exitCode ?? child.signalCode})`);
  } catch (e) {
    console.error(log.slice(-4000));
    killTree(child);
    throw e;
  }
  return {
    url,
    child,
    log: () => log,
    stop: async () => {
      killTree(child);
      const end = Date.now() + 15_000;
      while (await answers(url)) {
        if (Date.now() > end) throw new Error(`the worker on port ${port} still answers after it was killed`);
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
