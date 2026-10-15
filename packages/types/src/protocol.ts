import { z } from 'zod';
import type { TableCue, TableView } from './table';

/** An automatic rebuy's total limit may cover at most this many rebuys of the chosen amount. */
export const AUTO_REBUY_MAX_TIMES = 5;

/**
 * Client-generated id of a command. The room answers it with `ack` (or an `error` carrying it) and applies an id
 * once, so a command whose answer a lost connection swallowed can be sent again unchanged.
 */
const ReqId = z.string().min(8).max(64);

/** Client → server WebSocket messages. Validated at runtime by the game worker. */
export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sync') }),
  z.object({
    t: z.literal('sit'),
    reqId: ReqId,
    seatIndex: z.number().int().min(0).max(8),
    buyIn: z.number().int().positive(),
  }),
  z.object({ t: z.literal('leave'), reqId: ReqId }),
  /** Add chips from the wallet; applied between hands (queued while the player is in a hand). */
  z.object({ t: z.literal('topUp'), reqId: ReqId, amount: z.number().int().positive() }),
  z.object({ t: z.literal('cancelTopUp'), reqId: ReqId.optional() }),
  /** Automatic rebuy after busting. Turning it on needs `consent: true`, an amount and a total limit. */
  z.object({
    t: z.literal('autoRebuy'),
    reqId: ReqId,
    on: z.boolean(),
    amount: z.number().int().positive().optional(),
    cap: z.number().int().positive().optional(),
    consent: z.literal(true).optional(),
  }),
  z.object({ t: z.literal('sitOut'), reqId: ReqId.optional() }),
  z.object({ t: z.literal('sitIn'), reqId: ReqId.optional() }),
  z.object({ t: z.literal('waitlist'), join: z.boolean(), reqId: ReqId.optional() }),
  z.object({
    t: z.literal('action'),
    /** Client-generated id; the same id is never applied twice. Answered with `ack` once applied, also when sent again. */
    intentId: ReqId,
    handId: z.string().min(1).max(128),
    /** HandView.seq the client acted on. */
    seq: z.number().int().nonnegative(),
    type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
    /** For bet/raise: the street total ("raise to"). Ignored otherwise. */
    amount: z.number().int().nonnegative().optional(),
  }),
  /**
   * Choose (`kind`) or clear (`kind: null`) a pre-action for this street while another player is to act. `stage` and
   * `toCall` are what the player saw: if the table has moved on since, nothing is kept and the player gets a notice.
   */
  z.object({
    t: z.literal('preAction'),
    reqId: ReqId,
    handId: z.string().min(1).max(128),
    stage: z.enum(['preflop', 'flop', 'turn', 'river']),
    toCall: z.number().int().nonnegative(),
    kind: z.enum(['check', 'checkFold', 'fold']).nullable(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(200), reqId: ReqId.optional() }),
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
  /** A private table this connection has no valid join code for (the socket closes with 4003 if it may not watch). */
  | 'join_code_required'
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
  | 'rebuy_cap'
  /** A pre-action was dropped because the table changed (a bet came in, or it arrived too late): the player decides. */
  | 'preaction_cancelled';

/** Server → client WebSocket messages. */
export type ServerMessage =
  | { t: 'state'; state: TableView; cues: TableCue[] }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chatHistory'; messages: ChatMessage[] }
  | { t: 'ack'; reqId: string }
  | { t: 'error'; code: ErrorCode; message: string; reqId?: string }
  | { t: 'notice'; code: NoticeCode; amount?: number }
  | { t: 'replaced' }
  /** `at` only from the message handler: the room's automatic answer to a ping is the bare `{"t":"pong"}`. */
  | { t: 'pong'; at?: number };
