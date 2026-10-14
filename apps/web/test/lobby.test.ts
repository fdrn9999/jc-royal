import { describe, expect, it } from 'vitest';
import { entryOf, FAV_MAX, latest, parsePrefs, RECENT_MAX, withFav, withVisit } from '../src/lib/lobby';

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

describe('entryOf', () => {
  const tb = { status: 'open' as const, entryBlocked: false, seated: 1, maxSeats: 2 };
  it('offers a seat, the waitlist when full, and nothing when blocked or closing', () => {
    expect(entryOf(tb)).toBe('join');
    expect(entryOf({ ...tb, seated: 2 })).toBe('wait');
    expect(entryOf({ ...tb, seated: 2, entryBlocked: true })).toBe('blocked');
    expect(entryOf({ ...tb, status: 'closed' })).toBe('closing');
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
