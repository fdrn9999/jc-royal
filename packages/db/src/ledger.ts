/**
 * Wallet ledger operations shared by the API worker and the table room.
 *
 * Every balance change is one D1 batch (executed as a single transaction):
 *   1. insert a chip_ledger row computed from the current balance, guarded by
 *      the unique idempotency key and by "balance stays >= 0";
 *   2. update users.balance only if *this* ledger row was inserted.
 * Re-running the same operation (same idempotency key) is a no-op that reports
 * the original row, so retries can never grant, debit or refund twice.
 */

export type LedgerType = 'signup_grant' | 'buy_in' | 'cash_out' | 'admin_adjust' | 'reconcile';

export interface LedgerOp {
  userId: string;
  type: LedgerType;
  /** Signed integer delta. */
  amount: number;
  idempotencyKey: string;
  tableId?: string | null;
  refId?: string | null;
  actorId?: string | null;
  memo?: string | null;
}

export type LedgerResult =
  | { status: 'applied'; ledgerId: string; balanceAfter: number }
  | { status: 'duplicate'; ledgerId: string; balanceAfter: number }
  | { status: 'insufficient' };

/** Statement factory for extra writes that must commit atomically with the ledger row. */
export type GuardedStatements = (ledgerId: string) => D1PreparedStatement[];

export async function applyLedger(d1: D1Database, op: LedgerOp, extra?: GuardedStatements): Promise<LedgerResult> {
  if (!Number.isSafeInteger(op.amount) || op.amount === 0) throw new Error('ledger amount must be a non-zero integer');
  const ledgerId = crypto.randomUUID();
  const insert = d1
    .prepare(
      `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, table_id, ref_id, idempotency_key, actor_id, memo)
       SELECT ?1, id, ?2, ?3, balance + ?3, ?4, ?5, ?6, ?7, ?8 FROM users
       WHERE id = ?9 AND balance + ?3 >= 0
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .bind(ledgerId, op.type, op.amount, op.tableId ?? null, op.refId ?? null, op.idempotencyKey, op.actorId ?? null, op.memo ?? null, op.userId);
  const update = d1
    .prepare(
      `UPDATE users SET balance = balance + ?1, updated_at = (unixepoch('subsec') * 1000)
       WHERE id = ?2 AND EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?3)`,
    )
    .bind(op.amount, op.userId, ledgerId);
  const read = d1.prepare(`SELECT id, balance_after FROM chip_ledger WHERE idempotency_key = ?1`).bind(op.idempotencyKey);

  const results = await d1.batch([insert, update, ...(extra ? extra(ledgerId) : []), read]);
  const row = (results[results.length - 1]!.results as { id: string; balance_after: number }[])[0];
  if (!row) return { status: 'insufficient' };
  if (row.id === ledgerId) return { status: 'applied', ledgerId, balanceAfter: row.balance_after };
  return { status: 'duplicate', ledgerId: row.id, balanceAfter: row.balance_after };
}

/** SQL guard to append to extra statements: only write if the ledger row exists. */
export const LEDGER_GUARD = `EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?)`;

export interface LedgerMismatch {
  userId: string;
  balance: number;
  ledgerSum: number;
}

/** Users whose wallet balance differs from the sum of their ledger rows. */
export async function findLedgerMismatches(d1: D1Database): Promise<LedgerMismatch[]> {
  const { results } = await d1
    .prepare(
      `SELECT u.id AS userId, u.balance AS balance, COALESCE(SUM(l.amount), 0) AS ledgerSum
       FROM users u LEFT JOIN chip_ledger l ON l.user_id = u.id
       GROUP BY u.id HAVING u.balance <> COALESCE(SUM(l.amount), 0)`,
    )
    .all<LedgerMismatch>();
  return results;
}
