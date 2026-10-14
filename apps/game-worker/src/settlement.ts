/**
 * Wallet ↔ table chip movements and hand records, written to D1.
 *
 * Every operation is idempotent (unique ledger keys / primary keys), so the
 * room can safely retry after a crash or an eviction between the D1 write and
 * its own storage write.
 */
import { applyLedger, LEDGER_GUARD } from '@jc/db';
import type { HandRecord } from '@jc/poker-engine';

export interface TableRow {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  turnSeconds: number;
  isPrivate: boolean;
  allowSpectators: boolean;
  entryBlocked: boolean;
  status: 'open' | 'closing' | 'closed';
}

export async function loadTable(d1: D1Database, tableId: string): Promise<TableRow | null> {
  const r = await d1
    .prepare(
      `SELECT id, name, max_seats AS maxSeats, small_blind AS smallBlind, big_blind AS bigBlind,
              min_buy_in AS minBuyIn, max_buy_in AS maxBuyIn, turn_seconds AS turnSeconds,
              is_private AS isPrivate, allow_spectators AS allowSpectators, entry_blocked AS entryBlocked, status
       FROM tables WHERE id = ?1`,
    )
    .bind(tableId)
    .first<Record<string, unknown>>();
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    maxSeats: Number(r.maxSeats),
    smallBlind: Number(r.smallBlind),
    bigBlind: Number(r.bigBlind),
    minBuyIn: Number(r.minBuyIn),
    maxBuyIn: Number(r.maxBuyIn),
    turnSeconds: Number(r.turnSeconds),
    isPrivate: !!r.isPrivate,
    allowSpectators: !!r.allowSpectators,
    entryBlocked: !!r.entryBlocked,
    status: r.status as TableRow['status'],
  };
}

export type BuyInResult = { ok: true; balanceAfter: number } | { ok: false; code: 'insufficient_balance' | 'already_seated' };

/** Debits the wallet and opens a table session atomically. */
export async function buyIn(
  d1: D1Database,
  p: { userId: string; tableId: string; tableSessionId: string; seatIndex: number; amount: number },
): Promise<BuyInResult> {
  try {
    const r = await applyLedger(
      d1,
      {
        userId: p.userId,
        type: 'buy_in',
        amount: -p.amount,
        idempotencyKey: `buyin:${p.tableSessionId}`,
        tableId: p.tableId,
        refId: p.tableSessionId,
        memo: `seat ${p.seatIndex + 1}`,
      },
      (ledgerId) => [
        d1
          .prepare(
            `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status)
             SELECT ?1, ?2, ?3, ?4, ?5, 'seated' WHERE ${LEDGER_GUARD}`,
          )
          .bind(p.tableSessionId, p.tableId, p.userId, p.seatIndex, p.amount, ledgerId),
      ],
    );
    if (r.status === 'insufficient') return { ok: false, code: 'insufficient_balance' };
    return { ok: true, balanceAfter: r.balanceAfter };
  } catch (e) {
    // Unique (table_id, user_id) WHERE status='seated' — the batch rolled back entirely.
    if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return { ok: false, code: 'already_seated' };
    throw e;
  }
}

/** Was this buy-in committed? Used to reconcile seats reserved before a crash. */
export async function buyInCommitted(d1: D1Database, tableSessionId: string): Promise<boolean> {
  const r = await d1.prepare(`SELECT 1 AS ok FROM chip_ledger WHERE idempotency_key = ?1`).bind(`buyin:${tableSessionId}`).first();
  return !!r;
}

/** Credits the remaining stack and closes the table session. Safe to repeat. */
export async function cashOut(d1: D1Database, p: { userId: string; tableId: string; tableSessionId: string; amount: number }): Promise<void> {
  const close = d1
    .prepare(`UPDATE table_sessions SET status = 'closed', cash_out = ?2, closed_at = (unixepoch('subsec') * 1000) WHERE id = ?1 AND status = 'seated'`)
    .bind(p.tableSessionId, p.amount);
  if (p.amount <= 0) {
    await close.run();
    return;
  }
  const r = await applyLedger(
    d1,
    {
      userId: p.userId,
      type: 'cash_out',
      amount: p.amount,
      idempotencyKey: `cashout:${p.tableSessionId}`,
      tableId: p.tableId,
      refId: p.tableSessionId,
    },
    () => [close],
  );
  if (r.status === 'insufficient') throw new Error('cash-out cannot be insufficient');
  // On a duplicate the session row was already closed by the first attempt; make sure.
  if (r.status === 'duplicate') await close.run();
}

async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Persists a finished hand. The public action list is stored in clear; the full
 * engine log (hole cards, deck order) is gzip-compressed for audits of finished
 * hands only.
 */
export async function recordHand(d1: D1Database, tableId: string, handNumber: number, rec: HandRecord, engineLog: unknown): Promise<void> {
  const eventLog = JSON.stringify({ actions: rec.actions, engine: await gzipBase64(JSON.stringify(engineLog)) });
  const stmts: D1PreparedStatement[] = [
    d1
      .prepare(
        `INSERT OR IGNORE INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(rec.handId, tableId, handNumber, rec.startedAt, rec.endedAt, JSON.stringify(rec.board), rec.potTotal, rec.engineVersion, eventLog),
    ...rec.players.map((p) =>
      d1
        .prepare(
          `INSERT OR IGNORE INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          rec.handId,
          p.playerId,
          p.seatIndex,
          JSON.stringify(p.holeCards),
          p.stackStart,
          p.stackEnd,
          p.net,
          p.won,
          p.rankClass,
          p.rankValue,
          p.bestFive ? JSON.stringify(p.bestFive) : null,
          p.wentToShowdown ? 1 : 0,
          rec.endedAt,
        ),
    ),
    d1.prepare(`UPDATE tables SET hands_played = hands_played + 1 WHERE id = ?1`).bind(tableId),
  ];
  await d1.batch(stmts);
}

export interface LiveStats {
  seated: number;
  playing: boolean;
  waitlist: number;
  spectators: number;
  connections: number;
}

export async function publishLiveStats(d1: D1Database, tableId: string, s: LiveStats, issue?: string | null): Promise<void> {
  await d1
    .prepare(
      `UPDATE tables SET live_seated = ?2, live_playing = ?3, live_waitlist = ?4, live_spectators = ?5, live_connections = ?6,
              live_updated_at = (unixepoch('subsec') * 1000), last_issue = COALESCE(?7, last_issue)
       WHERE id = ?1`,
    )
    .bind(tableId, s.seated, s.playing ? 1 : 0, s.waitlist, s.spectators, s.connections, issue ?? null)
    .run();
}

export async function markTableClosed(d1: D1Database, tableId: string): Promise<void> {
  await d1.prepare(`UPDATE tables SET status = 'closed', live_seated = 0, live_playing = 0, updated_at = (unixepoch('subsec') * 1000) WHERE id = ?1`).bind(tableId).run();
}
