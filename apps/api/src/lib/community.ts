import { schema, type Db } from '@jc/db';
import { publicRole, type HandPotDto, type HandReplayFields, type HandReplayPlayer, type HandReviewDto, type MessageCategory } from '@jc/types';
import { and, eq, inArray } from 'drizzle-orm';
import type { Badge } from './badges';

/**
 * Whether a player's hole cards were face up for the table: shown down, not mucked. Rows recorded before muck existed
 * have no flag and were all shown down.
 */
export function shownAtShowdown(hp: { wentToShowdown: boolean; shown: boolean | null }): boolean {
  return hp.shown ?? hp.wentToShowdown;
}

/**
 * The public part of a stored hand log: actions (without player ids or times), button seat and pot payouts. Hands
 * recorded before the button and pots were stored have null for them. The engine log is never read here.
 */
export function replayLog(eventLog: string): Pick<HandReplayFields, 'actions' | 'buttonSeat' | 'pots'> {
  const log = JSON.parse(eventLog) as { actions: HandReplayFields['actions']; button?: unknown; pots?: unknown };
  return {
    actions: log.actions.map((a) => ({ seatIndex: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount })),
    buttonSeat: typeof log.button === 'number' ? log.button : null,
    pots: Array.isArray(log.pots) ? (log.pots as HandPotDto[]) : null,
  };
}

/** The columns of `users` a replay player is drawn with. */
export type ReplayUser = { nickname: string; role: string; status: string; isBot: boolean };
export const replayUser = { nickname: schema.users.nickname, role: schema.users.role, status: schema.users.status, isBot: schema.users.isBot };

/**
 * A player of a finished hand as `viewerId` may see it: hole cards, rank and best five only for the viewer and for
 * hands that were face up at showdown (see shownAtShowdown). `user` is the member's row now: a deleted account shows no
 * role, and a staff role only when the social policy shows its badge (`badge`, from lib/badges.ts).
 */
export function replayPlayer(hp: typeof schema.handPlayers.$inferSelect, user: ReplayUser, viewerId: string, badge: Badge = publicRole): HandReplayPlayer {
  const visible = hp.userId === viewerId || shownAtShowdown(hp);
  const ranked = visible && hp.wentToShowdown;
  const role = user.status === 'deleted' ? undefined : badge(user.role);
  return {
    seatIndex: hp.seatIndex,
    nickname: user.nickname,
    ...(role ? { role } : {}),
    ...(user.isBot ? { bot: true as const } : {}),
    holeCards: visible ? (JSON.parse(hp.holeCards) as string[]) : null,
    stackStart: hp.stackStart,
    net: hp.net,
    won: hp.won,
    rankClass: ranked ? hp.rankClass : null,
    bestFive: ranked && hp.bestFive ? (JSON.parse(hp.bestFive) as string[]) : null,
  };
}

/**
 * Finished hands as seen from `perspectiveUserId`: board and actions are public;
 * hole cards are included only for that user and for players whose cards were
 * face up at showdown (see shownAtShowdown). Hands not played by that user are not returned. `badges` gives the staff
 * badges the players' roles show (lib/badges.ts badgesFor).
 */
export async function handReviews(
  db: Db,
  handIds: string[],
  perspectiveUserId: string,
  badges: (roles: string[]) => Promise<Badge> = async () => publicRole,
): Promise<HandReviewDto[]> {
  if (handIds.length === 0) return [];
  const own = await db
    .select({ handId: schema.handPlayers.handId })
    .from(schema.handPlayers)
    .where(and(inArray(schema.handPlayers.handId, handIds), eq(schema.handPlayers.userId, perspectiveUserId)));
  const allowed = new Set(own.map((r) => r.handId));
  const ids = handIds.filter((id) => allowed.has(id));
  if (ids.length === 0) return [];
  const hands = await db
    .select({ h: schema.hands, t: { name: schema.tables.name, sb: schema.tables.smallBlind, bb: schema.tables.bigBlind, maxSeats: schema.tables.maxSeats } })
    .from(schema.hands)
    .innerJoin(schema.tables, eq(schema.tables.id, schema.hands.tableId))
    .where(inArray(schema.hands.id, ids));
  const players = await db
    .select({ hp: schema.handPlayers, user: replayUser })
    .from(schema.handPlayers)
    .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
    .where(inArray(schema.handPlayers.handId, ids));
  const badge = await badges(players.map((p) => p.user.role));
  const byId = new Map(hands.map((x) => [x.h.id, x]));
  return ids
    .map((id) => byId.get(id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map(({ h, t }) => ({
      id: h.id,
      tableName: t.name,
      handNumber: h.handNumber,
      endedAt: h.endedAt,
      board: JSON.parse(h.board) as string[],
      potTotal: h.potTotal,
      smallBlind: t.sb,
      bigBlind: t.bb,
      maxSeats: t.maxSeats,
      ...replayLog(h.eventLog),
      players: players
        .filter((p) => p.hp.handId === h.id)
        .sort((a, b) => a.hp.seatIndex - b.hp.seatIndex)
        .map(({ hp, user }) => ({ ...replayPlayer(hp, user, perspectiveUserId, badge), isAuthor: hp.userId === perspectiveUserId })),
    }));
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
