import { mergePresence, PRESENCE_AWAY_MS, PRESENCE_EXPIRE_MS, PRESENCE_MAX_DEVICES, PRESENCE_STAMP_MS, type PresenceState } from '@jc/types';

/** One device of a member, as the hub (presence.ts) keeps it. */
interface Conn {
  /** The sign-in it beats for (a sign-out removes its devices at once). */
  session: string;
  expiresAt: number;
  /** When the member last did something there, by the hub's clock. */
  activeAt: number;
  visible: boolean;
  /** What the page shows ("dm:<friend>"), for the push that would repeat what the member is already looking at. */
  view: string | null;
}

/** Beats one member may send a minute over all devices (a page beats twice a minute, a few more on activity). */
export const HUB_BEATS_PER_MIN = 40;
/** Status questions one member may ask a minute (the friends list and a conversation each ask twice a minute). */
export const HUB_QUERIES_PER_MIN = 30;
/** Most members one question may name. */
export const HUB_QUERY_MAX = 1_000;
const WINDOW_MS = 60_000;
const SWEEP_MS = 60_000;
/** Sign-outs of every device (each sparing a different sign-in, or none) one member's refusals hold at once. */
const MAX_CUTS = 16;
/** The closest a device closing asks the api to save the last-online time again (a page reloaded over and over). */
const LEAVE_STAMP_MS = 60_000;
/** Last-online times the hub keeps after a member goes; past that, the api's saved one (users.last_online_at) answers. */
const SEEN_KEEP_MS = 30 * 86_400_000;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const VIEW_RE = /^[a-z]+:[A-Za-z0-9_-]{1,64}$/;

export interface Beat {
  user: string;
  session: string;
  conn: string;
  idleMs: number;
  visible: boolean;
  view: string | null;
  /** When the sign-in runs out (the api's clock): the device shows no longer than that. */
  until?: number;
  /** When the sign-in was made (the api's clock), to tell it from sign-ins a sign-out of every device ended. */
  since?: number;
  /**
   * Friends can see the member (their mode is not invisible). Absent: false (an api from before last-online times, which
   * cannot tell: its beats never move the time).
   */
  mark?: boolean;
  /**
   * How long before sending it the api read the member's mode for this beat (ms, on the api's own clock): friends could
   * see them then, not necessarily when the beat arrives (its body may have been slow, or on its way while they switched
   * to invisible). The hub takes it off its own clock, so no two servers' clocks are compared. Absent: 0.
   */
  age?: number;
}

/**
 * A recorded beat or a leave. `stampAgo`: the api is to save the last-online time this long before it sent the call (ms,
 * on the hub's clock alone: the api counts back from its own, so the hub's clock never reaches users.last_online_at).
 */
export interface Seen {
  state: PresenceState;
  stampAgo?: number;
}

export interface Leave {
  user: string;
  /** One device of a sign-in (the page closed). */
  conn?: string;
  /** Every device of this sign-in (signed out). */
  session?: string;
  /** Every device except this sign-in's (signed out elsewhere, password changed). */
  except?: string;
  /** When the api signed them out (its clock); the hub's own clock when not given. */
  at?: number;
}

/** The hub's state and rules, apart from the Durable Object so the unit tests can drive it with their own clock. */
export class PresenceBook {
  private users = new Map<string, Map<string, Conn>>();
  private beats = new Map<string, { start: number; n: number }>();
  private asks = new Map<string, { start: number; n: number }>();
  /** Sign-ins signed out lately, until when: a beat the api let through just before arrives late and is not recorded. */
  private ended = new Map<string, number>();
  /**
   * A member's sign-outs of every device (but `except`) at `at`, each kept until `until` for the same reason. All of them
   * are kept, whatever order they arrive in: one arriving late never undoes a later one.
   */
  private cuts = new Map<string, { at: number; except: string | null; until: number }[]>();
  /**
   * When each member was last confirmed online with friends able to see it: a marked device's recorded beat. One time
   * per member, overwritten; never sent anywhere but to the api's friends query.
   */
  private seen = new Map<string, number>();
  /**
   * When the hub last had the api save a member's last-online time, and the time saved (none since the hub started:
   * the next beat does). Kept as long as the time is, so a time already saved is never asked again.
   */
  private stamped = new Map<string, { at: number; time: number }>();
  private sweptAt = 0;

