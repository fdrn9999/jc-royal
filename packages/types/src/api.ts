import { z } from 'zod';
import { SUPPORTED_MAX_SEATS } from './table';

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
export const PRIVACY_NOTICE_VERSION = '2026-10-14';

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
  })
  .refine((t) => t.bigBlind >= t.smallBlind, { message: 'bigBlind must be >= smallBlind', path: ['bigBlind'] })
  .refine((t) => t.minBuyIn >= t.bigBlind * 10, { message: 'minBuyIn must be >= 10 BB', path: ['minBuyIn'] })
  .refine((t) => t.maxBuyIn >= t.minBuyIn, { message: 'maxBuyIn must be >= minBuyIn', path: ['maxBuyIn'] })
  .refine((t) => !t.isPrivate || !!t.joinCode, { message: 'private tables need a join code', path: ['joinCode'] });
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
});

export const ChipAdjustSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, 'amount must be non-zero').refine((n) => Math.abs(n) <= 100_000_000),
  memo: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().min(8).max(64),
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
  host: { id: string; nickname: string } | null;
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
  playing: boolean;
  waitlist: number;
  spectators: number;
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

export interface StatsDto {
  handsPlayed: number;
  handsWon: number;
  winRate: number;
  totalWon: number;
  netChips: number;
  biggestPot: number;
  bestHand: { rankClass: string; cards: string[] } | null;
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
}

export type ApiError = { error: { code: string; message: string; details?: unknown } };
