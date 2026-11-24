/**
 * One rabbit hunt, from the press to what the player is shown (useTableSocket keeps it, the table draws it).
 *
 * The room deals the next hand on its own clock, so the answer can come after the hand it is about has left the table.
 * It is then still shown, as the hand before's, beside the game (RabbitPanel) and never on the board of the hand played
 * now. Every step is said: asked and waiting, answered, failed on the way (asked again with one press), or too late.
 */
import type { Card, ErrorCode } from '@jc/types';

export type RabbitPhase = 'requesting' | 'success' | 'error' | 'expired';

export interface RabbitHunt {
  tableId: string;
  handId: string;
  handNumber: number;
  /** The community cards that hand ended with. */
  board: readonly Card[];
  /** The request waiting for its answer (the last one sent). */
  reqId: string;
  phase: RabbitPhase;
  /** The cards that would have completed the board, once answered. */
  cards: readonly Card[] | null;
  /** When it came to this phase. */
  at: number;
  /** Its hand has left the table: shown as the hand before's from here on. */
  late: boolean;
}

/** No answer for this long is a failure the player can ask again after (the room keeps the answer longer than this). */
export const RABBIT_WAIT_MS = 8_000;
/** A result that was on the board for less than this when the next hand came is shown on as the hand before's. */
export const RABBIT_SEEN_MS = 2_500;
/** How long the hand before's result, a failure and a "too late" stay up before they close by themselves. */
export const RABBIT_SHOW_MS: Record<Exclude<RabbitPhase, 'requesting'>, number> = { success: 12_000, error: 15_000, expired: 5_000 };

export function startHunt(tableId: string, hand: { id: string; number: number; board: readonly Card[] }, reqId: string, now: number): RabbitHunt {
  return { tableId, handId: hand.id, handNumber: hand.number, board: [...hand.board], reqId, phase: 'requesting', cards: null, at: now, late: false };
}

/**
 * The room's answer. It is taken for the hand that was asked about only, while it is still wanted: a hand has one
 * rabbit hunt, so an answer that outlived its request (given up, then asked again) is as good as the one waited for.
 * Cards that do not complete that hand's board are not shown.
 */
export function answerHunt(h: RabbitHunt | null, m: { handId: string; cards: readonly Card[] }, now: number): RabbitHunt | null {
  if (!h || h.handId !== m.handId || (h.phase !== 'requesting' && h.phase !== 'error')) return h;
  const fits = m.cards.length > 0 && h.board.length + m.cards.length === 5 && new Set([...h.board, ...m.cards]).size === 5;
  return fits ? { ...h, phase: 'success', cards: [...m.cards], at: now } : { ...h, phase: 'error', at: now };
}

/** Refused: the hand's time is up or it was never mine to ask (`expired`, nothing to ask again), or it went wrong. */
export function refuseHunt(h: RabbitHunt | null, reqId: string, code: ErrorCode, now: number): RabbitHunt | null {
  if (!h || h.reqId !== reqId || h.phase !== 'requesting') return h;
  return { ...h, phase: code === 'conflict' || code === 'forbidden' ? 'expired' : 'error', at: now };
}

/** The request `reqId` got nowhere (not sent, no answer in time, the connection ended). */
export function failHunt(h: RabbitHunt | null, reqId: string, now: number): RabbitHunt | null {
  if (!h || h.reqId !== reqId || h.phase !== 'requesting') return h;
  return { ...h, phase: 'error', at: now };
}

/** Asked again after a failure, for the same hand, as a new request. */
export function retryHunt(h: RabbitHunt | null, reqId: string, now: number): RabbitHunt | null {
  if (!h || h.phase !== 'error') return h;
  return { ...h, reqId, phase: 'requesting', at: now };
}

/**
 * The table's own button was pressed, with `hand` settled on it (null: none). It is about that hand and no other: a
 * failed hunt of it is asked again, one not asked yet is begun (and takes the place of the hand before's, if that is
 * still up: its panel has a button of its own, `againHunt`). Null: nothing to send (asked already, or no such hand).
 */
export function pressHunt(h: RabbitHunt | null, tableId: string, hand: { id: string; number: number; board: readonly Card[] } | null, reqId: string, now: number): RabbitHunt | null {
  if (!hand) return null;
  if (h?.handId === hand.id) return h.phase === 'error' && !h.late ? retryHunt(h, reqId, now) : null;
  return startHunt(tableId, hand, reqId, now);
}

/** The panel of the hand before was asked to try again: that hand's failed hunt, as a new request. Null: nothing to send. */
export function againHunt(h: RabbitHunt | null, reqId: string, now: number): RabbitHunt | null {
  return h?.late && h.phase === 'error' ? retryHunt(h, reqId, now) : null;
}

/** The request has waited too long for its answer. */
export function huntOverdue(h: RabbitHunt | null, now: number): boolean {
  return !!h && h.phase === 'requesting' && now - h.at >= RABBIT_WAIT_MS;
}

/**
 * The table shows hand `handId` now (null: none). A hunt whose hand has left goes beside the game, unless its cards
 * had been on the board long enough to be seen: then it simply ends with its hand.
 */
export function huntAt(h: RabbitHunt | null, handId: string | null, now: number): RabbitHunt | null {
  if (!h || h.late || h.handId === handId) return h;
  if (h.phase === 'success' && now - h.at >= RABBIT_SEEN_MS) return null;
  return { ...h, late: true, at: h.phase === 'requesting' ? h.at : now };
}
