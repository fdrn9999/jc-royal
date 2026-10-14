/**
 * Academy progress, stored per account in localStorage (`jc.academy:<userId>`)
 * and synced to the server (see sync.ts), so a shared device never shows
 * another member's progress and a second device picks up where you left off.
 * The payload is versioned; `migrate` accepts anything (older versions,
 * garbage) and returns a valid current-version object. Progress is cosmetic:
 * it never touches the wallet, ledger or game statistics.
 */
import { useSyncExternalStore } from 'react';

export const LESSON_IDS = ['cards', 'hands', 'holdem', 'actions', 'practice'] as const;
export type LessonId = (typeof LESSON_IDS)[number];
export const SCENARIO_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Concepts questions are tagged with; mistakes per topic drive the review quiz. */
export const TOPICS = ['suits', 'ranks', 'hand-names', 'hand-order', 'kicker', 'split', 'positions', 'actions', 'pots'] as const;
export type Topic = (typeof TOPICS)[number];

export interface LessonProgress {
  startedAt: number;
  completedAt: number | null;
  /** Furthest step reached (0-based). */
  step: number;
}

export interface ScenarioStats {
  /** Times the scenario was started. */
  tries: number;
  /** Off-script or wrong answers made while playing it. */
  misses: number;
}

export interface Progress {
  v: 2;
  /** Last local change (ms); the newer side wins scalar fields when merging devices. */
  updatedAt: number;
  /** Set by "start over"; anything recorded before it is discarded on merge. */
  resetAt: number;
  lessons: Partial<Record<LessonId, LessonProgress>>;
  last: { lesson: LessonId; step: number } | null;
  quiz: { correct: number; wrong: number };
  practice: Partial<Record<ScenarioId, number>>;
  scenarioStats: Partial<Record<ScenarioId, ScenarioStats>>;
  /** Unresolved mistakes per topic (correct review answers pay them back). */
  mistakes: Partial<Record<Topic, number>>;
  review: { sessions: number; best: number };
  /** Real-table hands seen since the coaching tips started (first-hands guide). */
  coach: { hands: number; off: boolean };
  /** The first-visit "new to hold'em?" chooser was answered or dismissed. */
  onboarded: boolean;
}

export const CURRENT_VERSION = 2;
export const emptyProgress = (): Progress => ({
  v: 2,
  updatedAt: 0,
  resetAt: 0,
  lessons: {},
  last: null,
  quiz: { correct: 0, wrong: 0 },
  practice: {},
  scenarioStats: {},
  mistakes: {},
  review: { sessions: 0, best: 0 },
  coach: { hands: 0, off: false },
  onboarded: false,
});

const nat = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
const obj = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const isLesson = (x: unknown): x is LessonId => (LESSON_IDS as readonly unknown[]).includes(x);
const isScenario = (x: unknown): x is ScenarioId => (SCENARIO_IDS as readonly unknown[]).includes(x);
const isTopic = (x: unknown): x is Topic => (TOPICS as readonly unknown[]).includes(x);

/**
 * Step-wise upgrades: `UPGRADES[n]` turns a version-n payload into n+1. When the
 * shape changes, bump CURRENT_VERSION and add the step here; old saves are then
 * upgraded in order and sanitised, never thrown away.
 */
const UPGRADES: Record<number, (r: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 → v2: sync timestamps, mistakes/review, scenario stats, first-hands coach. Existing data is kept.
  1: (r) => ({ ...r, v: 2, updatedAt: 0, resetAt: 0, scenarioStats: {}, mistakes: {}, review: { sessions: 0, best: 0 }, coach: { hands: 0, off: false } }),
};

