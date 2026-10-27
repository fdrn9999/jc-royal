/**
 * Table bot administration (game-worker bots.ts and room.ts "table bots"). Mounted inside the admin router: an admin
 * session, the admin origin and the permission table's rule are already applied.
 *
 * - The policy (bots on or off service-wide, the bot fund's limit, how many bots may sit at once) is a super admin's,
 *   with the password, a reason and a preview of the old and new values. A change is a new version row; two
 *   administrators editing from the same version: the second is told it changed (409) and shown the current one. Every
 *   table that allows bots is then told to reload: bots sit down or stand up between hands, and one in a hand plays it out.
 * - Anyone with the feature may switch bots off in an emergency (password and reason); only a super admin switches
 *   them on again, through the policy.
 * - Which tables allow bots, and how (level, style, counts, giving up a seat), is each table's setting (PATCH /tables/:id).
 * - Each bot account may have its own level and style (bot_profiles), over the table's (BotProfile, botPlayOf), and its
 *   own buy-in in big blinds (botBuyInOf): anyone with the feature, with the password, a reason and a preview. The table
 *   it sits at reads it again at once and deals it from the next hand; a hand under way is played out as it was dealt.
 *   The buy-in counts from the next time it sits down: the stack at a seat it holds never changes.
 * - The fund's books are read here, never corrected here: what the fund issued (bot_fund.issued) must equal its ledger
 *   rows, each bot's wallet its ledger, and the bots' result against members is
 *   bot wallets + chips bots took to tables − issued. A correction goes through reconciliation like any other.
 */
import { BOT_STAT_KEYS, botStatMetric, dayStart, statsDay, STATS_DAY, type BotStatKey } from '@jc/db';
import { BOT_BUY_IN_BB, BOT_LEVELS, BOT_STYLES, botBuyInOf, botPlayOf, styleFor, type BotLevel, type BotProfile, type BotStyle, type BotTableStyle } from '@jc/types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { roomCall } from '../lib/room';

const ReasonSchema = z.string().trim().min(2).max(200);
/** What a policy can hold: the fund's limit is chips issued over all time, max bots counts every table. */
export const BOT_LIMITS = { fundLimit: { min: 0, max: 1_000_000_000 }, maxBots: { min: 0, max: 200 } } as const;
const PolicyFields = {
  /** The version the administrator was looking at: a newer one meanwhile is a conflict. */
  baseVersion: z.number().int().min(0),
  enabled: z.boolean(),
  fundLimit: z.number().int().min(BOT_LIMITS.fundLimit.min).max(BOT_LIMITS.fundLimit.max),
  maxBots: z.number().int().min(BOT_LIMITS.maxBots.min).max(BOT_LIMITS.maxBots.max),
};
const PolicySchema = z.object({ ...PolicyFields, reason: ReasonSchema });
const PolicyPreviewSchema = z.object({ ...PolicyFields, reason: ReasonSchema.optional() });
const StopSchema = z.object({ reason: ReasonSchema });
const ProfileFields = {
  /** When the profile the administrator was looking at was saved (null: the bot had none); anything newer is a conflict. */
  baseUpdatedAt: z.number().int().nullable(),
  /** Null follows the table the bot sits at. */
  level: z.enum(BOT_LEVELS).nullable(),
  style: z.enum(BOT_STYLES).nullable(),
  /** Big blinds it sits down with; null: the default; left out: as it is now. */
  buyInBb: z.number().int().min(BOT_BUY_IN_BB.min).max(BOT_BUY_IN_BB.max).nullable().optional(),
};
const ProfileSchema = z.object({ ...ProfileFields, reason: ReasonSchema });
const ProfilePreviewSchema = z.object({ ...ProfileFields, reason: ReasonSchema.optional() });
/** The postflop aggression of each bot (AF) is read from at most this many of its latest hands in the period. */
export const BOT_AF_HANDS = 500;

const EVENT_KINDS = ['join', 'leave', 'fund_exhausted', 'join_failed', 'action_failed'] as const;

export interface BotPolicy {
  version: number;
  enabled: boolean;
  fundLimit: number;
  maxBots: number;
  change: string;
  actorId: string | null;
  actorNickname: string | null;
  reason: string | null;
  createdAt: number;
}

const POLICY_COLUMNS = `p.version, p.enabled, p.fund_limit AS fundLimit, p.max_bots AS maxBots, p.change, p.actor_id AS actorId, p.reason,
  p.created_at AS createdAt, u.nickname AS actorNickname`;
