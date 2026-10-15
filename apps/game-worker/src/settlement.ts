/**
 * Wallet ↔ table chip movements and hand records, written to D1.
 *
 * Every operation is idempotent (unique ledger keys / primary keys), so the
 * room can safely retry after a crash or an eviction between the D1 write and
 * its own storage write.
 */
import { applyLedger, HAND_STATS_SQL, LEDGER_GUARD } from '@jc/db';
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
  roomType: 'official' | 'member';
  /** The member who opened a member room (or the admin who opened an official table). */
  createdBy: string | null;
  /** Hash of a private table's current join code. Never sent to clients. */
  joinCodeHash: string | null;
}

export async function loadTable(d1: D1Database, tableId: string): Promise<TableRow | null> {
  const r = await d1
    .prepare(
      `SELECT id, name, max_seats AS maxSeats, small_blind AS smallBlind, big_blind AS bigBlind,
              min_buy_in AS minBuyIn, max_buy_in AS maxBuyIn, turn_seconds AS turnSeconds,
              is_private AS isPrivate, allow_spectators AS allowSpectators, entry_blocked AS entryBlocked, status,
              room_type AS roomType, created_by AS createdBy, join_code_hash AS joinCodeHash
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
    roomType: r.roomType === 'member' ? 'member' : 'official',
    createdBy: r.createdBy == null ? null : String(r.createdBy),
    joinCodeHash: r.joinCodeHash == null ? null : String(r.joinCodeHash),
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

/**
 * Moves chips from the wallet to an open table session (a top-up or an automatic rebuy). The ledger key makes a
 * repeat a no-op ('duplicate'), so a retry after a crash never takes chips twice.
 */
export async function topUp(
  d1: D1Database,
  p: { userId: string; tableId: string; tableSessionId: string; amount: number; key: string; memo: string },
): Promise<'applied' | 'duplicate' | 'insufficient'> {
  const r = await applyLedger(
    d1,
    { userId: p.userId, type: 'top_up', amount: -p.amount, idempotencyKey: p.key, tableId: p.tableId, refId: p.tableSessionId, memo: p.memo },
    (ledgerId) => [d1.prepare(`UPDATE table_sessions SET buy_in = buy_in + ?1 WHERE id = ?2 AND ${LEDGER_GUARD}`).bind(p.amount, p.tableSessionId, ledgerId)],
  );
  return r.status;
}

/**
 * The chips a committed top-up took from the wallet, or null if this key was never committed. Used to settle one whose
 * outcome is unknown after a crash or a failed call, and to recognise a request that was already counted.
 */
export async function committedTopUp(d1: D1Database, key: string): Promise<number | null> {
  const r = await d1.prepare(`SELECT -amount AS amount FROM chip_ledger WHERE idempotency_key = ?1`).bind(key).first<{ amount: number }>();
  return r ? r.amount : null;
}

/** The wallet balance, so a top-up queued for after the hand can be refused at once when the wallet is short. */
export async function walletBalance(d1: D1Database, userId: string): Promise<number> {
  const r = await d1.prepare(`SELECT balance FROM users WHERE id = ?1`).bind(userId).first<{ balance: number }>();
  return r?.balance ?? 0;
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
    // Counted only the first time, so writing a hand again (a retry after an unclear failure) changes nothing.
    d1
      .prepare(`UPDATE tables SET hands_played = hands_played + 1 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM hands WHERE id = ?2)`)
      .bind(tableId, rec.handId),
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
  ];
  await d1.batch(stmts);
  // Per-player statistics for this hand (and any rows still without them). The hand is recorded either way.
  try {
    await d1.prepare(HAND_STATS_SQL).run();
  } catch (e) {
    console.error('hand stats failed', tableId, rec.handId, e);
  }
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
