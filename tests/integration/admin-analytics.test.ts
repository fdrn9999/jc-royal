/**
 * Operations statistics (GET /api/admin/stats): the daily rollup from accounts, seats, hands, reports and activity
 * markers, the page's answers, the markers written when a member signs in or comes back on a new day, the Academy day
 * counters, and the clean-up of old markers.
 *
 * The shared database holds other files' records too, so a window of past days is rolled up before and after this
 * file's own records are added and the difference is checked. Moving the rolled-through marker back makes the next
 * page view (or the cron) roll the window up again; a day is replaced whole, so doing it twice changes nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KST = 9 * HOUR;
const statsDay = (t: number) => Math.floor((t + KST) / DAY);
const at = (day: number, hour: number, min = 0) => day * DAY - KST + hour * HOUR + min * 60_000;
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

const admin = sharedAdmin();
const today = statsDay(Date.now());
const yesterday = today - 1;
/** The window rolled up: W0..yesterday, nine days (one rollup chunk). */
const W0 = today - 9;
/** u1 and u2 sign up on D1, whose first week ends on the window's last day; u3 the day after. */
const D1 = W0 + 1;
const D4 = D1 + 3;
const tag = uniq('st');
const id = { u1: `${tag}-u1`, u2: `${tag}-u2`, u3: `${tag}-u3`, off: `${tag}-off`, mem: `${tag}-mem`, bot: `${tag}-bot`, idle: `${tag}-idle` };

type Rows = Map<string, number>;
async function windowRows(): Promise<Rows> {
  const rows = await d1<{ day: number; metric: string; n: number }>(`SELECT day, metric, n FROM daily_stats WHERE day BETWEEN ${W0} AND ${yesterday}`);
  return new Map(rows.map((r) => [`${r.day}:${r.metric}`, r.n]));
}

/** Rolled up through the day before the window, activity recorded from its first day. */
async function rewind() {
  await d1(
    `INSERT INTO daily_stats (day, metric, n) VALUES (0, 'rolled_through', ${W0 - 1}) ON CONFLICT (day, metric) DO UPDATE SET n = excluded.n;` +
      `INSERT INTO daily_stats (day, metric, n) VALUES (0, 'activity_since', ${W0}) ON CONFLICT (day, metric) DO UPDATE SET n = MIN(n, excluded.n);`,
  );
}

async function page(query = 'unit=day&n=9') {
  const r = await admin.get(`/api/admin/stats?${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function markers(userId: string) {
  return (await d1<{ day: number }>(`SELECT day FROM active_days WHERE user_id = '${userId}' ORDER BY day`)).map((r) => r.day);
}

/** The marker is written after the response (waitUntil). */
async function waitForMarker(userId: string, day: number) {
  for (let i = 0; i < 20; i++) {
    if ((await markers(userId)).includes(day)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no activity marker for ${userId} on ${iso(day)}`);
}