const policyOf = (r: Record<string, unknown>): BotPolicy => ({
  version: Number(r.version),
  enabled: Number(r.enabled) === 1,
  fundLimit: Number(r.fundLimit),
  maxBots: Number(r.maxBots),
  change: String(r.change),
  actorId: (r.actorId as string | null) ?? null,
  actorNickname: (r.actorNickname as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  createdAt: Number(r.createdAt),
});
const brief = (p: BotPolicy | null) => (p ? { version: p.version, enabled: p.enabled, fundLimit: p.fundLimit, maxBots: p.maxBots } : null);

async function currentPolicy(db: D1Database): Promise<BotPolicy | null> {
  const r = await db.prepare(`SELECT ${POLICY_COLUMNS} FROM bot_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 1`).first<Record<string, unknown>>();
  return r ? policyOf(r) : null;
}

function conflict(current: BotPolicy | null): never {
  fail(409, 'bot_policy_conflict', 'the bot policy changed meanwhile', { policy: brief(current) });
}

const levelOf = (v: unknown): BotLevel | null => (BOT_LEVELS.includes(v as BotLevel) ? (v as BotLevel) : null);
const styleOf = (v: unknown): BotStyle | null => (BOT_STYLES.includes(v as BotStyle) ? (v as BotStyle) : null);
const tableStyleOf = (v: unknown): BotTableStyle => (v === 'auto' ? 'auto' : (styleOf(v) ?? 'auto'));
const buyInBbOf = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n >= BOT_BUY_IN_BB.min && n <= BOT_BUY_IN_BB.max ? n : null;
};
/** A bot_profiles row (`profiled`: the row's key, null without one). */
const profileRow = (r: Record<string, unknown>): BotProfile | null =>
  r.profiled ? { level: levelOf(r.level), style: styleOf(r.style), buyInBb: buyInBbOf(r.buyInBb) } : null;
/** A table's blinds and buy-in range, as botBuyInOf reads them. */
const tableBuyIn = (r: Record<string, unknown>) => ({ bigBlind: Number(r.bigBlind), minBuyIn: Number(r.minBuyIn), maxBuyIn: Number(r.maxBuyIn) });

/**
 * A bot's own settings, the table it sits at (if any) with that table's (and its blinds and buy-in range), the chips it
 * sat down there with, and the account's automatic style.
 */
async function botProfile(db: D1Database, id: string) {
  const r = await db
    .prepare(
      `SELECT u.id, u.nickname, u.is_bot AS isBot, p.bot_id AS profiled, p.level, p.style, p.buy_in_bb AS buyInBb, p.updated_at AS updatedAt,
              s.table_id AS tableId, s.buy_in AS seatBuyIn, t.name AS tableName, t.bot_level AS tableLevel, t.bot_style AS tableStyle,
              t.big_blind AS bigBlind, t.min_buy_in AS minBuyIn, t.max_buy_in AS maxBuyIn
         FROM users u LEFT JOIN bot_profiles p ON p.bot_id = u.id
         LEFT JOIN table_sessions s ON s.user_id = u.id AND s.status = 'seated' LEFT JOIN tables t ON t.id = s.table_id
        WHERE u.id = ?1 LIMIT 1`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!r || Number(r.isBot) !== 1) fail(404, 'not_found', 'bot not found');
  const profile = profileRow(r);
  const table = r.tableId
    ? { id: String(r.tableId), name: String(r.tableName), level: levelOf(r.tableLevel) ?? 'normal', style: tableStyleOf(r.tableStyle), ...tableBuyIn(r) }
    : null;
  return { id: String(r.id), nickname: String(r.nickname), profile, updatedAt: profile ? Number(r.updatedAt) : null, table, seatBuyIn: table ? Number(r.seatBuyIn) : null };
}

function profileConflict(current: Awaited<ReturnType<typeof botProfile>>): never {
  fail(409, 'bot_profile_conflict', "the bot's settings changed meanwhile", { profile: current.profile, updatedAt: current.updatedAt });
}

/** Tables that allow bots (official, open or closing), through tables_status_idx. */
const BOT_TABLES = `SELECT id FROM tables WHERE status IN ('open', 'closing') AND room_type = 'official' AND bots_enabled = 1`;

