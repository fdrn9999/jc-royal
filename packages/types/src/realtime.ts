import { z } from 'zod';

// ------------------------------------------------------------------ platform realtime (GET /ws/realtime)
//
// One socket per signed-in page, outside any table. It only tells a page that something it shows has changed: D1 (and
// the table rooms) stay the truth, the page reads it again through the API, or applies a public fact the event carries
// whole. Nothing a page receives here moves chips, seats anyone or changes any state, and the socket accepts nothing
// from the page but the topics it wants (see RealtimeClientFrame). The table socket (/ws/tables/:id) is unchanged.

/** Bumped only by a change an older page could not read; a page that sees another one reloads on its next navigation. */
export const REALTIME_PROTOCOL = 1;

/**
 * Realtime hubs: a member's sockets live on hub `realtimeShardOf(userId)`, and a public event goes to every hub. The API
 * and the game worker both read this constant (an env var could differ between them); changing it needs both deployed,
 * and every socket reconnects then anyway. See docs/REALTIME.md for the measurement behind the number.
 */
export const REALTIME_SHARDS = 4;

/** FNV-1a over the id: stable across workers and deploys, and even enough for random ids. */
export function realtimeShardOf(userId: string, shards = REALTIME_SHARDS): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** A hub's Durable Object name. */
export const realtimeHubName = (shard: number) => `rt-${shard}`;

/**
 * Public events a page receives only after asking for them (others reach every page of the member, or every page):
 * the lobby's table counts and the tournament list.
 */
export const REALTIME_TOPICS = ['lobby', 'tournaments'] as const;
export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** Close codes of /ws/realtime past the standard ones. */
export const REALTIME_CLOSE = {
  /** The sign-in it was opened with is past its check: reconnect now (the API checks the session again). */
  reauth: 4000,
  /** The sign-in ended (logout, other devices signed out, password change, suspension, admin disconnect): do not reconnect. */
  signedOut: 4401,
  /** More pages of this member than a hub keeps: the oldest closes. Reconnect only when the page is used again. */
  tooMany: 4008,
} as const;

const base = { eventId: z.string().min(1).max(64), occurredAt: z.number(), revision: z.number().optional() };
const user = { ...base, scope: z.literal('user') };
const pub = { ...base, scope: z.literal('lobby').or(z.literal('service')) };
const id = z.string().min(1).max(64);
const count = z.number().int().min(0);

/** The occupancy a table room mirrors to D1 (tables.live_*), never who: the same numbers every lobby card shows. */
export const LobbyLivePatchSchema = z.object({
  id,
  /** tables.live_updated_at of the write: a page keeps the newest it saw, from REST or from here. */
  rev: z.number(),
  seated: count,
  bots: count,
  playing: z.boolean(),
  waitlist: count,
  spectators: count,
  status: z.enum(['open', 'closing', 'closed']),
});
export type LobbyLivePatch = z.infer<typeof LobbyLivePatchSchema>;

export const RealtimeEventSchema = z.discriminatedUnion('type', [
  // ---- the member's own pages (scope user): what changed, never by how much; the page reads it again.
  /** The wallet moved (admin grant or deduction, table buy-in/cash-out/top-up, refill, referral): balance and ledger. */
  z.object({ ...user, type: z.literal('wallet.changed') }),
  /** Profile, VIP status or color, role or status: GET /api/auth/me again. */
  z.object({ ...user, type: z.literal('account.changed') }),
  /**
   * A personal message arrived, was read or deleted, here or on another device: the unread count and the list. One
   * administrator send to many members carries `spreadMs`: each page reads after a random wait of up to that long.
   */
  z.object({ ...user, type: z.literal('message.changed'), payload: z.object({ spreadMs: count }).optional() }),
  /** A friend request, an answer to one, a removed friendship or a block changed the friends list (it never says which). */
  z.object({ ...user, type: z.literal('social.friend.changed') }),
  /** A direct message with `peerId` up to `seq`: sent by the peer, or by this member on another device. */
  z.object({ ...user, type: z.literal('social.dm.created'), payload: z.object({ peerId: id, seq: count }) }),
  /** `readerId` read the conversation with `peerId` up to `seq` (the peer read mine, or I did elsewhere). */
  z.object({ ...user, type: z.literal('social.dm.read'), payload: z.object({ peerId: id, readerId: id, seq: count }) }),
  /** My seat or waitlist place at this table may have changed: read /api/tables/:id again (it holds myParticipation). */
  z.object({ ...user, type: z.literal('lobby.mine.changed'), resourceId: id }),

  // ---- public (scope lobby/service): only what every member may see.
  /** A table's live counts, as the lobby list shows them. Topic lobby. */
  z.object({ ...pub, type: z.literal('lobby.table.changed'), resourceId: id, payload: LobbyLivePatchSchema }),
  /** A table opened or its settings changed: read /api/tables/:id (once, for that table). Topic lobby. */
  z.object({ ...pub, type: z.literal('lobby.table.updated'), resourceId: id }),
  /** A table closed: drop it from the list. Topic lobby. */
  z.object({ ...pub, type: z.literal('lobby.table.removed'), resourceId: id }),
  /** A tournament was created, changed, filled, started, finished or cancelled. Topic tournaments. */
  z.object({ ...pub, type: z.literal('tournament.changed'), resourceId: id }),
  /**
   * A notice or maintenance window changed: `rev` as GET /api/service/status reports it. Every page reads it again
   * after a random wait of up to `spreadMs`, so thousands of pages do not ask in the same second.
   */
  z.object({ ...pub, type: z.literal('service.changed'), payload: z.object({ rev: z.number(), spreadMs: count }) }),
  /** Messages went to many members at once (an announcement): each page reads its unread count after a random wait. */
  z.object({ ...pub, type: z.literal('inbox.broadcast'), payload: z.object({ spreadMs: count }) }),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event as a publisher writes it: the publisher adds the id and the time. */
export type RealtimeEventInput = DistributiveOmit<RealtimeEvent, 'eventId' | 'occurredAt'>;
export type PersonalRealtimeEvent = Extract<RealtimeEventInput, { scope: 'user' }>;
export type PublicRealtimeEvent = Exclude<RealtimeEventInput, { scope: 'user' }>;

/** Server to page. `hello` first, once the hub took the socket; `{"t":"pong"}` answers `{"t":"ping"}` without waking it. */
export type RealtimeServerFrame = { t: 'hello'; v: number } | { t: 'event'; e: RealtimeEvent } | { t: 'pong' };

/** Page to server: the public topics it wants now (replacing the previous ones). Nothing else is read. */
export const RealtimeClientFrameSchema = z.object({ t: z.literal('sub'), topics: z.array(z.enum(REALTIME_TOPICS)).max(REALTIME_TOPICS.length) });
export type RealtimeClientFrame = z.infer<typeof RealtimeClientFrameSchema>;

/** Which topic a public event needs; undefined: every page gets it. */
export function realtimeTopicOf(type: RealtimeEventType): RealtimeTopic | undefined {
  if (type.startsWith('lobby.table.')) return 'lobby';
  if (type === 'tournament.changed') return 'tournaments';
  return undefined;
}
