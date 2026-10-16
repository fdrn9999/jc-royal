import { OPS_RETENTION_MS } from '@jc/db';
import { SWEEP_CLOSING_AFTER_MS } from './room';

const DAY = 86_400_000;

/** An adjustment this large (ten default sign-up grants) is left to a super admin and listed on the economy page. */
export const LARGE_ADJUSTMENT = 100_000;
/** Grants to one member at least this many times within RAPID_WINDOW_MS are listed. */
export const RAPID_GRANTS = 3;
export const RAPID_WINDOW_MS = DAY;
/**
 * A seat held this long is listed. It can be a long session: only sitting out stands a player up (after 10 minutes).
 * A table bot's seat is listed only on a closed or stuck table (bots stay as long as members play beside them).
 */
export const STALE_SESSION_MS = 12 * 60 * 60_000;

type LedgerType = 'signup_grant' | 'buy_in' | 'top_up' | 'cash_out' | 'admin_adjust' | 'reconcile' | 'free_refill' | 'bot_fund';
type Flow = { n: number; sum: number; plus: number; minus: number };
const flow = (): Flow => ({ n: 0, sum: 0, plus: 0, minus: 0 });
const add = (a: Flow, b: Flow) => {
  a.n += b.n;
  a.sum += b.sum;
  a.plus += b.plus;
  a.minus += b.minus;
};

interface AdminRow {
  id: string;
  userId: string;
  nickname: string | null;
  amount: number;
  memo: string | null;
  actorId: string | null;
  actorNickname: string | null;
  createdAt: number;
}

/**
 * The chip economy page: what is in wallets and on tables, what was issued, how chips moved per day, reconciliation
 * events and transactions worth a look. One D1 batch, read when an administrator opens the page (never polled).
 *
 * Cost: the ledger is read once in full (totals since the start need every row; a created_at index would cost a write
 * on every buy-in and cash-out to save this read), users once in full, admin adjustments through the idempotency-key
 * index, audit rows of the period through their time index, and small tables. `rowsRead` reports what a call cost.
 * `days` and the viewer's `tz` (minutes ahead of UTC) cut the period at the viewer's midnight.
 */
