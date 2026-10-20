// Friends' status (presence-book.ts, @jc/types mergePresence): what friends see from a member's devices, by the hub's
// clock only. The api applies modes and decides who may ask (routes/presence.ts, tests/integration/presence.test.ts).
import { mergePresence, PRESENCE_AWAY_MS, PRESENCE_EXPIRE_MS, PRESENCE_MAX_DEVICES } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { HUB_BEATS_PER_MIN, HUB_QUERIES_PER_MIN, HUB_QUERY_MAX, parseBeat, PresenceBook, type Beat } from './presence-book';

const T0 = 1_800_000_000_000;
const beat = (over: Partial<Beat> = {}): Beat => ({ user: 'u1', session: 's1', conn: 'c1-device', idleMs: 0, visible: true, view: null, ...over });

describe('mergePresence', () => {
  const live = (activeAgo: number, now = T0) => ({ expiresAt: now + 1, activeAt: now - activeAgo });

  it('is online while a device was active within five minutes, away from five minutes on', () => {
    expect(mergePresence('auto', [live(PRESENCE_AWAY_MS - 1)], T0)).toBe('online');
    expect(mergePresence('auto', [live(PRESENCE_AWAY_MS)], T0)).toBe('away');
  });

  it('merges devices: any active is online, all idle is away, none live is offline', () => {
    expect(mergePresence('auto', [live(PRESENCE_AWAY_MS * 3), live(1_000)], T0)).toBe('online');
    expect(mergePresence('auto', [live(PRESENCE_AWAY_MS * 3), live(PRESENCE_AWAY_MS)], T0)).toBe('away');
    expect(mergePresence('auto', [], T0)).toBe('offline');
    // An expired device counts for nothing, however recently it was active.
    expect(mergePresence('auto', [{ expiresAt: T0, activeAt: T0 }], T0)).toBe('offline');
  });

  it('invisible is offline whatever the devices do; away is away while any device is live', () => {
    expect(mergePresence('invisible', [live(0)], T0)).toBe('offline');
    expect(mergePresence('away', [live(0)], T0)).toBe('away');
    expect(mergePresence('away', [], T0)).toBe('offline');
  });
});

