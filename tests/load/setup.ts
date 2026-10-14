/**
 * Boots a separate local worker (own port and state) for the load scenario, so it never shares
 * data with the integration suite. Tables are seeded per run from LOAD_TABLES.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapAdmin } from '../support/global-setup';
import { prepareState, root, startWorker, type RunningWorker, type TestTable } from '../support/worker';
import { loadConfig } from './config';

let worker: RunningWorker | undefined;

export async function setup() {
  const cfg = loadConfig();
  const state = resolve(root, 'tests/.state/load');
  const tables: TestTable[] = Array.from({ length: cfg.tables }, (_, i) => ({ id: `load-${i}`, maxSeats: 6, sb: 5, bb: 10, min: 100, max: 2000 }));
  await prepareState(state, tables);
  worker = await startWorker(Number(process.env.LOAD_PORT ?? 8796), state);
  process.env.TEST_BASE_URL = worker.url;
  process.env.LOAD_STATE = state;
  await bootstrapAdmin(worker.url);
}

export async function teardown() {
  if (!worker) return;
  // Server-side errors are part of the result: keep the log next to the report.
  const log = worker.log();
  writeFileSync(resolve(root, 'tests/.state/load-worker.log'), log);
  const errors = log.split('\n').filter((l) => /command failed|conservation|uncaught|exception|\berror\b/i.test(l));
  console.log(`[load] worker log: ${log.length} bytes, ${errors.length} error lines (tests/.state/load-worker.log)`);
  for (const l of errors.slice(0, 20)) console.log(`[load]   ${l.trim().slice(0, 300)}`);
  await worker.stop();
}
