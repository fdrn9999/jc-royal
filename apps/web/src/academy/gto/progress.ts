/**
 * Advanced GTO Academy progress: its own store (`jc.academy.gto:<userId>` here, academy_gto_progress on the server),
 * apart from the beginner course's, so neither course's records can overwrite or drop the other's. It follows the same
 * rules as ../progress.ts: a versioned payload that `migrate` turns into a valid current one whatever it is given,
 * a merge that keeps every achievement from both devices, and a reset that discards what came before it. It is
 * study progress only: it never touches the wallet, the ledger, real hands or game statistics.
 */
import { useSyncExternalStore } from 'react';
import { GTO_MODULES, type GtoModuleId } from './types';

export interface GtoModuleProgress {
  startedAt: number;
  completedAt: number | null;
  /** Furthest step reached (0-based). */
  step: number;
}

/** One quiz or hand analysis: how often it was answered right and wrong, and how the latest answer went. */
export interface GtoAnswer {
  correct: number;
  wrong: number;
  /** The latest answer was right. */
  last: boolean;
  /** When the latest answer was given (ms). */
  at: number;
}

export interface GtoProgress {
  v: 1;
  /** Last local change (ms); the newer copy decides "last position" when two devices merge. */
  updatedAt: number;
  /** Set by "start over"; whatever was recorded before it is discarded on merge. */
  resetAt: number;
  modules: Partial<Record<GtoModuleId, GtoModuleProgress>>;
  last: { module: GtoModuleId; step: number } | null;
  /** By quiz id (quizzes.ts). */
  quiz: Record<string, GtoAnswer>;
  /** By hand-analysis id (hands.ts). */
  hands: Record<string, GtoAnswer>;
}

export const GTO_PROGRESS_VERSION = 1;
export const emptyGtoProgress = (): GtoProgress => ({ v: 1, updatedAt: 0, resetAt: 0, modules: {}, last: null, quiz: {}, hands: {} });

const nat = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const isModule = (x: unknown): x is GtoModuleId => (GTO_MODULES as readonly unknown[]).includes(x);
/** Content ids are short slugs ('f1', 'h-river-catch'); anything else is dropped. */
const ITEM_ID = /^[a-z0-9-]{1,32}$/;
/** More quiz or hand records than this is not something the app writes; the extra ones are dropped. */
const MAX_ITEMS = 200;

/** `UPGRADES[n]` turns a version-n payload into n+1 (none yet). Old saves are upgraded in order, never thrown away. */
const UPGRADES: Record<number, (r: Record<string, unknown>) => Record<string, unknown>> = {};

function answers(raw: unknown): Record<string, GtoAnswer> {
  const out: Record<string, GtoAnswer> = {};
  for (const [id, v] of Object.entries(obj(raw)).slice(0, MAX_ITEMS)) {
    if (!ITEM_ID.test(id)) continue;
    const a = obj(v);
    const correct = nat(a.correct);
    const wrong = nat(a.wrong);
    if (correct + wrong === 0) continue;
    out[id] = { correct, wrong, last: a.last === true, at: nat(a.at) };
  }
  return out;
}

export function migrateGto(raw: unknown): GtoProgress {
  const out = emptyGtoProgress();
  if (!raw || typeof raw !== 'object') return out;
  let r = raw as Record<string, unknown>;
  while (typeof r.v === 'number' && r.v < GTO_PROGRESS_VERSION && UPGRADES[r.v]) r = UPGRADES[r.v]!(r);
  if (r.v !== GTO_PROGRESS_VERSION) return out; // unknown or newer → start fresh rather than crash
  out.updatedAt = nat(r.updatedAt);
  out.resetAt = nat(r.resetAt);
  for (const [id, v] of Object.entries(obj(r.modules))) {
    if (!isModule(id)) continue;
    const m = obj(v);
    out.modules[id] = { startedAt: nat(m.startedAt), completedAt: m.completedAt === null || m.completedAt === undefined ? null : nat(m.completedAt), step: nat(m.step) };
  }
  const last = obj(r.last);
  if (isModule(last.module)) out.last = { module: last.module, step: nat(last.step) };
  out.quiz = answers(r.quiz);
  out.hands = answers(r.hands);
  return out;
}

// ------------------------------------------------------------------ merge (two devices / local + server)

const minSet = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b));

function mergeAnswers(a: Record<string, GtoAnswer>, b: Record<string, GtoAnswer>): Record<string, GtoAnswer> {
  const out: Record<string, GtoAnswer> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!x || !y) {
      out[id] = (x ?? y)!;
      continue;
    }
    // Counters keep the larger side (each device counts all it saw); the latest answer comes from whichever is later.
    const later = x.at >= y.at ? x : y;
    out[id] = { correct: Math.max(x.correct, y.correct), wrong: Math.max(x.wrong, y.wrong), last: later.last, at: later.at };
  }
  return out;
}

