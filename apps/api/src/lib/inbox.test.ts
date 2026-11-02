// The notification inbox (lib/inbox.ts, @jc/db inbox): the rows a change's batch writes, and the list read from them
// and from where the other items live (personal messages, tournament notices, service notices, maintenance), on SQLite
// with the real migrations (the guards read `changes()` of the statement before them, as in a D1 batch). The routes,
// D1's own batch and the realtime events are in tests/integration/inbox.test.ts.
import { IF_CHANGED, inboxForMembers, inboxReadStatement, inboxStatement } from '@jc/db';
import type { InboxItemDto } from '@jc/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceLabel, INBOX_UNREAD_SQL, inboxMarkRead, inboxPage, toInboxItem, type InboxQuery, type InboxRowOut } from './inbox';
import { d1Of, loadSqlite, migratedDb, type SqliteDb } from './test-sqlite';

beforeAll(loadSqlite);

const NOW = Date.parse('2026-11-02T03:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TID = 'tnsunday0001';

/** Every migration, three members (who joined a year before NOW) and a bot. */
function database(): SqliteDb {
  const db = migratedDb();
  for (const u of ['me', 'fr', 'ot'])
    db.prepare(`INSERT INTO users (id, email, nickname, password_hash, created_at) VALUES (?1, ?1 || '@test.dev', ?1, 'x', ?2)`).run(u, NOW - 365 * DAY);
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash, is_bot) VALUES ('bot', 'bot@test.dev', 'bot', 'x', 1)`).run();
  return db;
}

function setup() {
  const db = database();
  const d1 = d1Of(db);
  const list = async (user = 'me', q: Partial<InboxQuery> = {}, now = NOW): Promise<InboxItemDto[]> =>
    (await inboxPage(d1, user, now, { limit: 30, ...q }).all<InboxRowOut>()).results.map((r) => toInboxItem(r, now));
  const unread = async (user = 'me', now = NOW) => Number((await d1.prepare(`SELECT ${INBOX_UNREAD_SQL} AS n`).bind(user, now).first<{ n: number }>())!.n);
  const one = async (id: string, user = 'me') => (await list(user)).find((i) => i.id === id || i.kind === id);
  return { db, d1, list, unread, one };
}

const friendship = (db: SqliteDb, requester: string, other: string, status: 'pending' | 'accepted') => {
  const [a, b] = [requester, other].sort();
  db.prepare(`INSERT INTO friendships (user_a, user_b, requester_id, status) VALUES (?1, ?2, ?3, ?4)`).run(a, b, requester, status);
};

const tournament = (db: SqliteDb, id: string, status: string, name = 'Sunday') =>
  db
    .prepare(
      `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start)
       VALUES (?1, ?2, ?3, 6, 2, 1500, '[{"sb":10,"bb":20}]', 300000, 20, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 0)`,
    )
    .run(id, name, status);

const message = (db: SqliteDb, id: string, at: number, readAt: number | null = null) =>
  db.prepare(`INSERT INTO messages (id, user_id, category, title, body, read_at, created_at) VALUES (?1, 'me', 'system', 't', 'b', ?2, ?3)`).run(id, readAt, at);

describe('rows written with a change', () => {
  it('the same key again counts while unread, and starts over once read', async () => {
    const { db, d1, one, unread } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const ask = (at: number) => inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: at }).run();
    await ask(NOW - 3 * MIN);
    expect(await one('friend_request')).toMatchObject({ count: 1, readAt: null, at: NOW - 3 * MIN, actor: { id: 'fr', nickname: 'fr' }, state: 'open', href: '/friends' });
    await ask(NOW - 2 * MIN);
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: null, at: NOW - 2 * MIN });
    expect(await unread()).toBe(1);

    expect((await inboxReadStatement(d1, 'me', ['friend_request:fr'], NOW - MIN).run()).meta.changes).toBe(1);
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: NOW - MIN });
    expect(await unread()).toBe(0);
    // Read already: nothing to mark.
    expect((await inboxReadStatement(d1, 'me', ['friend_request:fr'], NOW).run()).meta.changes).toBe(0);

    await ask(NOW);
    expect(await one('friend_request')).toMatchObject({ count: 1, readAt: null, at: NOW });
    expect(await unread()).toBe(1);
  });

  it('is written only when the change before it in the batch was (IF_CHANGED)', async () => {
    const { db, d1, list } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const accept = (requester: string) => [
      d1.prepare(`UPDATE friendships SET status = 'accepted' WHERE user_a = 'fr' AND user_b = 'me' AND status = 'pending' AND requester_id = ?1`).bind(requester),
      inboxStatement(d1, 'fr', { kind: 'friend_accepted', key: 'friend_accepted:me', actorId: 'me', now: NOW }, IF_CHANGED),
    ];
    const missed = await d1.batch(accept('me'));
    expect(missed[1]!.meta.changes).toBe(0);
    expect(await list('fr')).toEqual([]);
    const made = await d1.batch(accept('fr'));
    expect(made[1]!.meta.changes).toBe(1);
    expect(await list('fr')).toMatchObject([{ kind: 'friend_accepted', actor: { id: 'me' }, href: '/friends/me', state: null }]);
  });

  it('a conversation item is read only once nothing in it is left unread', async () => {
    const { db, d1, one } = setup();
    friendship(db, 'fr', 'me', 'accepted');
    const pair = 'fr:me';
    for (const [id, seq] of [
      ['d1', 1],
      ['d2', 2],
    ] as const) {
      db.prepare(`INSERT INTO direct_messages (id, pair_key, sender_id, recipient_id, body, created_at, seq) VALUES (?1, ?2, 'fr', 'me', 'hi', ?3, ?4)`).run(id, pair, NOW - seq, seq);
      await inboxStatement(d1, 'me', { kind: 'dm', key: 'dm:fr', actorId: 'fr', now: NOW - seq }).run();
    }
    const guard = { sql: 'NOT EXISTS (SELECT 1 FROM direct_messages WHERE pair_key = ? AND recipient_id = ? AND read_at IS NULL)', params: [pair, 'me'] };
    const markDm = () => inboxReadStatement(d1, 'me', ['dm:fr', 'invite:fr'], NOW, guard).run();
    db.prepare(`UPDATE direct_messages SET read_at = ?1 WHERE id = 'd1'`).run(NOW);
    expect((await markDm()).meta.changes).toBe(0);
    expect(await one('dm')).toMatchObject({ count: 2, readAt: null });
    db.prepare(`UPDATE direct_messages SET read_at = ?1 WHERE id = 'd2'`).run(NOW);
    expect((await markDm()).meta.changes).toBe(1);
    expect(await one('dm')).toMatchObject({ readAt: NOW });
  });

  it('a tournament result reaches its members once, with their place', async () => {
    const { db, d1, list } = setup();
    tournament(db, TID, 'running');
    for (const [u, status, place] of [
      ['me', 'eliminated', 2],
      ['fr', 'won', 1],
      ['bot', 'eliminated', 3],
      ['ot', 'registered', null],
    ] as const)
      db.prepare(`INSERT INTO tournament_entries (tournament_id, user_id, status, place, registered_at) VALUES (?1, ?2, ?3, ?4, 1)`).run(TID, u, status, place);
    const finish = () =>
      d1.batch([
        d1.prepare(`UPDATE tournaments SET status = 'finished' WHERE id = ?1 AND status = 'running'`).bind(TID),
        inboxForMembers(
          d1,
          { kind: 'tournament_result', key: `tournament_result:${TID}`, ref: TID, now: NOW },
          {
            sql: `SELECT e.user_id FROM tournament_entries e JOIN users u ON u.id = e.user_id
                   WHERE e.tournament_id = ? AND e.status IN ('eliminated', 'won') AND u.is_bot = 0 AND u.status != 'deleted' AND ${IF_CHANGED.sql}`,
            params: [TID],
          },
        ),
      ]);
    expect((await finish())[1]!.meta.changes).toBe(2);
    expect(await list('me')).toMatchObject([{ kind: 'tournament_result', count: 1, params: { name: 'Sunday', place: 2 }, href: `/tournaments/${TID}` }]);
    expect(await list('fr')).toMatchObject([{ kind: 'tournament_result', params: { place: 1 } }]);
    expect(await list('bot')).toEqual([]);
    expect(await list('ot')).toEqual([]);
    // The same finish written again (a retried sync) changes nothing: no second count.
    expect((await finish())[1]!.meta.changes).toBe(0);
    expect(await list('me')).toMatchObject([{ count: 1 }]);
  });
});

describe('the list', () => {
  it('leaves out items of a withdrawn or blocked member, expired ones, and messages when the member turned them off', async () => {
    const { db, d1, list } = setup();
    await inboxStatement(d1, 'me', { kind: 'dm', key: 'dm:fr', actorId: 'fr', now: NOW - 3 }).run();
    await inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:ot', actorId: 'ot', now: NOW - 2 }).run();
    await inboxStatement(d1, 'me', { kind: 'vip', key: 'vip', params: { color: 'gold' }, now: NOW - 31 * DAY }).run();
    expect((await list()).map((i) => i.kind)).toEqual(['friend_request', 'dm']);

    db.prepare(`UPDATE users SET dm_notifications = 0 WHERE id = 'me'`).run();
    expect((await list()).map((i) => i.kind)).toEqual(['friend_request']);
    db.prepare(`UPDATE users SET dm_notifications = 1 WHERE id = 'me'`).run();
    db.prepare(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('me', 'ot')`).run();
    expect((await list()).map((i) => i.kind)).toEqual(['dm']);
    db.prepare(`UPDATE users SET status = 'deleted' WHERE id = 'fr'`).run();
    expect(await list()).toEqual([]);
  });

  it('shows a friend request as open, answered, or gone', async () => {
    const { db, d1, one } = setup();
    await inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: NOW }).run();
    expect((await one('friend_request'))!.state).toBe('expired');
    friendship(db, 'fr', 'me', 'pending');
    expect((await one('friend_request'))!.state).toBe('open');
    db.prepare(`UPDATE friendships SET status = 'accepted'`).run();
    expect((await one('friend_request'))!.state).toBe('done');
  });

  it('shows a table invite as open while it is recent and the table takes players', async () => {
    const { db, d1, list } = setup();
    db.prepare(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in) VALUES ('t1', 'Royal', 6, 10, 20, 400, 2000)`).run();
    await inboxStatement(d1, 'me', { kind: 'invite', key: 'invite:fr', actorId: 'fr', ref: 't1', params: { table: 'Royal' }, now: NOW - 5 * MIN }).run();
    expect(await list()).toMatchObject([{ kind: 'invite', state: 'open', params: { table: 'Royal' }, href: '/friends/fr' }]);
    expect((await list('me', {}, NOW + 30 * MIN))[0]!.state).toBe('expired');
    db.prepare(`UPDATE tables SET entry_blocked = 1`).run();
    expect((await list())[0]!.state).toBe('expired');
  });

  it('shows a tournament invite as open while a seat is left, done once the member is in, and expired otherwise', async () => {
    const { db, d1, list } = setup();
    tournament(db, TID, 'registering');
    await inboxStatement(d1, 'me', { kind: 'tournament_invite', key: 'tournament_invite:fr', actorId: 'fr', ref: TID, params: { name: 'Sunday' }, now: NOW - MIN }).run();
    expect(await list()).toMatchObject([{ kind: 'tournament_invite', state: 'open', params: { name: 'Sunday' }, actor: { id: 'fr' }, href: `/tournaments/${TID}` }]);
    expect(await list('me', { filter: 'game' })).toHaveLength(1);
    const entry = (u: string, status: string) =>
      db.prepare(`INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at) VALUES (?1, ?2, ?3, 1) ON CONFLICT DO UPDATE SET status = excluded.status`).run(TID, u, status);
    // Every seat taken by others: nothing to answer any more.
    db.prepare(`UPDATE tournaments SET capacity = 2`).run();
    entry('fr', 'registered');
    entry('ot', 'registered');
    expect((await list())[0]!.state).toBe('expired');
    entry('ot', 'unregistered');
    expect((await list())[0]!.state).toBe('open');
    entry('me', 'registered');
    expect((await list())[0]!.state).toBe('done');
    // Played and out: still done (it was taken up); withdrawn before the start, and registration over: expired.
    db.prepare(`UPDATE tournaments SET status = 'running'`).run();
    entry('me', 'eliminated');
    expect((await list())[0]!.state).toBe('done');
    entry('me', 'unregistered');
    expect((await list())[0]!.state).toBe('expired');
  });

  it('lists the personal messages as one item, read by a marker until a newer one arrives', async () => {
    const { db, d1, one, unread } = setup();
    message(db, 'm1', NOW - 5 * MIN);
    message(db, 'm2', NOW - 4 * MIN);
    message(db, 'm0', NOW - 40 * DAY);
    expect(await one('message')).toMatchObject({ id: 'message', count: 2, readAt: null, at: NOW - 4 * MIN, href: '/messages' });
    expect(await unread()).toBe(1);

    await d1.batch(inboxMarkRead(d1, 'me', [{ id: 'message', kind: 'message', at: NOW - 4 * MIN }], NOW - 3 * MIN));
    expect(await one('message')).toMatchObject({ readAt: NOW - 3 * MIN });
    expect(await unread()).toBe(0);
    // The messages themselves stay unread in their own page (the badge on the mail icon counts them).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL`).all()[0]!.n).toBe(3);

    message(db, 'm3', NOW - 2 * MIN);
    expect(await one('message')).toMatchObject({ count: 1, readAt: null, at: NOW - 2 * MIN });
    // Read where it lives: nothing new is unread.
    db.prepare(`UPDATE messages SET read_at = ?1 WHERE id = 'm3'`).run(NOW - MIN);
    expect((await one('message'))!.readAt).not.toBeNull();
  });

  it('a row counted again after the items were read back stays unread: the member did not see the second', async () => {
    const { db, d1, one, unread } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const ask = (at: number) => inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: at }).run();
    await ask(NOW - 3 * MIN);
    const seen = (await one('friend_request'))!;
    // Read back at NOW; the same friend asks again a moment later, before the read's batch runs.
    await ask(NOW + 1_000);
    await d1.batch(inboxMarkRead(d1, 'me', [seen], NOW));
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: null, at: NOW + 1_000 });
    expect(await unread('me', NOW + 2_000)).toBe(1);

    // Read back after it: read.
    await d1.batch(inboxMarkRead(d1, 'me', [(await one('friend_request'))!], NOW + 2_000));
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: NOW + 2_000 });
  });

  it('a row counted again by a request that took its time before the read, and wrote after it, stays unread too', async () => {
    const { db, d1, one, unread } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const ask = (at: number) => inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: at }).run();
    await ask(NOW - 3 * MIN);
    const seen = (await one('friend_request'))!;
    // The second request's time is before NOW (the read's), but its write lands after the items were read back.
    await ask(NOW - 1_000);
    await d1.batch(inboxMarkRead(d1, 'me', [seen], NOW));
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: null });
    expect(await unread('me', NOW + 2_000)).toBe(1);
  });

  it('a row counted again in the same millisecond as the one the member saw stays unread: its time moved on', async () => {
    const { db, d1, one } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const ask = (at: number) => inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: at }).run();
    await ask(NOW - 3 * MIN);
    const seen = (await one('friend_request'))!;
    await ask(NOW - 3 * MIN);
    await d1.batch(inboxMarkRead(d1, 'me', [seen], NOW));
    expect(await one('friend_request')).toMatchObject({ count: 2, readAt: null, at: NOW - 3 * MIN + 1 });
  });

  it('a row read in another tab and asked again in the same millisecond stays unread when this tab marks the old one', async () => {
    const { db, d1, one } = setup();
    friendship(db, 'fr', 'me', 'pending');
    const ask = (at: number) => inboxStatement(d1, 'me', { kind: 'friend_request', key: 'friend_request:fr', actorId: 'fr', now: at }).run();
    await ask(NOW - 3 * MIN);
    const seen = (await one('friend_request'))!;
    // Another tab marks it read, a request timed in the same millisecond lands after (count 1 again), and this tab's
    // marking of what it read comes last.
    await d1.batch(inboxMarkRead(d1, 'me', [seen], NOW));
    await ask(NOW - 3 * MIN);
    await d1.batch(inboxMarkRead(d1, 'me', [seen], NOW + 1_000));
    expect(await one('friend_request')).toMatchObject({ count: 1, readAt: null });
  });

  it('lists a tournament notice as its message, and reading it reads the message', async () => {
    const { db, d1, list, one } = setup();
    tournament(db, TID, 'running');
    message(db, `tn:${TID}:started:me`, NOW - 2 * MIN);
    message(db, `tn:tngone000001:aborted:me`, NOW - MIN);
    const items = await list();
    expect(items.map((i) => i.kind)).toEqual(['tournament_cancel', 'tournament_start']);
    expect(items[0]).toMatchObject({ params: { name: null, aborted: true }, state: null, href: '/tournaments/tngone000001' });
    expect(items[1]).toMatchObject({ id: `tn:${TID}:started:me`, params: { name: 'Sunday', aborted: false }, state: 'open', href: `/tournaments/${TID}` });
    // Not counted again in the personal messages' item.
    expect(await one('message')).toBeUndefined();

    await d1.batch(inboxMarkRead(d1, 'me', [items[1]!], NOW));
    expect(db.prepare(`SELECT read_at AS r FROM messages WHERE id = ?1`).all(`tn:${TID}:started:me`)[0]!.r).toBe(NOW);
    db.prepare(`UPDATE tournaments SET status = 'finished' WHERE id = ?1`).run(TID);
    expect((await list())[1]).toMatchObject({ readAt: NOW, state: 'done' });
  });

  it('reads all of a long list in statements D1 takes (no more than 100 values each)', async () => {
    const { db, d1, list, unread } = setup();
    tournament(db, TID, 'running');
    for (let i = 0; i < 150; i++) {
      db.prepare(
        `INSERT INTO notifications (id, user_id, kind, key, actor_id, count, created_at, updated_at, expires_at) VALUES (?1, 'me', 'friend_request', ?1, 'fr', 1, ?2, ?2, ?3)`,
      ).run(`n${String(i).padStart(3, '0')}`, NOW - i * MIN, NOW + DAY);
      message(db, `tn:${TID}:started:me${i}`, NOW - i * MIN);
    }
    const items = (await inboxPage(d1, 'me', NOW, { limit: 500 }).all<InboxRowOut>()).results.map((r) => toInboxItem(r, NOW));
    expect(items).toHaveLength(300);
    await d1.batch(inboxMarkRead(d1, 'me', items, NOW));
    expect(await unread()).toBe(0);
    expect((await list()).every((i) => i.readAt === NOW)).toBe(true);
  });

  it('lists service notices that have started, read by a marker until they change', async () => {
    const { db, d1, list, unread } = setup();
    const notice = (id: string, startsAt: number, extra = '') =>
      db
        .prepare(`INSERT INTO service_notices (id, kind, title_ko, title_en, starts_at, created_by, updated_at${extra ? ', deleted_at' : ''}) VALUES (?1, 'info', '점검', 'Notice', ?2, 'me', ?2${extra ? ', ?2' : ''})`)
        .run(id, startsAt);
    notice('s1', NOW - 10 * MIN);
    notice('s2', NOW + 10 * MIN);
    notice('s3', NOW - 10 * MIN, 'deleted');
    expect(await list()).toMatchObject([{ id: 'notice:s1', kind: 'notice', readAt: null, params: { titleKo: '점검', titleEn: 'Notice', urgent: false, postId: null }, href: null }]);
    expect(await list('fr')).toHaveLength(1);

    await d1.batch(inboxMarkRead(d1, 'me', [{ id: 'notice:s1', kind: 'notice', at: NOW - 10 * MIN }], NOW - 5 * MIN));
    expect(await unread()).toBe(0);
    expect(await unread('fr')).toBe(1);
    db.prepare(`UPDATE service_notices SET updated_at = ?1 WHERE id = 's1'`).run(NOW - MIN);
    expect(await list()).toMatchObject([{ id: 'notice:s1', readAt: null, at: NOW - MIN }]);
  });

  it('lists maintenance windows with whether they are ahead, over or called off', async () => {
    const { db, list } = setup();
    const window = (id: string, startsAt: number, endsAt: number, set = '') => {
      db.prepare(`INSERT INTO maintenance_windows (id, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'me', ?4, ?4)`).run(id, startsAt, endsAt, NOW - DAY);
      if (set) db.prepare(`UPDATE maintenance_windows SET ${set} WHERE id = ?1`).run(id);
    };
    window('w1', NOW + 60 * MIN, NOW + 120 * MIN);
    window('w2', NOW - 120 * MIN, NOW - 60 * MIN);
    window('w3', NOW + 60 * MIN, NOW + 120 * MIN, `cancelled_at = ${NOW - MIN}, updated_at = ${NOW - MIN}`);
    const items = Object.fromEntries((await list()).map((i) => [i.id, i]));
    expect(items['maintenance:w1']).toMatchObject({ state: 'open', at: NOW - DAY, params: { blockLogin: false } });
    expect(items['maintenance:w2']).toMatchObject({ state: 'done', at: NOW - 120 * MIN });
    expect(items['maintenance:w3']).toMatchObject({ state: 'expired', at: NOW - MIN });
  });

  it('a notice or maintenance window that last changed before the member joined is listed read; a later change is news', async () => {
    const { db, list, unread } = setup();
    db.prepare(`UPDATE users SET created_at = ?1 WHERE id = 'me'`).run(NOW - 30 * MIN);
    db.prepare(`INSERT INTO service_notices (id, kind, title_ko, title_en, starts_at, created_by, updated_at) VALUES ('s1', 'info', '공지', 'Notice', ?1, 'fr', ?1)`).run(NOW - 60 * MIN);
    db.prepare(`INSERT INTO maintenance_windows (id, starts_at, ends_at, created_by, created_at, updated_at, cancelled_at) VALUES ('w1', ?1, ?2, 'fr', ?3, ?3, ?3)`).run(
      NOW + 60 * MIN,
      NOW + 120 * MIN,
      NOW - 45 * MIN,
    );
    expect(await list()).toMatchObject([
      { id: 'maintenance:w1', state: 'expired', readAt: NOW - 30 * MIN },
      { id: 'notice:s1', readAt: NOW - 30 * MIN },
    ]);
    expect(await unread()).toBe(0);
    // A member who was there already still has both to read.
    expect(await unread('fr')).toBe(2);
    // The notice changes after the member joined: news to them too.
    db.prepare(`UPDATE service_notices SET updated_at = ?1 WHERE id = 's1'`).run(NOW - 10 * MIN);
    expect(await list()).toMatchObject([{ id: 'notice:s1', readAt: null, at: NOW - 10 * MIN }, { id: 'maintenance:w1' }]);
    expect(await unread()).toBe(1);
  });

  it('filters by group, by unread, and pages newest first', async () => {
    const { db, d1, list } = setup();
    for (const [i, u] of ['fr', 'ot', 'bot'].entries()) await inboxStatement(d1, 'me', { kind: 'friend_request', key: `friend_request:${u}`, actorId: u, now: NOW - 10 + i }).run();
    await inboxStatement(d1, 'me', { kind: 'security', key: 'security:password:1', params: { event: 'password_change' }, now: NOW - 20 }).run();
    db.prepare(`INSERT INTO service_notices (id, kind, title_ko, title_en, starts_at, created_by, updated_at) VALUES ('s1', 'urgent', 'a', 'a', ?1, 'me', ?1)`).run(NOW - 30);
    await inboxReadStatement(d1, 'me', ['friend_request:ot'], NOW).run();

    expect((await list()).map((i) => i.kind)).toEqual(['friend_request', 'friend_request', 'friend_request', 'security', 'notice']);
    expect((await list('me', { filter: 'social' })).map((i) => i.actor?.id)).toEqual(['bot', 'ot', 'fr']);
    expect((await list('me', { filter: 'account' })).map((i) => i.kind)).toEqual(['security']);
    expect(await list('me', { filter: 'service' })).toMatchObject([{ kind: 'notice', params: { urgent: true } }]);
    expect((await list('me', { filter: 'game' })).length).toBe(0);
    expect((await list('me', { filter: 'social', unread: true })).map((i) => i.actor?.id)).toEqual(['bot', 'fr']);

    // A page of two: three rows come back (the third tells there is more); the next starts after the second.
    const first = await list('me', { limit: 2 });
    expect(first).toHaveLength(3);
    const next = await list('me', { limit: 2, before: { at: first[1]!.at, id: first[1]!.id } });
    expect(next.map((i) => i.id)).toEqual([first[2]!.id, ...(await list()).slice(3).map((i) => i.id)]);
  });

  it('pages items of the same time by id, without skipping or repeating one', async () => {
    const { d1, list } = setup();
    for (const u of ['fr', 'ot', 'bot']) await inboxStatement(d1, 'me', { kind: 'friend_request', key: `friend_request:${u}`, actorId: u, now: NOW }).run();
    const all = (await list()).map((i) => i.id);
    const a = await list('me', { limit: 1 });
    const b = await list('me', { limit: 1, before: { at: a[0]!.at, id: a[0]!.id } });
    const c = await list('me', { limit: 1, before: { at: b[0]!.at, id: b[0]!.id } });
    expect([a[0]!.id, b[0]!.id, c[0]!.id]).toEqual(all);
    expect(c).toHaveLength(1);
  });
});

describe('deviceLabel', () => {
  it('names the browser and system only', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome · Windows');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge · Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe(
      'Samsung Internet · Android',
    );
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox · macOS');
    expect(deviceLabel(undefined)).toBe('Other · Other');
  });
});
