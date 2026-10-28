/**
 * Local measurement only (docs/LOAD_TEST.md): with the D1_STATS var set to 1 (the load harness sets it; no deployed
 * environment does), each response says how many D1 rows its queries read and wrote, as D1 counts them
 * (`meta.rows_read`, `meta.rows_written`), in the x-d1-* headers, and the worker log has a `d1-stats` line per statement.
 *
 * `first` and `raw` (drizzle's selects) return no counts: a query that only reads is run once more with `all` to read
 * them (so timings taken with this on are not the API's own); one that writes is counted as unmeasured, never run
 * twice. Work left to waitUntil after the response is not in the headers.
 */
export interface D1Counts {
  queries: number;
  read: number;
  written: number;
  unmeasured: number;
}

const WRITES = /\b(insert|update|delete|replace|create|drop|alter|pragma)\b/i;
const readsOnly = (sql: string) => /^\s*(select|with)\b/i.test(sql) && !WRITES.test(sql);

/** `trace` hears each counted statement with its counts (the harness logs them, for EXPLAIN QUERY PLAN on the same SQL). */
export function countingD1(db: D1Database, n: D1Counts, trace?: (sql: string, meta: D1Meta | undefined) => void): D1Database {
  const add = (meta: D1Meta | undefined, sql: string) => {
    n.queries++;
    n.read += meta?.rows_read ?? 0;
    n.written += meta?.rows_written ?? 0;
    trace?.(sql, meta);
  };
  // D1's own methods read private state: they are always called on the real objects, and batch gets those back.
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === 'bind') return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (k === 'all' || k === 'run')
          return async () => {
            const r = await t[k]();
            add(r.meta, sql);
            return r;
          };
        if (k === 'first' || k === 'raw')
          return async (...args: unknown[]) => {
            const out = await (t[k] as (...a: unknown[]) => Promise<unknown>)(...args);
            if (readsOnly(sql)) add((await t.all()).meta, sql);
            else n.unmeasured++;
            return out;
          };
        const v = Reflect.get(t, k, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    real.set(p, s);
    sqlOf.set(p, sql);
    return p;
  };
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          const rs = await t.batch(stmts.map((s) => real.get(s) ?? s));
          rs.forEach((r, i) => add(r.meta, sqlOf.get(stmts[i]!) ?? '(batch)'));
          return rs;
        };
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}