/**
 * A copy that has not seen a reset (made elsewhere at `resetAt`), cut down to what it recorded after it: modules
 * started since (or, started before, finished since: from that finish), and answers given since, each counted as
 * just that latest answer, since the counters before it cannot be told apart.
 */
function sinceReset(p: GtoProgress, resetAt: number): GtoProgress {
  if (p.resetAt >= resetAt) return p;
  const modules: GtoProgress['modules'] = {};
  for (const id of GTO_MODULES) {
    const m = p.modules[id];
    if (!m) continue;
    if (m.startedAt >= resetAt) modules[id] = m;
    else if (m.completedAt !== null && m.completedAt >= resetAt) modules[id] = { ...m, startedAt: m.completedAt };
  }
  const latest = (rec: Record<string, GtoAnswer>) => {
    const out: Record<string, GtoAnswer> = {};
    for (const [id, x] of Object.entries(rec)) if (x.at >= resetAt) out[id] = { correct: x.last ? 1 : 0, wrong: x.last ? 0 : 1, last: x.last, at: x.at };
    return out;
  };
  return { ...p, resetAt, modules, quiz: latest(p.quiz), hands: latest(p.hands) };
}

/**
 * Combines two copies of the same account's progress: modules keep the earliest start and completion and the
 * furthest step, answers keep the larger counters and the later latest answer, and the newer copy decides where
 * "continue" goes. A reset on one side discards everything the other side recorded before it, record by record, so a
 * device that missed the reset and kept studying brings only what it did after the reset.
 */
export function mergeGto(a: GtoProgress, b: GtoProgress): GtoProgress {
  const resetAt = Math.max(a.resetAt, b.resetAt);
  const alive = (p: GtoProgress) => p.updatedAt >= resetAt;
  if (!alive(a)) return b.updatedAt >= resetAt ? sinceReset(b, resetAt) : { ...emptyGtoProgress(), resetAt, updatedAt: resetAt };
  if (!alive(b)) return sinceReset(a, resetAt);
  a = sinceReset(a, resetAt);
  b = sinceReset(b, resetAt);
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const out: GtoProgress = { ...newer, resetAt, updatedAt: Math.max(a.updatedAt, b.updatedAt), modules: {} };
  for (const id of GTO_MODULES) {
    const x = a.modules[id];
    const y = b.modules[id];
    if (!x && !y) continue;
    out.modules[id] = {
      startedAt: minSet(x?.startedAt || null, y?.startedAt || null) ?? 0,
      completedAt: minSet(x?.completedAt, y?.completedAt),
      step: Math.max(x?.step ?? 0, y?.step ?? 0),
    };
  }
  out.quiz = mergeAnswers(a.quiz, b.quiz);
  out.hands = mergeAnswers(a.hands, b.hands);
  return out;
}

export const sameGto = (a: GtoProgress, b: GtoProgress) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ pure updates

/** Opening a module's step: the module starts (once), its furthest step grows, and "continue" points here. */
export function visitStep(p: GtoProgress, id: GtoModuleId, step: number, now: number): GtoProgress {
  const cur = p.modules[id];
  // The same step opened again changes nothing: the same object back, so nothing is stored or sent.
  if (cur?.startedAt && cur.step >= step && p.last?.module === id && p.last.step === step) return p;
  return {
    ...p,
    modules: { ...p.modules, [id]: { startedAt: cur?.startedAt || now, completedAt: cur?.completedAt ?? null, step: Math.max(cur?.step ?? 0, step) } },
    last: { module: id, step },
  };
}

export function completeModule(p: GtoProgress, id: GtoModuleId, now: number): GtoProgress {
  const cur = p.modules[id];
  if (cur?.startedAt && cur.completedAt) return p; // finished before: nothing to store
  return { ...p, modules: { ...p.modules, [id]: { startedAt: cur?.startedAt || now, completedAt: cur?.completedAt ?? now, step: cur?.step ?? 0 } } };
}

function answer(rec: Record<string, GtoAnswer>, id: string, correct: boolean, now: number): Record<string, GtoAnswer> {
  const cur = rec[id] ?? { correct: 0, wrong: 0, last: false, at: 0 };
  return { ...rec, [id]: { correct: cur.correct + (correct ? 1 : 0), wrong: cur.wrong + (correct ? 0 : 1), last: correct, at: now } };
}

export const answerQuiz = (p: GtoProgress, id: string, correct: boolean, now: number): GtoProgress => ({ ...p, quiz: answer(p.quiz, id, correct, now) });
export const answerHand = (p: GtoProgress, id: string, correct: boolean, now: number): GtoProgress => ({ ...p, hands: answer(p.hands, id, correct, now) });

// ------------------------------------------------------------------ reading it

export function moduleDone(p: GtoProgress, id: GtoModuleId): boolean {
  const c = p.modules[id]?.completedAt;
  return c !== null && c !== undefined;
}

