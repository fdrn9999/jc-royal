// Challenges (docs/CHALLENGES.md, packages/db/src/challengesSql.ts). On the real migration files in an in-memory SQLite:
// a challenge is completed at its target, at the time of the event that reached it, and once per period; never for a
// bot, from a private tournament or from a tournament the member never sat in; days and weeks are Korean, the week from
// Monday; the tenth completion gives the achievement; and every count reads an index. Against the server: a recorded
// hand completes the day's challenge from its settlement, opening the challenges judges what was missed but never
// twice, and the card shows the totals behind the member's achievements choice (withdrawal: privacy.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CHALLENGE_ACHIEVEMENT_AT, CHALLENGES, type ChallengesDto, type PlayerCardDto, type SocialSettingsDto } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { challengeAchievementSql, challengeCompletionSql, challengeProgressSql, challengeWindows } from '../../packages/db/src/challengesSql';
import { newUser } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const dir = new URL('../../packages/db/migrations/', import.meta.url);
function fresh() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) for (const stmt of readFileSync(new URL(f, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  return db;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 2026-11-02 00:00 in Korea, a Monday. */
const MONDAY = Date.UTC(2026, 10, 1, 15);

const user = (db: DatabaseSync, id: string, bot = false) =>
  db.prepare(`INSERT INTO users (id, email, nickname, password_hash, is_bot) VALUES (?1, ?2, ?1, 'x', ?3)`).run(id, `${id}@example.test`, bot ? 1 : 0);
const hand = (db: DatabaseSync, id: string, uid: string, at: number, showdown = false) =>
  db
    .prepare(`INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES (?1, ?2, 0, '[]', 100, 100, 0, 0, ?3, ?4)`)
    .run(id, uid, showdown ? 1 : 0, at);
const tournament = (db: DatabaseSync, id: string, startedAt: number, priv = false) =>
  db
    .prepare(
      `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms,
                                tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, started_at, is_private)
       VALUES (?1, ?1, 'running', 6, 2, 1500, '[]', 60000, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?2, ?3)`,
    )
    .run(id, startedAt, priv ? 1 : 0);
const entry = (db: DatabaseSync, t: string, uid: string, status: string) =>
  db.prepare(`INSERT INTO tournament_entries (tournament_id, user_id, status, registered_at) VALUES (?1, ?2, ?3, 0)`).run(t, uid, status);

/**
 * What challengeStatements (packages/db/src/challenges.ts, typed for D1) binds, run on node:sqlite: every challenge for
 * the day or week of `at`, then the achievement. The number of rows written.
 */
function judge(db: DatabaseSync, of: 'hand' | 'user', id: string, at: number) {
  const w = challengeWindows(at);
  let n = 0;
  for (const c of CHALLENGES) n += Number(db.prepare(challengeCompletionSql(c, of)).run(id, w[c.period].key, w[c.period].from, w[c.period].to).changes);
  return n + Number(db.prepare(challengeAchievementSql(of, CHALLENGE_ACHIEVEMENT_AT)).run(id).changes);
}
/** Every completion as `member code period at`, sorted. */
const done = (db: DatabaseSync) =>
  (db.prepare(`SELECT user_id AS u, code, period, completed_at AS at FROM challenge_completions ORDER BY u, code, period`).all() as { u: string; code: string; period: number; at: number }[]).map(
    (x) => `${x.u} ${x.code} ${x.period} ${x.at}`,
  );
const progress = (db: DatabaseSync, uid: string, period: 'day' | 'week', at: number) => {
  const w = challengeWindows(at)[period];
  return db.prepare(challengeProgressSql(CHALLENGES.filter((c) => c.period === period))).get(uid, w.from, w.to);
};

describe('challenge statements', () => {
  it('a recorded hand completes a challenge at its target, at the hand that reached it, once a day; never for a bot', () => {
    const db = fresh();
    user(db, 'm1');
    user(db, 'm2');
    user(db, 'bot', true);
    const t0 = MONDAY + 10 * HOUR;
    const day = challengeWindows(t0).day.key;
    for (let i = 1; i <= 9; i++) {
      hand(db, `h${i}`, 'm1', t0 + i * 1000, i <= 3);
      hand(db, `h${i}`, 'bot', t0 + i * 1000, true);
    }
    hand(db, 'h1', 'm2', t0 + 1000);
    // Nine hands, three of them shown down: the showdowns only, dated by the third.
    expect(judge(db, 'hand', 'h9', t0 + 9000)).toBe(1);
    expect(done(db)).toEqual([`m1 d_showdown_3 ${day} ${t0 + 3000}`]);
    expect(progress(db, 'm1', 'day', t0)).toEqual({ d_hands_10: 9, d_hands_30: 9, d_showdown_3: 3 });

    hand(db, 'h10', 'm1', t0 + 10_000);
    hand(db, 'h10', 'bot', t0 + 10_000);
    expect(judge(db, 'hand', 'h10', t0 + 10_000)).toBe(1);
    expect(done(db)).toEqual([`m1 d_hands_10 ${day} ${t0 + 10_000}`, `m1 d_showdown_3 ${day} ${t0 + 3000}`]);
    // Again, for another hand of the day or for the member: nothing more. A bot is never judged, even by its id.
    expect(judge(db, 'hand', 'h10', t0 + 10_000) + judge(db, 'hand', 'h1', t0 + 1000) + judge(db, 'user', 'm1', t0 + 20_000)).toBe(0);
    expect(judge(db, 'user', 'bot', t0 + 20_000)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM challenge_completions WHERE user_id = 'bot'`).get()).toEqual({ n: 0 });
    // The points are the catalogue's; the count never shows more than the target.
    expect(db.prepare(`SELECT SUM(points) AS p FROM challenge_completions WHERE user_id = 'm1'`).get()).toEqual({ p: 2 });
    for (let i = 11; i <= 40; i++) hand(db, `h${i}`, 'm1', t0 + i * 1000);
    expect(progress(db, 'm1', 'day', t0)).toEqual({ d_hands_10: 10, d_hands_30: 30, d_showdown_3: 3 });

    // The next day is another period: the same challenge again, with that day's number.
    for (let i = 1; i <= 10; i++) hand(db, `n${i}`, 'm1', t0 + DAY + i * 1000);
    expect(judge(db, 'user', 'm1', t0 + DAY + 20_000)).toBe(1);
    expect(done(db).filter((x) => x.includes('d_hands_10'))).toEqual([`m1 d_hands_10 ${day} ${t0 + 10_000}`, `m1 d_hands_10 ${day + 1} ${t0 + DAY + 10_000}`]);
  });

  it('a week runs from Monday to Sunday in Korea, and counts days with a hand', () => {
    const db = fresh();
    user(db, 'm1');
    const week = challengeWindows(MONDAY).week;
    expect(week.from).toBe(MONDAY);
    expect(week.to).toBe(MONDAY + 7 * DAY);
    // The Sunday before (the last moment of the week before), Monday twice, then Tuesday 08:00 (Monday still, in UTC).
    hand(db, 'p1', 'm1', MONDAY - 1);
    hand(db, 'a1', 'm1', MONDAY);
    hand(db, 'a2', 'm1', MONDAY + DAY - 1);
    hand(db, 'a3', 'm1', MONDAY + DAY + 8 * HOUR);
    expect(judge(db, 'user', 'm1', MONDAY + 3 * DAY)).toBe(0);
    expect(judge(db, 'user', 'm1', MONDAY - 1)).toBe(0);
    expect(progress(db, 'm1', 'week', MONDAY + 3 * DAY)).toEqual({ w_hands_100: 3, w_days_3: 2, w_tournaments_2: 0 });
    // Sunday's last moment is the third day of this week.
    hand(db, 's1', 'm1', MONDAY + 7 * DAY - 1);
    expect(judge(db, 'user', 'm1', MONDAY + 7 * DAY - 1)).toBe(1);
    expect(done(db)).toEqual([`m1 w_days_3 ${week.key} ${MONDAY + 7 * DAY - 1}`]);
    // The next Monday starts another week.
    hand(db, 'b1', 'm1', MONDAY + 7 * DAY);
    expect(challengeWindows(MONDAY + 7 * DAY).week.key).toBe(week.key + 1);
    expect(judge(db, 'user', 'm1', MONDAY + 7 * DAY)).toBe(0);
  });

  it('counts public tournaments the member sat in, from their start, never a private one or a seat never taken', () => {
    const db = fresh();
    user(db, 'm1');
    tournament(db, 'pub1', MONDAY + HOUR);
    entry(db, 'pub1', 'm1', 'eliminated');
    tournament(db, 'priv', MONDAY + 2 * HOUR, true);
    entry(db, 'priv', 'm1', 'won');
    tournament(db, 'gone', MONDAY + 3 * HOUR);
    entry(db, 'gone', 'm1', 'unregistered');
    tournament(db, 'old', MONDAY - HOUR);
    entry(db, 'old', 'm1', 'won');
    expect(judge(db, 'user', 'm1', MONDAY + DAY)).toBe(0);
    expect(progress(db, 'm1', 'week', MONDAY + DAY)).toMatchObject({ w_tournaments_2: 1 });
    tournament(db, 'pub2', MONDAY + 4 * DAY);
    entry(db, 'pub2', 'm1', 'playing');
    expect(judge(db, 'user', 'm1', MONDAY + 4 * DAY)).toBe(1);
    expect(done(db)).toEqual([`m1 w_tournaments_2 ${challengeWindows(MONDAY).week.key} ${MONDAY + 4 * DAY}`]);
  });

  it('the tenth completion gives the achievement, dated by it, once', () => {
    const db = fresh();
    user(db, 'm1');
    const add = (code: string, period: number, at: number) => db.prepare(`INSERT INTO challenge_completions (user_id, code, period, points, completed_at) VALUES ('m1', ?1, ?2, 1, ?3)`).run(code, period, at);
    const badge = () => db.prepare(`SELECT badge, awarded_at AS at FROM user_badges WHERE user_id = 'm1'`).all();
    // Inserted out of time order: the tenth by time is the one at 10_000.
    for (let i = 9; i >= 1; i--) add('d_hands_10', i, i * 1000);
    expect(judge(db, 'user', 'm1', MONDAY)).toBe(0);
    expect(badge()).toEqual([]);
    add('d_hands_10', 20, 20_000);
    add('d_showdown_3', 10, 10_000);
    expect(judge(db, 'user', 'm1', MONDAY)).toBe(1);
    expect(badge()).toEqual([{ badge: `play:challenges_${CHALLENGE_ACHIEVEMENT_AT}`, at: 10_000 }]);
    expect(judge(db, 'user', 'm1', MONDAY)).toBe(0);
  });

  it('reads each count on an index, never every hand or entry', () => {
    const db = fresh();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
    for (const of of ['hand', 'user'] as const) {
      for (const c of CHALLENGES) {
        const p = plan(challengeCompletionSql(c, of));
        expect(p.filter((d) => /^SCAN (x|t|te|hp|cc)\b/.test(d)), `${c.code} ${of}: ${p.join(' | ')}`).toEqual([]);
        expect(p.some((d) => d.includes(c.counts === 'tournaments' ? 'tournament_entries_user_idx' : 'hp_user_idx')), `${c.code} ${of}: ${p.join(' | ')}`).toBe(true);
      }
      const a = plan(challengeAchievementSql(of, CHALLENGE_ACHIEVEMENT_AT));
      expect(a.filter((d) => /^SCAN (cc|hp|b)\b/.test(d)), a.join(' | ')).toEqual([]);
    }
    const p = plan(challengeProgressSql(CHALLENGES));
    expect(p.filter((d) => /^SCAN (x|t|te)\b/.test(d)), p.join(' | ')).toEqual([]);
  });
});

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = { code: string; period: number; at: number };
const rows = (uid: string) => d1<Row>(`SELECT code, period, completed_at AS at FROM challenge_completions WHERE user_id = '${uid}' ORDER BY code`);

/** Hands `uid` played, recorded as the server records them (at a closed table of the test's own), at the times given. */
async function seedHands(uid: string, times: number[]) {
  const tag = Math.random().toString(36).slice(2, 8);
  const table = `it-chal-${tag}`;
  await d1(
    [
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${table}', '${table}', 6, 5, 10, 200, 2000, 'closed', 'official')`,
      ...times.flatMap((at, i) => [
        `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ('${table}-${i}', '${table}', ${i + 1}, ${at - 1000}, ${at}, '[]', 20, 'it', '{}')`,
        `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES ('${table}-${i}', '${uid}', 0, '[]', 1000, 1000, 0, 0, 0, ${at})`,
      ]),
    ].join('; '),
  );
}

/** Times earlier today, far enough from the day's end that the hands after them fall on the same day. */
async function today(n: number) {
  let now = Date.now();
  const end = challengeWindows(now).day.to;
  if (end - now < 120_000) {
    await sleep(end - now + 1000);
    now = Date.now();
  }
  const from = Math.max(challengeWindows(now).day.from, now - 60_000);
  return Array.from({ length: n }, (_, i) => from + i);
}

describe('challenges on the server', () => {
  it("a recorded hand's settlement completes the day's challenge; opening them counts it and judges again, never twice", async () => {
    const a = await newUser();
    const b = await newUser();
    await seedHands(a.me.id, await today(9));
    expect(await rows(a.me.id)).toEqual([]);

    const sit = async (u: typeof a, seatIndex: number) => {
      const ws = await TableSocket.open(u.client, 'it-chal-hu');
      open.push(ws);
      expect(await ws.request({ t: 'sit', seatIndex, buyIn: 300 })).toMatchObject({ t: 'ack' });
      await ws.waitState((s) => s.you.seatIndex === seatIndex);
      return ws;
    };
    const wa = await sit(a, 0);
    const wb = await sit(b, 1);
    const s = await wa.waitState((v) => v.status === 'playing' && !!v.hand && v.hand.actorSeat !== null, 20_000, 'hand dealt');
    const handId = s.hand!.id;
    await wb.waitState((v) => v.hand?.id === handId && v.hand.seq === s.hand!.seq, 15_000, 'same hand on both');
    const actorWs = isMyTurn(wa.state!) ? wa : wb;
    expect((await actorWs.act('fold')).result.t).toBe('state');
    await wa.waitState((v) => v.hand?.id !== handId || v.hand.stage === 'settled', 20_000, 'settled');

    // From the settlement (nobody asked yet): A's tenth hand of the day, dated by it; B's first gives nothing.
    let got: Row[] = [];
    for (const end = Date.now() + 20_000; got.length === 0 && Date.now() < end; await sleep(250)) got = await rows(a.me.id);
    const [tenth] = await d1<{ at: number }>(`SELECT ended_at AS at FROM hand_players WHERE hand_id = '${handId}' AND user_id = '${a.me.id}'`);
    expect(got).toEqual([{ code: 'd_hands_10', period: challengeWindows(tenth!.at).day.key, at: tenth!.at }]);
    expect(await rows(b.me.id)).toEqual([]);

    const mine = await a.client.get<ChallengesDto>('/api/me/challenges');
    expect(mine.status).toBe(200);
    const item = (code: string) => mine.body.items.find((x) => x.code === code);
    expect(item('d_hands_10')).toMatchObject({ done: true, progress: 10, target: 10, completedAt: tenth!.at, points: 1 });
    expect(item('d_hands_30')).toMatchObject({ done: false, progress: 10, target: 30, completedAt: null });
    expect(item('w_days_3')).toMatchObject({ done: false, progress: 1 });
    expect(mine.body).toMatchObject({ completed: 1, points: 1, recent: [{ code: 'd_hands_10', period: 'day', completedAt: tenth!.at, points: 1 }] });
    expect(mine.body.periods.map((p) => p.period)).toEqual(['day', 'week']);
    // Asking again judges again and finds nothing new.
    expect((await a.client.get<ChallengesDto>('/api/me/challenges')).body).toMatchObject({ completed: 1, points: 1 });
    expect(await rows(a.me.id)).toHaveLength(1);
    // A member only: no session, no challenges.
    expect((await new (await import('../support/client')).Client().get('/api/me/challenges')).status).toBe(401);
  });

  it('opening them judges hands whose settlement left them out; the card shows the totals as achievements are shown', async () => {
    const c = await newUser();
    const viewer = await newUser();
    await seedHands(c.me.id, await today(10));
    expect(await rows(c.me.id)).toEqual([]);
    const r = await c.client.get<ChallengesDto>('/api/me/challenges');
    expect(r.body).toMatchObject({ completed: 1, points: 1 });
    expect(await rows(c.me.id)).toHaveLength(1);

    const card = (u: typeof c) => u.client.get<PlayerCardDto>(`/api/players/${c.me.id}/card`);
    expect((await card(viewer)).body.challenges).toEqual({ completed: 1, points: 1 });
    expect((await c.client.patch<SocialSettingsDto>('/api/friends/settings', { showAchievements: false })).status).toBe(200);
    expect((await card(viewer)).body.challenges).toBeNull();
    // Their own card still shows them.
    expect((await card(c)).body.challenges).toEqual({ completed: 1, points: 1 });
  });
});