/** Bots seated now and the chips they took to tables (buy-ins and top-ups of their open seats). */
const SEATED = `SELECT COUNT(*) AS n, COALESCE(SUM(s.buy_in), 0) AS chips FROM users u CROSS JOIN table_sessions s ON s.user_id = u.id AND s.status = 'seated' WHERE u.is_bot = 1`;

/** Tells every table that allows bots to read the policy again; how many answered. */
async function reloadBotTables(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare(BOT_TABLES).all<{ id: string }>();
  const answers = await Promise.all(results.map(async ({ id }) => (await roomCall(c, id, 'reload')) ?? (await roomCall(c, id, 'reload'))));
  const unreached = results.filter((_, i) => !answers[i]).map((t) => t.id);
  return { tables: results.length, reached: results.length - unreached.length, unreached };
}

/** Writes the next version from `from` (still the latest), or reports the conflict. */
async function writeVersion(c: Context<AppEnv>, from: BotPolicy | null, next: { enabled: boolean; fundLimit: number; maxBots: number }, change: 'policy' | 'stop', reason: string) {
  const now = Date.now();
  const r = await c.env.DB.prepare(
    `INSERT INTO bot_policies (version, enabled, fund_limit, max_bots, change, actor_id, reason, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
      WHERE COALESCE((SELECT MAX(version) FROM bot_policies), 0) = ?9
     ON CONFLICT (version) DO NOTHING`,
  )
    .bind((from?.version ?? 0) + 1, next.enabled ? 1 : 0, next.fundLimit, next.maxBots, change, c.var.user!.id, reason, now, from?.version ?? 0)
    .run();
  if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
  return { version: (from?.version ?? 0) + 1, ...next };
}

/**
 * The bots' play per level over the period (game-worker bot-stats.ts, summed from `bt_*` daily counters): the counters
 * themselves, so each rate is shown with its own denominator. Every level, zeros included.
 */
function botPlay(rows: Record<string, unknown>[]) {
  const sum = new Map(rows.map((r) => [String(r.metric), Number(r.n)]));
  return BOT_LEVELS.map((level) => ({ level, ...(Object.fromEntries(BOT_STAT_KEYS.map((k) => [k, sum.get(botStatMetric(level, k)) ?? 0])) as Record<BotStatKey, number>) }));
}

const page = (c: Context<AppEnv>, fallback = 50) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? fallback) || fallback, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

