import { OpsCounter, opsBucket } from '@jc/db';
import { ADMIN_MONITOR_HUB, REALTIME_SHARDS, realtimeHubName, realtimeShardOf } from '@jc/types';
import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv, Env } from '../env';
import worker from '../index';
import { adminMonitorRevoke, sendToAdmins } from './admin-monitor';
import { realtimeSignOut, sendToAll, sendToUsers } from './realtime';

const unreachable = () => Promise.reject(new Error('D1_ERROR: unreachable'));

/** A D1 whose reads fail; `batch` records what would be written (or fails too with `batchFails`). */
function fakeEnv(batchFails = false) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const prepare = (sql: string) => {
    const s = { sql, args: [] as unknown[], bind: (...a: unknown[]) => ((s.args = a), s), all: unreachable, raw: unreachable, first: unreachable, run: unreachable };
    return s;
  };
  const DB = {
    prepare,
    batch: async (list: ReturnType<typeof prepare>[]) => {
      if (batchFails) throw new Error('D1_ERROR: unreachable');
      for (const s of list) writes.push({ sql: s.sql, args: s.args });
      return list.map(() => ({ results: [], meta: {} }));
    },
  };
  const env = { DB, ENVIRONMENT: 'development', ALLOWED_ORIGINS: 'http://localhost:5173' } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  return { env, ctx, writes, settle: () => Promise.all(pending) };
}

const get = (path: string, f: ReturnType<typeof fakeEnv>) => worker.fetch(new Request(`http://localhost${path}`), f.env, f.ctx);

describe('api_error counter', () => {
  it('counts a request that ended in a server error, after the response', async () => {
    const f = fakeEnv();
    const before = opsBucket(Date.now());
    const res = await get('/api/auth/nickname-available?nickname=royal1', f);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
    await f.settle();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.sql).toMatch(/^INSERT INTO ops_metrics .* ON CONFLICT \(bucket, metric\) DO UPDATE SET n = n \+ excluded\.n$/);
    const [bucket, metric, n] = f.writes[0]!.args;
    expect([metric, n]).toEqual(['api_error', 1]);
    expect(bucket).toBeGreaterThanOrEqual(before);
    expect((bucket as number) % 60_000).toBe(0);
  });

  it('does not count client errors', async () => {
    const f = fakeEnv();
    expect((await get('/api/no-such-route', f)).status).toBe(404);
    await f.settle();
    expect(f.writes).toHaveLength(0);
  });

  it('a counter that cannot be written does not change the response', async () => {
    const f = fakeEnv(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get('/api/auth/nickname-available?nickname=royal1', f);
    expect(res.status).toBe(500);
    await f.settle();
    expect(log).toHaveBeenCalledWith('ops counter', 'D1_ERROR: unreachable');
    log.mockRestore();
  });
});

