import { z } from 'zod';

/**
 * Friends' status (apps/game-worker/src/presence.ts PresenceHub, apps/api/src/routes/presence.ts). The server decides
 * it from each signed-in device's heartbeat; a device only says it is there and when the member last did something.
 * Separate from a table's "sitting out": being away never folds, sits out or changes a table's clock.
 */
export const PRESENCE_STATES = ['online', 'away', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];
/** auto: online while active, away after PRESENCE_AWAY_MS without activity; away: never online; invisible: offline to friends. */
export const PRESENCE_MODES = ['auto', 'away', 'invisible'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

/** No activity on any device this long: away (auto mode). */
export const PRESENCE_AWAY_MS = 5 * 60_000;
/** A device beats this often while signed in (also from a background tab). */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** A device not heard from this long is gone (about three missed beats); the server never trusts the interval itself. */
export const PRESENCE_EXPIRE_MS = 90_000;
/** A device with no activity this long stops beating (the member shows offline from it). */
export const PRESENCE_IDLE_STOP_MS = 30 * 60_000;
/** The soonest a device beats again for activity after a quiet spell, a return to the page or a new view. */
export const PRESENCE_ACTIVITY_BEAT_MS = 10_000;
/** How often the friends list and a conversation ask for friends' status. */
export const PRESENCE_POLL_MS = 30_000;
/** Devices kept per member (the oldest heard from goes first). */
export const PRESENCE_MAX_DEVICES = 10;
/**
 * The closest the server saves a member's last-online time again while they stay online (users.last_online_at, one
 * D1 row write). The hub knows it to the beat; the saved one answers after the hub restarts, at most this much early.
 */
export const PRESENCE_STAMP_MS = 10 * 60_000;

/**
 * One device's state for one member, as the hub keeps it. `activeAt` is when the member last did something there (by
 * the hub's clock: the device sends how long ago, capped). Exported for the unit tests of the merge.
 */
export interface PresenceConn {
  expiresAt: number;
  activeAt: number;
}

/**
 * What friends see, from every device the member is signed in on: invisible is offline, no live device is offline,
 * one device active within PRESENCE_AWAY_MS is online (unless the member chose away), otherwise away.
 */
export function mergePresence(mode: PresenceMode, conns: readonly PresenceConn[], now: number): PresenceState {
  if (mode === 'invisible') return 'offline';
  const live = conns.filter((c) => c.expiresAt > now);
  if (!live.length) return 'offline';
  if (mode === 'away') return 'away';
  return live.some((c) => now - c.activeAt < PRESENCE_AWAY_MS) ? 'online' : 'away';
}

/** What a view names, for the push that would show what the member is already looking at (a conversation). */
const view = z
  .string()
  .max(80)
  .regex(/^[a-z]+:[A-Za-z0-9_-]{1,64}$/)
  .optional();

/** POST /api/me/presence/heartbeat. `idleMs`: since the member last did something on this device. */
export const PresenceBeatSchema = z
  .object({
    conn: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    idleMs: z.number().int().min(0).max(24 * 3_600_000),
    visible: z.boolean(),
    view,
  })
  .strict();
export type PresenceBeat = z.infer<typeof PresenceBeatSchema>;

/** POST /api/me/presence/leave: this device signs off (page closed). */
export const PresenceLeaveSchema = z.object({ conn: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/) }).strict();

/** PUT /api/me/presence. */
export const PresenceModeSchema = z.object({ mode: z.enum(PRESENCE_MODES) }).strict();

/** GET/PUT /api/me/presence, and the heartbeat's answer (so another device's change shows on this one). */
export interface MyPresenceDto {
  mode: PresenceMode;
  /** What friends see now. */
  state: PresenceState;
}

/** GET /api/friends/presence: accepted friends only (never a request, a blocked or a withdrawn member). */
export interface FriendsPresenceDto {
  presence: Record<string, PresenceState>;
  /**
   * When each friend shown offline was last confirmed online (ms, to the minute): their last beat while not shown as
   * offline (closing the page or signing out does not move it). No key when it is not known (and no map when none is);
   * never for a friend shown online or away.
   */
  lastOnline?: Record<string, number>;
}

/** The order of the friends list by status (online first), then the given tie-break. */
export const PRESENCE_RANK: Record<PresenceState, number> = { online: 0, away: 1, offline: 2 };
