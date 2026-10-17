import { schema } from '@jc/db';
import { HAND_RANK_CLASSES, HandListQuerySchema, HandNoteInputSchema, POSITIONS, SettingsSaveSchema, type SettingsSaveResult, TREND_DAYS, type HandDetailDto, type HandSummaryDto, type LedgerEntryDto, type PositionStatsDto, type StatsDto, type StatsTrendDto } from '@jc/types';
import { and, desc, eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { badgesFor } from '../lib/badges';
import { replayLog, replayPlayer, replayUser } from '../lib/community';
import { countNote, failureMetric, isFiltered, listHands, readNote, savedMetrics, saveNote } from '../lib/handNotes';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { referralMe } from '../lib/referral';
import { claimRefill, REFILL_RATE, refillSnapshot } from '../lib/refill';
import { pushMuckEverywhere } from '../lib/room';
import { clientFails, countSettings, markSynced, needsSyncMark, readRow, saveFailure, saveSettings, toDto, toState } from '../lib/settings';

function pageParams(q: (k: string) => string | undefined) {
  const limit = Math.min(Math.max(Number(q('limit') ?? 20) || 20, 1), 100);
  const before = Number(q('before') ?? 0) || undefined;
  return { limit, before };
}

export const meRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  /** The free chip refill: its terms, what the member has, and whether (or when) they may claim one (lib/refill.ts). */
  .get('/refill', async (c) => c.json((await refillSnapshot(c.env, c.var.user!.id)).status))
  /**
   * Claims it. 409 refill_refused (details.status says why, and when the next one comes) or refill_changed (the wallet
   * or a seat changed while it was decided: nothing was paid, ask again). Repeating a paid claim pays nothing more.
   */
  .post('/refill', async (c) => {
    const uid = c.var.user!.id;
    await rateLimit(c, `refill:${uid}`, REFILL_RATE.limit, REFILL_RATE.windowMs);
    const r = await claimRefill(c.env, uid);
    if (!r.ok) fail(409, r.code, r.code === 'refill_changed' ? 'chips changed while the refill was decided; try again' : 'no refill now', { status: r.status });
    return c.json(r.claim);
  })
  /**
   * The member's referral code, share link and rewards (lib/referral.ts). Opening it also pays what the member's
   * referrals may pay now, so it is rate limited.
   */
  .get('/referral', async (c) => {
    const uid = c.var.user!.id;
    await rateLimit(c, `referral-me:${uid}`, 30, 60_000);
    return c.json(await referralMe(c.env, uid, new URL(c.req.url).origin));
  })
  .get('/ledger', async (c) => {
    const { limit, before } = pageParams((k) => c.req.query(k));
    const rows = await c.var.db
      .select()
      .from(schema.chipLedger)
      .where(and(eq(schema.chipLedger.userId, c.var.user!.id), before ? lt(schema.chipLedger.createdAt, before) : undefined))
      .orderBy(desc(schema.chipLedger.createdAt))
      .limit(limit);
    const out: LedgerEntryDto[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      balanceAfter: r.balanceAfter,
      tableId: r.tableId,
      memo: r.memo,
      createdAt: r.createdAt,
    }));
    return c.json(out);
  })
  /**
   * Only the user's own hand_players rows: a seat dealt into a hand, never a hand watched. vpip, pfr, saw_flop,
   * position and pot_won come from HAND_STATS_SQL (packages/db/src/handStats.ts); rows it hasn't filled yet are left
   * out of the figures that need them, so nothing is estimated.
   */
  .get('/stats', async (c) => {
    const uid = c.var.user!.id;
    const [aggR, potR, bestR, posR] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS played,
                COUNT(pot_won) AS measured,
                COALESCE(SUM(pot_won > 0), 0) AS won,
                COALESCE(SUM(pot_won), 0) AS totalWon,
                COALESCE(SUM(net), 0) AS net,
                COALESCE(MAX(CASE WHEN net > 0 THEN net END), 0) AS biggestWin,
                COUNT(vpip) AS dealt,
                COALESCE(SUM(vpip), 0) AS vpip,
                COALESCE(SUM(pfr), 0) AS pfr,
                COALESCE(SUM(saw_flop), 0) AS sawFlop,
                COALESCE(SUM(saw_flop AND went_to_showdown), 0) AS wtsd,
                COALESCE(SUM(went_to_showdown AND pot_won IS NOT NULL), 0) AS showdowns,
                COALESCE(SUM(went_to_showdown AND pot_won > 0), 0) AS wsd
         FROM hand_players WHERE user_id = ?1`,
      ).bind(uid),
      // Chips a player put in are won - net (payouts include uncalled chips handed back). The contested pot is all chips
      // put in minus the part of the largest contribution nobody matched; only hands the user put chips into count.
      c.env.DB.prepare(
        `WITH c AS (
           SELECT hp.hand_id, hp.user_id, hp.won - hp.net AS put,
                  ROW_NUMBER() OVER (PARTITION BY hp.hand_id ORDER BY hp.won - hp.net DESC) AS rk
           FROM hand_players hp WHERE hp.hand_id IN (SELECT hand_id FROM hand_players WHERE user_id = ?1)
         ), pots AS (
           SELECT SUM(put) - MAX(CASE WHEN rk = 1 THEN put ELSE 0 END) + MAX(CASE WHEN rk = 2 THEN put ELSE 0 END) AS pot,
                  MAX(CASE WHEN user_id = ?1 THEN put ELSE 0 END) AS myPut
           FROM c GROUP BY hand_id
         )
         SELECT COALESCE(MAX(pot), 0) AS largest, AVG(pot) AS avg FROM pots WHERE myPut > 0`,
      ).bind(uid),
      c.env.DB.prepare(
        `SELECT rank_class AS rankClass, rank_value AS rankValue, best_five AS bestFive FROM hand_players
         WHERE user_id = ?1 AND went_to_showdown = 1 AND rank_value IS NOT NULL
         ORDER BY rank_value DESC LIMIT 1`,
      ).bind(uid),
      c.env.DB.prepare(
        `SELECT position, COUNT(*) AS hands, COALESCE(SUM(vpip), 0) AS vpip, COALESCE(SUM(pfr), 0) AS pfr, COALESCE(SUM(net), 0) AS net
         FROM hand_players WHERE user_id = ?1 AND position IS NOT NULL GROUP BY position`,
      ).bind(uid),
    ]);
    type Agg = Record<'played' | 'measured' | 'won' | 'totalWon' | 'net' | 'biggestWin' | 'dealt' | 'vpip' | 'pfr' | 'sawFlop' | 'wtsd' | 'showdowns' | 'wsd', number>;
    const agg = (aggR!.results as Agg[])[0]!;
    const pot = (potR!.results as { largest: number; avg: number | null }[])[0];
    const best = (bestR!.results as { rankClass: string; rankValue: number; bestFive: string | null }[])[0];
    const byPos = new Map((posR!.results as (Omit<PositionStatsDto, 'position'> & { position: string })[]).map((r) => [r.position, r]));
    const stats: StatsDto = {
      handsPlayed: agg.played,
      handsWon: agg.won,
      winRate: agg.measured > 0 ? Math.round((agg.won / agg.measured) * 1000) / 10 : 0,
      totalWon: agg.totalWon,
      netChips: agg.net,
      largestPot: pot?.largest ?? 0,
      avgPot: pot?.avg == null ? null : Math.round(pot.avg),
      biggestWin: agg.biggestWin,
      bestHand:
        best && (HAND_RANK_CLASSES as readonly string[]).includes(best.rankClass)
          ? { rankClass: best.rankClass, cards: best.bestFive ? (JSON.parse(best.bestFive) as string[]) : [] }
          : null,
      vpip: { n: agg.vpip, of: agg.dealt },
      pfr: { n: agg.pfr, of: agg.dealt },
      raiseShare: { n: agg.pfr, of: agg.vpip },
      wtsd: { n: agg.wtsd, of: agg.sawFlop },
      wsd: { n: agg.wsd, of: agg.showdowns },
      positions: POSITIONS.map((position) => {
        const r = byPos.get(position);
        return { position, hands: r?.hands ?? 0, vpip: r?.vpip ?? 0, pfr: r?.pfr ?? 0, net: r?.net ?? 0 };
      }),
    };
    return c.json(stats);
  })
  /**
   * Net chips per day over the last `days` days, cut at the caller's time zone (`tz`, minutes east of UTC, as the
   * browser reports it negated). Days without hands are left out.
   */
  .get('/stats/trend', async (c) => {
    const days = Number(c.req.query('days') ?? 30);
    const tz = Number(c.req.query('tz') ?? 0);
    if (!(TREND_DAYS as readonly number[]).includes(days)) fail(400, 'bad_request', `days must be one of ${TREND_DAYS.join(', ')}`);
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) fail(400, 'bad_request', 'tz must be minutes east of UTC (-720 to 840)');
    const DAY = 86_400_000;
    const off = tz * 60_000;
    const today = Math.floor((Date.now() + off) / DAY);
    const from = (today - days + 1) * DAY - off;
    const { results } = await c.env.DB.prepare(
      `SELECT CAST((ended_at + ?2) / ${DAY} AS INTEGER) AS d, COUNT(*) AS hands, SUM(net) AS net
       FROM hand_players WHERE user_id = ?1 AND ended_at >= ?3 GROUP BY d ORDER BY d`,
    )
      .bind(c.var.user!.id, off, from)
      .all<{ d: number; hands: number; net: number }>();
    const out: StatsTrendDto = {
      days: days as StatsTrendDto['days'],
      tz,
      points: results.map((r) => ({ day: new Date(r.d * DAY).toISOString().slice(0, 10), hands: r.hands, net: r.net })),
    };
    return c.json(out);
  })
  /**
   * The member's hands, newest first, with their own notes (lib/handNotes.ts). Filters: date range, position, result,
   * pot size, tag, bookmarked; the next page starts after `before` (and `beforeId`, the last hand shown). A filtered
   * list is rate limited, since a narrow filter may read many of the member's hands.
   */
  .get('/hands', async (c) => {
    const uid = c.var.user!.id;
    const { limit, before } = pageParams((k) => c.req.query(k));
    const parsed = HandListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) fail(400, 'bad_request', 'invalid filter', parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
    const q = parsed.data;
    if (isFiltered(q)) await rateLimit(c, `hand-list:${uid}`, 60, 60_000);
    const out: HandSummaryDto[] = await listHands(c.env.DB, uid, { ...q, limit, before });
    return c.json(out);
  })
  /**
   * Replay of a finished hand the user played in. Hole cards of other players
   * are only included when they were face up at showdown (not folded, not mucked).
   */
  .get('/hands/:id', async (c) => {
    const handId = c.req.param('id');
    const uid = c.var.user!.id;
    const mine = await c.var.db.query.handPlayers.findFirst({ where: and(eq(schema.handPlayers.handId, handId), eq(schema.handPlayers.userId, uid)) });
    if (!mine) fail(404, 'not_found', 'hand not found');
    const [row] = await c.var.db
      .select({ h: schema.hands, t: { name: schema.tables.name, sb: schema.tables.smallBlind, bb: schema.tables.bigBlind, maxSeats: schema.tables.maxSeats } })
      .from(schema.hands)
      .innerJoin(schema.tables, eq(schema.tables.id, schema.hands.tableId))
      .where(eq(schema.hands.id, handId))
      .limit(1);
    if (!row) fail(404, 'not_found', 'hand not found');
    const { h: hand, t } = row;
    const [players, note] = await Promise.all([
      c.var.db
        .select({ hp: schema.handPlayers, user: replayUser })
        .from(schema.handPlayers)
        .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
        .where(eq(schema.handPlayers.handId, handId)),
      readNote(c.env.DB, uid, handId),
    ]);
    const badge = await badgesFor(c, players.map((p) => p.user.role));
    const out: HandDetailDto = {
      id: hand.id,
      tableId: hand.tableId,
      tableName: t.name,
      handNumber: hand.handNumber,
      board: JSON.parse(hand.board) as string[],
      potTotal: hand.potTotal,
      endedAt: hand.endedAt,
      smallBlind: t.sb,
      bigBlind: t.bb,
      maxSeats: t.maxSeats,
      ...replayLog(hand.eventLog),
      players: players
        .sort((a, b) => a.hp.seatIndex - b.hp.seatIndex)
        .map(({ hp, user }) => ({ ...replayPlayer(hp, user, uid, badge), userId: hp.userId, isYou: hp.userId === uid })),
      note,
    };
    return c.json(out);
  })
  /**
   * Saves the member's bookmark, tags or memo on a hand they were dealt into (lib/handNotes.ts). 404 not_found for any
   * other hand; 409 note_conflict, with the saved note in details, when the memo changed since revision `rev`. Saves and
   * refusals are counted per kind for operations statistics; nothing written is counted, logged or audited.
   */
  .put('/hands/:id/note', async (c) => {
    const uid = c.var.user!.id;
    const handId = c.req.param('id');
    try {
      await rateLimit(c, `hand-note:${uid}`, 60, 60_000);
      const input = await parseBody(c, HandNoteInputSchema);
      const r = await saveNote(c.env.DB, uid, handId, input);
      if (!r.ok) {
        if (r.code === 'not_found') fail(404, 'not_found', 'hand not found');
        fail(409, 'note_conflict', 'the memo changed since it was opened', { note: r.note });
      }
      await countNote(c.env.DB, savedMetrics(input));
      return c.json(r.note);
    } catch (e) {
      await countNote(c.env.DB, [failureMetric(e)]);
      throw e;
    }
  })
  /**
   * The member's account settings (lib/settings.ts). One read by key; the sync mark is written at most every ten
   * minutes, after the answer. `fails`: attempts that failed on the device since its last answer (counted). `for`: the
   * account the device expects; another one signed in meanwhile is refused (409 settings_account).
   */
  .get('/settings', async (c) => {
    const uid = c.var.user!.id;
    const now = Date.now();
    const expect = c.req.query('for');
    if (expect !== undefined && expect !== uid) fail(409, 'settings_account', 'another account is signed in');
    try {
      const row = await readRow(c.env.DB, uid);
      if (needsSyncMark(row, now)) c.executionCtx.waitUntil(markSynced(c.env.DB, uid, now).run().catch(() => undefined));
      const fails = clientFails(Number(c.req.query('fails')) || 0);
      if (fails) c.executionCtx.waitUntil(countSettings(c.env.DB, { ss_client_fail: fails }, now));
      return c.json(toDto(toState(row)));
    } catch (e) {
      await countSettings(c.env.DB, { ss_load_fail: 1 }, now);
      throw e;
    }
  })
  /**
   * Saves the settings and favourite tables a device changed: the newest change wins one at a time, and `kept` names what
   * a newer change made elsewhere kept. 409 settings_reset, with the account's settings in details, when an administrator
   * reset them since the device's epoch; 409 settings_busy when other saves kept landing in between. When the account's
   * auto-muck changed, the tables the member sits at take it on.
   */
  .put('/settings', async (c) => {
    const uid = c.var.user!.id;
    try {
      await rateLimit(c, `settings:${uid}`, 60, 60_000);
      const input = await parseBody(c, SettingsSaveSchema);
      if (input.user !== uid) fail(409, 'settings_account', 'another account is signed in');
      const r = await saveSettings(c.env.DB, uid, input);
      if (r.muck !== undefined) c.executionCtx.waitUntil(pushMuckEverywhere(c.env, uid, r.muck).catch(() => undefined));
      if (r.mark) c.executionCtx.waitUntil(markSynced(c.env.DB, uid, Date.now()).run().catch(() => undefined));
      const fails = clientFails(input.fails);
      await countSettings(c.env.DB, fails ? { ...r.metrics, ss_client_fail: fails } : r.metrics);
      return c.json({ settings: r.settings, kept: r.kept } satisfies SettingsSaveResult);
    } catch (e) {
      await countSettings(c.env.DB, { [saveFailure(e)]: 1 });
      throw e;
    }
  });