async function seed() {
  const user = (u: string, created: number) => `('${u}', '${u}@test.dev', '${u.slice(-14)}', 'x', ${created}, ${created})`;
  const table = (t: string, room: string) => `('${t}', '${t}', 6, 5, 10, 200, 2000, 'closed', '${room}')`;
  const seat = (s: string, t: string, u: string, a: number, b: number) => `('${tag}-${s}', '${t}', '${u}', 0, 300, 300, 'closed', ${a}, ${b})`;
  const hand = (h: string, t: string, ended: number, bots = 0) => `('${tag}-${h}', '${t}', 1, ${ended - 60_000}, ${ended}, '[]', 30, 'test', '[]', ${bots})`;
  await d1(
    `INSERT INTO users (id, email, nickname, password_hash, created_at, updated_at) VALUES ${user(id.u1, at(D1, 10))}, ${user(id.u2, at(D1, 11))}, ${user(id.u3, at(D1 + 1, 9))};` +
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ${table(id.off, 'official')}, ${table(id.mem, 'member')}, ${table(id.bot, 'official')};` +
      // u1 sits within a day of signing up, u2 within a week, u3 (whose week is not over) the next day.
      `INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, cash_out, status, created_at, closed_at) VALUES
         ${seat('s1', id.off, id.u1, at(D1, 10, 30), at(D1, 11, 30))}, ${seat('s2', id.mem, id.u2, at(D4, 20), at(D4, 20, 30))},
         ${seat('s3', id.mem, id.u1, at(D4, 20, 10), at(D4, 21, 10))}, ${seat('s4', id.off, id.u3, at(D1 + 1, 13), at(D1 + 1, 13, 10))};` +
      // Hands with table bots on D4: one, then two at the same table, three at another (bots sit at official tables only).
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log, bots) VALUES
         ${hand('h1', id.off, at(D1, 11))}, ${hand('h2', id.off, at(D1, 11, 5))}, ${hand('h3', id.off, at(D1, 11, 10))},
         ${hand('h4', id.mem, at(D4, 20, 20))}, ${hand('h5', id.mem, at(D4, 20, 25))},
         ${hand('h6', id.off, at(D4, 15), 1)}, ${hand('h7', id.off, at(D4, 15, 5), 2)}, ${hand('h8', id.bot, at(D4, 15, 10), 3)};` +
      `INSERT INTO reports (id, reporter_id, target_type, target_id, target_user_id, reason, status, handled_at, created_at) VALUES
         ('${tag}-r1', '${id.u2}', 'user', '${id.u1}', '${id.u1}', 'spam', 'resolved', ${at(D1 + 1, 12)}, ${at(D1, 12)}),
         ('${tag}-r2', '${id.u1}', 'user', '${id.u2}', '${id.u2}', 'abuse', 'open', NULL, ${at(D4, 9)});` +
      `INSERT INTO active_days (day, user_id) VALUES (${D1}, '${id.u1}'), (${D1 + 1}, '${id.u1}'), (${D4}, '${id.u1}'), (${D4}, '${id.u2}');`,
  );
}

afterAll(async () => {
  await d1(
    `DELETE FROM hands WHERE id LIKE '${tag}-%'; DELETE FROM table_sessions WHERE id LIKE '${tag}-%'; DELETE FROM reports WHERE id LIKE '${tag}-%';` +
      `DELETE FROM tables WHERE id LIKE '${tag}-%'; DELETE FROM active_days WHERE user_id LIKE '${tag}-%'; DELETE FROM users WHERE id LIKE '${tag}-%';`,
  );
  // Rolls the window up again without this file's records.
  await rewind();
  await page();
});