export async function economy(db: D1Database, days: number, tz: number, now = Date.now()) {
  const shift = tz * 60_000;
  const today = Math.floor((now + shift) / DAY);
  const since = (today - days + 1) * DAY - shift;
  const results = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS accounts, SUM(CASE WHEN status != 'deleted' AND is_bot = 0 THEN 1 ELSE 0 END) AS members, COALESCE(SUM(balance), 0) AS balance,
              COALESCE(SUM(CASE WHEN status = 'deleted' THEN balance ELSE 0 END), 0) AS deleted,
              COALESCE(SUM(CASE WHEN status = 'suspended' THEN balance ELSE 0 END), 0) AS suspended,
              COALESCE(SUM(CASE WHEN role != 'user' THEN balance ELSE 0 END), 0) AS staff,
              SUM(is_bot) AS botAccounts, COALESCE(SUM(CASE WHEN is_bot = 1 THEN balance ELSE 0 END), 0) AS bots
         FROM users`,
    ),
    // Every ledger row once: totals by type since the start, and by day within the period. Automatic rebuys are top-ups
    // with their own key prefix.
    db.prepare(
      `SELECT type, CASE WHEN created_at >= ?1 THEN CAST((created_at + ?2) / 86400000 AS INTEGER) END AS day,
              (type = 'top_up' AND substr(idempotency_key, 1, 6) = 'rebuy:') AS rebuy,
              COUNT(*) AS n, SUM(amount) AS sum,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS plus, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS minus
         FROM chip_ledger GROUP BY type, day, rebuy`,
    ).bind(since, shift),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(buy_in), 0) AS buyIn FROM table_sessions WHERE status = 'seated'`),
    // Admin adjustments of the period through the unique key index ('admin:' keys), newest first.
    db.prepare(
      `SELECT l.id, l.user_id AS userId, u.nickname, l.amount, l.memo, l.actor_id AS actorId, a.nickname AS actorNickname, l.created_at AS createdAt
         FROM chip_ledger l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN users a ON a.id = l.actor_id
        WHERE l.idempotency_key >= 'admin:' AND l.idempotency_key < 'admin;' AND l.created_at >= ?1
        ORDER BY l.created_at DESC LIMIT 2000`,
    ).bind(since),
    db.prepare(
      `SELECT a.id, a.action, a.target_id AS userId, u.nickname, a.actor_id AS actorId, x.nickname AS actorNickname, a.detail, a.created_at AS createdAt
         FROM admin_audit_log a LEFT JOIN users u ON u.id = a.target_id LEFT JOIN users x ON x.id = a.actor_id
        WHERE a.created_at >= ?1 AND a.action IN ('user.chips_refused', 'user.chips_duplicate') ORDER BY a.created_at DESC LIMIT 50`,
    ).bind(since),
    db.prepare(
      `SELECT CAST((bucket + ?2) / 86400000 AS INTEGER) AS day, metric, SUM(n) AS n FROM ops_metrics
        WHERE bucket >= ?1 AND metric IN ('cashout_fail', 'room_error', 'api_error') GROUP BY day, metric`,
    ).bind(since, shift),
    db.prepare(`SELECT id, name, status, last_issue AS issue FROM tables WHERE last_issue LIKE '%cash-out%' ORDER BY updated_at DESC LIMIT 20`),
    // CROSS JOIN starts from the seated rows (as many as people at tables), not from every table.
    db.prepare(
      `SELECT ts.id, ts.table_id AS tableId, t.name AS tableName, t.status AS tableStatus, ts.user_id AS userId, u.nickname, ts.buy_in AS buyIn, ts.created_at AS createdAt,
              CASE WHEN t.status = 'closed' THEN 'closed_table' WHEN t.status = 'closing' AND t.updated_at < ?2 THEN 'closing_table' ELSE 'long' END AS reason
         FROM table_sessions ts CROSS JOIN tables t ON t.id = ts.table_id LEFT JOIN users u ON u.id = ts.user_id
        WHERE ts.status = 'seated' AND ((ts.created_at < ?1 AND COALESCE(u.is_bot, 0) = 0) OR t.status = 'closed' OR (t.status = 'closing' AND t.updated_at < ?2))
        ORDER BY ts.created_at LIMIT 50`,
    ).bind(now - STALE_SESSION_MS, now - SWEEP_CLOSING_AFTER_MS),
    db.prepare(
      `SELECT scope, SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS created, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open
         FROM reconciliation_events GROUP BY scope`,
    ).bind(since),
    db.prepare(`SELECT created_at AS at, detail FROM admin_audit_log WHERE action = 'reconcile.run' ORDER BY created_at DESC LIMIT 1`),
  ]);
  const [wallets, ledger, seated, adminRows, refusals, ops, cashoutTables, stale, recon, lastRun] = results;
  const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[];
  const one = <T>(r: D1Result | undefined) => (r?.results[0] ?? {}) as T;

  // Ledger: totals by type, period counts, and the daily movement.
  const total: Record<LedgerType, Flow> = { signup_grant: flow(), buy_in: flow(), top_up: flow(), cash_out: flow(), admin_adjust: flow(), reconcile: flow(), free_refill: flow(), bot_fund: flow() };
  const period = { ...structuredClone(total), auto_rebuy: flow() };
  const perDay = new Map<number, Flow>();
  for (const r of rows<Flow & { type: LedgerType; day: number | null; rebuy: number }>(ledger)) {
    const f = { n: r.n, sum: r.sum ?? 0, plus: r.plus ?? 0, minus: r.minus ?? 0 };
    add(total[r.type], f);
    if (r.day === null) continue;
    add(r.rebuy ? period.auto_rebuy : period[r.type], f);
    const d = perDay.get(r.day) ?? flow();
    add(d, f);
    perDay.set(r.day, d);
  }
  const series = Array.from({ length: days }, (_, i) => {
    const day = today - days + 1 + i;
    const d = perDay.get(day) ?? flow();
    return { date: new Date(day * DAY).toISOString().slice(0, 10), n: d.n, moved: d.plus + d.minus, in: d.plus, out: d.minus };
  });

  const w = one<{ accounts: number; members: number; balance: number; deleted: number; suspended: number; staff: number; botAccounts: number | null; bots: number }>(wallets);
  const s = one<{ n: number; buyIn: number }>(seated);
  const ledgerTotal = Object.values(total).reduce((a, f) => a + f.sum, 0);
  // Chips bought in and not paid back yet: what the tables hold. A player who lost everything left no cash-out row,
  // and the chips they lost are in someone else's later cash-out.
  const onTables = -(total.buy_in.sum + total.top_up.sum + total.cash_out.sum);
  // Free refills (lib/refill.ts) are counted on their own, apart from the sign-up grant and admin adjustments.
  const issued = {
    signup: total.signup_grant.sum,
    admin: total.admin_adjust.sum,
    reconcile: total.reconcile.sum,
    refill: total.free_refill.sum,
    // The bot fund's issuance (lib bots / game-worker bots.ts): chips table bots play with, apart from members' grants.
    bots: total.bot_fund.sum,
    total: total.signup_grant.sum + total.admin_adjust.sum + total.reconcile.sum + total.free_refill.sum + total.bot_fund.sum,
  };

  // Repeated grants: the most grants (amount > 0) one member got within any RAPID_WINDOW_MS of the period.
  const admins = rows<AdminRow>(adminRows);
  const grantsByUser = new Map<string, AdminRow[]>();
  for (const r of admins) if (r.amount > 0) grantsByUser.set(r.userId, [...(grantsByUser.get(r.userId) ?? []), r]);
  const rapidGrants = [];
  for (const [userId, list] of grantsByUser) {
    const asc = [...list].sort((a, b) => a.createdAt - b.createdAt);
    let best = { count: 0, from: 0, to: 0, sum: 0 };
    for (let i = 0, j = 0, sum = 0; j < asc.length; j++) {
      sum += asc[j]!.amount;
      while (asc[j]!.createdAt - asc[i]!.createdAt > RAPID_WINDOW_MS) sum -= asc[i++]!.amount;
      if (j - i + 1 > best.count) best = { count: j - i + 1, from: asc[i]!.createdAt, to: asc[j]!.createdAt, sum };
    }
    if (best.count >= RAPID_GRANTS) rapidGrants.push({ userId, nickname: asc[0]!.nickname, count: best.count, sum: best.sum, from: best.from, to: best.to, actors: [...new Set(asc.map((r) => r.actorNickname ?? r.actorId))] });
  }
  rapidGrants.sort((a, b) => b.to - a.to);

  // Operations counters are kept OPS_RETENTION_MS: before that the period has none.
  const opsFrom = Math.max(since, now - OPS_RETENTION_MS);
  const opsTotals = { cashout_fail: 0, room_error: 0, api_error: 0 };
  const cashoutByDay = new Map<number, number>();
  for (const r of rows<{ day: number; metric: keyof typeof opsTotals; n: number }>(ops)) {
    opsTotals[r.metric] += r.n;
    if (r.metric === 'cashout_fail') cashoutByDay.set(r.day, (cashoutByDay.get(r.day) ?? 0) + r.n);
  }
  // The table's latest problem starts with its ISO time; only problems within the period are listed.
  const issues = rows<{ id: string; name: string; status: string; issue: string }>(cashoutTables)
    .map((t) => ({ ...t, at: Date.parse(t.issue.slice(0, 24)) || null }))
    .filter((t) => t.at !== null && t.at >= since);

  const recRows = rows<{ scope: 'user_ledger' | 'table'; created: number; open: number }>(recon);
  const scope = (k: 'user_ledger' | 'table') => recRows.find((r) => r.scope === k) ?? { created: 0, open: 0 };
  const run = rows<{ at: number; detail: string | null }>(lastRun)[0];
  const runDetail = run?.detail ? (JSON.parse(run.detail) as { mismatches?: number; created?: number }) : null;

  return {
    days,
    since,
    wallets: { members: w.members ?? 0, accounts: w.accounts ?? 0, balance: w.balance ?? 0, deleted: w.deleted ?? 0, suspended: w.suspended ?? 0, staff: w.staff ?? 0, bots: w.bots ?? 0, botAccounts: w.botAccounts ?? 0 },
    tables: { chips: onTables, openSessions: s.n ?? 0, seatedBuyIn: s.buyIn ?? 0 },
    issued,
    ledger: { total: ledgerTotal, byType: total },
    // Wallets that differ from their ledger, summed (0 when every wallet matches, unless differences cancel out).
    gap: (w.balance ?? 0) - ledgerTotal,
    period: { counts: period, moved: series.reduce((a, d) => a + d.moved, 0), series },
    reconciliation: {
      created: { user_ledger: scope('user_ledger').created, table: scope('table').created },
      open: { user_ledger: scope('user_ledger').open, table: scope('table').open },
      lastRun: run ? { at: run.at, mismatches: runDetail?.mismatches ?? null, created: runDetail?.created ?? null } : null,
    },
    failures: {
      from: opsFrom,
      cashout: opsTotals.cashout_fail,
      room: opsTotals.room_error,
      api: opsTotals.api_error,
      cashoutDays: [...cashoutByDay].sort((a, b) => a[0] - b[0]).map(([day, n]) => ({ date: new Date(day * DAY).toISOString().slice(0, 10), n })),
      tables: issues,
    },
    anomalies: {
      rapidGrants,
      largeAdjustments: admins.filter((r) => Math.abs(r.amount) >= LARGE_ADJUSTMENT).slice(0, 50),
      refused: rows<{ id: string; action: string; userId: string; nickname: string | null; actorId: string; actorNickname: string | null; detail: string | null; createdAt: number }>(refusals).map((r) => ({
        ...r,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      })),
      staleSessions: rows<Record<string, unknown>>(stale),
      adminRowsCapped: admins.length >= 2000,
    },
    thresholds: { largeAdjustment: LARGE_ADJUSTMENT, rapidGrants: RAPID_GRANTS, rapidWindowMs: RAPID_WINDOW_MS, staleSessionMs: STALE_SESSION_MS, closingAfterMs: SWEEP_CLOSING_AFTER_MS },
    rowsRead: results.reduce((a, r) => a + (r.meta.rows_read ?? 0), 0),
  };
}