describe('PresenceBook', () => {
  it('a beat makes the member online until it expires (about three missed beats), whatever interval the device claims', () => {
    const b = new PresenceBook();
    expect(b.stateOf('u1', T0)).toBe('offline');
    expect(b.beat(T0, beat())).toBe('online');
    expect(b.stateOf('u1', T0 + PRESENCE_EXPIRE_MS - 1)).toBe('online');
    // The hub sets the expiry from its own clock: no field of a beat can make it last longer.
    expect(b.stateOf('u1', T0 + PRESENCE_EXPIRE_MS)).toBe('offline');
  });

  it('turns away after five minutes without activity, by the idle time the device reports', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ idleMs: PRESENCE_AWAY_MS - 30_000 }));
    expect(b.stateOf('u1', T0)).toBe('online');
    expect(b.stateOf('u1', T0 + 30_000)).toBe('away');
    // Activity again (a key, a click, a game action) brings the member back on the next beat.
    expect(b.beat(T0 + 30_000, beat({ idleMs: 0 }))).toBe('online');
  });

  it('keeps each device apart: one active device keeps the member online while another idles', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ conn: 'phone-0001', idleMs: PRESENCE_AWAY_MS * 2 }));
    expect(b.stateOf('u1', T0)).toBe('away');
    b.beat(T0, beat({ conn: 'laptop-001', session: 's2', idleMs: 0 }));
    expect(b.stateOf('u1', T0)).toBe('online');
    // The active one closes without a leave: once it expires the idle one decides alone.
    b.beat(T0 + 60_000, beat({ conn: 'phone-0001', idleMs: PRESENCE_AWAY_MS * 2 }));
    expect(b.stateOf('u1', T0 + PRESENCE_EXPIRE_MS + 1)).toBe('away');
  });

  it('the same device id under another sign-in is another device', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ session: 's1' }));
    b.beat(T0, beat({ session: 's2' }));
    b.leave(T0, { user: 'u1', session: 's1', conn: 'c1-device' });
    expect(b.stateOf('u1', T0)).toBe('online');
    b.leave(T0, { user: 'u1', session: 's2', conn: 'c1-device' });
    expect(b.stateOf('u1', T0)).toBe('offline');
  });

  it('a sign-out removes that sign-in only; a password change every other; an account-wide one all', () => {
    const b = new PresenceBook();
    for (const s of ['s1', 's2', 's3']) b.beat(T0, beat({ session: s, conn: `dev-${s}-01` }));
    b.leave(T0, { user: 'u1', session: 's1' });
    expect(b.size(T0)).toBe(2);
    b.leave(T0, { user: 'u1', except: 's2' });
    expect(b.size(T0)).toBe(1);
    expect(b.stateOf('u1', T0)).toBe('online');
    b.leave(T0, { user: 'u1' });
    expect(b.stateOf('u1', T0)).toBe('offline');
    // Leaving a member with no devices is harmless.
    b.leave(T0, { user: 'nobody' });
  });

  it('keeps at most PRESENCE_MAX_DEVICES devices per member, forgetting the one heard from longest ago', () => {
    const b = new PresenceBook();
    for (let i = 0; i <= PRESENCE_MAX_DEVICES; i++) b.beat(T0 + i, beat({ conn: `device-${String(i).padStart(3, '0')}` }));
    expect(b.size(T0 + 100)).toBe(PRESENCE_MAX_DEVICES);
    b.leave(T0, { user: 'u1', session: 's1', conn: 'device-000' });
    expect(b.size(T0 + 100)).toBe(PRESENCE_MAX_DEVICES);
  });

  it('limits beats per member a minute; the limit lifts with the next minute', () => {
    const b = new PresenceBook();
    for (let i = 0; i < HUB_BEATS_PER_MIN; i++) expect(b.beat(T0 + i, beat())).toBe('online');
    expect(b.beat(T0 + HUB_BEATS_PER_MIN, beat())).toBeNull();
    // Another member is not affected.
    expect(b.beat(T0 + HUB_BEATS_PER_MIN, beat({ user: 'u2' }))).toBe('online');
    expect(b.beat(T0 + 60_000, beat())).toBe('online');
  });

  it('answers questions about the named members only, and limits questions per asker', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ user: 'friend' }));
    expect(b.query(T0, 'me', ['friend', 'stranger'])).toEqual({ friend: 'online', stranger: 'offline' });
    for (let i = 1; i < HUB_QUERIES_PER_MIN; i++) expect(b.query(T0 + i, 'me', ['friend'])).not.toBeNull();
    expect(b.query(T0 + 100, 'me', ['friend'])).toBeNull();
    expect(b.query(T0 + 100, 'other', ['friend'])).toEqual({ friend: 'online' });
    // A question naming too many members is cut, never answered in full.
    const many = Array.from({ length: HUB_QUERY_MAX + 5 }, (_, i) => `m${i}`);
    expect(Object.keys(b.query(T0 + 60_000, 'big', many)!)).toHaveLength(HUB_QUERY_MAX);
  });

  it('tells what a visible, live page shows (a conversation open), and nothing for a hidden or expired one', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ view: 'dm:friend-1' }));
    expect(b.viewing(T0, 'u1', 'dm:friend-1')).toBe(true);
    expect(b.viewing(T0, 'u1', 'dm:friend-2')).toBe(false);
    b.beat(T0 + 1, beat({ view: 'dm:friend-1', visible: false }));
    expect(b.viewing(T0 + 1, 'u1', 'dm:friend-1')).toBe(false);
    b.beat(T0 + 2, beat({ view: 'dm:friend-1' }));
    expect(b.viewing(T0 + 2 + PRESENCE_EXPIRE_MS, 'u1', 'dm:friend-1')).toBe(false);
  });

  it('a visible page on the conversation whose member is away from it (no activity for five minutes) is not viewing', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ view: 'dm:friend-1', idleMs: PRESENCE_AWAY_MS - 1_000 }));
    expect(b.viewing(T0, 'u1', 'dm:friend-1')).toBe(true);
    // Still beating (the page is open and visible), but nothing done there since: their pushes go out again.
    b.beat(T0 + 1_000, beat({ view: 'dm:friend-1', idleMs: PRESENCE_AWAY_MS + 1_000 }));
    expect(b.viewing(T0 + 1_000, 'u1', 'dm:friend-1')).toBe(false);
    // The member moves the mouse there again.
    b.beat(T0 + 2_000, beat({ view: 'dm:friend-1', idleMs: 0 }));
    expect(b.viewing(T0 + 2_000, 'u1', 'dm:friend-1')).toBe(true);
    // Left idle on the desk while the member reads it on the phone: the phone counts.
    b.beat(T0 + 3_000, beat({ view: 'dm:friend-1', idleMs: PRESENCE_AWAY_MS * 2 }));
    b.beat(T0 + 3_000, beat({ conn: 'c2-phone', view: 'dm:friend-1', idleMs: 0 }));
    expect(b.viewing(T0 + 3_000, 'u1', 'dm:friend-1')).toBe(true);
  });

  it('shows a device no longer than its sign-in lasts, and records nothing for a sign-in that has run out', () => {
    const b = new PresenceBook();
    expect(b.beat(T0, beat({ until: T0 + 10_000 }))).toBe('online');
    expect(b.stateOf('u1', T0 + 9_999)).toBe('online');
    expect(b.stateOf('u1', T0 + 10_000)).toBe('offline');
    expect(b.beat(T0 + 20_000, beat({ until: T0 + 20_000 }))).toBe('offline');
    expect(b.size(T0 + 20_000)).toBe(0);
  });

  it('a beat of a signed-out sign-in that arrives after the sign-out is not recorded', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.leave(T0 + 1, { user: 'u1', session: 's1' });
    // Let through by the api just before the sign-out, it reaches the hub just after.
    expect(b.beat(T0 + 2, beat())).toBe('offline');
    expect(b.size(T0 + 2)).toBe(0);
    // Another sign-in of the member is not affected.
    expect(b.beat(T0 + 3, beat({ session: 's2' }))).toBe('online');
    // The refusal lasts as long as a device would show (the api refuses an ended sign-in anyway).
    b.leave(T0 + 4, { user: 'u1', session: 's2' });
    expect(b.beat(T0 + 4 + PRESENCE_EXPIRE_MS, beat({ session: 's2' }))).toBe('online');
  });

  it('after a sign-out of every other device, beats of the older sign-ins are refused; the kept one and newer ones are not', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ session: 's1', since: T0 - 2_000 }));
    b.beat(T0, beat({ session: 's2', since: T0 - 1_000 }));
    b.leave(T0 + 10, { user: 'u1', except: 's2', at: T0 + 5 });
    expect(b.size(T0 + 10)).toBe(1);
    expect(b.beat(T0 + 20, beat({ session: 's1', since: T0 - 2_000 }))).toBe('online');
    expect(b.size(T0 + 20)).toBe(1);
    // A sign-in made after the sign-out (a new login) shows; a beat that does not say when its sign-in began does not.
    b.beat(T0 + 30, beat({ session: 's3', since: T0 + 6 }));
    b.beat(T0 + 30, beat({ session: 's4' }));
    expect(b.size(T0 + 30)).toBe(2);
    // Signed out of every device: the kept one is refused too, until the refusal runs out.
    b.leave(T0 + 40, { user: 'u1', at: T0 + 40 });
    expect(b.beat(T0 + 50, beat({ session: 's2', since: T0 - 1_000 }))).toBe('offline');
    expect(b.beat(T0 + 50, beat({ session: 's3', since: T0 + 6 }))).toBe('offline');
    expect(b.beat(T0 + 50, beat({ session: 's5', since: T0 + 41 }))).toBe('online');
    expect(b.beat(T0 + 40 + PRESENCE_EXPIRE_MS + 60_000, beat({ session: 's2', since: T0 - 1_000 }))).toBe('online');
  });

  it('a sign-out arriving after a later one never undoes it', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ session: 's1', since: T0 - 2_000 }));
    // Signed out of every device at T0+20 (it arrives first), after signing out of all but s1 at T0+10 (it arrives late).
    b.leave(T0 + 30, { user: 'u1', at: T0 + 20 });
    b.leave(T0 + 31, { user: 'u1', except: 's1', at: T0 + 10 });
    // A beat of s1 the api let through before T0+20, arriving now: still refused.
    expect(b.beat(T0 + 40, beat({ session: 's1', since: T0 - 2_000 }))).toBe('offline');
    expect(b.size(T0 + 40)).toBe(0);
    // Both run out as before.
    expect(b.beat(T0 + 31 + PRESENCE_EXPIRE_MS + 60_000, beat({ session: 's1', since: T0 - 2_000 }))).toBe('online');
  });

  it('however many older sign-outs arrive late, a sign-out of every device still holds', () => {
    const b = new PresenceBook();
    b.leave(T0 + 30, { user: 'u1', at: T0 + 20 });
    // Twenty "all but s1" sign-outs from before it arrive late (more than the hub keeps one by one).
    for (let i = 0; i < 20; i++) b.leave(T0 + 31 + i, { user: 'u1', except: 's1', at: T0 + i });
    expect(b.beat(T0 + 52, beat({ session: 's1', since: T0 - 2_000 }))).toBe('offline');
    // Then twenty "all but this one" of other sign-ins, all from before s1 was made (none of them refuses s1).
    for (let i = 0; i < 20; i++) b.leave(T0 + 53 + i, { user: 'u1', except: `o${i}`, at: T0 - 5_000 + i });
    expect(b.beat(T0 + 80, beat({ session: 's1', since: T0 - 2_000 }))).toBe('offline');
    expect(b.size(T0 + 80)).toBe(0);
    // A sign-in made after them all is let through.
    expect(b.beat(T0 + 80, beat({ session: 's9', since: T0 + 25 }))).toBe('online');
  });

  it('forgets devices gone quiet when it sweeps', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.beat(T0, beat({ user: 'u2' }));
    // A beat a sweep interval later sweeps both expired members away.
    b.beat(T0 + PRESENCE_EXPIRE_MS + 60_000, beat({ user: 'u3' }));
    expect(b.size(T0 + PRESENCE_EXPIRE_MS + 60_000)).toBe(1);
    expect(b.stateOf('u1', T0 + PRESENCE_EXPIRE_MS + 60_000)).toBe('offline');
  });
});

