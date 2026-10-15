import { OpsCounter, opsBucket } from '@jc/db';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import worker from '../index';

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