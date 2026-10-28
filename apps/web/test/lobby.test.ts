import { describe, expect, it } from 'vitest';
import type { LobbyLivePatch, LobbyTableDto, PublicLobbyTable } from '@jc/types';
import { arrivalOf, entryOf, FAV_MAX, IDLE_AFTER_MS, IDLE_POLL_MS, latest, LIVE_POLL_MS, lobbyPoller, mergeList, newLobbyLive, parsePrefs, POLL_MS, RECENT_MAX, RESUME, RESUME_WAIT, resumeOf, seatHeld, withCard, withCounts, withFav, withVisit } from '../src/lib/lobby';

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
function lobbyRequests(ms: number, o: { input?: (t: number) => boolean; wake?: (t: number) => boolean; visible?: (t: number) => boolean; live?: (t: number) => boolean } = {}) {
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
  const p = lobbyPoller(f, () => o.visible?.(t) ?? true, () => t, () => o.live?.(t) ?? false);
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

  it('while the realtime socket brings the changes, a lobby in use reads the list once a minute', () => {
    const runs = lobbyRequests(HOUR, { input: (t) => t % 10_000 === 0, live: () => true });
    expect(runs).toHaveLength(1 + HOUR / LIVE_POLL_MS);
    expect(runs.slice(1).every((r, i) => r - runs[i]! === LIVE_POLL_MS)).toBe(true);
    // Switching tabs back and forth does not read it again within IDLE_POLL_MS.
    const tabs = lobbyRequests(10 * 60_000, { live: () => true, wake: (t) => t % 7_000 === 0 });
    expect(tabs.slice(1).every((r, i) => r - tabs[i]! >= IDLE_POLL_MS)).toBe(true);
  });

  it('the socket going down brings back the usual polling', () => {
    const down = 5 * 60_000;
    const runs = lobbyRequests(down + 30_000, { input: (t) => t % 10_000 === 0, live: (t) => t < down });
    expect(runs.filter((r) => r < down)).toHaveLength(5);
    // The first tick after it went down is due already (the last read was a minute ago); every 5 s from then.
    expect(runs.filter((r) => r >= down)).toEqual([down, down + 5_000, down + 10_000, down + 15_000, down + 20_000, down + 25_000, down + 30_000]);
  });
});

