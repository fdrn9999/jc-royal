/**
 * Boots the real Workers runtime (wrangler dev / workerd, api + game workers)
 * against fresh local D1 + Durable Object state, so integration tests exercise
 * the deployed code path. Set TEST_BASE_URL to reuse a running server instead.
 */
import { resolve } from 'node:path';
import { prepareState, root, startWorker, type RunningWorker } from './worker';

let worker: RunningWorker | undefined;

export async function setup() {
  if (process.env.TEST_BASE_URL) return;
  const state = resolve(root, 'tests/.state/main');
  await prepareState(state);
  worker = await startWorker(Number(process.env.TEST_PORT ?? 8799), state);
  process.env.TEST_BASE_URL = worker.url;
}

export async function teardown() {
  await worker?.stop();
}
