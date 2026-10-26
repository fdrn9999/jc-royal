/**
 * Wallet ↔ table chip movements and hand records, written to D1.
 *
 * Every operation is idempotent (unique ledger keys / primary keys), so the
 * room can safely retry after a crash or an eviction between the D1 write and
 * its own storage write.
 */
import { applyLedger, botStatsIncrement, HAND_STATS_SQL, handStatsIncrements, LEDGER_GUARD, opsUpserts, SOCIAL_POLICY_JSON, statsDay, type LedgerOp, type OpsCount, type TimeBankMetric } from '@jc/db';
import type { HandRecord } from '@jc/poker-engine';
import { BOT_LEVELS, BOT_TABLE_STYLES, toSocialPolicy, type BotLevel, type BotTableStyle, type SocialPolicy, type TimeBankPolicy } from '@jc/types';
import { TOURNAMENT_JSON, toTournamentRow, type TournamentRow } from './tournament';

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
  /** Emergency control: no new hand starts until an admin resumes the table. */
  handsPaused: boolean;
  status: 'open' | 'closing' | 'closed';
  roomType: 'official' | 'member' | 'tournament';
  /** The member who opened a member room (or the admin who opened an official table). */
  createdBy: string | null;
  /** Hash of a private table's current join code. Never sent to clients. */
  joinCodeHash: string | null;
  /**
   * The table's bot settings (official tables only, see bots.ts): whether bots may sit, their level, how many members
   * must be seated first, at most how many bots, the player count they fill up to, and whether one gives up its seat
   * after the hand to a member waiting for one.
   */
  bots: { enabled: boolean; level: BotLevel; style: BotTableStyle; minHumans: number; max: number; fillTo: number; yieldSeat: boolean };
  /** The service-wide bot switch (bot_policies, newest version) as D1 last showed it; read again with each hand record. */
  botPolicyOn: boolean;
  /** The time bank policy (time_bank_policies, newest version) as D1 last showed it; read again with each hand record. */
  timeBank: TimeBankPolicy | null;
  /**
   * The social policy (social_policies, newest version: quick reactions, staff badges) as D1 last showed it; read again
   * with each hand record. Null before any version exists, or for one this build cannot read: SOCIAL_DEFAULTS then.
   */
  social: SocialPolicy | null;
  /** The tournament this table plays (tournament tables only; see tournament.ts). */
  tournament: TournamentRow | null;
}

/** The next maintenance window that has not finished (the current one while it runs): see maintenance_windows. */
export interface Maintenance {
  startsAt: number;
  endsAt: number;
}

export function maintenanceQuery(d1: D1Database, now: number) {
  return d1
    .prepare(
      `SELECT starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows
       WHERE ended_at IS NULL AND cancelled_at IS NULL AND ends_at > ?1 ORDER BY starts_at LIMIT 1`,
    )
    .bind(now);
}

export function toMaintenance(r: { startsAt: unknown; endsAt: unknown } | undefined): Maintenance | null {
  return r ? { startsAt: Number(r.startsAt), endsAt: Number(r.endsAt) } : null;
}

export async function loadMaintenance(d1: D1Database, now = Date.now()): Promise<Maintenance | null> {
  return toMaintenance((await maintenanceQuery(d1, now).first<Maintenance>()) ?? undefined);
}

/** The table's settings and the maintenance window, in one D1 call. */
export async function loadTable(d1: D1Database, tableId: string, now = Date.now()): Promise<{ table: TableRow | null; maintenance: Maintenance | null }> {
  const [t, m] = await d1.batch([
    d1
      .prepare(
        `SELECT id, name, max_seats AS maxSeats, small_blind AS smallBlind, big_blind AS bigBlind,
                min_buy_in AS minBuyIn, max_buy_in AS maxBuyIn, turn_seconds AS turnSeconds,
                is_private AS isPrivate, allow_spectators AS allowSpectators, entry_blocked AS entryBlocked, hands_paused AS handsPaused, status,
                room_type AS roomType, created_by AS createdBy, join_code_hash AS joinCodeHash,
                bots_enabled AS botsEnabled, bot_level AS botLevel, bot_style AS botStyle, bot_min_humans AS botMinHumans, bot_max AS botMax,
                bot_fill_to AS botFillTo, bot_yield AS botYield, (${BOT_POLICY_ON}) AS botPolicyOn, (${TIME_BANK_POLICY}) AS timeBank,
                (${SOCIAL_POLICY_JSON}) AS social, (${TOURNAMENT_JSON}) AS tournament
         FROM tables WHERE id = ?1`,
      )
      .bind(tableId),
    maintenanceQuery(d1, now),
  ]);
  const r = t?.results[0] as Record<string, unknown> | undefined;
  return { table: r ? toTableRow(r) : null, maintenance: toMaintenance(m?.results[0] as Maintenance | undefined) };
}

