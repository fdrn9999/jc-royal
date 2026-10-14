/**
 * Academy contracts shared by the web app and the API: progress sync payload,
 * anonymous content events and the cosmetic badge rules. Badges are derived
 * from progress only; they never involve chips or the ledger.
 */
import { z } from 'zod';

export const ACADEMY_LESSONS = ['cards', 'hands', 'holdem', 'actions', 'practice'] as const;
export const ACADEMY_SCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/** Progress JSON is the web client's versioned model; the server stores it opaquely (size-capped). */
export const AcademyProgressPutSchema = z.object({
  version: z.number().int().min(1).max(1000),
  updatedAt: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).refine((d) => JSON.stringify(d).length <= 32_000, 'progress too large'),
});

export interface AcademyProgressDto {
  data: Record<string, unknown> | null;
  version: number | null;
  updatedAt: number | null;
  badges: BadgeDto[];
}

const ItemId = z.string().regex(/^[A-Za-z0-9:_-]{1,48}$/);
export const AcademyEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), id: ItemId, correct: z.boolean() }),
  z.object({ kind: z.enum(['lesson', 'scenario']), id: ItemId, phase: z.enum(['start', 'complete']) }),
]);
export const AcademyEventsSchema = z.object({ events: z.array(AcademyEventSchema).min(1).max(50) });
export type AcademyEvent = z.infer<typeof AcademyEventSchema>;

export interface AcademyStatRow {
  kind: 'lesson' | 'question' | 'scenario';
  itemId: string;
  starts: number;
  completes: number;
  correct: number;
  wrong: number;
}

export const BADGES = ['first-step', 'card-reader', 'hand-expert', 'rule-keeper', 'practice-graduate', 'academy-graduate', 'sharp-eye'] as const;
export type BadgeId = (typeof BADGES)[number];
export interface BadgeDto {
  badge: BadgeId;
  awardedAt: number;
}

/** Reads only the fields it needs from an (untrusted) progress payload. */
export function badgesFor(data: unknown): BadgeId[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const lessons = (d.lessons && typeof d.lessons === 'object' ? d.lessons : {}) as Record<string, { completedAt?: unknown } | undefined>;
  const done = (id: string) => typeof lessons[id]?.completedAt === 'number';
  const practice = (d.practice && typeof d.practice === 'object' ? d.practice : {}) as Record<string, unknown>;
  const review = (d.review && typeof d.review === 'object' ? d.review : {}) as { sessions?: unknown; streak?: unknown };
  const out: BadgeId[] = [];
  if (ACADEMY_LESSONS.some(done)) out.push('first-step');
  if (done('cards')) out.push('card-reader');
  if (done('hands')) out.push('hand-expert');
  if (done('holdem') && done('actions')) out.push('rule-keeper');
  if (ACADEMY_SCENARIOS.every((s) => typeof practice[s] === 'number')) out.push('practice-graduate');
  if (ACADEMY_LESSONS.every(done)) out.push('academy-graduate');
  if (typeof review.sessions === 'number' && review.sessions >= 3) out.push('sharp-eye');
  return out;
}
