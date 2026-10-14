import { schema } from '@jc/db';
import { HAND_RANK_CLASSES, type HandSummaryDto, type LedgerEntryDto, type StatsDto } from '@jc/types';
import { and, desc, eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail } from '../lib/http';

function pageParams(q: (k: string) => string | undefined) {
  const limit = Math.min(Math.max(Number(q('limit') ?? 20) || 20, 1), 100);
  const before = Number(q('before') ?? 0) || undefined;
  return { limit, before };
}

export const meRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
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
  .get('/stats', async (c) => {
    const uid = c.var.user!.id;
    const agg = await c.env.DB.prepare(
      `SELECT COUNT(*) AS played,
              SUM(CASE WHEN won > 0 THEN 1 ELSE 0 END) AS won,
              COALESCE(SUM(won), 0) AS totalWon,
              COALESCE(SUM(net), 0) AS net,
              COALESCE(MAX(won), 0) AS biggest
       FROM hand_players WHERE user_id = ?1`,
    )
      .bind(uid)
      .first<{ played: number; won: number | null; totalWon: number; net: number; biggest: number }>();
    const best = await c.env.DB.prepare(
      `SELECT rank_class AS rankClass, rank_value AS rankValue, best_five AS bestFive FROM hand_players
       WHERE user_id = ?1 AND went_to_showdown = 1 AND rank_value IS NOT NULL
       ORDER BY rank_value DESC LIMIT 1`,
    )
      .bind(uid)
      .first<{ rankClass: string; rankValue: number; bestFive: string | null }>();
    const played = agg?.played ?? 0;
    const won = agg?.won ?? 0;
    const stats: StatsDto = {
      handsPlayed: played,
      handsWon: won,
      winRate: played > 0 ? Math.round((won / played) * 1000) / 10 : 0,
      totalWon: agg?.totalWon ?? 0,
      netChips: agg?.net ?? 0,
      biggestPot: agg?.biggest ?? 0,
      bestHand:
        best && (HAND_RANK_CLASSES as readonly string[]).includes(best.rankClass)
          ? { rankClass: best.rankClass, cards: best.bestFive ? (JSON.parse(best.bestFive) as string[]) : [] }
          : null,
    };
    return c.json(stats);
  })
  .get('/hands', async (c) => {
    const { limit, before } = pageParams((k) => c.req.query(k));
    const rows = await c.var.db
      .select({ hp: schema.handPlayers, h: schema.hands, t: { name: schema.tables.name } })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .innerJoin(schema.tables, eq(schema.tables.id, schema.hands.tableId))
      .where(and(eq(schema.handPlayers.userId, c.var.user!.id), before ? lt(schema.handPlayers.endedAt, before) : undefined))
      .orderBy(desc(schema.handPlayers.endedAt))
      .limit(limit);
    const out: HandSummaryDto[] = rows.map(({ hp, h, t }) => ({
      id: h.id,
      tableId: h.tableId,
      tableName: t.name,
      handNumber: h.handNumber,
      endedAt: h.endedAt,
      board: JSON.parse(h.board) as string[],
      potTotal: h.potTotal,
      net: hp.net,
      won: hp.won,
      holeCards: JSON.parse(hp.holeCards) as string[],
      rankClass: hp.rankClass,
    }));
    return c.json(out);
  })
  /**
   * Replay of a finished hand the user played in. Hole cards of other players
   * are only included when they were shown down.
   */
  .get('/hands/:id', async (c) => {
    const handId = c.req.param('id');
    const uid = c.var.user!.id;
    const mine = await c.var.db.query.handPlayers.findFirst({ where: and(eq(schema.handPlayers.handId, handId), eq(schema.handPlayers.userId, uid)) });
    if (!mine) fail(404, 'not_found', 'hand not found');
    const hand = await c.var.db.query.hands.findFirst({ where: eq(schema.hands.id, handId) });
    if (!hand) fail(404, 'not_found', 'hand not found');
    const players = await c.var.db
      .select({ hp: schema.handPlayers, nickname: schema.users.nickname })
      .from(schema.handPlayers)
      .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
      .where(eq(schema.handPlayers.handId, handId));
    const log = JSON.parse(hand.eventLog) as { actions: unknown[] };
    return c.json({
      id: hand.id,
      handNumber: hand.handNumber,
      board: JSON.parse(hand.board) as string[],
      potTotal: hand.potTotal,
      endedAt: hand.endedAt,
      actions: log.actions,
      players: players.map(({ hp, nickname }) => ({
        seatIndex: hp.seatIndex,
        nickname,
        isYou: hp.userId === uid,
        holeCards: hp.userId === uid || hp.wentToShowdown ? (JSON.parse(hp.holeCards) as string[]) : null,
        stackStart: hp.stackStart,
        net: hp.net,
        won: hp.won,
        rankClass: hp.wentToShowdown ? hp.rankClass : null,
      })),
    });
  });
