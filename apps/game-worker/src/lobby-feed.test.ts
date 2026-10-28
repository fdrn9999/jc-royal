// A table room's lobby feed (lobby-feed.ts): the counts at most once a second, as they last were, never the same ones
// twice; and the members whose own place moved.
import type { LobbyLivePatch } from '@jc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOBBY_PUSH_MS, LobbyFeed, placesMoved, placesOf } from './lobby-feed';

const patch = (rev: number, over: Partial<LobbyLivePatch> = {}): LobbyLivePatch => ({ id: 't1', rev, seated: 2, bots: 0, playing: true, waitlist: 0, spectators: 0, status: 'open', ...over });

describe('LobbyFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the first change at once, a burst after it once with its last counts', () => {
    const sent: LobbyLivePatch[] = [];
    const feed = new LobbyFeed((p) => sent.push(p), () => Date.now());
    feed.push(patch(1));
    expect(sent.map((p) => p.rev)).toEqual([1]);
    feed.push(patch(2, { playing: false }));
    feed.push(patch(3, { seated: 3 }));
    feed.push(patch(4, { seated: 3, spectators: 1 }));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(LOBBY_PUSH_MS);
    expect(sent.map((p) => p.rev)).toEqual([1, 4]);
    expect(sent[1]).toMatchObject({ seated: 3, spectators: 1, playing: true });
  });

  it('never sends the counts it sent last again, whatever the revision', () => {
    const sent: LobbyLivePatch[] = [];
    const feed = new LobbyFeed((p) => sent.push(p), () => Date.now());
    feed.push(patch(1));
    // The hand ended and the next was dealt within the second: the lobby sees no change.
    feed.push(patch(2, { playing: false }));
    feed.push(patch(3));
    vi.advanceTimersByTime(LOBBY_PUSH_MS);
    expect(sent.map((p) => p.rev)).toEqual([1]);
    vi.advanceTimersByTime(5 * LOBBY_PUSH_MS);
    feed.push(patch(4));
    expect(sent.map((p) => p.rev)).toEqual([1]);
    feed.push(patch(5, { waitlist: 1 }));
    expect(sent.map((p) => p.rev)).toEqual([1, 5]);
  });

  it('after a quiet second sends at once again', () => {
    const sent: LobbyLivePatch[] = [];
    const feed = new LobbyFeed((p) => sent.push(p), () => Date.now());
    feed.push(patch(1));
    vi.advanceTimersByTime(LOBBY_PUSH_MS + 1);
    feed.push(patch(2, { seated: 1 }));
    expect(sent.map((p) => p.rev)).toEqual([1, 2]);
  });
});

describe('placesOf / placesMoved', () => {
  it('names who sat, stood up, joined, left or moved up the waitlist, and nobody else', () => {
    const before = placesOf(['a', 'b'], ['c', 'd', 'e']);
    // b stood up, c took the seat, d and e moved up, f joined.
    const after = placesOf(['a', 'c'], ['d', 'e', 'f']);
    expect(placesMoved(before, after).sort()).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(placesMoved(after, after)).toEqual([]);
  });

  it('a seat outranks a stale waitlist entry for the same member', () => {
    expect(placesOf(['a'], ['a']).get('a')).toBe('s');
  });
});