describe('operations statistics', () => {
  it('rolls days up from the records, and rolling them up again changes nothing', async () => {
    await rewind();
    expect((await page()).rolled).toEqual({ days: 9, behind: 0 });
    const before = await windowRows();

    await seed();
    await rewind();
    const shown = await page();
    expect(shown.rolled).toEqual({ days: 9, behind: 0 });
    const after = await windowRows();
    const delta = (day: number, metric: string) => (after.get(`${day}:${metric}`) ?? 0) - (before.get(`${day}:${metric}`) ?? 0);

    // Sign-ups, and first games within a day / a week, kept on the sign-up day once its week has passed.
    expect([delta(D1, 'signups'), delta(D1 + 1, 'signups')]).toEqual([2, 1]);
    expect([delta(D1, 'cohort_play_1d'), delta(D1, 'cohort_play_7d')]).toEqual([1, 2]);
    expect(delta(D1 + 1, 'cohort_play_1d')).toBe(0); // u3 sat within a day, but its week is not over
    // Seats by room, counted and timed on the day they closed; hands and the tables that played them.
    expect([delta(D1, 'seats_official'), delta(D1, 'seat_ms_official'), delta(D1 + 1, 'seats_official')]).toEqual([1, HOUR, 1]);
    expect([delta(D4, 'seats_member'), delta(D4, 'seat_ms_member')]).toEqual([2, 90 * 60_000]);
    expect([delta(D1, 'hands_official'), delta(D1, 'tables_official'), delta(D4, 'hands_member'), delta(D4, 'tables_member')]).toEqual([3, 1, 2, 1]);
    // Hands a bot played in are counted apart whatever the number of bots: one row for the day, the tables once each.
    expect([delta(D4, 'hands_bots'), delta(D4, 'tables_bots'), delta(D4, 'hands_official'), delta(D4, 'tables_official')]).toEqual([3, 2, 0, 0]);
    // Concurrency: s2 and s3 overlap from 20:10 to 20:30.
    const peak = (day: number, metric: string, n: number) => {
      const was = before.get(`${day}:${metric}`) ?? 0;
      if (was === 0) expect(after.get(`${day}:${metric}`), `${iso(day)} ${metric}`).toBe(n);
      else expect(after.get(`${day}:${metric}`)).toBeGreaterThanOrEqual(n);
    };
    peak(D4, 'peak_h20', 2);
    peak(D4, 'peak_h21', 1);
    peak(D4, 'peak', 2);
    peak(D1, 'peak_h10', 1);
    peak(D1, 'peak_h11', 1);
    // Reports filed by day, and decided ones with the time they took, on the day of the decision.
    expect([delta(D1, 'reports'), delta(D4, 'reports'), delta(D1 + 1, 'handled'), delta(D1 + 1, 'handle_ms')]).toEqual([1, 1, 1, DAY]);
    // Active members: u1 is new on D1 and returning afterwards; the 7- and 30-day counts take each member once.
    expect([delta(D1, 'dau'), delta(D1, 'returning'), delta(D1 + 1, 'dau'), delta(D1 + 1, 'returning')]).toEqual([1, 0, 1, 1]);
    expect([delta(D4, 'dau'), delta(D4, 'returning'), delta(D4, 'wau'), delta(D4, 'mau')]).toEqual([2, 2, 2, 2]);
    expect([delta(yesterday, 'dau'), delta(yesterday, 'wau'), delta(yesterday, 'mau')]).toEqual([0, 2, 2]);

    // The page reads the same numbers: nine days ending yesterday, each rolled up.
    expect(shown.periods.map((p: { from: string }) => p.from)).toEqual(Array.from({ length: 9 }, (_, i) => iso(W0 + i)));
    expect(shown.rolledThrough).toBe(iso(yesterday));
    const p1 = shown.periods[1];
    expect(p1).toMatchObject({ from: iso(D1), days: 1, complete: true });
    expect(p1.members.signups).toBe(after.get(`${D1}:signups`));
    expect(p1.activation).toMatchObject({ cohort: after.get(`${D1}:signups`), play7d: after.get(`${D1}:cohort_play_7d`) });
    expect(p1.play.official.hands).toBe(after.get(`${D1}:hands_official`));
    expect(shown.hourly).toHaveLength(24);

    // Once more without changes: the same rows.
    await rewind();
    expect((await page()).rolled).toEqual({ days: 9, behind: 0 });
    expect(await windowRows()).toEqual(after);
    // Nothing left to roll up: the page only reads.
    expect((await page()).rolled).toBeNull();
    // Weeks and months over the same days.
    const weeks = await page('unit=week&n=2');
    expect(weeks.periods).toHaveLength(2);
    expect(weeks.periods[1].to).toBe(iso(yesterday));
    expect((await page('unit=month&n=1')).periods[0].from.slice(8)).toBe('01');
  });

  it('is for administrators only and refuses malformed periods', async () => {
    expect((await new Client('http://localhost:5174').get('/api/admin/stats')).status).toBe(401);
    const member = await newUser();
    expect((await member.client.get('/api/admin/stats')).status).toBeGreaterThanOrEqual(401);
    for (const q of ['unit=year', 'unit=__proto__', 'unit=day&n=0', 'unit=day&n=91', 'unit=week&n=27', 'unit=month&n=13', 'unit=day&n=abc']) {
      const r = await admin.get(`/api/admin/stats?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('invalid_input');
    }
  });

  it('marks a member active on signing in and on the first request of a new day, the day only', async () => {
    const u = await newUser();
    await waitForMarker(u.me.id, today);
    // A session last used yesterday: its first request today marks the day again (and slides the session).
    await d1(`DELETE FROM active_days WHERE user_id = '${u.me.id}'; UPDATE sessions SET last_seen_at = ${Date.now() - DAY} WHERE user_id = '${u.me.id}' AND kind = 'user';`);
    expect((await u.client.get('/api/auth/me')).status).toBe(200);
    await waitForMarker(u.me.id, today);
    const [s] = await d1<{ last_seen_at: number }>(`SELECT last_seen_at FROM sessions WHERE user_id = '${u.me.id}' AND kind = 'user'`);
    expect(Date.now() - s!.last_seen_at).toBeLessThan(DAY / 2);
    // Further requests the same day add nothing; the marker holds only the day and the member.
    expect((await u.client.get('/api/auth/me')).status).toBe(200);
    expect(await markers(u.me.id)).toEqual([today]);
    const cols = await d1<{ name: string }>(`SELECT name FROM pragma_table_info('active_days') ORDER BY cid`);
    expect(cols.map((c) => c.name)).toEqual(['day', 'user_id']);
  });

  it('counts Academy events per day, not per member', async () => {
    const u = await newUser();
    const read = async () =>
      new Map((await d1<{ metric: string; n: number }>(`SELECT metric, n FROM daily_stats WHERE day = ${statsDay(Date.now())} AND metric GLOB 'ac_*'`)).map((r) => [r.metric, r.n]));
    const before = await read();
    const events = [
      { kind: 'lesson', id: 'cards', phase: 'start' },
      { kind: 'lesson', id: 'cards', phase: 'complete' },
      { kind: 'scenario', id: 'E', phase: 'start' },
      { kind: 'question', id: 'c-heart', correct: true },
      { kind: 'question', id: 'h-kicker', correct: false },
    ];
    const r = await u.client.post('/api/academy/events', { events });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await read();
    const delta = (m: string) => (after.get(m) ?? 0) - (before.get(m) ?? 0);
    expect(['ac_lesson_start', 'ac_lesson_done', 'ac_scenario_start', 'ac_scenario_done', 'ac_answer', 'ac_correct'].map(delta)).toEqual([1, 1, 1, 0, 2, 1]);
  });

  it("deletes a member's activity markers when the member leaves", async () => {
    const u = await newUser();
    await waitForMarker(u.me.id, today);
    await d1(`INSERT INTO active_days (day, user_id) VALUES (${today - 3}, '${u.me.id}')`);
    expect((await u.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await markers(u.me.id)).toEqual([]);
  });

  it('rolls up in the daily cron, then deletes markers older than the retention', async () => {
    await d1(`INSERT INTO active_days (day, user_id) VALUES ${[40, 36, 35, 34, 1].map((n) => `(${today - n}, '${id.idle}')`).join(', ')}`);
    await rewind();
    // Local wrangler dev runs cron handlers only on request; this is the primary (API) worker's scheduled handler.
    const res = await fetch(`${BASE()}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('30 18 * * *')}`);
    expect(res.status, await res.text()).toBe(200);
    const [m] = await d1<{ n: number }>(`SELECT n FROM daily_stats WHERE day = 0 AND metric = 'rolled_through'`);
    expect(m!.n).toBe(yesterday);
    // Rolled up through yesterday, so the 30-day counts no longer need markers older than 35 days.
    expect(await markers(id.idle)).toEqual([today - 35, today - 34, today - 1]);
  });
});
