import { inboxForMembers } from '@jc/db';

/** A friend who sits down again within this time is not told of again (their item stays as it was). */
export const FRIEND_TABLE_QUIET_MS = 30 * 60_000;

/**
 * The friends a member's sitting down at a public table is told of, as an inbox item (kind 'friend_table', one per
 * friend, the latest table): accepted friends, neither side blocking the other (a block against staff is not in force,
 * as everywhere), active members, not told of this friend in the last FRIEND_TABLE_QUIET_MS. Nobody when the member
 * turned the sharing off, shows as away or invisible (presence other than 'auto'), or is not active. The caller checks
 * the table: never a private or tournament table, so no join code or private table is ever named. `?8` the member,
 * `?9` the item's key, `?10` the quiet limit (numbered after the item's own values, see inboxForMembers).
 */
const FRIENDS_TO_TELL = `
  SELECT fu.id AS user_id
    FROM friendships f
    JOIN users me ON me.id = ?8 AND me.status = 'active' AND me.share_table = 1 AND me.presence_mode = 'auto'
    JOIN users fu ON fu.id = CASE WHEN f.user_a = ?8 THEN f.user_b ELSE f.user_a END AND fu.status = 'active' AND fu.is_bot = 0
   WHERE (f.user_a = ?8 OR f.user_b = ?8) AND f.status = 'accepted'
     AND NOT EXISTS (SELECT 1 FROM user_blocks ub JOIN users bu ON bu.id = ub.blocked_id AND bu.role = 'user'
                      WHERE (ub.blocker_id = ?8 AND ub.blocked_id = fu.id) OR (ub.blocker_id = fu.id AND ub.blocked_id = ?8))
     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = fu.id AND n.key = ?9 AND n.updated_at > ?10)`;

/**
 * The friends whose item was written by this call: theirs carries its time. Read through the member's friendships, so
 * each lookup is by (user, key), the inbox's own index.
 */
const TOLD = `
  SELECT n.user_id AS userId
    FROM friendships f
    JOIN notifications n ON n.user_id = CASE WHEN f.user_a = ?2 THEN f.user_b ELSE f.user_a END AND n.key = ?1 AND n.updated_at = ?3
   WHERE (f.user_a = ?2 OR f.user_b = ?2) AND f.status = 'accepted'`;

/**
 * Writes the item for each friend to tell and returns who got one (for their pages to read the inbox again). Run
 * after the buy-in committed, never awaited by the game; a failure only loses the item.
 */
export async function tellFriendsSat(d1: D1Database, userId: string, table: { id: string; name: string }, now: number): Promise<string[]> {
  const key = `friend_table:${userId}`;
  const [, told] = await d1.batch([
    inboxForMembers(d1, { kind: 'friend_table', key, actorId: userId, ref: table.id, params: { name: table.name }, now }, {
      sql: FRIENDS_TO_TELL,
      params: [userId, key, now - FRIEND_TABLE_QUIET_MS],
    }),
    d1.prepare(TOLD).bind(key, userId, now),
  ]);
  return ((told?.results ?? []) as { userId: string }[]).map((r) => r.userId);
}
