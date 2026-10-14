import { z } from 'zod';
import { SUPPORTED_MAX_SEATS } from './table';

export const NICKNAME_RE = /^[\p{L}\p{N}_]{2,16}$/u;

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export const PasswordSchema = z.string().min(8).max(128);
export const NicknameSchema = z.string().trim().regex(NICKNAME_RE);

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  nickname: NicknameSchema,
});
export const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1).max(128) });
export const UpdateProfileSchema = z.object({
  nickname: NicknameSchema.optional(),
  avatarUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), 'https only')
    .nullable()
    .optional(),
  locale: z.enum(['ko', 'en']).optional(),
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
    isPrivate: z.boolean().default(false),
    joinCode: z.string().trim().min(4).max(32).optional(),
  })
  .refine((t) => t.bigBlind >= t.smallBlind, { message: 'bigBlind must be >= smallBlind', path: ['bigBlind'] })
  .refine((t) => t.minBuyIn >= t.bigBlind * 10, { message: 'minBuyIn must be >= 10 BB', path: ['minBuyIn'] })
  .refine((t) => t.maxBuyIn >= t.minBuyIn, { message: 'maxBuyIn must be >= minBuyIn', path: ['maxBuyIn'] })
  .refine((t) => !t.isPrivate || !!t.joinCode, { message: 'private tables need a join code', path: ['joinCode'] });
export type TableInput = z.infer<typeof TableInputSchema>;

export const TablePatchSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  smallBlind: z.number().int().min(1).optional(),
  bigBlind: z.number().int().min(2).optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  isPrivate: z.boolean().optional(),
  joinCode: z.string().trim().min(4).max(32).nullable().optional(),
  allowSpectators: z.boolean().optional(),
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

export interface LobbyTableDto {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  isPrivate: boolean;
  allowSpectators: boolean;
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
