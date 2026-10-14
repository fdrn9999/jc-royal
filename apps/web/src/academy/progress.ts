/**
 * Academy progress, stored per account in localStorage (`jc.academy:<userId>`)
 * so a shared device never shows another member's progress. The payload is
 * versioned; `migrate` accepts anything (older versions, garbage) and returns a
 * valid current-version object. Progress is cosmetic: it never touches the
 * wallet, ledger or game statistics.
 */
import { useSyncExternalStore } from 'react';

export const LESSON_IDS = ['cards', 'hands', 'holdem', 'actions', 'practice'] as const;
export type LessonId = (typeof LESSON_IDS)[number];
export const SCENARIO_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface LessonProgress {
  startedAt: number;
  completedAt: number | null;
  /** Furthest step reached (0-based). */
  step: number;
}

export interface Progress {
  v: 1;
  lessons: Partial<Record<LessonId, LessonProgress>>;
  last: { lesson: LessonId; step: number } | null;
  quiz: { correct: number; wrong: number };
  practice: Partial<Record<ScenarioId, number>>;
  /** The first-visit "new to hold'em?" chooser was answered or dismissed. */
  onboarded: boolean;
}

export const CURRENT_VERSION = 1;
export const emptyProgress = (): Progress => ({ v: 1, lessons: {}, last: null, quiz: { correct: 0, wrong: 0 }, practice: {}, onboarded: false });

const nat = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
const isLesson = (x: unknown): x is LessonId => (LESSON_IDS as readonly unknown[]).includes(x);

/**
 * Step-wise upgrades: `UPGRADES[n]` turns a version-n payload into n+1. When the
 * shape changes, bump CURRENT_VERSION and add the step here; old saves are then
 * upgraded in order and sanitised, never thrown away.
 */
const UPGRADES: Record<number, (r: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(raw: unknown): Progress {
  const out = emptyProgress();
  if (!raw || typeof raw !== 'object') return out;
  let r = raw as Record<string, unknown>;
  while (typeof r.v === 'number' && r.v < CURRENT_VERSION && UPGRADES[r.v]) r = UPGRADES[r.v]!(r);
  if (r.v !== CURRENT_VERSION) return out; // unknown or newer → start fresh rather than crash
  const lessons = (r.lessons && typeof r.lessons === 'object' ? r.lessons : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(lessons)) {
    if (!isLesson(id) || !v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    out.lessons[id] = { startedAt: nat(p.startedAt), completedAt: p.completedAt === null || p.completedAt === undefined ? null : nat(p.completedAt), step: nat(p.step) };
  }
  const last = r.last as Record<string, unknown> | null;
  if (last && isLesson(last.lesson)) out.last = { lesson: last.lesson, step: nat(last.step) };
  const quiz = (r.quiz ?? {}) as Record<string, unknown>;
  out.quiz = { correct: nat(quiz.correct), wrong: nat(quiz.wrong) };
  const practice = (r.practice && typeof r.practice === 'object' ? r.practice : {}) as Record<string, unknown>;
  for (const [id, at] of Object.entries(practice)) if ((SCENARIO_IDS as readonly string[]).includes(id)) out.practice[id as ScenarioId] = nat(at);
  out.onboarded = r.onboarded === true;
  return out;
}

// ------------------------------------------------------------------ pure updates

export function startLesson(p: Progress, id: LessonId, step: number, now: number): Progress {
  const cur = p.lessons[id];
  return {
    ...p,
    onboarded: true,
    lessons: { ...p.lessons, [id]: { startedAt: cur?.startedAt || now, completedAt: cur?.completedAt ?? null, step: Math.max(cur?.step ?? 0, step) } },
    last: { lesson: id, step },
  };
}

export function completeLesson(p: Progress, id: LessonId, now: number): Progress {
  const cur = p.lessons[id];
  return { ...p, onboarded: true, lessons: { ...p.lessons, [id]: { startedAt: cur?.startedAt || now, completedAt: cur?.completedAt ?? now, step: cur?.step ?? 0 } } };
}

export function recordAnswer(p: Progress, correct: boolean): Progress {
  return { ...p, quiz: { correct: p.quiz.correct + (correct ? 1 : 0), wrong: p.quiz.wrong + (correct ? 0 : 1) } };
}

export function completeScenario(p: Progress, id: ScenarioId, now: number): Progress {
  const next: Progress = { ...p, onboarded: true, practice: { ...p.practice, [id]: p.practice[id] ?? now } };
  return SCENARIO_IDS.every((s) => next.practice[s]) ? completeLesson(next, 'practice', now) : next;
}

export function lessonsDone(p: Progress): number {
  return LESSON_IDS.filter((id) => p.lessons[id]?.completedAt !== null && p.lessons[id]?.completedAt !== undefined).length;
}

/** 0–100: lessons count fully, practice counts per scenario. */
export function percent(p: Progress): number {
  const theory = LESSON_IDS.filter((id) => id !== 'practice' && isDone(p, id)).length;
  const practice = SCENARIO_IDS.filter((s) => p.practice[s]).length / SCENARIO_IDS.length;
  return Math.round(((theory + practice) / LESSON_IDS.length) * 100);
}

export function isDone(p: Progress, id: LessonId): boolean {
  const c = p.lessons[id]?.completedAt;
  return c !== null && c !== undefined;
}

export const tutorialComplete = (p: Progress) => LESSON_IDS.every((id) => isDone(p, id));

/** Where "continue" should go: the last lesson if unfinished, else the first unfinished one. */
export function nextLesson(p: Progress): LessonId | null {
  if (p.last && !isDone(p, p.last.lesson)) return p.last.lesson;
  return LESSON_IDS.find((id) => !isDone(p, id)) ?? null;
}

// ------------------------------------------------------------------ store

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const storageKey = (userId: string) => `jc.academy:${userId}`;

export function load(kv: KV, userId: string): Progress {
  try {
    return migrate(JSON.parse(kv.getItem(storageKey(userId)) ?? 'null'));
  } catch {
    return emptyProgress();
  }
}

export function save(kv: KV, userId: string, p: Progress) {
  try {
    kv.setItem(storageKey(userId), JSON.stringify(p));
  } catch {
    /* storage full / blocked: progress stays in memory */
  }
}

const memory = new Map<string, Progress>();
const listeners = new Set<() => void>();
const kv = (): KV | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function get(userId: string): Progress {
  let p = memory.get(userId);
  if (!p) {
    const s = kv();
    p = s ? load(s, userId) : emptyProgress();
    memory.set(userId, p);
  }
  return p;
}

export function updateProgress(userId: string, fn: (p: Progress) => Progress) {
  const next = fn(get(userId));
  memory.set(userId, next);
  const s = kv();
  if (s) save(s, userId, next);
  for (const l of listeners) l();
}

export function resetProgress(userId: string) {
  updateProgress(userId, (p) => ({ ...emptyProgress(), onboarded: p.onboarded }));
}

const GUEST = 'guest';
export function useProgress(userId: string | null | undefined): Progress {
  const id = userId ?? GUEST;
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => get(id),
  );
}
