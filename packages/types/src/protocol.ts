import { z } from 'zod';
import type { TableCue, TableView } from './table';

/** An automatic rebuy's total limit may cover at most this many rebuys of the chosen amount. */
export const AUTO_REBUY_MAX_TIMES = 5;

/** Client → server WebSocket messages. Validated at runtime by the game worker. */
export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sync') }),
  z.object({
    t: z.literal('sit'),
    reqId: z.string().min(8).max(64),
    seatIndex: z.number().int().min(0).max(8),
    buyIn: z.number().int().positive(),
  }),
  z.object({ t: z.literal('leave'), reqId: z.string().min(8).max(64) }),
  /** Add chips from the wallet; applied between hands (queued while the player is in a hand). */
  z.object({ t: z.literal('topUp'), reqId: z.string().min(8).max(64), amount: z.number().int().positive() }),
  z.object({ t: z.literal('cancelTopUp') }),
  /** Automatic rebuy after busting. Turning it on needs `consent: true`, an amount and a total limit. */
  z.object({
    t: z.literal('autoRebuy'),
    reqId: z.string().min(8).max(64),
    on: z.boolean(),
    amount: z.number().int().positive().optional(),
    cap: z.number().int().positive().optional(),
    consent: z.literal(true).optional(),
  }),
  z.object({ t: z.literal('sitOut') }),
  z.object({ t: z.literal('sitIn') }),
  z.object({ t: z.literal('waitlist'), join: z.boolean() }),
  z.object({
    t: z.literal('action'),
    /** Client-generated id; the same id is never applied twice. */
    intentId: z.string().min(8).max(64),
    handId: z.string().min(1).max(128),
    /** HandView.seq the client acted on. */
    seq: z.number().int().nonnegative(),
    type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
    /** For bet/raise: the street total ("raise to"). Ignored otherwise. */
    amount: z.number().int().nonnegative().optional(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(200) }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface ChatMessage {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  at: number;
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'insufficient_balance'
  | 'seat_taken'
  | 'already_seated'
  | 'buyin_out_of_range'
  | 'table_closed'
  | 'entry_blocked'
  | 'not_your_turn'
  | 'illegal_action'
  | 'stale_version'
  | 'duplicate'
  | 'spectators_disabled'
  | 'internal';

/**
 * What happened to a top-up or automatic rebuy the room carried out after a hand (sent only to that player).
 * `amount` is what was taken from the wallet, for the `_applied` codes.
 */
export type NoticeCode =
  | 'topup_applied'
  /** The queued top-up no longer fit the buy-in range once the hand ended; nothing was taken. */
  | 'topup_dropped'
  | 'topup_insufficient'
  | 'rebuy_applied'
  /** Automatic rebuy turned itself off: the wallet was short, or the next rebuy would pass the limit. */
  | 'rebuy_insufficient'
  | 'rebuy_cap';

/** Server → client WebSocket messages. */
export type ServerMessage =
  | { t: 'state'; state: TableView; cues: TableCue[] }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chatHistory'; messages: ChatMessage[] }
  | { t: 'ack'; reqId: string }
  | { t: 'error'; code: ErrorCode; message: string; reqId?: string }
  | { t: 'notice'; code: NoticeCode; amount?: number }
  | { t: 'replaced' }
  | { t: 'pong'; at: number };
