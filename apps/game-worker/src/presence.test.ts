// Friends' status (presence-book.ts, @jc/types mergePresence): what friends see from a member's devices, by the hub's
// clock only. The api applies modes and decides who may ask (routes/presence.ts, tests/integration/presence.test.ts).
import { mergePresence, PRESENCE_AWAY_MS, PRESENCE_EXPIRE_MS, PRESENCE_MAX_DEVICES, PRESENCE_STAMP_MS } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { HUB_BEATS_PER_MIN, HUB_QUERIES_PER_MIN, HUB_QUERY_MAX, parseBeat, PresenceBook, type Beat } from './presence-book';

const T0 = 1_800_000_000_000;
const beat = (over: Partial<Beat> = {}): Beat => ({ user: 'u1', session: 's1', conn: 'c1-device', idleMs: 0, visible: true, view: null, mark: true, ...over });

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
    expect(b.beat(T0, beat())?.state).toBe('online');
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
    expect(b.beat(T0 + 30_000, beat({ idleMs: 0 }))?.state).toBe('online');
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
    for (let i = 0; i < HUB_BEATS_PER_MIN; i++) expect(b.beat(T0 + i, beat())?.state).toBe('online');
    expect(b.beat(T0 + HUB_BEATS_PER_MIN, beat())).toBeNull();
    // Another member is not affected.
    expect(b.beat(T0 + HUB_BEATS_PER_MIN, beat({ user: 'u2' }))?.state).toBe('online');
    expect(b.beat(T0 + 60_000, beat())?.state).toBe('online');
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
    expect(b.beat(T0, beat({ until: T0 + 10_000 }))?.state).toBe('online');
    expect(b.stateOf('u1', T0 + 9_999)).toBe('online');
    expect(b.stateOf('u1', T0 + 10_000)).toBe('offline');
    expect(b.beat(T0 + 20_000, beat({ until: T0 + 20_000 }))?.state).toBe('offline');
    expect(b.size(T0 + 20_000)).toBe(0);
  });

  it('a beat of a signed-out sign-in that arrives after the sign-out is not recorded', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.leave(T0 + 1, { user: 'u1', session: 's1' });
    // Let through by the api just before the sign-out, it reaches the hub just after.
    expect(b.beat(T0 + 2, beat())?.state).toBe('offline');
    expect(b.size(T0 + 2)).toBe(0);
    // Another sign-in of the member is not affected.
    expect(b.beat(T0 + 3, beat({ session: 's2' }))?.state).toBe('online');
    // The refusal lasts as long as a device would show (the api refuses an ended sign-in anyway).
    b.leave(T0 + 4, { user: 'u1', session: 's2' });
    expect(b.beat(T0 + 4 + PRESENCE_EXPIRE_MS, beat({ session: 's2' }))?.state).toBe('online');
  });

  it('after a sign-out of every other device, beats of the older sign-ins are refused; the kept one and newer ones are not', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ session: 's1', since: T0 - 2_000 }));
    b.beat(T0, beat({ session: 's2', since: T0 - 1_000 }));
    b.leave(T0 + 10, { user: 'u1', except: 's2', at: T0 + 5 });
    expect(b.size(T0 + 10)).toBe(1);
    expect(b.beat(T0 + 20, beat({ session: 's1', since: T0 - 2_000 }))?.state).toBe('online');
    expect(b.size(T0 + 20)).toBe(1);
    // A sign-in made after the sign-out (a new login) shows; a beat that does not say when its sign-in began does not.
    b.beat(T0 + 30, beat({ session: 's3', since: T0 + 6 }));
    b.beat(T0 + 30, beat({ session: 's4' }));
    expect(b.size(T0 + 30)).toBe(2);
    // Signed out of every device: the kept one is refused too, until the refusal runs out.
    b.leave(T0 + 40, { user: 'u1', at: T0 + 40 });
    expect(b.beat(T0 + 50, beat({ session: 's2', since: T0 - 1_000 }))?.state).toBe('offline');
    expect(b.beat(T0 + 50, beat({ session: 's3', since: T0 + 6 }))?.state).toBe('offline');
    expect(b.beat(T0 + 50, beat({ session: 's5', since: T0 + 41 }))?.state).toBe('online');
    expect(b.beat(T0 + 40 + PRESENCE_EXPIRE_MS + 60_000, beat({ session: 's2', since: T0 - 1_000 }))?.state).toBe('online');
  });

  it('a sign-out arriving after a later one never undoes it', () => {
    const b = new PresenceBook();
    b.beat(T0, beat({ session: 's1', since: T0 - 2_000 }));
    // Signed out of every device at T0+20 (it arrives first), after signing out of all but s1 at T0+10 (it arrives late).
    b.leave(T0 + 30, { user: 'u1', at: T0 + 20 });
    b.leave(T0 + 31, { user: 'u1', except: 's1', at: T0 + 10 });
    // A beat of s1 the api let through before T0+20, arriving now: still refused.
    expect(b.beat(T0 + 40, beat({ session: 's1', since: T0 - 2_000 }))?.state).toBe('offline');
    expect(b.size(T0 + 40)).toBe(0);
    // Both run out as before.
    expect(b.beat(T0 + 31 + PRESENCE_EXPIRE_MS + 60_000, beat({ session: 's1', since: T0 - 2_000 }))?.state).toBe('online');
  });

  it('however many older sign-outs arrive late, a sign-out of every device still holds', () => {
    const b = new PresenceBook();
    b.leave(T0 + 30, { user: 'u1', at: T0 + 20 });
    // Twenty "all but s1" sign-outs from before it arrive late (more than the hub keeps one by one).
    for (let i = 0; i < 20; i++) b.leave(T0 + 31 + i, { user: 'u1', except: 's1', at: T0 + i });
    expect(b.beat(T0 + 52, beat({ session: 's1', since: T0 - 2_000 }))?.state).toBe('offline');
    // Then twenty "all but this one" of other sign-ins, all from before s1 was made (none of them refuses s1).
    for (let i = 0; i < 20; i++) b.leave(T0 + 53 + i, { user: 'u1', except: `o${i}`, at: T0 - 5_000 + i });
    expect(b.beat(T0 + 80, beat({ session: 's1', since: T0 - 2_000 }))?.state).toBe('offline');
    expect(b.size(T0 + 80)).toBe(0);
    // A sign-in made after them all is let through.
    expect(b.beat(T0 + 80, beat({ session: 's9', since: T0 + 25 }))?.state).toBe('online');
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

describe('PresenceBook last-online time', () => {
  it('is the last recorded beat; the api saves it on the first beat and then at most every PRESENCE_STAMP_MS', () => {
    const b = new PresenceBook();
    expect(b.seenOf(['u1'])).toEqual({});
    // Told as how long before the hub answered: this beat's own time, 0 ms ago.
    expect(b.beat(T0, beat())).toEqual({ state: 'online', stampAgo: 0 });
    expect(b.beat(T0 + 30_000, beat())).toEqual({ state: 'online' });
    expect(b.seenOf(['u1', 'u2'])).toEqual({ u1: T0 + 30_000 });
    expect(b.beat(T0 + PRESENCE_STAMP_MS - 1, beat())?.stampAgo).toBeUndefined();
    expect(b.beat(T0 + PRESENCE_STAMP_MS, beat())?.stampAgo).toBe(0);
    // The device then goes quiet: the time stays at its last beat, not when it expired.
    expect(b.stateOf('u1', T0 + PRESENCE_STAMP_MS + PRESENCE_EXPIRE_MS)).toBe('offline');
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + PRESENCE_STAMP_MS });
  });

  it('a member shown as offline (unmarked beats) neither moves nor saves it', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    expect(b.beat(T0 + 60_000, beat({ mark: false }))).toEqual({ state: 'online' });
    expect(b.beat(T0 + PRESENCE_STAMP_MS * 2, beat({ mark: false }))).toEqual({ state: 'online' });
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
    // Never visible since the hub started: nothing known at all.
    b.beat(T0 + PRESENCE_STAMP_MS * 2, beat({ user: 'ghost', mark: false }));
    expect(b.seenOf(['ghost'])).toEqual({});
    // Closing an unmarked device moves nothing either.
    expect(b.leave(T0 + PRESENCE_STAMP_MS * 2 + 1, { user: 'u1', session: 's1', conn: 'c1-device' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
  });

  it('a marked device closing or signing out has its last beat saved sooner, at most once a minute, without moving it', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.beat(T0 + 30_000, beat());
    // The beat at T0 + 30 s, 31 s before the leave.
    expect(b.leave(T0 + 61_000, { user: 'u1', session: 's1', conn: 'c1-device' })).toEqual({ stampAgo: 31_000 });
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 30_000 });
    // Reloaded and closed again within the minute: the hub knows, the api is not asked to write again.
    b.beat(T0 + 70_000, beat({ conn: 'c2-device' }));
    expect(b.leave(T0 + 80_000, { user: 'u1', session: 's1', conn: 'c2-device' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 70_000 });
    // A sign-out of every device after a minute saves the last beat.
    b.beat(T0 + 200_000, beat({ conn: 'c3-device', session: 's2' }));
    expect(b.leave(T0 + 250_000, { user: 'u1' })).toEqual({ stampAgo: 50_000 });
    // Nothing left to take off: nothing moves.
    expect(b.leave(T0 + 400_000, { user: 'u1' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 200_000 });
  });

  it('switching to offline-looking and then closing leaves the time at the last beat friends could see, saved if it was not', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    // The mode changed; the page closes before its next beat: nothing new to save.
    expect(b.leave(T0 + 20_000, { user: 'u1', session: 's1', conn: 'c1-device' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
    // Or marked beats go on unsaved (within PRESENCE_STAMP_MS of the last save), it beats unmarked, then signs out: the
    // last marked beat is saved all the same, or a hub started again would answer the older saved one.
    b.beat(T0 + 100_000, beat({ conn: 'c2-device' }));
    b.beat(T0 + 130_000, beat({ conn: 'c2-device', mark: false }));
    expect(b.leave(T0 + 200_000, { user: 'u1', session: 's1' })).toEqual({ stampAgo: 100_000 });
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 100_000 });
  });

  it('a beat on its way when the member turned invisible moves the time no later than when the api read the mode', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    // Read as visible at T0 + 30 s, its body slow, it reaches the hub after the switch to invisible and an unmarked
    // beat. How long the api held it is measured on the api's clock alone, so however far that clock is off the hub's,
    // the time is the hub's arrival less that.
    b.beat(T0 + 40_000, beat({ conn: 'c2-device', mark: false, age: 1_000 }));
    b.beat(T0 + 45_000, beat({ age: 15_000 }));
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 30_000 });
    // Never back (an older read arriving after a later one); no age (an api that does not say): the hub's clock.
    b.beat(T0 + 55_000, beat({ age: 40_000 }));
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 30_000 });
    b.beat(T0 + 60_000, beat());
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 60_000 });
  });

  it('tells the api how long ago, never a moment: a hub clock minutes ahead of the api moves no saved or shown time', () => {
    const b = new PresenceBook();
    const ahead = 5 * 60_000;
    // The api reads the mode (visible) at T0 by its clock, sends the beat 2 s later (a slow body), and it reaches the
    // hub 10 ms after that, at T0 + 2_010 + ahead by the hub's clock.
    const r = b.beat(T0 + 2_010 + ahead, beat({ age: 2_000 }));
    // The api saves its sending time less the span: its own read.
    expect(T0 + 2_000 - r!.stampAgo!).toBe(T0);
    // The member turns invisible at once; a friend's list asks two minutes later, its question taking 5 ms to arrive.
    const asked = T0 + 120_000;
    const shown = asked - b.seenAgo(asked + 5 + ahead, ['u1']).u1!;
    // Later than the read by the beat's way to the hub less the question's (milliseconds), whatever the clocks say.
    expect(shown).toBe(T0 + 5);
    expect(b.seenAgo(asked, ['u2'])).toEqual({});
  });

  it('a beat the api held longer than a device lasts moves no time: its read says nothing of now', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    // Read a day after T0 and arriving two days after that (its body held that long).
    const wire = { user: 'u1', session: 's1', conn: 'c1-device', idleMs: 0, visible: true, mark: true };
    b.beat(T0 + 3 * 86_400_000, parseBeat({ ...wire, age: 2 * 86_400_000 })!);
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
    // Held no longer than a device lasts: the time of the read.
    b.beat(T0 + 3 * 86_400_000 + 1, parseBeat({ ...wire, age: PRESENCE_EXPIRE_MS })!);
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 3 * 86_400_000 + 1 - PRESENCE_EXPIRE_MS });
  });

  it('a device leaving saves an unsaved time once, and a saved one is never asked again while the hub keeps it', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.beat(T0 + 30_000, beat());
    // Gone quiet and swept (another member's beat sweeps) before its page said it closed: the time is still saved.
    b.beat(T0 + 30_000 + PRESENCE_EXPIRE_MS + 61_000, beat({ user: 'u2' }));
    expect(b.leave(T0 + 30_000 + PRESENCE_EXPIRE_MS + 62_000, { user: 'u1', session: 's1', conn: 'c1-device' })).toEqual({ stampAgo: PRESENCE_EXPIRE_MS + 62_000 });
    // An offline-looking member closing pages long after that: nothing more to save, no write.
    const later = T0 + PRESENCE_STAMP_MS * 3;
    b.beat(later, beat({ conn: 'c3-device', mark: false }));
    expect(b.leave(later + 1, { user: 'u1', session: 's1', conn: 'c3-device' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 + 30_000 });
  });

  it('a beat from an api that does not say whether friends can see the member moves nothing', () => {
    const b = new PresenceBook();
    const { mark: _mark, ...old } = beat();
    expect(b.beat(T0, old)).toEqual({ state: 'online' });
    expect(b.seenOf(['u1'])).toEqual({});
  });

  it('closing a device that already expired keeps its last beat', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    expect(b.leave(T0 + PRESENCE_EXPIRE_MS + 1, { user: 'u1', session: 's1', conn: 'c1-device' })).toEqual({});
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
  });

  it('a refused or rate-limited beat moves nothing', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.leave(T0 + 1, { user: 'u1', session: 's1' });
    expect(b.beat(T0 + 2, beat())).toEqual({ state: 'offline' });
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
    for (let i = 0; i < HUB_BEATS_PER_MIN; i++) b.beat(T0 + 10 + i, beat({ user: 'u2', session: 's9' }));
    expect(b.beat(T0 + 100, beat({ user: 'u2', session: 's9' }))).toBeNull();
    expect(b.seenOf(['u2'])).toEqual({ u2: T0 + 10 + HUB_BEATS_PER_MIN - 1 });
  });

  it('keeps a time for thirty days after the member goes, then leaves it to the saved one', () => {
    const b = new PresenceBook();
    b.beat(T0, beat());
    b.beat(T0 + 29 * 86_400_000, beat({ user: 'u2' }));
    expect(b.seenOf(['u1'])).toEqual({ u1: T0 });
    b.beat(T0 + 30 * 86_400_000, beat({ user: 'u3' }));
    expect(b.seenOf(['u1', 'u2'])).toEqual({ u2: T0 + 29 * 86_400_000 });
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
    expect(parseBeat({ ...ok, mark: 'yes' })).toBeNull();
    expect(parseBeat({ ...ok, age: Number.NaN })).toBeNull();
    expect(parseBeat({ ...ok, age: '5' })).toBeNull();
  });

  it('takes whether friends can see the member and how long ago the api read it, absent from an older api', () => {
    const ok = { user: 'u1', session: 's1', conn: 'c1', idleMs: 0, visible: true };
    expect(parseBeat({ ...ok, mark: false })?.mark).toBe(false);
    expect(parseBeat({ ...ok, mark: true, age: 1_500 })).toMatchObject({ mark: true, age: 1_500 });
    // Never ahead of the hub; a long one is kept as it is (cut short, it would make the read later: the beat then
    // moves no time).
    expect(parseBeat({ ...ok, age: -5 })?.age).toBe(0);
    expect(parseBeat({ ...ok, age: 1e12 })?.age).toBe(1e12);
    // No moment from the api's clock is read.
    expect(parseBeat({ ...ok, mark: true, at: T0 })).not.toHaveProperty('at');
    expect(parseBeat(ok)).not.toHaveProperty('mark');
    expect(parseBeat(ok)).not.toHaveProperty('age');
  });
});
