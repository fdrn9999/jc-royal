import { z } from 'zod';
import type { PublicRole } from './social';
import { BOT_LEVELS, SUPPORTED_MAX_SEATS, type BotLevel } from './table';

export const NICKNAME_RE = /^[\p{L}\p{N}_]{2,16}$/u;

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
/** New-password policy. The API enforces it and the web forms show it as a live checklist. */
export const PASSWORD_RULES = [
  { id: 'length', test: (p: string) => p.length >= 8 },
  // Any English letter; upper and lower case are not both required.
  { id: 'letter', test: (p: string) => /[A-Za-z]/.test(p) },
  { id: 'digit', test: (p: string) => /[0-9]/.test(p) },
  { id: 'special', test: (p: string) => /[!-\/:-@\[-`{-~]/.test(p) },
] as const;
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.test(p));
export const PasswordSchema = z.string().max(128).refine(passwordOk, 'password must have 8+ characters with a letter, a digit and a symbol');
export const NicknameSchema = z.string().trim().regex(NICKNAME_RE);

export const LocaleSchema = z.enum(['ko', 'en']);
/** Version of the signup privacy notice. Bump it when the notice text changes; each signup stores the version it accepted. */
export const PRIVACY_NOTICE_VERSION = '2026-10-16';

/** Youngest age (full years) allowed to sign up; matches the "14 or older" agreement. */
export const MIN_SIGNUP_AGE = 14;
/** YYYY-MM-DD of a Date in UTC (the API's notion of "today"). */
export const isoDate = (d: Date = new Date()) => d.toISOString().slice(0, 10);
/** Full years between two YYYY-MM-DD dates. */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDate(d) === s;
};
export const BirthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(realDate, 'not a calendar date')
  // One day of slack for members whose local date is already ahead of UTC.
  .refine((s) => s >= '1900-01-01' && s <= isoDate(new Date(Date.now() + 86_400_000)), 'out of range');

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  nickname: NicknameSchema,
  birthDate: BirthDateSchema,
  /** Account language: used for mail and system messages, and shown to admins. */
  locale: LocaleSchema.default('ko'),
  /** Required notices, each accepted explicitly. */
  agreements: z.object({ age14: z.literal(true), privacy: z.literal(true) }),
  /** Proof from /email-verification/confirm. Required while sign-up email verification is on. */
  emailVerificationToken: z.string().min(20).max(200).optional(),
  /** A referral code (from the link's `?ref=` or typed); empty is no code. Checked by the server: `referral_invalid`. */
  referralCode: z.string().max(40).optional(),
});
export const EmailVerificationRequestSchema = z.object({ email: EmailSchema, locale: LocaleSchema.default('ko') });
export const EmailVerificationConfirmSchema = z.object({ email: EmailSchema, code: z.string().regex(/^\d{6}$/) });
export interface SignupOptionsDto {
  /** True when sign-up needs a confirmed email code (mail is configured, or outside production). */
  emailVerification: boolean;
  privacyNoticeVersion: string;
}
export interface EmailVerificationSentDto {
  ok: true;
  expiresInMinutes: number;
  resendAfterSeconds: number;
  /** Outside production only, so the flow works without a mail provider. */
  devCode?: string;
}
export const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1).max(128), remember: z.boolean().default(false) });
export const UpdateProfileSchema = z.object({
  nickname: NicknameSchema.optional(),
  avatarUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), 'https only')
    .nullable()
    .optional(),
  locale: LocaleSchema.optional(),
});
export const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema });
export const ResetRequestSchema = z.object({ email: EmailSchema });
export const ResetConfirmSchema = z.object({ token: z.string().min(20).max(200), newPassword: PasswordSchema });
export const DeleteAccountSchema = z.object({ password: z.string().min(1).max(128) });

/**
 * An official table's table bots: whether they may sit in, how well they play, how many members must be seated first
 * (minHumans), how many bots at most (max), the player count they fill up to (fillTo), and whether one stands up after
 * the hand for a member waiting for a seat (yieldSeat). Member rooms never have bots.
 */
const BotSettingsShape = {
  botsEnabled: z.boolean().default(false),
  botLevel: z.enum(BOT_LEVELS).default('normal'),
  botMinHumans: z.number().int().min(1).max(8).default(1),
  botMax: z.number().int().min(1).max(8).default(1),
  botFillTo: z.number().int().min(2).max(9).default(2),
  botYield: z.boolean().default(true),
};
export type BotSettings = { botsEnabled: boolean; botLevel: BotLevel; botMinHumans: number; botMax: number; botFillTo: number; botYield: boolean };

/** What makes a table's bot settings unusable at its size (also checked against the stored row on a patch). */
export function botSettingsIssues(b: Pick<BotSettings, 'botMinHumans' | 'botMax' | 'botFillTo'>, maxSeats: number): { message: string; path: string[] }[] {
  const out: { message: string; path: string[] }[] = [];
  if (b.botFillTo > maxSeats) out.push({ message: 'botFillTo must be <= maxSeats', path: ['botFillTo'] });
  if (b.botMax > maxSeats - 1) out.push({ message: 'botMax must leave a seat for a member', path: ['botMax'] });
  if (b.botMinHumans >= b.botFillTo) out.push({ message: 'botMinHumans must be < botFillTo', path: ['botMinHumans'] });
  return out;
}

export const TableInputSchema = z
  .object({
    name: z.string().trim().min(2).max(40),
    maxSeats: z.union(SUPPORTED_MAX_SEATS.map((n) => z.literal(n)) as [z.ZodLiteral<2>, z.ZodLiteral<6>, z.ZodLiteral<9>]),
    smallBlind: z.number().int().min(1).max(1_000_000),
    bigBlind: z.number().int().min(2).max(2_000_000),
    minBuyIn: z.number().int().positive(),
    maxBuyIn: z.number().int().positive(),
    turnSeconds: z.number().int().min(10).max(120).default(20),
    allowSpectators: z.boolean().default(true),
    beginner: z.boolean().default(false),
    isPrivate: z.boolean().default(false),
    joinCode: z.string().trim().min(4).max(32).optional(),
    ...BotSettingsShape,
  })
  .refine((t) => t.bigBlind >= t.smallBlind, { message: 'bigBlind must be >= smallBlind', path: ['bigBlind'] })
  .refine((t) => t.minBuyIn >= t.bigBlind * 10, { message: 'minBuyIn must be >= 10 BB', path: ['minBuyIn'] })
  .refine((t) => t.maxBuyIn >= t.minBuyIn, { message: 'maxBuyIn must be >= minBuyIn', path: ['maxBuyIn'] })
  .refine((t) => !t.isPrivate || !!t.joinCode, { message: 'private tables need a join code', path: ['joinCode'] })
  .superRefine((t, ctx) => botSettingsIssues(t, t.maxSeats).forEach((i) => ctx.addIssue({ code: 'custom', ...i })));
export type TableInput = z.infer<typeof TableInputSchema>;

/** Blinds a member can choose for their own room (small blind is half the big blind). */
export const ROOM_BIG_BLINDS = [10, 20, 50, 100, 200] as const;
/** Rooms a member can have open at once. */
export const MAX_ACTIVE_ROOMS = 2;
/** A member room with nobody seated for this long closes itself. */
export const MEMBER_IDLE_CLOSE_MS = 10 * 60_000;

const RoomCodeSchema = z.string().trim().min(4).max(32);

/** A member's own room. Buy-in limits are in big blinds' worth of chips, within 10–200 BB. */
export const RoomCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(30),
    maxSeats: z.union(SUPPORTED_MAX_SEATS.map((n) => z.literal(n)) as [z.ZodLiteral<2>, z.ZodLiteral<6>, z.ZodLiteral<9>]),
    bigBlind: z.union(ROOM_BIG_BLINDS.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<10>, z.ZodLiteral<20>, ...z.ZodLiteral<number>[]]),
    minBuyIn: z.number().int().positive(),
    maxBuyIn: z.number().int().positive(),
    allowSpectators: z.boolean().default(true),
    isPrivate: z.boolean().default(false),
    joinCode: RoomCodeSchema.optional(),
  })
  .refine((t) => t.minBuyIn >= t.bigBlind * 10, { message: 'minBuyIn must be >= 10 BB', path: ['minBuyIn'] })
  .refine((t) => t.maxBuyIn <= t.bigBlind * 200, { message: 'maxBuyIn must be <= 200 BB', path: ['maxBuyIn'] })
  .refine((t) => t.maxBuyIn >= t.minBuyIn, { message: 'maxBuyIn must be >= minBuyIn', path: ['maxBuyIn'] })
  .refine((t) => !t.isPrivate || !!t.joinCode, { message: 'private rooms need a join code', path: ['joinCode'] });
export type RoomCreate = z.infer<typeof RoomCreateSchema>;

/** What the host can change. Stakes, seats, chips, cards and results are not theirs to change. */
export const RoomPatchSchema = z.object({
  name: z.string().trim().min(2).max(30).optional(),
  allowSpectators: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  joinCode: RoomCodeSchema.nullable().optional(),
});

/** A private table's join code, exchanged for a short-lived access cookie (the code never goes in a URL). */
export const TableAccessSchema = z.object({ code: z.string().trim().min(1).max(64) });

export const TablePatchSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  smallBlind: z.number().int().min(1).optional(),
  bigBlind: z.number().int().min(2).optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  isPrivate: z.boolean().optional(),
  joinCode: z.string().trim().min(4).max(32).nullable().optional(),
  allowSpectators: z.boolean().optional(),
  beginner: z.boolean().optional(),
  entryBlocked: z.boolean().optional(),
  botsEnabled: z.boolean().optional(),
  botLevel: z.enum(BOT_LEVELS).optional(),
  botMinHumans: BotSettingsShape.botMinHumans.removeDefault().optional(),
  botMax: BotSettingsShape.botMax.removeDefault().optional(),
  botFillTo: BotSettingsShape.botFillTo.removeDefault().optional(),
  botYield: z.boolean().optional(),
});

/** Hands played below which quick play counts a player as a newcomer and prefers beginner tables. */
export const NEWCOMER_HANDS = 50;

/** Quick play: optional table size and big blind (exact matches), and tables to skip after a failed try. */
export const QuickPlaySchema = z.object({
  maxSeats: z.union(SUPPORTED_MAX_SEATS.map((n) => z.literal(n)) as [z.ZodLiteral<2>, z.ZodLiteral<6>, z.ZodLiteral<9>]).optional(),
  bigBlind: z.number().int().min(2).max(2_000_000).optional(),
  exclude: z.array(z.string().min(1).max(64)).max(20).default([]),
});
export type QuickPlayInput = z.input<typeof QuickPlaySchema>;

export const ChipAdjustSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, 'amount must be non-zero').refine((n) => Math.abs(n) <= 100_000_000),
  memo: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().min(8).max(64),
  /** The transaction this adjustment corrects (a free refill paid by mistake, say), shown with both. */
  refLedgerId: z.string().min(8).max(64).optional(),
});

export type Role = 'user' | 'admin' | 'super_admin';
export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface MeDto {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: Role;
  balance: number;
  locale: 'ko' | 'en';
  createdAt: number;
}

export type RoomType = 'official' | 'member';

export interface LobbyTableDto {
  id: string;
  name: string;
  roomType: RoomType;
  /** The member who opened a member room. */
  host: { id: string; nickname: string; role?: PublicRole } | null;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  isPrivate: boolean;
  allowSpectators: boolean;
  /** Low-stakes table recommended for newcomers. */
  beginner: boolean;
  entryBlocked: boolean;
  status: 'open' | 'closed';
  /** Live occupancy reported by the table room. */
  seated: number;
  /** Of seated, the table bots. */
  bots: number;
  /** Table bots may sit in while few members play (official tables only): how well they play; null when they may not. */
  botLevel: BotLevel | null;
  playing: boolean;
  waitlist: number;
  spectators: number;
}

/**
 * The table quick play picked: the table room confirmed a free seat for this player at that moment. Nothing is held
 * or paid yet; the buy-in still goes through the normal seat request. Failures are `no_table` (nothing matches the
 * filters), `insufficient_balance` (details.minBuyIn: the cheapest minimum among matches) or `tables_full`.
 */
export interface QuickPlayDto {
  table: LobbyTableDto;
  seatIndex: number;
}

/**
 * Why a free chip refill would not pay now (GET/POST /api/me/refill): the refill is off or paused, the wait since the
 * last one is not over, wallet and table chips together are not below the line, the account is suspended, or `held`:
 * the chips on a table could not be confirmed (see `RefillHold`) and the claim waits until they can.
 */
export type RefillReason = 'off' | 'paused' | 'cooldown' | 'above' | 'suspended' | 'held';
/** `busy`: chips are moving between wallet and seat; `unreachable`: a table did not answer; `mismatch`: an open seat the table does not have. */
export type RefillHold = 'busy' | 'unreachable' | 'mismatch';
export interface RefillPolicyDto {
  version: number;
  enabled: boolean;
  paused: boolean;
  /** Paid when wallet + table chips are below this. */
  below: number;
  amount: number;
  cooldownMs: number;
}
export interface RefillStatusDto {
  /** Null when no policy was ever set (the refill is off). */
  policy: RefillPolicyDto | null;
  wallet: number;
  /** Chips at tables (open seats' stacks, a hand's bets included); null when not counted or not confirmed. */
  tables: number | null;
  eligible: boolean;
  reason: RefillReason | null;
  hold: RefillHold | null;
  /** When the next refill may be claimed (the wait after the last one), server time. */
  nextAt: number | null;
  last: { at: number; amount: number } | null;
  /** Refills received so far. */
  received: number;
  /** Server time of this answer. */
  now: number;
}
export interface RefillClaimDto {
  amount: number;
  balance: number;
  nextAt: number;
  /** Another request (a second tab, a retry) had already claimed this refill: nothing more was paid. */
  duplicate: boolean;
  status: RefillStatusDto;
}

/** A member's referral code as shared: JC and 5–10 capital letters or digits (the codes made now have 5). */
export const REFERRAL_CODE_RE = /^JC[A-Z0-9]{5,10}$/;
/** A code as typed or pasted, before it is checked: no spaces, capital letters. */
export const normalizeReferralCode = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/**
 * A signup made with a code (apps/api/src/lib/referral.ts). `pending`: not paid yet (the new member's hands, a pause,
 * a suspension); `review`: held for an operator; `settled`: both sides final; `unpaid`: closed without a reward.
 */
export type ReferralStatus = 'pending' | 'review' | 'settled' | 'unpaid';
/** One side's reward: `capped` when the referrer had reached a cap, `skipped` when that member had withdrawn. */
export type ReferralSideStatus = 'pending' | 'paid' | 'capped' | 'skipped' | 'unpaid';
/** Why a referral is waiting or closed without a reward. */
export type ReferralFailure =
  | 'off'
  | 'paused'
  | 'hands'
  | 'email'
  | 'repeat_email'
  | 'burst'
  | 'rejected'
  | 'daily_cap'
  | 'total_cap'
  | 'invitee_deleted'
  | 'invitee_suspended'
  | 'referrer_deleted'
  | 'referrer_suspended';
/** What members are told of the referral policy (the review threshold is not shown). */
export interface ReferralPolicyDto {
  version: number;
  enabled: boolean;
  paused: boolean;
  referrerAmount: number;
  inviteeAmount: number;
  /** Referrer rewards per day (KST) and in total. */
  dailyCap: number;
  totalCap: number;
  /** Hands the new member finishes before either side is paid. */
  minHands: number;
}
/** One side of one referral, as its member sees it. */
export interface ReferralRewardDto {
  status: ReferralStatus;
  side: ReferralSideStatus;
  /** Chips promised to this side when the signup was accepted. */
  amount: number;
  paidAt: number | null;
  failure: ReferralFailure | null;
  /**
   * Hands the new member still has to finish (0 once done), told to the new member only: in the referrer's list it is
   * null, and `failure: 'hands'` says only that the reward waits for them.
   */
  handsLeft: number | null;
  createdAt: number;
}
export interface ReferralInviteeDto extends ReferralRewardDto {
  /** Null once that member has withdrawn. */
  nickname: string | null;
}
/** GET /api/me/referral: the member's code and link, the policy, and what their referrals paid. */
export interface ReferralMeDto {
  code: string;
  link: string;
  policy: ReferralPolicyDto | null;
  counts: { invited: number; paid: number; pending: number; unpaid: number };
  /** Chips received as the referrer, and promised ones not paid yet. */
  earned: number;
  waiting: number;
  /** The member who invited this one, if any, and this member's own reward. */
  invitedBy: (ReferralRewardDto & { nickname: string | null }) | null;
  /** The newest members invited (up to 20). */
  recent: ReferralInviteeDto[];
  /** Chips this request paid to the member (waiting rewards settled as the card opened): the wallet changed. */
  paidNow: number;
  now: number;
}
/** GET /api/auth/referral/:code, for the signup form: whose code it is and what the new member would get now. */
export interface ReferralCodeCheckDto {
  valid: boolean;
  inviter: string | null;
  /** Null when referral rewards are off (the code is still accepted). */
  reward: { amount: number; minHands: number; paused: boolean } | null;
}

export interface LedgerEntryDto {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  tableId: string | null;
  memo: string | null;
  createdAt: number;
}

/** `n` of `of` hands; `of` is 0 while there is nothing to measure. */
export interface StatRatio {
  n: number;
  of: number;
}

/** Table positions, earliest to act preflop first. Heads-up the button posts the small blind and counts as BTN. */
export const POSITIONS = ['EP', 'MP', 'CO', 'BTN', 'SB', 'BB'] as const;
export type Position = (typeof POSITIONS)[number];

export interface PositionStatsDto {
  position: Position;
  hands: number;
  /** Hands at this position entered preflop by choice / raised preflop. */
  vpip: number;
  pfr: number;
  net: number;
}

/**
 * The user's own play statistics, from the hands they were dealt into (watching doesn't count). Figures that need the
 * per-hand statistics columns only count hands whose columns are filled (see packages/db/src/handStats.ts).
 */
export interface StatsDto {
  handsPlayed: number;
  /** Hands where the user won part of a pot: split pots count, getting only uncalled chips back doesn't. */
  handsWon: number;
  /** handsWon over the hands measured, in percent with one decimal. */
  winRate: number;
  /** Chips won from pots, without uncalled chips handed back. */
  totalWon: number;
  netChips: number;
  /** Largest pot among hands the user put chips into; uncalled chips handed back are not part of it. */
  largestPot: number;
  /** Average of those pots, rounded; null before any. */
  avgPot: number | null;
  /** Largest profit in one hand (net, i.e. after subtracting the user's own chips); 0 if never ahead. */
  biggestWin: number;
  bestHand: { rankClass: string; cards: string[] } | null;
  /** Put chips in preflop by choice (blinds don't count), over hands dealt. */
  vpip: StatRatio;
  /** Raised preflop (an all-in above the highest bet counts), over hands dealt. */
  pfr: StatRatio;
  /** Of the hands entered preflop by choice, the ones raised. */
  raiseShare: StatRatio;
  /** Went to showdown, over hands that saw the flop. */
  wtsd: StatRatio;
  /** Won part of a pot at showdown, over showdowns. */
  wsd: StatRatio;
  /** Every position, in POSITIONS order, zeros included. */
  positions: PositionStatsDto[];
}

export const TREND_DAYS = [7, 30, 90] as const;

export interface StatsTrendDto {
  days: (typeof TREND_DAYS)[number];
  /** Minutes east of UTC the days were cut at. */
  tz: number;
  /** Days with hands, oldest first ('YYYY-MM-DD' in that time zone); days without hands are left out. */
  points: { day: string; hands: number; net: number }[];
}

export interface HandSummaryDto {
  id: string;
  tableId: string;
  tableName: string;
  handNumber: number;
  endedAt: number;
  board: string[];
  potTotal: number;
  net: number;
  won: number;
  holeCards: string[];
  rankClass: string | null;
  /** The member's seat position, or null where the hand's statistics were not worked out (see handStats.ts). */
  position: Position | null;
  /** The table's big blind now (blinds are not stored per hand). */
  bigBlind: number;
  /** The member's own note on the hand: never shown to anyone else. */
  bookmarked: boolean;
  tags: HandTag[];
  hasMemo: boolean;
}

/** Tags a member can put on their own hands, in the order of their bits in hand_notes.tags. */
export const HAND_TAGS = ['review', 'bluff', 'hardCall', 'bigPot'] as const;
export type HandTag = (typeof HAND_TAGS)[number];
export const HAND_MEMO_MAX = 500;
export const HAND_RESULTS = ['up', 'down', 'even'] as const;
export type HandResult = (typeof HAND_RESULTS)[number];
/** Pot sizes the hand list can be narrowed to, in big blinds of the table's current blind. */
export const HAND_MIN_POTS = [20, 50, 100] as const;

const epochMs = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * The filters of GET /api/me/hands (`limit` and `before` are read as before). `beforeId` is the last hand of the
 * previous page, with `before` its end; the date range is [from, to) in ms. Every filter is optional; a value outside
 * its list is refused (400).
 */
export const HandListQuerySchema = z.object({
  beforeId: z.string().min(1).max(128).optional(),
  from: epochMs.optional(),
  to: epochMs.optional(),
  position: z.enum(POSITIONS).optional(),
  result: z.enum(HAND_RESULTS).optional(),
  minPot: z.coerce
    .number()
    .refine((n) => (HAND_MIN_POTS as readonly number[]).includes(n))
    .optional(),
  tag: z.enum(HAND_TAGS).optional(),
  bookmarked: z.literal('1').optional(),
});
export type HandListQuery = z.infer<typeof HandListQuerySchema>;

export interface HandNoteDto {
  bookmarked: boolean;
  tags: HandTag[];
  memo: string | null;
  /** Memo revision: a memo save names the revision it was written over. 0 before the first memo. */
  rev: number;
  /** null before the member saved anything on the hand. */
  updatedAt: number | null;
}

/**
 * PUT /api/me/hands/:id/note. Only the fields sent change: a tag left out keeps its state. A memo save needs `rev`, the
 * revision it was written over; if the memo changed since (another tab or device), nothing is saved and the answer is
 * 409 note_conflict with the saved note in details. An empty memo removes it.
 */
export const HandNoteInputSchema = z
  .object({
    bookmarked: z.boolean().optional(),
    tags: z.partialRecord(z.enum(HAND_TAGS), z.boolean()).optional(),
    memo: z.string().max(HAND_MEMO_MAX).optional(),
    rev: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((b) => b.bookmarked !== undefined || (b.tags && Object.keys(b.tags).length > 0) || b.memo !== undefined, { message: 'nothing to save' })
  .refine((b) => b.memo === undefined || b.rev !== undefined, { message: 'a memo needs rev', path: ['rev'] });
export type HandNoteInput = z.infer<typeof HandNoteInputSchema>;

export type ApiError = { error: { code: string; message: string; details?: unknown } };
