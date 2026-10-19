import { z } from 'zod';
import type { PublicRole } from './social';
import type { VipColor } from './vip';
import type { TableCue, TableView } from './table';

/** An automatic rebuy's total limit may cover at most this many rebuys of the chosen amount. */
export const AUTO_REBUY_MAX_TIMES = 5;

/** Quick reactions a seated player can send: shown for a moment over their avatar, never stored, no effect on play. */
export const REACTIONS = ['clap', 'laugh', 'cry', 'wow', 'cool', 'fire', 'heart', 'gg'] as const;
export type ReactionId = (typeof REACTIONS)[number];
export const REACTION_EMOJI: Record<ReactionId, string> = { clap: '👏', laugh: '😂', cry: '😭', wow: '😮', cool: '😎', fire: '🔥', heart: '❤️', gg: '🤝' };
/** At least this long between two reactions from one player (the default; the social policy sets it). */
export const REACTION_COOLDOWN_MS = 2_000;
/** And at most `max` of them in any `windowMs` (the default; the social policy sets it). */
export const REACTION_BURST = { max: 5, windowMs: 30_000 } as const;
/** The room forgives this much early arrival: two taps the client spaced correctly can reach it a little closer. */
export const REACTION_SLACK_MS = 300;

/** How fast one seated player may send reactions: `cooldownMs` apart, and at most `burstMax` in any `burstWindowMs`. */
export interface ReactionRules {
  cooldownMs: number;
  burstMax: number;
  burstWindowMs: number;
}
/** The limits before the social policy existed, and for a room or a policy that does not say. */
export const DEFAULT_REACTION_RULES: ReactionRules = { cooldownMs: REACTION_COOLDOWN_MS, burstMax: REACTION_BURST.max, burstWindowMs: REACTION_BURST.windowMs };

/**
 * Milliseconds until a player who sent reactions at `times` (oldest first) may send another at `now` (0: now), under
 * `rules`. The room and the client apply the same rule: the client so that a tap the room would refuse is not offered.
 */
export function reactionWait(times: readonly number[], now: number, rules: ReactionRules = DEFAULT_REACTION_RULES): number {
  const recent = times.filter((at) => now - at < rules.burstWindowMs);
  const last = recent[recent.length - 1];
  const cooldown = last === undefined ? 0 : last + rules.cooldownMs - now;
  const burst = recent.length >= rules.burstMax ? recent[recent.length - rules.burstMax]! + rules.burstWindowMs - now : 0;
  return Math.max(0, cooldown, burst);
}

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
  /**
   * The auto-muck setting pages before it was always on sent. Auto-muck now always applies (a losing showdown hand stays
   * face down where the rules allow it): the room acknowledges this for a seated player and changes nothing.
   */
  z.object({ t: z.literal('muck'), reqId: ReqId, on: z.boolean() }),
  /**
   * Shows the player's first card (0), second (1) or both from the hand that just ended, until the next deal: any player
   * dealt in whose cards the showdown did not turn over (folded, won uncontested, or a losing hand kept face down).
   */
  z.object({ t: z.literal('show'), reqId: ReqId, card: z.union([z.literal(0), z.literal(1), z.literal('both')]) }),
  /**
   * Adds time from the player's time bank to their current turn. `seq` and `seen` (HandView.seq and HandView.extraMs, 0
   * when absent) are what the player saw: a second tap sent before the first one's result was shown adds nothing.
   */
  z.object({
    t: z.literal('timeBank'),
    reqId: ReqId,
    handId: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
    seen: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(200), reqId: ReqId.optional() }),
  /** A quick reaction from the sender's seat (seated players only). Sent once: one that missed its moment is not retried. */
  z.object({ t: z.literal('react'), reaction: z.enum(REACTIONS), reqId: ReqId.optional() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface ChatMessage {
  id: string;
  userId: string;
  nickname: string;
  /** Staff only (see PublicRole): the role the sender held when the line was posted. */
  role?: PublicRole;
  /** A VIP member's name color when the line was posted (see shownVip). */
  vip?: VipColor;
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
  | 'maintenance'
  | 'not_your_turn'
  | 'illegal_action'
  | 'stale_version'
  | 'duplicate'
  | 'spectators_disabled'
  /** A private table this connection has no valid join code for (the socket closes with 4003 if it may not watch). */
  | 'join_code_required'
  /** The account is suspended: no buy-in or top-up, and an admin's disconnect closes the socket (4004). */
  | 'suspended'
  /** An admin ended this connection (close 4004); the client does not reconnect on its own. */
  | 'disconnected'
  /** The time bank is off at this table, or the player has none (a table bot, not dealt in). */
  | 'time_bank_off'
  /** Less than TIME_BANK_MIN_USE_MS left in the player's time bank. */
  | 'time_bank_empty'
  /** A tournament table: no sitting down, leaving, topping up, rebuying or waitlist (docs/TOURNAMENT.md). */
  | 'tournament_table'
  /** Quick reactions are off service-wide (the social policy). */
  | 'reactions_off'
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
  /** A quick reaction, to everyone at the table; `seatIndex` and `userId` are the sender's when the room took it. */
  | { t: 'react'; seatIndex: number; userId: string; reaction: ReactionId; at: number }
  | { t: 'ack'; reqId: string }
  | { t: 'error'; code: ErrorCode; message: string; reqId?: string }
  | { t: 'notice'; code: NoticeCode; amount?: number }
  | { t: 'replaced' }
  /** `at` only from the message handler: the room's automatic answer to a ping is the bare `{"t":"pong"}`. */
  | { t: 'pong'; at?: number };
