/**
 * Boots the real Workers runtime (wrangler dev / workerd, api + game workers)
 * against fresh local D1 + Durable Object state, so integration tests exercise
 * the deployed code path. Set TEST_BASE_URL to reuse a running server instead.
 */
import { resolve } from 'node:path';
import { Client, PASSWORD, signupBody } from './client';
import { prepareState, root, startWorker, type RunningWorker } from './worker';

let worker: RunningWorker | undefined;

export async function setup() {
  if (process.env.TEST_BASE_URL) return;
  const state = resolve(root, 'tests/.state/main');
  await prepareState(state);
  worker = await startWorker(Number(process.env.TEST_PORT ?? 8799), state);
  process.env.TEST_BASE_URL = worker.url;
  // One super admin shared by all test files (bootstrap succeeds only once per database).
  const email = 'super-admin@test.dev';
  const web = new Client();
  const reg = await web.post('/api/auth/register', await signupBody(web, { email, nickname: 'superadmin' }));
  if (reg.status !== 201) throw new Error(`admin register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const boot = await fetch(`${worker.url}/api/admin/auth/bootstrap`, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'test-bootstrap-token-0123456789', email }) });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status} ${await boot.text()}`);
  process.env.TEST_ADMIN_EMAIL = email;
  // One shared admin session for files that only need admin APIs: the per-account login limit
  // (5 per 15 min) is reserved for admin.test.ts, which tests the login flow itself.
  const login = await fetch(`${worker.url}/api/admin/auth/login`, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  process.env.TEST_ADMIN_COOKIES = JSON.stringify(login.headers.getSetCookie().map((c) => c.split(';')[0]));
}

export async function teardown() {
  await worker?.stop();
}
