import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { root } from './worker';

/**
 * Runs SQL against the local D1 the test worker uses (outside the application, like an operator console).
 * Asynchronous on purpose: a blocking spawnSync of a few seconds keeps the HTTP client from noticing that the dev
 * server closed its idle keep-alive connection, and the next request then fails with ECONNRESET.
 *
 * This runs in a second process on the SQLite file the worker has open, so while the worker writes (tables left by
 * earlier test files keep playing) it can get SQLITE_BUSY. A batch that fails that way leaves nothing behind, so it is
 * retried; any other error fails at once.
 */
export async function d1<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const args = [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', resolve(root, 'tests/.state/main'), '-c', 'apps/api/wrangler.jsonc', '--json', '--command', sql];
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: root, encoding: 'utf8' });
      const out = JSON.parse(stdout.slice(stdout.indexOf('['))) as { results: T[] }[];
      return out.flatMap((x) => x.results);
    } catch (e) {
      // With --json wrangler reports a failed statement on stdout, which the bare error message leaves out.
      const { stdout, stderr, message } = e as Error & { stdout?: string; stderr?: string };
      const why = (stdout || stderr || message).trim().slice(0, 2000);
      if (!why.includes('SQLITE_BUSY') || attempt >= 10) throw new Error(`d1 execute failed (attempt ${attempt}): ${why}`);
      await new Promise((r) => setTimeout(r, 100 * attempt + Math.random() * 100));
    }
  }
}

/**
 * Holds the local D1's write lock from this process until the returned function is called, so the worker's D1 calls
 * fail meanwhile, reads included (local D1 takes a commit token for every query): a stand-in for D1 being unreachable.
 * Taking the lock waits for a write the worker has under way.
 */
export function holdD1WriteLock(): () => void {
  const dir = resolve(root, 'tests/.state/main/v3/d1/miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`expected one local D1 file, found ${files.join(', ') || 'none'}`);
  const db = new DatabaseSync(resolve(dir, files[0]!), { timeout: 10_000 });
  db.exec('BEGIN IMMEDIATE');
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}