  /**
   * Records a beat. Null: too many from this member this minute (the device backs off). A beat of a sign-in that has
   * run out or was signed out (it was on its way when the sign-out came) is answered but not recorded. A recorded,
   * marked beat moves the last-online time to when the api read the mode (now less the beat's `age`, never back), and
   * asks the api to save it at most every PRESENCE_STAMP_MS. One the api held longer than a device lasts moves nothing:
   * so old a read says nothing of now.
   */
  beat(now: number, b: Beat): Seen | null {
    this.sweep(now);
    if (!allow(this.beats, b.user, HUB_BEATS_PER_MIN, now)) return null;
    if (this.refused(now, b)) return { state: this.stateOf(b.user, now) };
    let conns = this.users.get(b.user);
    if (!conns) this.users.set(b.user, (conns = new Map()));
    // Keyed by the sign-in too: a device id sent with another sign-in is another device.
    conns.set(`${b.session}:${b.conn}`, {
      session: b.session,
      expiresAt: Math.min(now + PRESENCE_EXPIRE_MS, b.until ?? Infinity),
      activeAt: now - Math.max(0, b.idleMs),
      visible: b.visible,
      view: b.view,
    });
    if (conns.size > PRESENCE_MAX_DEVICES) {
      let oldest: string | null = null;
      let at = Infinity;
      for (const [k, c] of conns) if (c.expiresAt < at) [oldest, at] = [k, c.expiresAt];
      if (oldest) conns.delete(oldest);
    }
    const state = this.stateOf(b.user, now);
    const age = b.age ?? 0;
    if (!b.mark || age > PRESENCE_EXPIRE_MS) return { state };
    this.seen.set(b.user, Math.max(now - age, this.seen.get(b.user) ?? 0));
    return { state, ...this.stamp(now, b.user, PRESENCE_STAMP_MS) };
  }

  /**
   * Whether the api saves the member's last-online time now: one it has not saved yet, and not within `gap` of the last
   * save. Never moves the time itself.
   */
  private stamp(now: number, user: string, gap: number): { stampAgo?: number } {
    const time = this.seen.get(user);
    const last = this.stamped.get(user);
    if (time === undefined || (last !== undefined && (time <= last.time || now - last.at < gap))) return {};
    this.stamped.set(user, { at: now, time });
    return { stampAgo: Math.max(0, now - time) };
  }

  /**
   * Forgets devices that signed out; a sign-out (not a page closing) also refuses that sign-in's beats still on their way.
   * It has the api save a last-online time not saved yet sooner (at most once a minute), whatever the devices showed
   * when they left (a member who switched to invisible and then left still has their last marked beat saved), but
   * never moves it: it stays the last marked beat, so such a member is not shown later than that.
   */
  leave(now: number, l: Leave): { stampAgo?: number } {
    const until = now + PRESENCE_EXPIRE_MS;
    if (l.conn === undefined && l.session !== undefined) this.ended.set(l.session, until);
    else if (l.conn === undefined) {
      const at = l.at ?? now;
      const except = l.except ?? null;
      const cuts = (this.cuts.get(l.user) ?? []).filter((c) => c.until > now);
      // One per sign-in spared (or none): the latest of them refuses every sign-in the earlier ones did (those were
      // signed out by it too), so the two make one, kept until the later end.
      const same = cuts.find((c) => c.except === except);
      if (same) {
        same.at = Math.max(same.at, at);
        same.until = Math.max(same.until, until);
      } else cuts.push({ at, except, until });
      // More sign-ins spared than MAX_CUTS (never seen: each is a password change): the one ending soonest goes. The
      // sign-out of every device is never the one.
      if (cuts.length > MAX_CUTS) {
        let k = -1;
        for (let j = 0; j < cuts.length; j++) if (cuts[j]!.except !== null && (k < 0 || cuts[j]!.until < cuts[k]!.until)) k = j;
        cuts.splice(k, 1);
      }
      this.cuts.set(l.user, cuts);
    }
    const conns = this.users.get(l.user);
    if (conns) {
      for (const [k, c] of conns) {
        const gone = l.conn !== undefined ? k === `${l.session}:${l.conn}` : l.session !== undefined ? c.session === l.session : l.except !== undefined ? c.session !== l.except : true;
        if (gone) conns.delete(k);
      }
      if (!conns.size) this.users.delete(l.user);
    }
    return this.stamp(now, l.user, LEAVE_STAMP_MS);
  }

  private refused(now: number, b: Beat): boolean {
    if (b.until !== undefined && b.until <= now) return true;
    const ended = this.ended.get(b.session);
    if (ended !== undefined && ended > now) return true;
    const cuts = this.cuts.get(b.user);
    return !!cuts && cuts.some((cut) => cut.until > now && b.session !== cut.except && (b.since === undefined || b.since <= cut.at));
  }

