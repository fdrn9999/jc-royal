import { describe, expect, it } from 'vitest';
import { entryOf, FAV_MAX, IDLE_AFTER_MS, IDLE_POLL_MS, latest, lobbyPoller, parsePrefs, POLL_MS, RECENT_MAX, withFav, withVisit } from '../src/lib/lobby';

/** A request whose answer the test decides; it rejects like fetch when aborted. */
function deferred<T>() {
  const calls: { signal: AbortSignal; resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  return { calls, load };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('latest', () => {
  it('skips a poll while a request is out, then polls again once it is answered', async () => {
    const d = deferred<number>();
    const got: number[] = [];
    const f = latest(d.load, (v) => got.push(v), () => got.push(-1));
    expect(f.run()).toBe(true);
    expect(f.run()).toBe(false);
    expect(d.calls).toHaveLength(1);
    d.calls[0]!.resolve(1);
    await flush();
    expect(got).toEqual([1]);
    expect(f.run()).toBe(true);
    expect(d.calls).toHaveLength(2);
  });

  it('a refresh replaces the request out, and the older answer is never applied even when it arrives last', async () => {
    const calls: ((v: string) => void)[] = [];
    const got: string[] = [];
    // This loader ignores the abort signal, like a response already on its way.
    const f = latest((_s) => new Promise<string>((r) => calls.push(r)), (v) => got.push(v), () => got.push('error'));
    f.run();
    f.run(true);
    calls[1]!('new');
    await flush();
    calls[0]!('old');
    await flush();
    expect(got).toEqual(['new']);
  });

  it('aborts the replaced request, and its abort is not reported as an error', async () => {
    const d = deferred<string>();
    const got: string[] = [];
    const f = latest(d.load, (v) => got.push(v), () => got.push('error'));
    f.run();
    f.run(true);
    expect(d.calls[0]!.signal.aborted).toBe(true);
    await flush();
    expect(got).toEqual([]);
    d.calls[1]!.reject(new Error('offline'));
    await flush();
    expect(got).toEqual(['error']);
  });

  it('applies nothing after stop', async () => {
    const calls: ((v: string) => void)[] = [];
    const got: string[] = [];
    const f = latest((_s) => new Promise<string>((r) => calls.push(r)), (v) => got.push(v), () => got.push('error'));
    f.run();
    f.stop();
    calls[0]!('late');
    await flush();
    expect(got).toEqual([]);
    expect(f.run()).toBe(false);
  });

  it('records when the last request started', () => {
    let t = 1_000;
    const f = latest(() => new Promise<never>(() => undefined), () => undefined, () => undefined, () => t);
    expect(f.startedAt).toBe(0);
    f.run();
    t = 2_000;
    expect(f.startedAt).toBe(1_000);
  });
});

/**
 * Lobby list requests over `ms` on a fake clock, one second at a time: the page's first request, a tick every POLL_MS,
 * input at the given times and wakes (visibility, focus) at the given times. Requests are answered at once.
 */
function lobbyRequests(ms: number, o: { input?: (t: number) => boolean; wake?: (t: number) => boolean; visible?: (t: number) => boolean } = {}) {
  let t = 0;
  let started = 0;
  const runs: number[] = [];
  const f = {
    run: () => {
      runs.push(t);
      started = t;
      return true;
    },
    get startedAt() {
      return started;
    },
  };
  const p = lobbyPoller(f, () => o.visible?.(t) ?? true, () => t);
  f.run();
  for (t = 1_000; t <= ms; t += 1_000) {
    if (t % POLL_MS === 0) p.tick();
    if (o.wake?.(t)) p.wake();
    if (o.input?.(t)) p.input();
  }
  return runs;
}
const HOUR = 3_600_000;

describe('lobby polling', () => {
  it('a lobby left open with nobody at it asks for the list 130 times an hour instead of 721', () => {
    const runs = lobbyRequests(HOUR);
    // Before: the first request and one every 5 s, used or not.
    const before = 1 + HOUR / POLL_MS;
    expect(before).toBe(721);
    expect(runs).toHaveLength(130);
    // Every 5 s for the first minute, then every 30 s.
    expect(runs.slice(0, 13)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000, 55_000, 85_000]);
    expect(runs.slice(13).every((r, i) => r - runs[12 + i]! === IDLE_POLL_MS)).toBe(true);
  });

  it('a lobby someone is using refreshes every 5 s, as before', () => {
    expect(lobbyRequests(HOUR, { input: (t) => t % 10_000 === 0 })).toHaveLength(721);
    expect(lobbyRequests(HOUR, { input: (t) => t % 50_000 === 0 })).toHaveLength(721);
  });

  it('the first input after a quiet spell brings the list up to date at once, then every 5 s again', () => {
    const at = 10 * 60_000 + 7_000;
    const runs = lobbyRequests(at + 20_000, { input: (t) => t === at });
    const last = runs.filter((r) => r < at).at(-1)!;
    expect(at - last).toBeGreaterThan(POLL_MS);
    // The next tick (3 s later) is too soon after it; the ones after that are 5 s apart.
    expect(runs.filter((r) => r >= at)).toEqual([at, at + 8_000, at + 13_000, at + 18_000]);
  });

  it('coming back to the page refreshes at once and counts as use; a hidden page asks for nothing', () => {
    const back = 20 * 60_000 + 2_000;
    const runs = lobbyRequests(back + IDLE_AFTER_MS, { visible: (t) => t >= back, wake: (t) => t === back });
    expect(runs[0]).toBe(0); // the page's first request
    expect(runs.slice(1)[0]).toBe(back);
    expect(runs.slice(1).every((r) => r >= back)).toBe(true);
    // In use again: every 5 s for the next minute.
    expect(runs.filter((r) => r > back && r < back + IDLE_AFTER_MS - POLL_MS).every((r, i, a) => i === 0 || r - a[i - 1]! === POLL_MS)).toBe(true);
  });
});

describe('entryOf', () => {
  const tb = { status: 'open' as const, entryBlocked: false, seated: 1, maxSeats: 2 };
  it('offers a seat, the waitlist when full, and nothing when blocked or closing', () => {
    expect(entryOf(tb)).toBe('join');
    expect(entryOf({ ...tb, seated: 2 })).toBe('wait');
    expect(entryOf({ ...tb, seated: 2, entryBlocked: true })).toBe('blocked');
    expect(entryOf({ ...tb, status: 'closed' })).toBe('closing');
  });

  it("sends a player back to their own seat before anything the table offers newcomers", () => {
    const mine = { ...tb, myParticipation: { status: 'seated' as const } };
    expect(entryOf(mine)).toBe('continue');
    expect(entryOf({ ...mine, seated: 2 })).toBe('continue');
    expect(entryOf({ ...mine, entryBlocked: true })).toBe('continue');
    expect(entryOf({ ...mine, status: 'closed' })).toBe('continue');
    // No seat, or an older server that says nothing: the usual choices.
    expect(entryOf({ ...tb, seated: 2, myParticipation: { status: 'none' } })).toBe('wait');
    expect(entryOf({ ...tb, myParticipation: undefined })).toBe('join');
  });
});

describe('table prefs', () => {
  it('keeps recent visits newest first, once each, up to the limit', () => {
    let p = parsePrefs(null);
    for (let i = 0; i < RECENT_MAX + 3; i++) p = withVisit(p, `t${i}`, i);
    p = withVisit(p, 't5', 100);
    expect(p.recent[0]).toEqual({ id: 't5', at: 100 });
    expect(p.recent).toHaveLength(RECENT_MAX);
    expect(new Set(p.recent.map((r) => r.id)).size).toBe(RECENT_MAX);
  });

  it('adds and removes favourites without duplicates, up to the limit', () => {
    let p = withFav(withFav(parsePrefs(null), 'a', true), 'a', true);
    expect(p.fav).toEqual(['a']);
    p = withFav(p, 'a', false);
    expect(p.fav).toEqual([]);
    for (let i = 0; i < FAV_MAX + 5; i++) p = withFav(p, `t${i}`, true);
    expect(p.fav).toHaveLength(FAV_MAX);
  });

  it('reads anything unexpected in storage as nothing saved', () => {
    expect(parsePrefs('not json')).toEqual({ fav: [], recent: [] });
    expect(parsePrefs('[1,2]')).toEqual({ fav: [], recent: [] });
    expect(parsePrefs(JSON.stringify({ fav: ['a', 3], recent: [{ id: 'b', at: 1, x: 1 }, { id: 2 }, null] }))).toEqual({ fav: ['a'], recent: [{ id: 'b', at: 1 }] });
  });
});
