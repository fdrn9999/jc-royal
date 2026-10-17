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
 * - Which tables allow bots, and how (level, counts, giving up a seat), is each table's setting (PATCH /tables/:id).
 * - The fund's books are read here, never corrected here: what the fund issued (bot_fund.issued) must equal its ledger
 *   rows, each bot's wallet its ledger, and the bots' result against members is
 *   bot wallets + chips bots took to tables − issued. A correction goes through reconciliation like any other.
 */
import { dayStart, statsDay, STATS_DAY } from '@jc/db';
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

const page = (c: Context<AppEnv>, fallback = 50) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? fallback) || fallback, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

export const adminBotRoutes = new Hono<AppEnv>()
  /**
   * The policy and its latest versions, the fund (issued, limit, left), the bots' chips and result, the tables that
   * allow bots with the bots seated there, and the period's play (`days` 1 to 30): hands with a bot, and the bots' net
   * by the table's level now.
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
        `SELECT id, name, status, max_seats AS maxSeats, big_blind AS bigBlind, bot_level AS level, bot_min_humans AS minHumans, bot_max AS max,
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