  /** online / away / offline from the member's devices alone (auto mode). */
  stateOf(user: string, now: number): PresenceState {
    const conns = this.users.get(user);
    return conns ? mergePresence('auto', [...conns.values()], now) : 'offline';
  }

  /** Each named member's state. Null: the asking member asked too often this minute. */
  query(now: number, asker: string, ids: readonly string[]): Record<string, PresenceState> | null {
    this.sweep(now);
    if (!allow(this.asks, asker, HUB_QUERIES_PER_MIN, now)) return null;
    const out: Record<string, PresenceState> = {};
    for (const id of ids.slice(0, HUB_QUERY_MAX)) out[id] = this.stateOf(id, now);
    return out;
  }

  /** The last-online times the hub knows of these members, on its clock. */
  seenOf(ids: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of ids.slice(0, HUB_QUERY_MAX)) {
      const at = this.seen.get(id);
      if (at !== undefined) out[id] = at;
    }
    return out;
  }

  /**
   * The same as the api is sent them (asked with query, so under its limit): how long before `now` each was, on the
   * hub's clock alone. The api counts back from its own clock, so the two servers' clocks are never compared.
   */
  seenAgo(now: number, ids: readonly string[]): Record<string, number> {
    const out = this.seenOf(ids);
    for (const id of Object.keys(out)) out[id] = Math.max(0, now - out[id]!);
    return out;
  }

  /**
   * A live, visible page of the member shows this view and they did something there lately (not away from it): a page
   * left open on a desk while they went away holds back no push, theirs or their other devices'.
   */
  viewing(now: number, user: string, view: string): boolean {
    const conns = this.users.get(user);
    if (!conns) return false;
    for (const c of conns.values()) if (c.expiresAt > now && c.visible && c.view === view && now - c.activeAt < PRESENCE_AWAY_MS) return true;
    return false;
  }

  /** Members with a live device (tests and the size check). */
  size(now: number): number {
    let n = 0;
    for (const conns of this.users.values()) for (const c of conns.values()) if (c.expiresAt > now) n++;
    return n;
  }

  /** Forgets devices gone quiet and finished rate windows, at most once a minute (O(members)). */
  private sweep(now: number) {
    if (now - this.sweptAt < SWEEP_MS) return;
    this.sweptAt = now;
    for (const [u, conns] of this.users) {
      for (const [k, c] of conns) if (c.expiresAt <= now) conns.delete(k);
      if (!conns.size) this.users.delete(u);
    }
    for (const m of [this.beats, this.asks]) for (const [k, w] of m) if (now - w.start >= WINDOW_MS) m.delete(k);
    for (const [k, until] of this.ended) if (until <= now) this.ended.delete(k);
    // A stamp goes with its time (one is made only for a member with a time).
    for (const [k, at] of this.seen) {
      if (now - at < SEEN_KEEP_MS) continue;
      this.seen.delete(k);
      this.stamped.delete(k);
    }
    for (const [k, cuts] of this.cuts) {
      const live = cuts.filter((c) => c.until > now);
      if (live.length) this.cuts.set(k, live);
      else this.cuts.delete(k);
    }
  }
}

function allow(m: Map<string, { start: number; n: number }>, key: string, limit: number, now: number): boolean {
  const w = m.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    m.set(key, { start: now, n: 1 });
    return true;
  }
  if (w.n >= limit) return false;
  w.n++;
  return true;
}

export const id = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

/** Reads a call's body; null when it is not what the api sends. */
export function parseBeat(v: Record<string, unknown>): Beat | null {
  const view = v.view === null || v.view === undefined ? null : typeof v.view === 'string' && VIEW_RE.test(v.view) ? v.view : undefined;
  if (!id(v.user) || !id(v.session) || !id(v.conn) || typeof v.idleMs !== 'number' || !Number.isFinite(v.idleMs) || typeof v.visible !== 'boolean' || view === undefined) return null;
  const until = time(v.until);
  const since = time(v.since);
  const age = time(v.age);
  if (until === null || since === null || age === null || (v.mark !== undefined && typeof v.mark !== 'boolean')) return null;
  return {
    user: v.user,
    session: v.session,
    conn: v.conn,
    idleMs: Math.min(Math.max(0, v.idleMs), 86_400_000),
    visible: v.visible,
    view,
    ...(until !== undefined ? { until } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(typeof v.mark === 'boolean' ? { mark: v.mark } : {}),
    // Never ahead of the hub; never cut short (that would make the read later): beat() ignores one held too long.
    ...(age !== undefined ? { age: Math.max(0, age) } : {}),
  };
}

/** An optional moment or span (ms): undefined when absent, null when it is not a finite number. */
export function time(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