export const modulesDone = (p: GtoProgress) => GTO_MODULES.filter((id) => moduleDone(p, id)).length;

/** The content the progress is measured against: quiz and hand-analysis ids with their modules. */
export interface GtoCatalog {
  quizzes: readonly { id: string; module: GtoModuleId }[];
  hands: readonly { id: string; module: GtoModuleId }[];
}

/**
 * 0–100, shown with its parts: completed modules count for half, quizzes answered right at least once for 30% and
 * hand analyses answered for 20%. Records of items the catalog no longer has are not counted.
 */
export function gtoPercent(p: GtoProgress, cat: GtoCatalog): number {
  const s = gtoSummary(p, cat);
  const share = (n: number, of: number) => (of ? n / of : 0);
  return Math.round(100 * (0.5 * share(s.modules, GTO_MODULES.length) + 0.3 * share(s.quizzes, cat.quizzes.length) + 0.2 * share(s.hands, cat.hands.length)));
}

export function gtoSummary(p: GtoProgress, cat: GtoCatalog) {
  return {
    modules: modulesDone(p),
    quizzes: cat.quizzes.filter((q) => (p.quiz[q.id]?.correct ?? 0) > 0).length,
    hands: cat.hands.filter((h) => p.hands[h.id]).length,
    answered: Object.values(p.quiz).reduce((n, a) => n + a.correct + a.wrong, 0),
    correct: Object.values(p.quiz).reduce((n, a) => n + a.correct, 0),
  };
}

/** Weak concepts: modules whose latest answer on a quiz or hand analysis was wrong, most such items first. */
export function weakModules(p: GtoProgress, cat: GtoCatalog): { module: GtoModuleId; count: number }[] {
  const n: Partial<Record<GtoModuleId, number>> = {};
  for (const q of cat.quizzes) if (p.quiz[q.id] && !p.quiz[q.id]!.last) n[q.module] = (n[q.module] ?? 0) + 1;
  for (const h of cat.hands) if (p.hands[h.id] && !p.hands[h.id]!.last) n[h.module] = (n[h.module] ?? 0) + 1;
  return GTO_MODULES.filter((m) => n[m]).map((module) => ({ module, count: n[module]! })).sort((x, y) => y.count - x.count);
}

/** Where "continue" goes: the last module if it is not finished, else the first unfinished one. */
export function nextModule(p: GtoProgress): { module: GtoModuleId; step: number } | null {
  if (p.last && !moduleDone(p, p.last.module)) return p.last;
  const id = GTO_MODULES.find((m) => !moduleDone(p, m));
  return id ? { module: id, step: p.modules[id]?.step ?? 0 } : null;
}

// ------------------------------------------------------------------ store

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const gtoStorageKey = (userId: string) => `jc.academy.gto:${userId}`;

export function loadGto(kv: KV, userId: string): GtoProgress {
  try {
    return migrateGto(JSON.parse(kv.getItem(gtoStorageKey(userId)) ?? 'null'));
  } catch {
    return emptyGtoProgress();
  }
}

export function saveGto(kv: KV, userId: string, p: GtoProgress) {
  try {
    kv.setItem(gtoStorageKey(userId), JSON.stringify(p));
  } catch {
    /* storage full / blocked: progress stays in memory */
  }
}

const memory = new Map<string, GtoProgress>();
const listeners = new Set<() => void>();
const changeHooks = new Set<(userId: string, p: GtoProgress) => void>();
const kv = (): KV | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function getGto(userId: string): GtoProgress {
  let p = memory.get(userId);
  if (!p) {
    const s = kv();
    p = s ? loadGto(s, userId) : emptyGtoProgress();
    memory.set(userId, p);
  }
  return p;
}

function put(userId: string, next: GtoProgress, notify: boolean) {
  memory.set(userId, next);
  const s = kv();
  if (s) saveGto(s, userId, next);
  for (const l of listeners) l();
  if (notify) for (const h of changeHooks) h(userId, next);
}

/** Local change: stamps updatedAt and lets the sync push it. */
export function updateGto(userId: string, fn: (p: GtoProgress) => GtoProgress) {
  const cur = getGto(userId);
  const next = fn(cur);
  if (next === cur) return;
  put(userId, { ...next, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) }, true);
}

/** Replaces the stored copy without stamping (the sync, after a merge). */
export function replaceGto(userId: string, p: GtoProgress) {
  put(userId, p, false);
}

export function onGtoChange(hook: (userId: string, p: GtoProgress) => void) {
  changeHooks.add(hook);
  return () => changeHooks.delete(hook);
}

export function resetGto(userId: string) {
  const now = Date.now();
  updateGto(userId, () => ({ ...emptyGtoProgress(), resetAt: now }));
}

export const GUEST = 'guest';
export function useGtoProgress(userId: string | null | undefined): GtoProgress {
  const id = userId ?? GUEST;
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getGto(id),
  );
}
