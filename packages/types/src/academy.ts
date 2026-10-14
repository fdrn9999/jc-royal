/**
 * Academy contracts shared by the web app and the API: progress sync payload,
 * anonymous content events and the cosmetic badge rules. Badges are derived
 * from progress only; they never involve chips or the ledger.
 */
import { z } from 'zod';

export const ACADEMY_LESSONS = ['cards', 'hands', 'holdem', 'actions', 'practice'] as const;
export const ACADEMY_SCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
/** Steps in each lesson page; "finish" is only offered on the last one. Practice has no steps: it completes with its scenarios. */
export const ACADEMY_LESSON_STEPS: Record<(typeof ACADEMY_LESSONS)[number], number> = { cards: 4, hands: 5, holdem: 5, actions: 4, practice: 1 };
/** Questions in one review or random quiz set; each must be answered correctly to finish the set. */
export const ACADEMY_REVIEW_SIZE = 8;
/** How far a device clock may be from the server's when progress times are checked for badges. */
export const BADGE_CLOCK_SKEW_MS = 24 * 60 * 60_000;

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

/**
 * The badges the server awards. They are cosmetic self-study marks, not certificates: lessons and quizzes run in the
 * browser, so the server cannot prove anything was studied. It counts only claims the real app produces — whole-ms
 * times between the account's creation and the server's now, a lesson started before it was finished and finished
 * on its last step, and at least ACADEMY_REVIEW_SIZE answers recorded per review set — allowing BADGE_CLOCK_SKEW_MS
 * for device clocks. Each rule still holds after the cross-device merge (earliest times, largest steps and counters).
 * A claim that fails is ignored for badges only; the progress itself is still stored. A time too far ahead counts in
 * a later sync, once the server's clock has caught up.
 */
export function plausibleBadges(data: unknown, { now, since }: { now: number; since: number }): BadgeId[] {
  if (!data || typeof data !== 'object') return [];
  const rec =(x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
  const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  const when = (t: unknown): t is number => count(t) && t >= since - BADGE_CLOCK_SKEW_MS && t <= now + BADGE_CLOCK_SKEW_MS;
  const d = rec(data);
  const lessons: Record<string, { completedAt: number }> = {};
  for (const id of ACADEMY_LESSONS) {
    const p = rec(rec(d.lessons)[id]);
    if (when(p.completedAt) && when(p.startedAt) && p.startedAt <= p.completedAt + BADGE_CLOCK_SKEW_MS && count(p.step) && p.step >= ACADEMY_LESSON_STEPS[id] - 1)
      lessons[id] = { completedAt: p.completedAt };
  }
  const practice: Record<string, number> = {};
  for (const s of ACADEMY_SCENARIOS) {
    const at = rec(d.practice)[s];
    if (when(at)) practice[s] = at;
  }
  const quiz = rec(d.quiz);
  const answers = (count(quiz.correct) ? quiz.correct : 0) + (count(quiz.wrong) ? quiz.wrong : 0);
  const sessions = rec(d.review).sessions;
  const review = { sessions: count(sessions) && sessions * ACADEMY_REVIEW_SIZE <= answers ? sessions : 0 };
  return badgesFor({ lessons, practice, review });
}
