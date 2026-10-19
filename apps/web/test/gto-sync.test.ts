import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuiz, emptyGtoProgress, getGto, replaceGto, updateGto } from '../src/academy/gto/progress';
import { startGtoSync } from '../src/academy/gto/sync';

/** The PUT /api/academy/gto/progress rule (apps/api/src/routes/academy.ts): with `base`, compare-and-set. */
function fakeServer(row: { data: Record<string, unknown>; updatedAt: number } | null) {
  const calls: string[] = [];
  const fetch = vi.fn(async (_path: string, init: { method?: string; body?: string }) => {
    calls.push(init.method ?? 'GET');
    if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ data: row?.data ?? null, version: row ? 1 : null, updatedAt: row?.updatedAt ?? null }));
    const b = JSON.parse(init.body!) as { updatedAt: number; data: Record<string, unknown>; base?: number | null };
    const fits = b.base === undefined ? !row || b.updatedAt >= row.updatedAt : b.base === null ? !row : row?.updatedAt === b.base && b.updatedAt > b.base;
    if (b.base === undefined && !fits) return new Response(JSON.stringify({ ok: true })); // the newer updatedAt wins, silently
    if (!fits) return new Response(JSON.stringify({ error: { code: 'conflict', message: 'changed' } }), { status: 409 });
    row = { data: b.data, updatedAt: b.updatedAt };
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, row: () => row, write: (r: typeof row) => (row = r) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GTO progress sync (§32): two devices writing from the same copy', () => {
  it('a push refused because another device wrote first merges that copy in and writes again, dropping nothing', async () => {
    vi.useFakeTimers();
    const uid = 'sync-a';
    replaceGto(uid, emptyGtoProgress());
    const first = { ...answerQuiz(emptyGtoProgress(), 'q1', true, 50), updatedAt: 100 };
    const server = fakeServer({ data: { ...first }, updatedAt: 100 });
    const stop = startGtoSync(uid);
    await vi.advanceTimersByTimeAsync(0);
    expect(getGto(uid).quiz.q1).toBeTruthy();

    // Another device, from the same copy, answers q2 and writes it first.
    server.write({ data: { ...answerQuiz(first, 'q2', true, 150), updatedAt: 200 }, updatedAt: 200 });
    // Here q3 is answered and pushed (debounced) from the copy this device merged with.
    updateGto(uid, (p) => answerQuiz(p, 'q3', false, 250));
    await vi.advanceTimersByTimeAsync(1_600);

    const quiz = (server.row()!.data as { quiz: Record<string, unknown> }).quiz;
    expect(Object.keys(quiz).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(Object.keys(getGto(uid).quiz).sort()).toEqual(['q1', 'q2', 'q3']);
    // GET on start, the refused PUT, the GET of the newer copy and the PUT over it.
    expect(server.calls.slice(-3)).toEqual(['PUT', 'GET', 'PUT']);
    expect(server.calls.filter((c) => c === 'PUT')).toHaveLength(2);
    stop();
  });

  it('with nothing in between, one push and no extra request; the next push builds on the copy it wrote', async () => {
    vi.useFakeTimers();
    const uid = 'sync-b';
    replaceGto(uid, emptyGtoProgress());
    const server = fakeServer(null);
    const stop = startGtoSync(uid);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toEqual(['GET']); // nothing here and nothing there: nothing to send
    updateGto(uid, (p) => answerQuiz(p, 'q1', true, 10));
    await vi.advanceTimersByTimeAsync(1_600);
    updateGto(uid, (p) => answerQuiz(p, 'q2', true, 20));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(server.calls).toEqual(['GET', 'PUT', 'PUT']);
    expect(Object.keys((server.row()!.data as { quiz: Record<string, unknown> }).quiz).sort()).toEqual(['q1', 'q2']);
    stop();
  });
});
