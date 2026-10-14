import { schema, type Db } from '@jc/db';
import type { HandReviewDto, MessageCategory } from '@jc/types';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Finished hands as seen from `perspectiveUserId`: board and actions are public;
 * hole cards are included only for that user and for players who went to
 * showdown. Hands not played by that user are not returned.
 */
export async function handReviews(db: Db, handIds: string[], perspectiveUserId: string): Promise<HandReviewDto[]> {
  if (handIds.length === 0) return [];
  const own = await db
    .select({ handId: schema.handPlayers.handId })
    .from(schema.handPlayers)
    .where(and(inArray(schema.handPlayers.handId, handIds), eq(schema.handPlayers.userId, perspectiveUserId)));
  const allowed = new Set(own.map((r) => r.handId));
  const ids = handIds.filter((id) => allowed.has(id));
  if (ids.length === 0) return [];
  const hands = await db
    .select({ h: schema.hands, t: { name: schema.tables.name, sb: schema.tables.smallBlind, bb: schema.tables.bigBlind } })
    .from(schema.hands)
    .innerJoin(schema.tables, eq(schema.tables.id, schema.hands.tableId))
    .where(inArray(schema.hands.id, ids));
  const players = await db
    .select({ hp: schema.handPlayers, nickname: schema.users.nickname })
    .from(schema.handPlayers)
    .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
    .where(inArray(schema.handPlayers.handId, ids));
  const byId = new Map(hands.map((x) => [x.h.id, x]));
  return ids
    .map((id) => byId.get(id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map(({ h, t }) => {
      const log = JSON.parse(h.eventLog) as { actions: HandReviewDto['actions'] };
      return {
        id: h.id,
        tableName: t.name,
        handNumber: h.handNumber,
        endedAt: h.endedAt,
        board: JSON.parse(h.board) as string[],
        potTotal: h.potTotal,
        smallBlind: t.sb,
        bigBlind: t.bb,
        actions: log.actions.map((a) => ({ seatIndex: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
        players: players
          .filter((p) => p.hp.handId === h.id)
          .sort((a, b) => a.hp.seatIndex - b.hp.seatIndex)
          .map(({ hp, nickname }) => {
            const visible = hp.userId === perspectiveUserId || hp.wentToShowdown;
            return {
              seatIndex: hp.seatIndex,
              nickname,
              isAuthor: hp.userId === perspectiveUserId,
              holeCards: visible ? (JSON.parse(hp.holeCards) as string[]) : null,
              stackStart: hp.stackStart,
              net: hp.net,
              won: hp.won,
              rankClass: hp.wentToShowdown ? hp.rankClass : null,
            };
          }),
      };
    });
}

/** Writes a one-way message (automatic system notices or admin sends). */
export async function sendMessages(
  db: Db,
  p: { userIds: string[]; category: MessageCategory; title: string; body: string; senderId?: string | null; batchId?: string | null },
): Promise<number> {
  if (p.userIds.length === 0) return 0;
  const rows = p.userIds.map((userId) => ({
    id: crypto.randomUUID(),
    userId,
    category: p.category,
    title: p.title,
    body: p.body,
    senderId: p.senderId ?? null,
    batchId: p.batchId ?? null,
  }));
  // D1 limits bound parameters per statement; insert in chunks.
  for (let i = 0; i < rows.length; i += 10) await db.insert(schema.messages).values(rows.slice(i, i + 10));
  return rows.length;
}