describe('parseBeat', () => {
  it('takes what the api sends and clamps the idle time', () => {
    expect(parseBeat({ user: 'u1', session: 's1', conn: 'c1', idleMs: -5, visible: true })).toEqual({ user: 'u1', session: 's1', conn: 'c1', idleMs: 0, visible: true, view: null });
    expect(parseBeat({ user: 'u1', session: 's1', conn: 'c1', idleMs: 1e12, visible: false, view: 'dm:x' })?.idleMs).toBe(86_400_000);
    const span = parseBeat({ user: 'u1', session: 's1', conn: 'c1', idleMs: 0, visible: true, until: T0 + 1, since: T0 - 1 });
    expect(span).toMatchObject({ until: T0 + 1, since: T0 - 1 });
    expect(Object.keys(parseBeat({ user: 'u1', session: 's1', conn: 'c1', idleMs: 0, visible: true })!)).not.toContain('until');
  });

  it('refuses anything else', () => {
    const ok = { user: 'u1', session: 's1', conn: 'c1', idleMs: 0, visible: true };
    expect(parseBeat({ ...ok, user: 'a b' })).toBeNull();
    expect(parseBeat({ ...ok, session: undefined })).toBeNull();
    expect(parseBeat({ ...ok, idleMs: Number.NaN })).toBeNull();
    expect(parseBeat({ ...ok, idleMs: '5' })).toBeNull();
    expect(parseBeat({ ...ok, visible: 1 })).toBeNull();
    expect(parseBeat({ ...ok, view: 'https://evil.example/' })).toBeNull();
    expect(parseBeat({ ...ok, conn: 'x'.repeat(65) })).toBeNull();
    expect(parseBeat({ ...ok, until: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseBeat({ ...ok, since: '1' })).toBeNull();
  });
});