export const adminBotRoutes = new Hono<AppEnv>()
  /**
   * The policy and its latest versions, the fund (issued, limit, left), the bots' chips and result, the tables that
   * allow bots with the bots seated there, and the period's play (`days` 1 to 30): hands with a bot, the bots' net
   * by the table's level now, and how each level played (`play`: public counters and its moves, from bot-stats.ts).
   */
  .get('/bots', async (c) => {
    const days = Math.trunc(Number(c.req.query('days') ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 30) fail(400, 'invalid_input', 'days must be 1 to 30');
    const now = Date.now();
    const first = statsDay(now) - days + 1;
    const since = dayStart(first);
    const db = c.env.DB;
    const res = await db.batch([
      db.prepare(`SELECT ${POLICY_COLUMNS} FROM bot_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 20`),
      db.prepare(`SELECT issued, updated_at AS updatedAt FROM bot_fund WHERE id = 1`),
      db.prepare(`SELECT COUNT(*) AS accounts, COALESCE(SUM(balance), 0) AS wallets FROM users WHERE is_bot = 1`),
      db.prepare(SEATED),
      db.prepare(
        `SELECT id, name, status, max_seats AS maxSeats, big_blind AS bigBlind, bot_level AS level, bot_style AS style, bot_min_humans AS minHumans, bot_max AS max,
                bot_fill_to AS fillTo, bot_yield AS yieldSeat, live_seated AS seated, live_bots AS bots, live_playing AS playing
           FROM tables WHERE status IN ('open', 'closing') AND room_type = 'official' AND bots_enabled = 1 ORDER BY name LIMIT 100`,
      ),
      db.prepare(
        `SELECT s.table_id AS tableId, s.user_id AS botId, u.nickname, s.seat_index AS seatIndex, s.buy_in AS buyIn, s.created_at AS since
           FROM users u CROSS JOIN table_sessions s ON s.user_id = u.id AND s.status = 'seated' WHERE u.is_bot = 1 ORDER BY s.table_id, s.seat_index`,
      ),
      // The bots' hands of the period through hp_user_idx, by the level their table has now.
      db
        .prepare(
          `SELECT t.bot_level AS level, COUNT(*) AS hands, COALESCE(SUM(hp.net), 0) AS net
             FROM users u CROSS JOIN hand_players hp ON hp.user_id = u.id AND hp.ended_at >= ?1
             JOIN hands h ON h.id = hp.hand_id JOIN tables t ON t.id = h.table_id
            WHERE u.is_bot = 1 GROUP BY t.bot_level`,
        )
        .bind(since),
      db.prepare(`SELECT day, metric, n FROM daily_stats WHERE day >= ?1 AND metric IN ('hands_bots', 'tables_bots')`).bind(first),
      db.prepare(`SELECT kind, COUNT(*) AS n FROM bot_events WHERE created_at >= ?1 GROUP BY kind`).bind(since),
      db.prepare(`SELECT metric, SUM(n) AS n FROM daily_stats WHERE day >= ?1 AND metric GLOB 'bt_*' GROUP BY metric`).bind(first),
    ]);
    const rows = (i: number) => (res[i]?.results ?? []) as Record<string, unknown>[];
    const versions = rows(0).map(policyOf);
    const policy = versions[0] ?? null;
    const issued = Number(rows(1)[0]?.issued ?? 0);
    const wallets = Number(rows(2)[0]?.wallets ?? 0);
    const seated = rows(3)[0] ?? {};
    const atTables = Number(seated.chips ?? 0);
    const botsAt = new Map<string, Record<string, unknown>[]>();
    for (const b of rows(5)) botsAt.set(b.tableId as string, [...(botsAt.get(b.tableId as string) ?? []), b]);
    const series = new Map<number, { hands: number; tables: number }>();
    for (const r of rows(7)) {
      const d = series.get(r.day as number) ?? { hands: 0, tables: 0 };
      if (r.metric === 'hands_bots') d.hands = Number(r.n);
      else d.tables = Number(r.n);
      series.set(r.day as number, d);
    }
    return c.json({
      now,
      days,
      since,
      policy,
      versions,
      limits: BOT_LIMITS,
      fund: { issued, limit: policy?.fundLimit ?? 0, left: Math.max(0, (policy?.fundLimit ?? 0) - issued), updatedAt: Number(rows(1)[0]?.updatedAt ?? 0) || null },
      // Seats' chips are what the bots took to the table; what they hold now is the room's (they cash out what they hold).
      chips: { accounts: Number(rows(2)[0]?.accounts ?? 0), wallets, atTables, seated: Number(seated.n ?? 0), result: wallets + atTables - issued },
      tables: rows(4).map((t) => ({ ...t, playing: Boolean(t.playing), yieldSeat: Boolean(t.yieldSeat), seatedBots: botsAt.get(t.id as string) ?? [] })),
      // Seated at a table that no longer allows bots (they stand up after the hand) or that is not listed above.
      elsewhere: rows(5).filter((b) => !rows(4).some((t) => t.id === b.tableId)),
      byLevel: rows(6).map((r) => ({ level: r.level as string, hands: Number(r.hands), net: Number(r.net) })),
      series: Array.from({ length: days }, (_, i) => ({ date: new Date((first + i) * STATS_DAY).toISOString().slice(0, 10), ...(series.get(first + i) ?? { hands: 0, tables: 0 }) })),
      events: Object.fromEntries(rows(8).map((r) => [r.kind as string, Number(r.n)])),
      play: botPlay(rows(9)),
    });
  })
  /**
   * A new policy version. `preview`: the old and new values, when they apply (each table between hands) and what is
   * running now. The tables that allow bots are told to reload; those that did not answer pick it up at their next
   * bot seat (the buy-in reads the policy) or when they load.
   */
  .put('/bots/policy', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PolicyPreviewSchema : PolicySchema);
    const current = await currentPolicy(c.env.DB);
    if ((current?.version ?? 0) !== body.baseVersion) conflict(current);
    const next = { enabled: body.enabled, fundLimit: body.fundLimit, maxBots: body.maxBots };
    if (current && current.enabled === next.enabled && current.fundLimit === next.fundLimit && current.maxBots === next.maxBots) {
      fail(400, 'bot_policy_no_change', 'the policy is the same as now');
    }
    if (preview) {
      const db = c.env.DB;
      const [tables, seated, fund] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS n FROM (${BOT_TABLES})`),
        db.prepare(SEATED),
        db.prepare(`SELECT issued FROM bot_fund WHERE id = 1`),
      ]);
      const issued = Number((fund?.results[0] as { issued?: number } | undefined)?.issued ?? 0);
      return c.json({
        preview: true,
        from: brief(current),
        to: { version: body.baseVersion + 1, ...next },
        appliesFrom: 'between_hands',
        tables: Number((tables?.results[0] as { n?: number } | undefined)?.n ?? 0),
        seatedBots: Number((seated?.results[0] as { n?: number } | undefined)?.n ?? 0),
        issued,
        // A limit under what is already issued issues nothing more; nothing issued is taken back.
        fundLeft: Math.max(0, next.fundLimit - issued),
      });
    }
    const to = await writeVersion(c, current, next, 'policy', body.reason!);
    const rooms = await reloadBotTables(c);
    await audit(c, 'bots.policy', undefined, { from: brief(current), to, reason: body.reason, rooms: { tables: rooms.tables, reached: rooms.reached } });
    return c.json({ ok: true, policy: to, rooms });
  })
  /** Emergency stop (anyone with the feature): bots finish the hand they are in and stand up; nothing is paid or taken. */
  .post('/bots/stop', async (c) => {
    const { reason } = await parseBody(c, StopSchema);
    const current = await currentPolicy(c.env.DB);
    if (!current?.enabled) fail(409, 'bot_already_off', 'table bots are already off');
    const to = await writeVersion(c, current, { enabled: false, fundLimit: current.fundLimit, maxBots: current.maxBots }, 'stop', reason);
    const rooms = await reloadBotTables(c);
    await audit(c, 'bots.stop', undefined, { from: brief(current), to, reason, rooms: { tables: rooms.tables, reached: rooms.reached } });
    return c.json({ ok: true, policy: to, rooms });
  })
  /**
   * Bot accounts, a page at a time (oldest first): each one's own settings (null: the table's), the table it sits at and
   * how it plays there (`effective`), and its play over the period (`days` 1 to 30) from the recorded hands: hands,
   * VPIP and PFR over the hands whose statistics were worked out (`counted`), net chips, and postflop aggression (AF:
   * bets and raises against calls) over at most BOT_AF_HANDS of its latest hands there. `result` is the account's all-time
   * result at the tables: wallet + chips it took to the table it sits at − chips the fund issued to it. Nothing is made
   * up: a bot with no hands in the period has none, and the console shows no rate for it.
   */
  .get('/bots/accounts', async (c) => {
    const days = Math.trunc(Number(c.req.query('days') ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 30) fail(400, 'invalid_input', 'days must be 1 to 30');
    const { limit, offset } = page(c);
    const since = dayStart(statsDay(Date.now()) - days + 1);
    const db = c.env.DB;
    const PAGE = `SELECT id FROM users WHERE is_bot = 1 ORDER BY created_at, id LIMIT ?1 OFFSET ?2`;
    const res = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_bot = 1`),
      db
        .prepare(
          `SELECT u.id, u.nickname, u.status, u.balance, u.created_at AS createdAt, p.bot_id AS profiled, p.level, p.style,
                  p.buy_in_bb AS buyInBb, p.updated_at AS updatedAt, pu.nickname AS updatedBy
             FROM users u LEFT JOIN bot_profiles p ON p.bot_id = u.id LEFT JOIN users pu ON pu.id = p.updated_by
            WHERE u.is_bot = 1 ORDER BY u.created_at, u.id LIMIT ?1 OFFSET ?2`,
        )
        .bind(limit, offset),
      db
        .prepare(
          `SELECT s.user_id AS id, s.table_id AS tableId, t.name AS tableName, t.bot_level AS tableLevel, t.bot_style AS tableStyle,
                  t.big_blind AS bigBlind, t.min_buy_in AS minBuyIn, t.max_buy_in AS maxBuyIn,
                  s.seat_index AS seatIndex, s.buy_in AS buyIn, s.created_at AS since
             FROM (${PAGE}) b CROSS JOIN table_sessions s ON s.user_id = b.id AND s.status = 'seated' JOIN tables t ON t.id = s.table_id
            ORDER BY s.created_at`,
        )
        .bind(limit, offset),
      db
        .prepare(
          `SELECT hp.user_id AS id, COUNT(*) AS hands, SUM(hp.vpip IS NOT NULL) AS counted, COALESCE(SUM(hp.vpip), 0) AS vpip,
                  COALESCE(SUM(hp.pfr), 0) AS pfr, COALESCE(SUM(hp.net), 0) AS net
             FROM (${PAGE}) b CROSS JOIN hand_players hp ON hp.user_id = b.id AND hp.ended_at >= ?3 GROUP BY hp.user_id`,
        )
        .bind(limit, offset, since),
      // Postflop: a move that takes the street's highest total higher is a bet or raise, one that puts chips in without
      // doing so a call (a short all-in included), as the bots count it (profile.ts). Logs that cannot be read add nothing.
      db
        .prepare(
          `WITH recent AS (
             SELECT hp.user_id, hp.hand_id, hp.seat_index AS seat, ROW_NUMBER() OVER (PARTITION BY hp.user_id ORDER BY hp.ended_at DESC) AS rn
               FROM (${PAGE}) b CROSS JOIN hand_players hp ON hp.user_id = b.id AND hp.ended_at >= ?3
           ), picked AS (
             SELECT user_id, hand_id, seat FROM recent WHERE rn <= ?4
           ), logs AS (
             SELECT h.id AS hand_id, CASE WHEN json_valid(h.event_log) THEN CASE WHEN json_type(h.event_log, '$.actions') = 'array' THEN h.event_log END END AS log
               FROM (SELECT DISTINCT hand_id FROM picked) d CROSS JOIN hands h ON h.id = d.hand_id
           ), acts AS (
             SELECT l.hand_id, a.key AS k, json_extract(a.value, '$.seatIndex') AS seat, json_extract(a.value, '$.stage') AS stage,
                    COALESCE(json_extract(a.value, '$.amount'), 0) AS amount
               FROM logs l, json_each(l.log, '$.actions') a
              WHERE l.log IS NOT NULL AND json_extract(a.value, '$.stage') <> 'preflop'
           ), run AS (
             SELECT hand_id, k, seat, stage, amount, SUM(amount) OVER (PARTITION BY hand_id, stage, seat ORDER BY k) AS total FROM acts
           ), seen AS (
             SELECT hand_id, seat, amount, total,
                    COALESCE(MAX(total) OVER (PARTITION BY hand_id, stage ORDER BY k ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
               FROM run
           )
           SELECT p.user_id AS id, COUNT(DISTINCT p.hand_id) AS hands,
                  COALESCE(SUM(s.amount > 0 AND s.total > s.before), 0) AS aggressive, COALESCE(SUM(s.amount > 0 AND s.total <= s.before), 0) AS calls
             FROM picked p LEFT JOIN seen s ON s.hand_id = p.hand_id AND s.seat = p.seat GROUP BY p.user_id`,
        )
        .bind(limit, offset, since, BOT_AF_HANDS),
      db
        .prepare(`SELECT l.user_id AS id, COALESCE(SUM(l.amount), 0) AS funded FROM (${PAGE}) b CROSS JOIN chip_ledger l ON l.user_id = b.id AND l.type = 'bot_fund' GROUP BY l.user_id`)
        .bind(limit, offset),
    ]);
    const rows = (i: number) => (res[i]?.results ?? []) as Record<string, unknown>[];
    const by = (i: number) => new Map(rows(i).map((r) => [String(r.id), r]));
    const seats = new Map<string, Record<string, unknown>>();
    for (const s of rows(2)) if (!seats.has(String(s.id))) seats.set(String(s.id), s);
    const play = by(3);
    const af = by(4);
    const funded = by(5);
    const items = rows(1).map((r) => {
      const id = String(r.id);
      const profile = profileRow(r);
      const s = seats.get(id);
      const table = s ? { level: levelOf(s.tableLevel) ?? 'normal', style: tableStyleOf(s.tableStyle), ...tableBuyIn(s) } : null;
      const p = play.get(id);
      const a = af.get(id);
      return {
        id,
        nickname: String(r.nickname),
        status: String(r.status),
        balance: Number(r.balance),
        createdAt: Number(r.createdAt),
        profile,
        updatedAt: profile ? Number(r.updatedAt) : null,
        updatedBy: profile ? ((r.updatedBy as string | null) ?? null) : null,
        auto: styleFor(id),
        seat: s
          ? { tableId: String(s.tableId), tableName: String(s.tableName), seatIndex: Number(s.seatIndex), since: Number(s.since), buyIn: Number(s.buyIn), table }
          : null,
        // How it plays at that table from the next hand (the one under way was dealt with what the room had then).
        effective: table ? botPlayOf(id, profile, table) : null,
        play: {
          hands: Number(p?.hands ?? 0),
          counted: Number(p?.counted ?? 0),
          vpip: Number(p?.vpip ?? 0),
          pfr: Number(p?.pfr ?? 0),
          net: Number(p?.net ?? 0),
          af: { hands: Number(a?.hands ?? 0), aggressive: Number(a?.aggressive ?? 0), calls: Number(a?.calls ?? 0) },
        },
        result: Number(r.balance) + Number(s?.buyIn ?? 0) - Number(funded.get(id)?.funded ?? 0),
      };
    });
    return c.json({
      days,
      since,
      total: Number(rows(0)[0]?.n ?? 0),
      limit,
      offset,
      afHands: BOT_AF_HANDS,
      items,
      rowsRead: res.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0),
    });
  })
  /**
   * A bot's own level and style; null for either follows the table it sits at. Its buy-in in big blinds: null sits down
   * with the default, left out keeps it (all three null: back to the table's, the row removed). `preview`: the old and
   * new settings and, when it sits at a table, how it plays there now and after and (`buyIn`) the chips it would sit
   * down there with before and after, and with what it sat down now. The table is told to read it again (once more if it
   * does not answer); `roomConfirmed` false: the table picks it up at a deal within a few minutes, or when the bot next
   * sits down. A buy-in counts only from the next time it sits down: the stack at its seat now never changes.
   */
  .put('/bots/:id/profile', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? ProfilePreviewSchema : ProfileSchema);
    const db = c.env.DB;
    const current = await botProfile(db, c.req.param('id'));
    if (current.updatedAt !== body.baseUpdatedAt) profileConflict(current);
    const from: BotProfile = { level: current.profile?.level ?? null, style: current.profile?.style ?? null, buyInBb: current.profile?.buyInBb ?? null };
    const to: BotProfile = { level: body.level, style: body.style, buyInBb: body.buyInBb === undefined ? from.buyInBb : body.buyInBb };
    if (from.level === to.level && from.style === to.style && from.buyInBb === to.buyInBb) fail(400, 'bot_profile_no_change', 'the settings are the same as now');
    const none = to.level === null && to.style === null && to.buyInBb === null;
    const table = current.table;
    const effective = table ? { from: botPlayOf(current.id, current.profile, table), to: botPlayOf(current.id, to, table) } : null;
    const buyIn = table ? { from: botBuyInOf(from, table), to: botBuyInOf(to, table), seated: current.seatBuyIn ?? 0 } : null;
    if (preview) {
      return c.json({ preview: true, bot: { id: current.id, nickname: current.nickname }, from, to, auto: styleFor(current.id), table, effective, buyIn, appliesFrom: table ? 'next_hand' : 'next_seat' });
    }
    const now = Math.max(Date.now(), (current.updatedAt ?? 0) + 1);
    const actor = c.var.user!.id;
    // Written only over the profile that was read (a second administrator's change meanwhile is a conflict, not lost).
    const r =
      none
        ? await db.prepare(`DELETE FROM bot_profiles WHERE bot_id = ?1 AND updated_at = ?2`).bind(current.id, current.updatedAt).run()
        : current.updatedAt === null
          ? await db
              .prepare(`INSERT INTO bot_profiles (bot_id, level, style, buy_in_bb, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (bot_id) DO NOTHING`)
              .bind(current.id, to.level, to.style, to.buyInBb, actor, now)
              .run()
          : await db
              .prepare(`UPDATE bot_profiles SET level = ?2, style = ?3, buy_in_bb = ?4, updated_by = ?5, updated_at = ?6 WHERE bot_id = ?1 AND updated_at = ?7`)
              .bind(current.id, to.level, to.style, to.buyInBb, actor, now, current.updatedAt)
              .run();
    if (!r.meta.changes) profileConflict(await botProfile(db, current.id));
    const live = table ? ((await roomCall(c, table.id, 'bot-profiles')) ?? (await roomCall(c, table.id, 'bot-profiles'))) : null;
    const roomConfirmed = table ? !!live : null;
    await audit(c, 'bots.profile', { type: 'user', id: current.id }, { from, to, reason: body.reason, table: table?.id ?? null, effective: effective?.to ?? null, buyIn, roomConfirmed });
    return c.json({
      ok: true,
      profile: none ? null : to,
      updatedAt: none ? null : now,
      table,
      effective: effective?.to ?? null,
      buyIn,
      appliesFrom: table ? 'next_hand' : 'next_seat',
      roomConfirmed,
    });
  })
  /** The bots' operations log, newest first: `table`, `kind` narrow it; server pages (`hasMore` says if more follow). */
  .get('/bots/events', async (c) => {
    const { limit, offset } = page(c);
    const table = c.req.query('table')?.trim().slice(0, 64) || null;
    const kind = c.req.query('kind') || null;
    if (kind && !(EVENT_KINDS as readonly string[]).includes(kind)) fail(400, 'invalid_input', 'unknown event kind');
    const where = [table ? 'e.table_id = ?3' : null, kind ? `e.kind = ?${table ? 4 : 3}` : null].filter(Boolean);
    const { results } = await c.env.DB.prepare(
      `SELECT e.id, e.table_id AS tableId, t.name AS tableName, e.bot_id AS botId, u.nickname, e.kind, e.code, e.created_at AS createdAt
         FROM bot_events e LEFT JOIN tables t ON t.id = e.table_id LEFT JOIN users u ON u.id = e.bot_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.created_at DESC, e.id DESC LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit + 1, offset, ...(table ? [table] : []), ...(kind ? [kind] : []))
      .all();
    return c.json({ items: results.slice(0, limit), hasMore: results.length > limit, limit, offset });
  })
  /**
   * The fund's books, checked on request: issued against the bot_fund ledger rows, each bot's wallet against its
   * ledger, a bot seated twice, a bot seated at a closed table. Reads every bot's ledger rows (ledger_user_idx).
   */
  .get('/bots/integrity', async (c) => {
    const db = c.env.DB;
    const res = await db.batch([
      db.prepare(`SELECT issued FROM bot_fund WHERE id = 1`),
      db.prepare(
        `SELECT u.id, u.nickname, u.balance, COALESCE(SUM(l.amount), 0) AS ledger, COALESCE(SUM(CASE WHEN l.type = 'bot_fund' THEN l.amount ELSE 0 END), 0) AS funded
           FROM users u LEFT JOIN chip_ledger l ON l.user_id = u.id WHERE u.is_bot = 1 GROUP BY u.id`,
      ),
      db.prepare(
        `SELECT s.user_id AS botId, u.nickname, COUNT(*) AS n FROM users u CROSS JOIN table_sessions s ON s.user_id = u.id AND s.status = 'seated'
          WHERE u.is_bot = 1 GROUP BY s.user_id HAVING COUNT(*) > 1`,
      ),
      db.prepare(
        `SELECT s.user_id AS botId, u.nickname, s.table_id AS tableId, t.name AS tableName FROM users u CROSS JOIN table_sessions s ON s.user_id = u.id AND s.status = 'seated'
           JOIN tables t ON t.id = s.table_id WHERE u.is_bot = 1 AND t.status = 'closed'`,
      ),
      db.prepare(SEATED),
    ]);
    const rows = (i: number) => (res[i]?.results ?? []) as Record<string, unknown>[];
    const issued = Number(rows(0)[0]?.issued ?? 0);
    const bots = rows(1).map((r) => ({ id: r.id as string, nickname: r.nickname as string, balance: Number(r.balance), ledger: Number(r.ledger), funded: Number(r.funded) }));
    const fundLedger = bots.reduce((s, b) => s + b.funded, 0);
    const wallets = bots.reduce((s, b) => s + b.balance, 0);
    const atTables = Number(rows(4)[0]?.chips ?? 0);
    const walletMismatches = bots.filter((b) => b.balance !== b.ledger).map((b) => ({ ...b, diff: b.balance - b.ledger }));
    const doubleSeated = rows(2);
    const onClosedTables = rows(3);
    const ok = issued === fundLedger && !walletMismatches.length && !doubleSeated.length && !onClosedTables.length;
    return c.json({
      ok,
      checkedAt: Date.now(),
      fund: { issued, ledger: fundLedger, diff: issued - fundLedger },
      accounts: bots.length,
      walletMismatches,
      doubleSeated,
      onClosedTables,
      result: { wallets, atTables, issued, net: wallets + atTables - issued },
      rowsRead: res.reduce((s, r) => s + (r.meta?.rows_read ?? 0), 0),
    });
  });