function toTableRow(r: Record<string, unknown>): TableRow {
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
    handsPaused: !!r.handsPaused,
    status: r.status as TableRow['status'],
    roomType: r.roomType === 'member' ? 'member' : r.roomType === 'tournament' ? 'tournament' : 'official',
    createdBy: r.createdBy == null ? null : String(r.createdBy),
    joinCodeHash: r.joinCodeHash == null ? null : String(r.joinCodeHash),
    bots: {
      enabled: !!r.botsEnabled,
      level: BOT_LEVELS.includes(r.botLevel as BotLevel) ? (r.botLevel as BotLevel) : 'normal',
      style: BOT_TABLE_STYLES.includes(r.botStyle as BotTableStyle) ? (r.botStyle as BotTableStyle) : 'auto',
      minHumans: Math.max(1, Number(r.botMinHumans ?? 1)),
      max: Math.max(0, Number(r.botMax ?? 0)),
      fillTo: Math.max(0, Number(r.botFillTo ?? 0)),
      yieldSeat: r.botYield == null ? true : !!r.botYield,
    },
    botPolicyOn: Number(r.botPolicyOn) === 1,
    timeBank: toTimeBankPolicy(r.timeBank),
    social: toSocialPolicy(r.social),
    tournament: r.roomType === 'tournament' ? toTournamentRow(r.tournament) : null,
  };
}

/** Whether the newest bot policy has bots on (SQL expression; null, read as off, before any policy exists). */
export const BOT_POLICY_ON = `SELECT enabled FROM bot_policies ORDER BY version DESC LIMIT 1`;

/** The newest time bank policy as one JSON value (SQL expression; null before any policy exists). */
export const TIME_BANK_POLICY = `SELECT json_object('version', version, 'enabled', enabled, 'memberRooms', member_rooms, 'initialMs', initial_ms,
  'maxMs', max_ms, 'unitMs', unit_ms, 'refillHands', refill_hands, 'refillMs', refill_ms) FROM time_bank_policies ORDER BY version DESC LIMIT 1`;

/** A policy read with TIME_BANK_POLICY; null (off) for none, or for one this build cannot read. */
export function toTimeBankPolicy(raw: unknown): TimeBankPolicy | null {
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const n = (k: string) => (Number.isSafeInteger(p[k]) && (p[k] as number) >= 0 ? (p[k] as number) : null);
    const [version, initialMs, maxMs, unitMs, refillHands, refillMs] = ['version', 'initialMs', 'maxMs', 'unitMs', 'refillHands', 'refillMs'].map(n);
    if (version == null || initialMs == null || maxMs == null || unitMs == null || refillHands == null || refillMs == null || unitMs <= 0 || refillHands <= 0) return null;
    return { version, enabled: p.enabled === 1, memberRooms: p.memberRooms === 1, initialMs, maxMs, unitMs, refillHands, refillMs };
  } catch {
    return null;
  }
}

export type BuyInResult = { ok: true; balanceAfter: number } | { ok: false; code: 'insufficient_balance' | 'already_seated' | 'suspended' };

/** Whether the account may still bring chips to a table; asked only after the ledger refused a buy-in or top-up. */
async function accountActive(d1: D1Database, userId: string): Promise<boolean> {
  const r = await d1.prepare(`SELECT status FROM users WHERE id = ?1`).bind(userId).first<{ status: string }>();
  return r?.status === 'active';
}

/**
 * Debits the wallet and opens a table session atomically. `guard` adds conditions to the ledger statement (see
 * LedgerOp.guard): a table bot's buy-in uses it (bots.ts), and its refusal reads as 'insufficient_balance'.
 */