describe('realtime delivery counters', () => {
  /** A hub namespace whose stubs answer `status(name)` (0: unreachable), recording each call. */
  const hubs = (status: (name: string) => number) => {
    const calls: string[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (url: string) => {
          calls.push(`${name} ${new URL(url).pathname}`);
          const s = status(name);
          if (!s) throw new Error('hub unreachable');
          return new Response(null, { status: s });
        },
      }),
    };
    return { calls, ns };
  };
  const counted = (f: ReturnType<typeof fakeEnv>) => f.writes.map((w) => [w.args[1], w.args[2]]);
  const ctxOf = (f: ReturnType<typeof fakeEnv>) => ({ env: f.env, executionCtx: f.ctx }) as unknown as Context<AppEnv>;
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('counts the member hubs that missed a public event, in one write; nothing when every hub took it', async () => {
    const warn = quiet();
    const f = fakeEnv();
    const h = hubs((name) => (name === realtimeHubName(0) ? 0 : name === realtimeHubName(1) ? 503 : 200));
    Object.assign(f.env, { REALTIME: h.ns });
    await sendToAll(f.env, { scope: 'lobby', type: 'lobby.table.removed', resourceId: 't1' });
    expect(h.calls).toHaveLength(REALTIME_SHARDS);
    expect(counted(f)).toEqual([['rt_undelivered', 2]]);
    expect(warn).toHaveBeenCalledWith(`realtime lobby.table.removed not delivered to 2 of ${REALTIME_SHARDS} hubs`);

    const ok = fakeEnv();
    Object.assign(ok.env, { REALTIME: hubs(() => 200).ns });
    await sendToUsers(ok.env, ['u1', 'u2'], { scope: 'user', type: 'wallet.changed' });
    await sendToAll(ok.env, { scope: 'lobby', type: 'lobby.table.removed', resourceId: 't1' });
    expect(ok.writes).toHaveLength(0);
    warn.mockRestore();
  });

  it('a count that cannot be written changes nothing about the send', async () => {
    const warn = quiet();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fakeEnv(true);
    Object.assign(f.env, { REALTIME: hubs(() => 0).ns });
    await expect(sendToUsers(f.env, ['u1'], { scope: 'user', type: 'wallet.changed' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('ops counter', 'D1_ERROR: unreachable');
    log.mockRestore();
    warn.mockRestore();
  });

  it("counts the control center's hub missing an event, and still reports the miss to the caller", async () => {
    const f = fakeEnv();
    const e = { type: 'admin.monitor.changed', kind: 'tournament', resourceId: 't1', revision: 3 } as const;
    Object.assign(f.env, { ADMIN_MONITOR: hubs(() => 500).ns });
    await expect(sendToAdmins(f.env, e)).rejects.toThrow('admin monitor publish: 500');
    expect(counted(f)).toEqual([['rt_undelivered', 1]]);

    const ok = fakeEnv();
    Object.assign(ok.env, { ADMIN_MONITOR: hubs(() => 200).ns });
    await sendToAdmins(ok.env, e);
    expect(ok.writes).toHaveLength(0);
  });

  it('counts a sign-out no hub took after the second try, and not one the second try delivered', async () => {
    const warn = quiet();
    const f = fakeEnv();
    const member = hubs(() => 0);
    const console_ = hubs(() => 503);
    Object.assign(f.env, { REALTIME: member.ns, ADMIN_MONITOR: console_.ns });
    realtimeSignOut(ctxOf(f), { user: 'u1', session: 's1' });
    adminMonitorRevoke(ctxOf(f), { user: 'u1' });
    await f.settle();
    const hub = realtimeHubName(realtimeShardOf('u1'));
    expect(member.calls).toEqual([`${hub} /revoke`, `${hub} /revoke`]);
    expect(console_.calls).toEqual([`${ADMIN_MONITOR_HUB} /revoke`, `${ADMIN_MONITOR_HUB} /revoke`]);
    expect(counted(f)).toEqual([
      ['rt_revoke_fail', 1],
      ['rt_revoke_fail', 1],
    ]);

    let tries = 0;
    const g = fakeEnv();
    Object.assign(g.env, { REALTIME: hubs(() => (++tries === 1 ? 0 : 200)).ns });
    realtimeSignOut(ctxOf(g), { user: 'u1' });
    await g.settle();
    expect(tries).toBe(2);
    expect(g.writes).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('OpsCounter (table room)', () => {
  const t0 = Date.UTC(2026, 9, 15, 12, 0, 30);
  it('adds up per minute and metric, and gives back a failed write', () => {
    const c = new OpsCounter();
    c.add('ws_drop', 1, t0);
    c.add('ws_drop', 2, t0 + 20_000);
    c.add('ws_retry', 1, t0);
    c.add('ws_drop', 1, t0 + 60_000);
    const taken = c.take();
    expect(c.size).toBe(0);
    expect(taken).toEqual([
      { bucket: opsBucket(t0), metric: 'ws_drop', n: 3 },
      { bucket: opsBucket(t0), metric: 'ws_retry', n: 1 },
      { bucket: opsBucket(t0) + 60_000, metric: 'ws_drop', n: 1 },
    ]);
    c.add('ws_drop', 1, t0);
    c.restore(taken);
    expect(c.take().find((x) => x.metric === 'ws_drop' && x.bucket === opsBucket(t0))?.n).toBe(4);
  });

  it('keeps at most MAX_PENDING minute rows, dropping the oldest', () => {
    const c = new OpsCounter();
    for (let i = 0; i <= OpsCounter.MAX_PENDING; i++) c.add('room_error', 1, t0 + i * 60_000);
    const rows = c.take();
    expect(rows).toHaveLength(OpsCounter.MAX_PENDING);
    expect(Math.min(...rows.map((r) => r.bucket))).toBe(opsBucket(t0) + 60_000);
  });
});