export function migrate(raw: unknown): Progress {
  const out = emptyProgress();
  if (!raw || typeof raw !== 'object') return out;
  let r = raw as Record<string, unknown>;
  while (typeof r.v === 'number' && r.v < CURRENT_VERSION && UPGRADES[r.v]) r = UPGRADES[r.v]!(r);
  if (r.v !== CURRENT_VERSION) return out; // unknown or newer → start fresh rather than crash
  out.updatedAt = nat(r.updatedAt);
  out.resetAt = nat(r.resetAt);
  for (const [id, v] of Object.entries(obj(r.lessons))) {
    if (!isLesson(id) || !v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    out.lessons[id] = { startedAt: nat(p.startedAt), completedAt: p.completedAt === null || p.completedAt === undefined ? null : nat(p.completedAt), step: nat(p.step) };
  }
  const last = r.last as Record<string, unknown> | null;
  if (last && isLesson(last.lesson)) out.last = { lesson: last.lesson, step: nat(last.step) };
  const quiz = obj(r.quiz);
  out.quiz = { correct: nat(quiz.correct), wrong: nat(quiz.wrong) };
  for (const [id, at] of Object.entries(obj(r.practice))) if (isScenario(id)) out.practice[id] = nat(at);
  for (const [id, v] of Object.entries(obj(r.scenarioStats))) if (isScenario(id)) out.scenarioStats[id] = { tries: nat(obj(v).tries), misses: nat(obj(v).misses) };
  for (const [k, n] of Object.entries(obj(r.mistakes))) if (isTopic(k) && nat(n) > 0) out.mistakes[k] = nat(n);
  const review = obj(r.review);
  out.review = { sessions: nat(review.sessions), best: nat(review.best) };
  const coach = obj(r.coach);
  out.coach = { hands: nat(coach.hands), off: coach.off === true };
  out.onboarded = r.onboarded === true;
  return out;
}

// ------------------------------------------------------------------ merge (two devices / local + server)

const minSet = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b));

/**
 * Combines two copies of the same account's progress. Achievements are unioned
 * (completion keeps the earliest time, steps and counters the larger value);
 * the newer copy decides "last position", settings and open mistakes. A reset
 * on one side discards everything the other side recorded before it.
 */
export function merge(a: Progress, b: Progress): Progress {
  const resetAt = Math.max(a.resetAt, b.resetAt);
  const alive = (p: Progress) => p.updatedAt >= resetAt;
  if (!alive(a)) return b.updatedAt >= resetAt ? { ...b, resetAt } : { ...emptyProgress(), resetAt, updatedAt: resetAt, onboarded: a.onboarded || b.onboarded };
  if (!alive(b)) return { ...a, resetAt };
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const out: Progress = { ...newer, resetAt, updatedAt: Math.max(a.updatedAt, b.updatedAt), lessons: {}, practice: {}, scenarioStats: {} };
  for (const id of LESSON_IDS) {
    const x = a.lessons[id];
    const y = b.lessons[id];
    if (!x && !y) continue;
    out.lessons[id] = {
      startedAt: minSet(x?.startedAt || null, y?.startedAt || null) ?? 0,
      completedAt: minSet(x?.completedAt, y?.completedAt),
      step: Math.max(x?.step ?? 0, y?.step ?? 0),
    };
  }
  for (const id of SCENARIO_IDS) {
    const at = minSet(a.practice[id], b.practice[id]);
    if (at !== null) out.practice[id] = at;
    const sa = a.scenarioStats[id];
    const sb = b.scenarioStats[id];
    if (sa || sb) out.scenarioStats[id] = { tries: Math.max(sa?.tries ?? 0, sb?.tries ?? 0), misses: Math.max(sa?.misses ?? 0, sb?.misses ?? 0) };
  }
  out.quiz = { correct: Math.max(a.quiz.correct, b.quiz.correct), wrong: Math.max(a.quiz.wrong, b.quiz.wrong) };
  out.review = { sessions: Math.max(a.review.sessions, b.review.sessions), best: Math.max(a.review.best, b.review.best) };
  out.coach = { hands: Math.max(a.coach.hands, b.coach.hands), off: newer.coach.off };
  out.onboarded = a.onboarded || b.onboarded;
  return out;
}

