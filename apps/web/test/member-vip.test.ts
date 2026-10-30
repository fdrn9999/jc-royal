// Other members' VIP colors on open screens (src/lib/memberVip.ts): an administrator's change arrives as the member's id
// and the color others see; a screen lays it over what it holds for that member only, keeps the newest by the member's
// VIP version, and a read that started before the change cannot take it back.
import type { FriendsDto, PostPageDto } from '@jc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMemberVip, withHeardVip, withMemberVip } from '../src/lib/memberVip';
import { startRealtime, stopRealtime } from '../src/lib/realtime';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {}
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const socket = () => FakeSocket.all[FakeSocket.all.length - 1]!;
let n = 0;
const vipEvent = (id: string, revision: number, vip: string | null) => socket().frame({ t: 'event', e: { type: 'member.vip.changed', scope: 'service', eventId: `e${++n}`, occurredAt: Date.now(), resourceId: id, revision, payload: { vip } } });
let off: () => void = () => {};

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
  startRealtime('me', () => {});
  socket().readyState = FakeSocket.OPEN;
  socket().frame({ t: 'hello', v: 1 });
});

afterEach(() => {
  off();
  stopRealtime();
  vi.unstubAllGlobals();
});

const friends = (): FriendsDto => ({
  friends: [{ id: 'f1', nickname: 'Ann', avatarUrl: null, since: 1 } as FriendsDto['friends'][number], { id: 'f2', nickname: 'Bo', avatarUrl: null, vip: 'gold', since: 1 } as FriendsDto['friends'][number]],
  incoming: [],
  outgoing: [],
});

describe('withMemberVip', () => {
  it('sets or removes the color on that member only, wherever the data holds them', () => {
    const d = friends();
    const set = withMemberVip(d, 'f1', 'rose');
    expect(set.friends[0]!.vip).toBe('rose');
    expect(set.friends[1]).toBe(d.friends[1]);
    const gone = withMemberVip(d, 'f2', undefined);
    expect('vip' in gone.friends[1]!).toBe(false);
    // a post page: the notice's and the posts' authors
    const page = { notices: [], posts: [{ id: 'p1', title: 't', author: { id: 'f1', nickname: 'Ann', avatarUrl: null, isAdmin: false } }], total: 1, pageSize: 20 } as unknown as PostPageDto;
    expect(withMemberVip(page, 'f1', 'cyan').posts[0]!.author.vip).toBe('cyan');
  });

  it('gives back the same data when it holds nobody it changes, so the screen does not redraw', () => {
    const d = friends();
    expect(withMemberVip(d, 'someone-else', 'gold')).toBe(d);
    expect(withMemberVip(d, 'f2', 'gold')).toBe(d);
    // a post's id is not a member's: only an object with a nickname is one
    const post = { id: 'f1', title: 'not a member' };
    expect(withMemberVip(post, 'f1', 'gold')).toBe(post);
  });
});

describe('member.vip.changed', () => {
  it('reaches the screens listening, once, and an older or repeated version changes nothing', () => {
    const got: [string, string | undefined][] = [];
    off = onMemberVip((id, vip) => got.push([id, vip]));
    vipEvent('m1', 3, 'gold');
    vipEvent('m1', 3, 'gold');
    vipEvent('m1', 2, 'rose');
    vipEvent('m1', 4, null);
    expect(got).toEqual([['m1', 'gold'], ['m1', undefined]]);
  });

  it('a read that started before a change has it laid over; one that started after is left as it is', () => {
    off = onMemberVip(() => {});
    const before = Date.now() - 1_000;
    vipEvent('f1', 7, 'emerald');
    expect(withHeardVip(friends(), before).friends[0]!.vip).toBe('emerald');
    const after = Date.now() + 1_000;
    const d = friends();
    expect(withHeardVip(d, after)).toBe(d);
  });

  it('an event that is not well formed is not applied', () => {
    const got: string[] = [];
    off = onMemberVip((id) => got.push(id));
    socket().frame({ t: 'event', e: { type: 'member.vip.changed', scope: 'service', eventId: 'bad1', occurredAt: 1, resourceId: 'm2', revision: 1, payload: { vip: 'not-a-color' } } });
    socket().frame({ t: 'event', e: { type: 'member.vip.changed', scope: 'user', eventId: 'bad2', occurredAt: 1, resourceId: 'm2', revision: 1, payload: { vip: 'gold' } } });
    expect(got).toEqual([]);
  });
});
