/**
 * Boots the real Workers runtime (wrangler dev / workerd, api + game workers)
 * against fresh local D1 + Durable Object state, so integration tests exercise
 * the deployed code path. Set TEST_BASE_URL to reuse a running server instead.
 */
import { resolve } from 'node:path';
import { Client, PASSWORD, signupBody } from './client';
import { startPushSink, type PushSink } from './push-sink';
import { prepareState, root, startWorker, type RunningWorker } from './worker';

let worker: RunningWorker | undefined;
let sink: PushSink | undefined;

export async function setup() {
  if (process.env.TEST_BASE_URL) return;
  const state = resolve(root, 'tests/.state/main');
  await prepareState(state);
  sink = await startPushSink();
  process.env.TEST_PUSH_SINK = sink.url;
  // The realtime hubs check their sockets' sign-ins in D1 every 15 s here (every 5 min in production), so a sign-out
  // whose revoke was lost can be seen to end its socket (integration/realtime.test.ts). Not shorter: the local runtime
  // sends a hub's closes only once the hub has been idle for about 10 s, and a check every few seconds never lets it be.
  worker = await startWorker(Number(process.env.TEST_PORT ?? 8799), state, { REALTIME_SWEEP_MS: '15000' });
  process.env.TEST_BASE_URL = worker.url;
  await bootstrapAdmin(worker.url);
}

/** Creates the super admin (bootstrap succeeds only once per database) and shares one session through env. */
export async function bootstrapAdmin(url: string) {
  const email = 'super-admin@test.dev';
  const web = new Client(undefined, url);
  const reg = await web.post('/api/auth/register', await signupBody(web, { email, nickname: 'superadmin' }));
  if (reg.status !== 201) throw new Error(`admin register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const boot = await fetch(`${url}/api/admin/auth/bootstrap`, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'test-bootstrap-token-0123456789', email }) });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status} ${await boot.text()}`);
  process.env.TEST_ADMIN_EMAIL = email;
  // One shared admin session for files that only need admin APIs: the per-account login limit
  // (5 per 15 min) is reserved for admin.test.ts, which tests the login flow itself.
  const login = await fetch(`${url}/api/admin/auth/login`, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  process.env.TEST_ADMIN_COOKIES = JSON.stringify(login.headers.getSetCookie().map((c) => c.split(';')[0]));
}

export async function teardown() {
  await worker?.stop();
  await sink?.close();
}