export async function buyIn(
  d1: D1Database,
  p: { userId: string; tableId: string; tableSessionId: string; seatIndex: number; amount: number; guard?: LedgerOp['guard'] },
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
        activeOnly: true,
        ...(p.guard ? { guard: p.guard } : {}),
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
    if (r.status === 'insufficient') return { ok: false, code: (await accountActive(d1, p.userId)) ? 'insufficient_balance' : 'suspended' };
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
 * repeat a no-op ('duplicate'), so a retry after a crash never takes chips twice. A suspended account gets 'suspended'.
 */
export async function topUp(
  d1: D1Database,
  p: { userId: string; tableId: string; tableSessionId: string; amount: number; key: string; memo: string },
): Promise<'applied' | 'duplicate' | 'insufficient' | 'suspended'> {
  const r = await applyLedger(
    d1,
    { userId: p.userId, type: 'top_up', amount: -p.amount, idempotencyKey: p.key, tableId: p.tableId, refId: p.tableSessionId, memo: p.memo, activeOnly: true },
    (ledgerId) => [d1.prepare(`UPDATE table_sessions SET buy_in = buy_in + ?1 WHERE id = ?2 AND ${LEDGER_GUARD}`).bind(p.amount, p.tableSessionId, ledgerId)],
  );
  if (r.status === 'insufficient' && !(await accountActive(d1, p.userId))) return 'suspended';
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
 * Persists a finished hand. The public action list, button seat, blinds and pot payouts
 * (for replays) are stored in clear; the full engine log (hole cards, deck order)
 * is gzip-compressed for audits of finished hands only. Records queued before the
 * button, pots and blinds existed have none of them.
 *
 * The same batch reads the maintenance window back (and, with `botPolicy`, the bot switch: only tables that allow bots
 * ask), so a dealing room that was never told of a change (the admin's fan-out did not reach it, and its occupancy did
 * not change) learns of it before its next hand; the time bank and social policies are read back the same way. `bots` is how many
 * table bots were dealt in: hands with bots are kept apart from members-only play in statistics. `timeBank` is the
 * hand's time bank counters and `botStats` the bots' play summed over the last few hands (bot-stats.ts), each added to
 * the day's statistics only with the hand's first write.
 */
export async function recordHand(
  d1: D1Database,
  tableId: string,
  handNumber: number,
  rec: HandRecord,
  engineLog: unknown,
  opts: { bots?: number; botPolicy?: boolean; timeBank?: Partial<Record<TimeBankMetric, number>>; botStats?: { day: number; n: Record<string, number> }[] } = {},
): Promise<{ maintenance: Maintenance | null; botPolicyOn: boolean | null; timeBank: TimeBankPolicy | null; social: SocialPolicy | null }> {
  const eventLog = JSON.stringify({
    actions: rec.actions,
    button: rec.buttonSeat ?? null,
    blinds: rec.blinds ?? null,
    pots: rec.pots ?? null,
    engine: await gzipBase64(JSON.stringify(engineLog)),
  });
  const policy = opts.botPolicy ? [d1.prepare(`SELECT (${BOT_POLICY_ON}) AS botPolicyOn`)] : [];
  const stmts: D1PreparedStatement[] = [
    maintenanceQuery(d1, Date.now()),
    ...policy,
    d1.prepare(`SELECT (${TIME_BANK_POLICY}) AS timeBank, (${SOCIAL_POLICY_JSON}) AS social`),
    // Counted only the first time, so writing a hand again (a retry after an unclear failure) changes nothing.
    ...handStatsIncrements(d1, statsDay(rec.endedAt), rec.handId, opts.timeBank ?? {}),
    ...(opts.botStats ?? []).flatMap((b) => botStatsIncrement(d1, b.day, rec.handId, b.n)),
    d1
      .prepare(`UPDATE tables SET hands_played = hands_played + 1 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM hands WHERE id = ?2)`)
      .bind(tableId, rec.handId),
    d1
      .prepare(
        `INSERT OR IGNORE INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log, bots)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(rec.handId, tableId, handNumber, rec.startedAt, rec.endedAt, JSON.stringify(rec.board), rec.potTotal, rec.engineVersion, eventLog, opts.bots ?? 0),
    ...rec.players.map((p) =>
      d1
        .prepare(
          `INSERT OR IGNORE INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at, shown)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
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
          // A record kept from before muck existed has no flag: NULL reads as went_to_showdown, which it was.
          p.shown === undefined ? null : p.shown ? 1 : 0,
        ),
    ),
  ];
  const results = await d1.batch(stmts);
  // Per-player statistics for this hand (and any rows still without them). The hand is recorded either way.
  try {
    await d1.prepare(HAND_STATS_SQL).run();
  } catch (e) {
    console.error('hand stats failed', tableId, rec.handId, e);
  }
  const policies = results[1 + policy.length]?.results[0] as { timeBank?: unknown; social?: unknown } | undefined;
  return {
    maintenance: toMaintenance(results[0]?.results[0] as Maintenance | undefined),
    botPolicyOn: policy.length ? Number((results[1]?.results[0] as { botPolicyOn?: unknown } | undefined)?.botPolicyOn) === 1 : null,
    timeBank: toTimeBankPolicy(policies?.timeBank),
    social: toSocialPolicy(policies?.social),
  };
}

export interface LiveStats {
  /** Seats taken, table bots included. */
  seated: number;
  /** Of those, the table bots. */
  bots: number;
  playing: boolean;
  waitlist: number;
  spectators: number;
  connections: number;
}

/**
 * Writes the room's live occupancy, its latest problem (if any) and its pending operations counters in one D1 batch,
 * which also reads the maintenance window back (so a room learns of one without a D1 call of its own).
 */
export async function publishLiveStats(d1: D1Database, tableId: string, s: LiveStats, issue: string | null = null, ops: OpsCount[] = [], now = Date.now()): Promise<Maintenance | null> {
  const results = await d1.batch([
    maintenanceQuery(d1, now),
    d1
      .prepare(
        `UPDATE tables SET live_seated = ?2, live_playing = ?3, live_waitlist = ?4, live_spectators = ?5, live_connections = ?6,
                live_updated_at = (unixepoch('subsec') * 1000), last_issue = COALESCE(?7, last_issue), live_bots = ?8
         WHERE id = ?1`,
      )
      .bind(tableId, s.seated, s.playing ? 1 : 0, s.waitlist, s.spectators, s.connections, issue, s.bots),
    ...opsUpserts(d1, ops),
  ]);
  return toMaintenance(results[0]?.results[0] as Maintenance | undefined);
}

export async function markTableClosed(d1: D1Database, tableId: string): Promise<void> {
  await d1.prepare(`UPDATE tables SET status = 'closed', live_seated = 0, live_bots = 0, live_playing = 0, updated_at = (unixepoch('subsec') * 1000) WHERE id = ?1`).bind(tableId).run();
}
