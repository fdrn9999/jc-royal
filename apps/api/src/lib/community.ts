import { schema, type Db } from '@jc/db';
import { publicRole, shownVip, type HandPotDto, type HandReplayFields, type HandReplayPlayer, type HandReviewDto, type MessageCategory } from '@jc/types';
import { and, eq, inArray } from 'drizzle-orm';
import type { Badge } from './badges';

/**
 * Whether a player's hole cards were face up for the table: shown down, not mucked. Rows recorded before muck existed
 * have no flag and were all shown down.
 */
export function shownAtShowdown(hp: { wentToShowdown: boolean; shown: boolean | null }): boolean {
  return hp.shown ?? hp.wentToShowdown;
}

/** What replaySettlement reads of a hand's player rows. */
export type SettlementRow = { seatIndex: number; won: number; potWon: number | null };
/** What replayLog reads of a hand's player rows: their settlement, and the stack each started with (replayBlinds). */
export type ReplayRow = SettlementRow & { stackStart?: number };

/**
 * The public part of a stored hand log: actions (without player ids or times), button seat, blinds (replayBlinds) and
 * pot payouts, settled with the hand's player rows (replaySettlement). Hands recorded before the button and pots were
 * stored have null for them. The engine log is never read here.
 */
export function replayLog(
  eventLog: string,
  rows: ReplayRow[],
): Pick<HandReplayFields, 'actions' | 'buttonSeat' | 'smallBlind' | 'bigBlind' | 'pots' | 'returned'> {
  const log = JSON.parse(eventLog) as { actions: HandReplayFields['actions']; button?: unknown; blinds?: unknown; pots?: unknown };
  const actions = log.actions.map((a) => ({ seatIndex: a.seatIndex, stage: a.stage, type: a.type, amount: a.amount }));
  return {
    actions,
    buttonSeat: typeof log.button === 'number' ? log.button : null,
    ...replayBlinds(log.blinds, actions, rows),
    ...replaySettlement(Array.isArray(log.pots) ? (log.pots as HandPotDto[]) : null, rows),
  };
}

const chips = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/**
 * The blinds a hand was dealt at: stored with the hand since they were (the engine's record), else read off a blind
 * posted by a player who still had chips after posting it (a stack shorter than its blind posts all it has, which tells
 * nothing about the blind). Never the table's blinds now: an admin may have changed them since, and a tournament's
 * rise with its levels. Null where the log doesn't tell, and a replay then counts in chips, not big blinds.
 */
export function replayBlinds(
  stored: unknown,
  actions: Pick<HandReplayFields['actions'][number], 'seatIndex' | 'type' | 'amount'>[],
  rows: Pick<ReplayRow, 'seatIndex' | 'stackStart'>[],
): Pick<HandReplayFields, 'smallBlind' | 'bigBlind'> {
  const b = stored as { sb?: unknown; bb?: unknown } | null | undefined;
  if (b && chips(b.sb) && chips(b.bb)) return { smallBlind: b.sb, bigBlind: b.bb };
  const posted = (type: 'post-sb' | 'post-bb') => {
    const a = actions.find((x) => x.type === type);
    const start = a && rows.find((r) => r.seatIndex === a.seatIndex)?.stackStart;
    return a && chips(a.amount) && typeof start === 'number' && start > a.amount ? a.amount : null;
  };
  return { smallBlind: posted('post-sb'), bigBlind: posted('post-bb') };
}

/**
 * The pots a replay shows and the chips nobody called, handed back to the player who put in the most. The amount is
 * the one the hand's statistics stored, won − pot_won (packages/db/src/handStats.ts, the one definition); it is not
 * worked out again here. The engine pays such chips as a pot of their own only when someone was all in: a bet everyone
 * folded to stays in the pot it paid, so it comes out of the last pot that player won as a pot of its own. Each pot's
 * winners still add up to its amount, each player's to what they won, the pots to the hand's total.
 *
 * `returned` is null and the pots are as stored when nothing came back, when the statistics aren't filled yet (the game
 * worker fills them right after recording the hand, or with the next one), or when the amount doesn't fit the pots: it
 * isn't one player's, it isn't the pot the engine already shows, or it is more than that player's share of the pot.
 */