export function sameProgress(a: Progress, b: Progress): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

/** Counts an answer; a wrong one adds an open mistake on its topic, a right one pays one back. */
export function recordAnswer(p: Progress, correct: boolean, topic?: Topic): Progress {
  const mistakes = { ...p.mistakes };
  if (topic) {
    const n = (mistakes[topic] ?? 0) + (correct ? -1 : 1);
    if (n > 0) mistakes[topic] = n;
    else delete mistakes[topic];
  }
  return { ...p, mistakes, quiz: { correct: p.quiz.correct + (correct ? 1 : 0), wrong: p.quiz.wrong + (correct ? 0 : 1) } };
}

export function startScenario(p: Progress, id: ScenarioId): Progress {
  const s = p.scenarioStats[id] ?? { tries: 0, misses: 0 };
  return { ...p, onboarded: true, scenarioStats: { ...p.scenarioStats, [id]: { ...s, tries: s.tries + 1 } } };
}

export function missScenario(p: Progress, id: ScenarioId, topic: Topic): Progress {
  const s = p.scenarioStats[id] ?? { tries: 0, misses: 0 };
  return recordAnswer({ ...p, scenarioStats: { ...p.scenarioStats, [id]: { ...s, misses: s.misses + 1 } } }, false, topic);
}

export function completeScenario(p: Progress, id: ScenarioId, now: number): Progress {
  const next: Progress = { ...p, onboarded: true, practice: { ...p.practice, [id]: p.practice[id] ?? now } };
  return SCENARIO_IDS.every((s) => next.practice[s]) ? completeLesson(next, 'practice', now) : next;
}

export function finishReview(p: Progress, score: number): Progress {
  return { ...p, review: { sessions: p.review.sessions + 1, best: Math.max(p.review.best, score) } };
}

export function lessonsDone(p: Progress): number {
  return LESSON_IDS.filter((id) => isDone(p, id)).length;
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

/** Topics with open mistakes, most-missed first. */
export function weakTopics(p: Progress): { topic: Topic; count: number }[] {
  return (Object.entries(p.mistakes) as [Topic, number][]).filter(([, n]) => n > 0).map(([topic, count]) => ({ topic, count })).sort((x, y) => y.count - x.count);
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
const changeHooks = new Set<(userId: string, p: Progress) => void>();
const kv = (): KV | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function getProgress(userId: string): Progress {
  let p = memory.get(userId);
  if (!p) {
    const s = kv();
    p = s ? load(s, userId) : emptyProgress();
    memory.set(userId, p);
  }
  return p;
}

function put(userId: string, next: Progress, notify: boolean) {
  memory.set(userId, next);
  const s = kv();
  if (s) save(s, userId, next);
  for (const l of listeners) l();
  if (notify) for (const h of changeHooks) h(userId, next);
}

/** Local change: stamps updatedAt and schedules a server push. */
export function updateProgress(userId: string, fn: (p: Progress) => Progress) {
  const cur = getProgress(userId);
  put(userId, { ...fn(cur), updatedAt: Math.max(Date.now(), cur.updatedAt + 1) }, true);
}

/** Replaces the stored copy without stamping (used by the sync after a merge). */
export function replaceProgress(userId: string, p: Progress) {
  put(userId, p, false);
}

export function onProgressChange(hook: (userId: string, p: Progress) => void) {
  changeHooks.add(hook);
  return () => changeHooks.delete(hook);
}

export function resetProgress(userId: string) {
  const now = Date.now();
  updateProgress(userId, (p) => ({ ...emptyProgress(), onboarded: p.onboarded, coach: p.coach, resetAt: now }));
}

const GUEST = 'guest';
export function useProgress(userId: string | null | undefined): Progress {
  const id = userId ?? GUEST;
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getProgress(id),
  );
}
