/**
 * Hand review: a member's own bookmark, tags and memo on hands they were dealt into (PUT /api/me/hands/:id/note), the
 * hand list's filters and paging (GET /api/me/hands), the per-day save and failure counters and the kept-now totals in
 * operations statistics, and that no administrator screen, search or audit row carries what a member wrote.
 *
 * Hands are stored the way the game worker stores them, with their statistics already filled (pot_won set, so
 * HAND_STATS_SQL leaves them alone) and positions chosen per hand.
 */
import type { HandNoteDto, HandSummaryDto } from '@jc/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KST = 9 * HOUR;
const statsDay = (t: number) => Math.floor((t + KST) / DAY);

const admin = sharedAdmin();
const tag = uniq('hn');
const hid = (h: string) => `${tag}-${h}`;
const T0 = Date.now() - 40 * DAY;
/** The table's big blind is 10, so `pot` 1,200 is 120 BB. h4 and h5 ended at the same moment. */
const HANDS = [
  { h: 'h1', at: T0, pos: 'BTN', net: 50, pot: 300 },
  { h: 'h2', at: T0 + DAY, pos: 'SB', net: -20, pot: 100 },
  { h: 'h3', at: T0 + 2 * DAY, pos: 'BB', net: 0, pot: 600 },
  { h: 'h4', at: T0 + 3 * DAY, pos: 'BTN', net: 500, pot: 1200 },
  { h: 'h5', at: T0 + 3 * DAY, pos: 'CO', net: -100, pot: 250 },
  { h: 'h6', at: Date.now() - HOUR, pos: 'EP', net: 10, pot: 60 },
] as const;

type User = Awaited<ReturnType<typeof newUser>>;
let a: User;
let b: User;

beforeAll(async () => {
  [a, b] = await Promise.all([newUser(), newUser()]);
  const player = (h: string, user: string, seat: number, pos: string, net: number, pot: number, at: number) => {
    const won = net > 0 ? pot : 0;
    return `('${hid(h)}', '${user}', ${seat}, '["As","Kd"]', 1000, ${1000 + net}, ${net}, ${won}, NULL, NULL, NULL, 0, ${at}, '${pos}', 0, 0, 0, ${won})`;
  };
  await d1(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${hid('t')}', '${hid('t')}', 6, 5, 10, 200, 2000, 'closed', 'official');` +
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ` +
      HANDS.map((x, i) => `('${hid(x.h)}', '${hid('t')}', ${i + 1}, ${x.at - 60_000}, ${x.at}, '["2c","3d","4h","5s","6c"]', ${x.pot}, 'test', '{"actions":[]}')`).join(', ') +
      ';' +
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at, position, vpip, pfr, saw_flop, pot_won) VALUES ` +
      [...HANDS.map((x) => player(x.h, a.me.id, 0, x.pos, x.net, x.pot, x.at)), player('h1', b.me.id, 1, 'BB', -50, 300, T0)].join(', ') +
      ';',
  );
});

afterAll(async () => {
  await d1(
    `DELETE FROM hand_notes WHERE hand_id LIKE '${tag}-%'; DELETE FROM hand_players WHERE hand_id LIKE '${tag}-%'; DELETE FROM hands WHERE id LIKE '${tag}-%'; DELETE FROM tables WHERE id = '${hid('t')}';` +
      `DELETE FROM rate_limits WHERE key IN ('hand-note:${a.me.id}', 'hand-list:${a.me.id}');`,
  );
});

async function list(u: User, q = ''): Promise<HandSummaryDto[]> {
  const r = await u.client.get(`/api/me/hands?${q}`);
  expect(r.status, `${q} ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
}
/** The hands' short names (h1…h6) in the order listed. */
const names = (rows: { id: string }[]) => rows.map((r) => r.id.slice(tag.length + 1));
const listed = async (u: User, q: string) => names(await list(u, q));
const put = (u: User, h: string, body: unknown) => u.client.req('PUT', `/api/me/hands/${hid(h)}/note`, body);
async function saved(u: User, h: string, body: unknown): Promise<HandNoteDto> {
  const r = await put(u, h, body);
  expect(r.status, `${h} ${JSON.stringify(body)} ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
}
async function noteOf(u: User, h: string): Promise<HandNoteDto> {
  const r = await u.client.get(`/api/me/hands/${hid(h)}`);
  expect(r.status).toBe(200);
  return r.body.note;
}

/** Today's hand-note counters (they are added as saves arrive, never rolled up). */
async function counters() {
  const rows = await d1<{ metric: string; n: number }>(`SELECT metric, n FROM daily_stats WHERE day = ${statsDay(Date.now())} AND metric GLOB 'hn_*'`);
  return new Map(rows.map((r) => [r.metric, r.n]));
}
const METRICS = ['hn_bookmark', 'hn_tag', 'hn_memo', 'hn_fail_conflict', 'hn_fail_invalid', 'hn_fail_notfound', 'hn_fail_limit', 'hn_fail_error'];
const deltas = (before: Map<string, number>, after: Map<string, number>) => Object.fromEntries(METRICS.map((m) => [m, (after.get(m) ?? 0) - (before.get(m) ?? 0)]));

/** Fills `key`'s rate-limit window, away from the window's end so the next request falls in it. */
async function fillWindow(key: string, limit: number) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 100));
  const start = Date.now() - (Date.now() % 60_000);
  await d1(`INSERT INTO rate_limits (key, window_start, count) VALUES ('${key}', ${start}, ${limit}) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`);
}