describe('lobby realtime merge', () => {
  const row = (id: string, o: Partial<LobbyTableDto> = {}): LobbyTableDto => ({
    id,
    name: id,
    roomType: 'official',
    host: null,
    maxSeats: 6,
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 100,
    maxBuyIn: 1000,
    isPrivate: false,
    allowSpectators: true,
    beginner: false,
    entryBlocked: false,
    status: 'open',
    seated: 1,
    bots: 0,
    botLevel: null,
    playing: false,
    waitlist: 0,
    spectators: 0,
    myParticipation: { status: 'none' },
    liveRev: 100,
    rev: 50,
    ...o,
  });
  const patch = (id: string, rev: number, o: Partial<LobbyLivePatch> = {}): LobbyLivePatch => ({ id, rev, seated: 1, bots: 0, playing: false, waitlist: 0, spectators: 0, status: 'open', ...o });
  const card = (id: string, o: Partial<LobbyTableDto> = {}): PublicLobbyTable => {
    const { myParticipation: _, ...c } = row(id, o);
    return c;
  };

  it('takes newer counts and keeps the older ones from overwriting them', () => {
    const t = row('a');
    expect(withCounts(t, patch('a', 101, { seated: 3, playing: true }))).toMatchObject({ seated: 3, playing: true, liveRev: 101 });
    expect(withCounts(t, patch('a', 100, { seated: 3 }))).toBe(t);
    expect(withCounts(t, patch('a', 99, { seated: 3 }))).toBe(t);
  });

  it('keeps my own place when a card arrives, and drops a waitlist place when the table stops taking players', () => {
    const waiting = row('a', { seated: 6, myParticipation: { status: 'waiting', position: 2 } });
    expect(withCard(waiting, card('a', { rev: 51, name: 'renamed' })).myParticipation).toEqual({ status: 'waiting', position: 2 });
    expect(withCard(waiting, card('a', { rev: 51, status: 'closed' })).myParticipation).toEqual({ status: 'none' });
    expect(withCounts(waiting, patch('a', 101, { status: 'closed' })).myParticipation).toEqual({ status: 'none' });
    // A seat survives closing: the player is cashed out by the room, then the table leaves the list.
    const seated = row('a', { myParticipation: { status: 'seated' } });
    expect(withCounts(seated, patch('a', 101, { status: 'closed' })).myParticipation).toEqual({ status: 'seated' });
    // A table new to the page: nobody's place is in an event, so none until it is read.
    expect(withCard(undefined, card('b')).myParticipation).toEqual({ status: 'none' });
  });

  it('a card takes the newer settings and the newer counts each on its own', () => {
    const t = row('a', { rev: 50, liveRev: 200, seated: 4 });
    const merged = withCard(t, card('a', { rev: 60, liveRev: 150, seated: 2, name: 'renamed' }));
    expect(merged).toMatchObject({ name: 'renamed', rev: 60, seated: 4, liveRev: 200 });
    const older = withCard(t, card('a', { rev: 40, liveRev: 250, seated: 5, name: 'old' }));
    expect(older).toMatchObject({ name: 'a', rev: 50, seated: 5, liveRev: 250 });
  });

  it('a list read that started before an event never shows the older state', () => {
    const live = newLobbyLive();
    live.patches.set('a', patch('a', 150, { seated: 5 }));
    live.cards.set('a', { card: card('a', { rev: 70, name: 'renamed' }), at: 2_000 });
    // The read started at 1 000 (before both), and arrived after them.
    const [a] = mergeList([row('a')], 1_000, live, true);
    expect(a).toMatchObject({ seated: 5, name: 'renamed' });
    // A later read that has caught up: the events are forgotten and the read is shown as it is.
    const [b] = mergeList([row('a', { liveRev: 160, rev: 70, seated: 2, name: 'renamed' })], 3_000, live, true);
    expect(b).toMatchObject({ seated: 2, name: 'renamed' });
    expect(live.patches.size + live.cards.size).toBe(0);
  });

  it('adds a table that opened after the read began, drops one that closed, and orders them as the API', () => {
    const live = newLobbyLive();
    live.cards.set('m', { card: card('m', { roomType: 'member', bigBlind: 2 }), at: 2_000 });
    live.cards.set('b', { card: card('b', { bigBlind: 20 }), at: 2_000 });
    live.gone.add('c');
    const ids = (l: LobbyTableDto[]) => l.map((t) => t.id);
    expect(ids(mergeList([row('a'), row('c')], 1_000, live))).toEqual(['a', 'b', 'm']);
    // A read that began after `b` opened and does not have it: `b` closed meanwhile.
    expect(ids(mergeList([row('a')], 3_000, live, true))).toEqual(['a']);
    expect(live.cards.size).toBe(0);
  });

  it('my place from a fresh read of one table holds until a list read that began after it', () => {
    const live = newLobbyLive();
    live.mine.set('a', { p: { status: 'seated' }, at: 2_000 });
    expect(mergeList([row('a')], 1_000, live)[0]!.myParticipation).toEqual({ status: 'seated' });
    expect(mergeList([row('a', { myParticipation: { status: 'none' } })], 2_500, live)[0]!.myParticipation).toEqual({ status: 'none' });
    expect(live.mine.size).toBe(0);
  });

  it('counts for a table not listed wait for its card, and are forgotten by the next read', () => {
    const live = newLobbyLive();
    live.patches.set('n', patch('n', 5, { seated: 2 }));
    expect(mergeList([row('a')], 1_000, live)).toHaveLength(1);
    live.cards.set('n', { card: card('n', { liveRev: 0, seated: 0 }), at: 2_000 });
    expect(mergeList([row('a')], 1_000, live).find((t) => t.id === 'n')).toMatchObject({ seated: 2, liveRev: 5 });
    live.cards.clear();
    mergeList([row('a')], 3_000, live, true);
    expect(live.patches.size).toBe(0);
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

  it('a place on the waitlist is a look at it, never a second sign-up, while the table is open', () => {
    const waiting = { ...tb, seated: 2, myParticipation: { status: 'waiting' as const, position: 2 } };
    expect(entryOf(waiting)).toBe('waiting');
    // A free seat or stopped entries do not hide the place I already have.
    expect(entryOf({ ...waiting, seated: 1 })).toBe('waiting');
    expect(entryOf({ ...waiting, entryBlocked: true })).toBe('waiting');
    // A closing table drops its waitlist.
    expect(entryOf({ ...waiting, status: 'closed' })).toBe('closing');
  });
});

describe('resumeOf', () => {
  it('reads only the marks the lobby sets', () => {
    expect(resumeOf(RESUME)).toBe('seat');
    expect(resumeOf(RESUME_WAIT)).toBe('wait');
    expect(resumeOf(null)).toBeNull();
    expect(resumeOf({ resume: true })).toBeNull();
    expect(resumeOf('seat')).toBeNull();
  });
});

describe('arrivalOf', () => {
  const you = { seatIndex: null, inWaitlist: false, canSit: true, needsCode: false };
  const view = (over: Record<string, unknown> = {}, me: Partial<typeof you> = {}) =>
    ({ status: 'waiting', maintenance: null, reservation: null, waitlist: [], tournament: null, ...over, you: { ...you, ...me } }) as unknown as Parameters<typeof arrivalOf>[0];

  it('says nothing when there is a seat to take, or the join code comes first', () => {
    expect(arrivalOf(view(), true)).toBeNull();
    expect(arrivalOf(view({}, { canSit: false, needsCode: true }), false)).toBeNull();
  });

  it('a seat or a place on the waitlist I already have comes before anything else', () => {
    expect(arrivalOf(view({ status: 'closing' }, { seatIndex: 3, canSit: false }), false)).toBe('seated');
    expect(arrivalOf(view({ waitlist: ['a', 'me'] }, { inWaitlist: true, canSit: false }), true)).toBe('waiting');
  });

  it('tells a closing table, maintenance, a full table and a seat kept for others apart', () => {
    expect(arrivalOf(view({ status: 'closing' }, { canSit: false }), true)).toBe('closing');
    expect(arrivalOf(view({ maintenance: { startsAt: 0, endsAt: 1, active: true } }, { canSit: false }), true)).toBe('maintenance');
    expect(arrivalOf(view({}, { canSit: false }), false)).toBe('full');
    expect(arrivalOf(view({ reservation: { nickname: 'a', until: 1 } }, { canSit: false }), true)).toBe('held');
    expect(arrivalOf(view({ waitlist: ['a'] }, { canSit: false }), true)).toBe('held');
    // A free seat the room still refuses for another reason (entries stopped): no guess at which.
    expect(arrivalOf(view({}, { canSit: false }), true)).toBe('unavailable');
  });

  it('a seat is kept for others only while it is free and I may not take it', () => {
    expect(seatHeld(view({ waitlist: ['a'] }, { canSit: false }), true)).toBe(true);
    expect(seatHeld(view({ waitlist: ['a'] }, { canSit: false }), false)).toBe(false);
    expect(seatHeld(view({ reservation: { nickname: 'me', until: 1 } }), true)).toBe(false);
    expect(seatHeld(view({ waitlist: ['a'] }, { canSit: false, seatIndex: 1 }), true)).toBe(false);
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