export function replaySettlement(pots: HandPotDto[] | null, rows: SettlementRow[]): Pick<HandReplayFields, 'pots' | 'returned'> {
  const asStored = { pots, returned: null };
  if (rows.some((r) => r.potWon === null)) return asStored;
  const back = rows.filter((r) => r.won > r.potWon!);
  if (back.length !== 1) return asStored;
  const returned = { seatIndex: back[0]!.seatIndex, amount: back[0]!.won - back[0]!.potWon! };
  if (!pots) return { pots, returned };
  const own = pots.find((p) => p.uncalled);
  if (own) return own.winners.length === 1 && own.winners[0]!.seatIndex === returned.seatIndex && own.amount === returned.amount ? { pots, returned } : asStored;
  const k = pots.findLastIndex((p) => p.winners.some((w) => w.seatIndex === returned.seatIndex));
  const pot = pots[k];
  if (!pot || pot.winners.find((w) => w.seatIndex === returned.seatIndex)!.amount < returned.amount) return asStored;
  const kept: HandPotDto = {
    ...pot,
    amount: pot.amount - returned.amount,
    winners: pot.winners.map((w) => (w.seatIndex === returned.seatIndex ? { ...w, amount: w.amount - returned.amount } : w)).filter((w) => w.amount > 0),
  };
  const handedBack: HandPotDto = { amount: returned.amount, eligibleSeats: [returned.seatIndex], winners: [{ ...returned }], uncalled: true };
  return { pots: [...pots.slice(0, k), ...(kept.amount > 0 ? [kept] : []), handedBack, ...pots.slice(k + 1)], returned };
}

/** The columns of `users` a replay player is drawn with. */
export type ReplayUser = { nickname: string; role: string; status: string; isBot: boolean; vipColor: string | null };
export const replayUser = {
  nickname: schema.users.nickname,
  role: schema.users.role,
  status: schema.users.status,
  isBot: schema.users.isBot,
  vipColor: schema.users.vipColor,
};

/**
 * A player of a finished hand as `viewerId` may see it: hole cards, rank and best five only for the viewer and for
 * hands that were face up at showdown (see shownAtShowdown); a hand mucked at the showdown says so (`mucked`, which the
 * table saw), never what it held. `user` is the member's row now: a deleted account shows no
 * role, and a staff role only when the social policy shows its badge (`badge`, from lib/badges.ts); the VIP color is
 * the one other players see now (shownVip), as at the tables.
 */
export function replayPlayer(hp: typeof schema.handPlayers.$inferSelect, user: ReplayUser, viewerId: string, badge: Badge = publicRole): HandReplayPlayer {
  const visible = hp.userId === viewerId || shownAtShowdown(hp);
  const ranked = visible && hp.wentToShowdown;
  const role = user.status === 'deleted' ? undefined : badge(user.role);
  const vip = shownVip(user);
  return {
    seatIndex: hp.seatIndex,
    nickname: user.nickname,
    ...(role ? { role } : {}),
    ...(user.isBot ? { bot: true as const } : {}),
    ...(vip ? { vip } : {}),
    holeCards: visible ? (JSON.parse(hp.holeCards) as string[]) : null,
    ...(hp.wentToShowdown && !shownAtShowdown(hp) ? { mucked: true as const } : {}),
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
    .select({ h: schema.hands, t: { name: schema.tables.name, maxSeats: schema.tables.maxSeats } })
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
    .map(({ h, t }) => {
      const seated = players.filter((p) => p.hp.handId === h.id).sort((a, b) => a.hp.seatIndex - b.hp.seatIndex);
      return {
        id: h.id,
        tableName: t.name,
        handNumber: h.handNumber,
        endedAt: h.endedAt,
        board: JSON.parse(h.board) as string[],
        potTotal: h.potTotal,
        maxSeats: t.maxSeats,
        ...replayLog(h.eventLog, seated.map((p) => p.hp)),
        players: seated.map(({ hp, user }) => ({ ...replayPlayer(hp, user, perspectiveUserId, badge), isAuthor: hp.userId === perspectiveUserId })),
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