describe('hand list', () => {
  it("lists only the member's own hands, newest first, and pages through hands that ended at the same moment", async () => {
    const p1 = await list(a, 'limit=2');
    expect(names(p1)).toEqual(['h6', 'h5']);
    const next = (rows: HandSummaryDto[]) => `limit=2&before=${rows.at(-1)!.endedAt}&beforeId=${rows.at(-1)!.id}`;
    const p2 = await list(a, next(p1));
    expect(names(p2)).toEqual(['h4', 'h3']);
    const p3 = await list(a, next(p2));
    expect(names(p3)).toEqual(['h2', 'h1']);
    expect(await list(a, next(p3))).toEqual([]);
    expect(p2[0]).toMatchObject({ position: 'BTN', bigBlind: 10, potTotal: 1200, net: 500, bookmarked: false, tags: [], hasMemo: false });
    expect(await listed(b, '')).toEqual(['h1']);
  });

  it('filters by period, position, result and pot size on the server, alone and together', async () => {
    expect(await listed(a, `from=${T0 + DAY}&to=${T0 + 3 * DAY}`)).toEqual(['h3', 'h2']);
    expect(await listed(a, 'position=BTN')).toEqual(['h4', 'h1']);
    expect(await listed(a, 'result=up')).toEqual(['h6', 'h4', 'h1']);
    expect(await listed(a, 'result=down')).toEqual(['h5', 'h2']);
    expect(await listed(a, 'result=even')).toEqual(['h3']);
    // Pot size in big blinds of the table: 20 BB is 200 chips here.
    expect(await listed(a, 'minPot=20')).toEqual(['h5', 'h4', 'h3', 'h1']);
    expect(await listed(a, 'minPot=50')).toEqual(['h4', 'h3']);
    expect(await listed(a, 'position=BTN&result=up&minPot=100')).toEqual(['h4']);
    // A filter keeps paging.
    const first = await list(a, 'position=BTN&limit=1');
    expect(names(first)).toEqual(['h4']);
    expect(await listed(a, `position=BTN&limit=1&before=${first[0]!.endedAt}&beforeId=${first[0]!.id}`)).toEqual(['h1']);
    // Another member's filters see only their own hand.
    expect(await listed(b, 'position=BB')).toEqual(['h1']);
    expect(await listed(b, 'position=BTN')).toEqual([]);
    for (const q of ['position=UTG', 'result=win', 'minPot=30', 'tag=funny', 'bookmarked=true', 'from=soon']) {
      const r = await a.client.get(`/api/me/hands?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('bad_request');
    }
    expect((await new Client().get('/api/me/hands?position=BTN')).status).toBe(401);
  });
});

describe('hand notes', () => {
  it('sets the bookmark and tags bit by bit, so concurrent saves of different tags all land; filters by them', async () => {
    const n = await saved(a, 'h3', { bookmarked: true });
    expect(n).toMatchObject({ bookmarked: true, tags: [], memo: null, rev: 0 });
    expect(n.updatedAt).toBeGreaterThan(0);
    // The same save again changes nothing.
    expect(await saved(a, 'h3', { bookmarked: true })).toMatchObject({ bookmarked: true, tags: [], memo: null, rev: 0 });

    const all = await Promise.all([put(a, 'h1', { tags: { bluff: true } }), put(a, 'h1', { tags: { hardCall: true } }), put(a, 'h1', { bookmarked: true })]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await noteOf(a, 'h1')).toMatchObject({ bookmarked: true, tags: ['bluff', 'hardCall'], memo: null, rev: 0 });
    // Only the tags sent change.
    expect(await saved(a, 'h1', { tags: { bluff: false, review: true } })).toMatchObject({ bookmarked: true, tags: ['review', 'hardCall'] });
    await saved(a, 'h4', { tags: { bigPot: true } });

    expect(await listed(a, 'bookmarked=1')).toEqual(['h3', 'h1']);
    expect(await listed(a, 'tag=bigPot')).toEqual(['h4']);
    expect(await listed(a, 'tag=hardCall')).toEqual(['h1']);
    expect(await listed(a, 'tag=bluff')).toEqual([]);
    expect(await listed(a, 'bookmarked=1&tag=review')).toEqual(['h1']);
    expect(await listed(a, 'bookmarked=1&position=BB')).toEqual(['h3']);
    const rows = await list(a, '');
    expect(rows.find((r) => r.id === hid('h1'))).toMatchObject({ bookmarked: true, tags: ['review', 'hardCall'], hasMemo: false });
    expect(rows.find((r) => r.id === hid('h2'))).toMatchObject({ bookmarked: false, tags: [], hasMemo: false });
  });

  it("keeps each member's notes their own: another member's hand is not found, a shared hand has a note each", async () => {
    for (const r of [await put(b, 'h2', { bookmarked: true }), await b.client.get(`/api/me/hands/${hid('h2')}`), await put(a, 'nope', { bookmarked: true })]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('not_found');
    }
    expect(await saved(b, 'h1', { bookmarked: false, tags: { review: true } })).toMatchObject({ bookmarked: false, tags: ['review'] });
    expect(await noteOf(a, 'h1')).toMatchObject({ bookmarked: true, tags: ['review', 'hardCall'] });
    expect(await listed(b, 'tag=review')).toEqual(['h1']);
    expect(await listed(b, 'bookmarked=1')).toEqual([]);
    expect((await new Client().req('PUT', `/api/me/hands/${hid('h1')}/note`, { bookmarked: true })).status).toBe(401);
  });

  it('saves a memo only over the revision it was written on: a stale or simultaneous save is refused with the saved one', async () => {
    expect(await saved(a, 'h2', { memo: '  first look  ', rev: 0 })).toMatchObject({ memo: 'first look', rev: 1 });
    const stale = await put(a, 'h2', { memo: 'from another tab', rev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('note_conflict');
    expect(stale.body.error.details.note).toMatchObject({ memo: 'first look', rev: 1 });

    const race = await Promise.all([put(a, 'h2', { memo: 'tab one', rev: 1 }), put(a, 'h2', { memo: 'tab two', rev: 1 })]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const won = race.find((r) => r.status === 200)!.body as HandNoteDto;
    expect(await noteOf(a, 'h2')).toMatchObject({ memo: won.memo, rev: 2 });

    // A revision the hand never had: nothing is written.
    const ahead = await put(a, 'h5', { memo: 'too new', rev: 3 });
    expect(ahead.status).toBe(409);
    expect(ahead.body.error.details.note).toMatchObject({ memo: null, rev: 0 });
    expect(await noteOf(a, 'h5')).toEqual({ bookmarked: false, tags: [], memo: null, rev: 0, updatedAt: null });

    // Bookmark and tags need no revision and leave the memo alone; an empty memo removes it.
    expect(await saved(a, 'h2', { bookmarked: true })).toMatchObject({ bookmarked: true, memo: won.memo, rev: 2 });
    expect((await list(a, '')).find((r) => r.id === hid('h2'))?.hasMemo).toBe(true);
    expect(await saved(a, 'h2', { memo: '   ', rev: 2 })).toMatchObject({ memo: null, rev: 3 });
    expect((await list(a, '')).find((r) => r.id === hid('h2'))?.hasMemo).toBe(false);
    // The longest memo allowed, in Korean.
    expect((await saved(a, 'h2', { memo: '가'.repeat(500), rev: 3 })).memo).toHaveLength(500);

    for (const body of [{}, { memo: 'no revision' }, { memo: 'x'.repeat(501), rev: 4 }, { tags: { funny: true } }, { bookmarked: 'yes' }, { bookmarked: true, extra: 1 }, { tags: {} }, { memo: 'x', rev: -1 }]) {
      const r = await put(a, 'h2', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await noteOf(a, 'h2')).toMatchObject({ rev: 4 });
  });

  it('counts saves per kind and refusals per reason for the day, nothing else', async () => {
    const before = await counters();
    await saved(a, 'h6', { bookmarked: true });
    await saved(a, 'h6', { tags: { review: true } });
    await saved(a, 'h6', { memo: 'counted', rev: 0 });
    await saved(a, 'h6', { bookmarked: false, tags: { bluff: true }, memo: 'again', rev: 1 });
    expect((await put(a, 'h6', { memo: 'stale', rev: 0 })).status).toBe(409);
    expect((await put(a, 'h6', {})).status).toBe(400);
    expect((await put(b, 'h6', { bookmarked: true })).status).toBe(404);
    expect(deltas(before, await counters())).toEqual({
      hn_bookmark: 2,
      hn_tag: 2,
      hn_memo: 2,
      hn_fail_conflict: 1,
      hn_fail_invalid: 1,
      hn_fail_notfound: 1,
      hn_fail_limit: 0,
      hn_fail_error: 0,
    });
  });

  it('rate limits saves and filtered lists per member, and counts the refused save', async () => {
    const before = await counters();
    await fillWindow(`hand-note:${a.me.id}`, 60);
    const r = await put(a, 'h6', { bookmarked: true });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(deltas(before, await counters())).toMatchObject({ hn_fail_limit: 1, hn_bookmark: 0 });

    await fillWindow(`hand-list:${a.me.id}`, 60);
    expect((await a.client.get('/api/me/hands?position=BTN')).status).toBe(429);
    // The plain list (paging only) is not limited.
    expect(names(await list(a, 'limit=1'))).toEqual(['h6']);
    await d1(`DELETE FROM rate_limits WHERE key IN ('hand-note:${a.me.id}', 'hand-list:${a.me.id}')`);
    expect(names(await list(a, 'position=BTN'))).toEqual(['h4', 'h1']);
  });
});

describe('administrators', () => {
  it('see counts only: no screen, search, audit row or statistic carries what a member wrote', async () => {
    // The memo carries a marker no response may contain, and a word the operator searches for: the search's own
    // query is audited as typed, so it is not the marker.
    const marker = `MEMO-${tag}`;
    const word = `find${tag}`;
    expect(await saved(a, 'h3', { memo: `secret ${marker} ${word}`, rev: 0 })).toMatchObject({ memo: `secret ${marker} ${word}` });

    const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
    if (!until || until - Date.now() < 60_000) expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const seen = [
      await admin.get(`/api/admin/hands/${hid('h3')}`),
      await admin.get(`/api/admin/hands?userId=${a.me.id}`),
      await admin.get(`/api/admin/users/${a.me.id}`),
      await admin.get(`/api/admin/users?q=${word}`),
      await admin.get('/api/admin/audit?limit=50'),
      await admin.get('/api/admin/stats?unit=day&n=7'),
    ];
    for (const r of seen) {
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(marker);
      expect(text).not.toContain('hardCall');
    }
    expect(seen[3]!.body).toEqual([]);
    // The hand audit is unchanged: hole cards for the audit, no note fields.
    expect(seen[0]!.body.players[0]).not.toHaveProperty('note');
    const [audited] = await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE detail LIKE '%${marker}%' OR detail LIKE '%hand_notes%'`);
    expect(audited!.n).toBe(0);

    // Kept now: one pass over every member's notes, as counts.
    const stats = seen[5]!.body;
    const [now] = await d1<{ members: number; bookmarked: number; tagged: number; memos: number }>(
      `SELECT count(DISTINCT user_id) AS members, coalesce(sum(bookmarked), 0) AS bookmarked, coalesce(sum(tags != 0), 0) AS tagged, coalesce(sum(memo IS NOT NULL), 0) AS memos FROM hand_notes`,
    );
    expect(stats.handNotesNow).toEqual(now);
    expect(Object.keys(stats.total.handNotes).sort()).toEqual([...METRICS].sort());
  });

  it('keep the per-day counters when days are rolled up again', async () => {
    const yesterday = statsDay(Date.now()) - 1;
    const read = async () => (await d1<{ n: number }>(`SELECT n FROM daily_stats WHERE day = ${yesterday} AND metric = 'hn_memo'`))[0]?.n ?? 0;
    await d1(`INSERT INTO daily_stats (day, metric, n) VALUES (${yesterday}, 'hn_memo', 7) ON CONFLICT (day, metric) DO UPDATE SET n = n + 7`);
    const kept = await read();
    try {
      await d1(`INSERT INTO daily_stats (day, metric, n) VALUES (0, 'rolled_through', ${yesterday - 1}) ON CONFLICT (day, metric) DO UPDATE SET n = excluded.n`);
      const r = await admin.get('/api/admin/stats?unit=day&n=1');
      expect(r.status).toBe(200);
      expect(r.body.rolled).toMatchObject({ days: 1 });
      expect(await read()).toBe(kept);
      expect(r.body.periods[0].handNotes.hn_memo).toBe(kept);
    } finally {
      await d1(`UPDATE daily_stats SET n = n - 7 WHERE day = ${yesterday} AND metric = 'hn_memo'; DELETE FROM daily_stats WHERE day = ${yesterday} AND metric = 'hn_memo' AND n = 0`);
    }
  });
});

describe('withdrawal', () => {
  it("deletes the member's notes and leaves other members' notes on the same hand", async () => {
    const count = async (u: User) => (await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM hand_notes WHERE user_id = '${u.me.id}'`))[0]!.n;
    expect(await count(a)).toBeGreaterThan(3);
    expect(await count(b)).toBe(1);
    expect((await a.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(1);
    expect(await noteOf(b, 'h1')).toMatchObject({ tags: ['review'] });
  });
});
