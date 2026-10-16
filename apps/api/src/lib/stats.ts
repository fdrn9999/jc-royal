import { ACADEMY_METRICS, ACTIVE_DAYS_RETENTION, STATS_DAY, STATS_MARKER_DAY, STATS_TZ_OFFSET_MS, dayStart, statsDay } from '@jc/db';

/**
 * Operations statistics by day, week and month for the admin console (GET /api/admin/stats).
 *
 * Once a day (the cron trigger, before the housekeeping) the days that ended are rolled up into `daily_stats`, one
 * number per day and metric, from records the service keeps anyway: accounts (sign-ups, first seat), seats
 * (table_sessions: count, length, concurrency), hands, reports, and the activity markers of `active_days`. A day is
 * rolled up whole and replaced whole, so running it twice (the cron and an administrator opening the page at the same
 * time) writes the same numbers. The page reads only `daily_stats`.
 *
 * Cost of one day: every `tables` row once (hands are reached through hands_table_idx), the day's hands and closed
 * seats (tsess_closed_idx), the seats open during it, every `users` row once (no created_at index), the reports filed in it
 * (reports_created_idx) and every report once for the decided ones (no handled_at index), and the activity markers of
 * the 30 days before it.
 */

const DAY = STATS_DAY;
const HOUR = 3_600_000;

/** Days rolled up per call; a first run starts at the first sign-up, at most ROLLUP_BACKFILL_DAYS back. */
export const ROLLUP_CHUNK_DAYS = 31;
export const ROLLUP_BACKFILL_DAYS = 366;

const ROOMS = ['official', 'member'] as const;
type Room = (typeof ROOMS)[number];
const HOURS = Array.from({ length: 24 }, (_, h) => `peak_h${String(h).padStart(2, '0')}`);

/** First seat within a day / a week of signing up, kept on the sign-up day once the week has passed. */
const COHORT = { d1: 'cohort_play_1d', d7: 'cohort_play_7d' } as const;
export const COHORT_DAYS = 7;

/** Day-0 markers. */
const M = { rolledFrom: 'rolled_from', rolledThrough: 'rolled_through', activitySince: 'activity_since' } as const;

type Row = { day: number; metric: string; n: number };
type Rollup = { from: number; to: number; rowsRead: number; rowsWritten: number };

const rowsRead = (rs: D1Result[]) => rs.reduce((s, r) => s + (r.meta?.rows_read ?? 0), 0);

async function markers(db: D1Database) {
  const { results } = await db.prepare('SELECT metric, n FROM daily_stats WHERE day = ?1').bind(STATS_MARKER_DAY).all<{ metric: string; n: number }>();
  const get = (m: string) => results.find((r) => r.metric === m)?.n ?? null;
  return { rolledFrom: get(M.rolledFrom), rolledThrough: get(M.rolledThrough), activitySince: get(M.activitySince) };
}

/**
 * Concurrently open seats: for each hour from `start`, the most seats open at once. A seat is [a, b); `b` null is still
 * open. A seat closing at the instant another opens is not counted twice.
 */
export function hourlyPeaks(seats: { a: number; b: number | null }[], start: number, hours: number): number[] {
  const end = start + hours * HOUR;
  const events: [number, number][] = [];
  let open = 0;
  for (const s of seats) {
    const b = s.b ?? Infinity;
    if (b <= start || s.a >= end || b <= s.a) continue;
    if (s.a <= start) open++;
    else events.push([s.a, 1]);
    if (b < end) events.push([b, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = new Array<number>(hours).fill(0);
  let i = 0;
  for (let h = 0; h < hours; h++) {
    const hourEnd = start + (h + 1) * HOUR;
    // What changes on the hour itself belongs to this hour: a seat closed on it is not counted, one opened on it is.
    for (; i < events.length && events[i]![0] <= hourEnd - HOUR; i++) open += events[i]![1];
    let peak = open;
    for (; i < events.length && events[i]![0] < hourEnd; i++) {
      open += events[i]![1];
      if (open > peak) peak = open;
    }
    out[h] = peak;
  }
  return out;
}

/** Rolls up days `a`..`b` (inclusive): computes every metric, then replaces the days' rows in one batch. */
async function rollupSpan(db: D1Database, a: number, b: number, activitySince: number | null): Promise<Rollup> {
  const s = dayStart(a);
  const e = dayStart(b + 1);
  const tz = STATS_TZ_OFFSET_MS;
  const actFrom = activitySince === null ? null : Math.max(a, activitySince);
  const stmts = [
    // tables first (CROSS JOIN keeps the order), each table's hands of the span through hands_table_idx.
    db
      .prepare(
        `SELECT CAST((h.ended_at + ?3) / 86400000 AS INTEGER) AS day, t.room_type AS room, COUNT(*) AS n, COUNT(DISTINCT h.table_id) AS tables
           FROM tables t CROSS JOIN hands h ON h.table_id = t.id AND h.ended_at >= ?1 AND h.ended_at < ?2 GROUP BY day, room`,
      )
      .bind(s, e, tz),
    db
      .prepare(
        `SELECT CAST((s.closed_at + ?3) / 86400000 AS INTEGER) AS day, t.room_type AS room, COUNT(*) AS n, SUM(s.closed_at - s.created_at) AS ms
           FROM table_sessions s CROSS JOIN tables t ON t.id = s.table_id WHERE s.closed_at >= ?1 AND s.closed_at < ?2 GROUP BY day, room`,
      )
      .bind(s, e, tz),
    // Seats open at some point of the span: closed after it began (tsess_closed_idx), or still open.
    db
      .prepare(
        `SELECT created_at AS a, closed_at AS b FROM table_sessions WHERE closed_at >= ?1 AND created_at < ?2
         UNION ALL SELECT created_at AS a, NULL AS b FROM table_sessions WHERE status = 'seated' AND created_at < ?2`,
      )
      .bind(s, e),
    // Sign-ups, and whether each took a seat within a day / a week: from COHORT_DAYS before the span, whose week ends in it.
    db
      .prepare(
        `SELECT CAST((u.created_at + ?3) / 86400000 AS INTEGER) AS day, COUNT(*) AS n,
                SUM(EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = u.id AND s.created_at < u.created_at + 86400000)) AS d1,
                SUM(EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = u.id AND s.created_at < u.created_at + ?4)) AS d7
           FROM users u WHERE u.created_at >= ?1 AND u.created_at < ?2 GROUP BY day`,
      )
      .bind(s - COHORT_DAYS * DAY, e, tz, COHORT_DAYS * DAY),
    db.prepare(`SELECT CAST((created_at + ?3) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM reports WHERE created_at >= ?1 AND created_at < ?2 GROUP BY day`).bind(s, e, tz),
    db
      .prepare(
        `SELECT CAST((handled_at + ?3) / 86400000 AS INTEGER) AS day, COUNT(*) AS n, SUM(handled_at - created_at) AS ms
           FROM reports WHERE status IN ('resolved', 'dismissed') AND handled_at >= ?1 AND handled_at < ?2 GROUP BY day`,
      )
      .bind(s, e, tz),
  ];
  if (actFrom !== null && actFrom <= b) {
    // Per day: members active that day, of them those who signed up before it, and the distinct members of the 7 and
    // 30 days ending that day (each a range of the primary key).
    stmts.push(
      db
        .prepare(
          `WITH RECURSIVE d(day) AS (SELECT ?1 UNION ALL SELECT day + 1 FROM d WHERE day < ?2)
           SELECT d.day AS day,
                  (SELECT COUNT(*) FROM active_days WHERE day = d.day) AS dau,
                  (SELECT COUNT(*) FROM active_days x JOIN users u ON u.id = x.user_id WHERE x.day = d.day AND u.created_at < d.day * 86400000 - ?3) AS back,
                  (SELECT COUNT(DISTINCT user_id) FROM active_days WHERE day BETWEEN d.day - 6 AND d.day) AS wau,
                  (SELECT COUNT(DISTINCT user_id) FROM active_days WHERE day BETWEEN d.day - 29 AND d.day) AS mau
             FROM d`,
        )
        .bind(actFrom, b, tz),
    );
  }
  const res = await db.batch(stmts);
  const [hands, seats, open, users, created, handled, active] = res.map((r) => r.results as Record<string, number | string | null>[]);

  const rows: Row[] = [];
  const put = (day: number, metric: string, n: number | null | undefined) => {
    if (n) rows.push({ day, metric, n: Math.round(n) });
  };
  for (const r of hands!) {
    put(r.day as number, `hands_${r.room as Room}`, r.n as number);
    put(r.day as number, `tables_${r.room as Room}`, r.tables as number);
  }
  for (const r of seats!) {
    put(r.day as number, `seats_${r.room as Room}`, r.n as number);
    put(r.day as number, `seat_ms_${r.room as Room}`, r.ms as number);
  }
  const peaks = hourlyPeaks(open as { a: number; b: number | null }[], s, (b - a + 1) * 24);
  for (let d = a; d <= b; d++) {
    const day = peaks.slice((d - a) * 24, (d - a + 1) * 24);
    day.forEach((n, h) => put(d, HOURS[h]!, n));
    put(d, 'peak', Math.max(...day));
  }
  for (const r of users!) {
    const day = r.day as number;
    if (day >= a) put(day, 'signups', r.n as number);
    if (day <= b - COHORT_DAYS) {
      put(day, COHORT.d1, r.d1 as number);
      put(day, COHORT.d7, r.d7 as number);
    }
  }
  for (const r of created!) put(r.day as number, 'reports', r.n as number);
  for (const r of handled!) {
    put(r.day as number, 'handled', r.n as number);
    put(r.day as number, 'handle_ms', r.ms as number);
  }
  for (const r of active ?? []) {
    put(r.day as number, 'dau', r.dau as number);
    put(r.day as number, 'returning', r.back as number);
    put(r.day as number, 'wau', r.wau as number);
    put(r.day as number, 'mau', r.mau as number);
  }

  // Replaces the span's own rows: every metric of days a..b but the Academy and refill counters (added as events arrive)
  // and the cohorts (kept on their sign-up day), and the cohorts whose week ended in the span. Only non-zero numbers are kept.
  const write = await db.batch([
    db.prepare(`DELETE FROM daily_stats WHERE day BETWEEN ?1 AND ?2 AND metric NOT GLOB 'ac_*' AND metric NOT GLOB 'rf_*' AND metric NOT GLOB 'cohort_*'`).bind(a, b),
    db.prepare(`DELETE FROM daily_stats WHERE day BETWEEN ?1 AND ?2 AND metric GLOB 'cohort_*'`).bind(a - COHORT_DAYS, b - COHORT_DAYS),
    db
      .prepare(
        `INSERT INTO daily_stats (day, metric, n) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?1)`,
      )
      .bind(JSON.stringify(rows.map((r) => [r.day, r.metric, r.n]))),
    db.prepare(`INSERT INTO daily_stats (day, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (day, metric) DO UPDATE SET n = MIN(n, excluded.n)`).bind(STATS_MARKER_DAY, M.rolledFrom, a),
    db.prepare(`INSERT INTO daily_stats (day, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (day, metric) DO UPDATE SET n = MAX(n, excluded.n)`).bind(STATS_MARKER_DAY, M.rolledThrough, b),
  ]);
  return { from: a, to: b, rowsRead: rowsRead(res) + rowsRead(write), rowsWritten: write.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0) };
}

/**
 * Rolls up the days that ended and are not rolled up yet, `maxChunks` × ROLLUP_CHUNK_DAYS at most (the cron catches up
 * a year in one run; the stats page, which only fills a gap, one chunk). Also notes the first day with activity markers.
 */
export async function rollup(db: D1Database, { now = Date.now(), maxChunks = 1 } = {}) {
  const today = statsDay(now);
  const last = today - 1;
  const m = await markers(db);
  let activitySince = m.activitySince;
  if (activitySince === null) {
    const first = await db.prepare('SELECT MIN(day) AS d FROM active_days').first<{ d: number | null }>();
    if (first?.d != null) {
      await db.prepare('INSERT OR IGNORE INTO daily_stats (day, metric, n) VALUES (?1, ?2, ?3)').bind(STATS_MARKER_DAY, M.activitySince, first.d).run();
      activitySince = first.d;
    }
  }
  let from = m.rolledThrough === null ? null : m.rolledThrough + 1;
  if (from === null) {
    const first = await db.prepare('SELECT MIN(created_at) AS at FROM users').first<{ at: number | null }>();
    from = first?.at == null ? today : Math.max(statsDay(first.at), today - ROLLUP_BACKFILL_DAYS);
  }
  const spans: Rollup[] = [];
  for (let i = 0; i < maxChunks && from <= last; i++) {
    const to = Math.min(last, from + ROLLUP_CHUNK_DAYS - 1);
    spans.push(await rollupSpan(db, from, to, activitySince));
    from = to + 1;
  }
  return { spans, behind: from <= last ? last - from + 1 : 0 };
}

// ------------------------------------------------------------------ the page

export type StatsUnit = 'day' | 'week' | 'month';
export const STATS_UNITS: Record<StatsUnit, { default: number; max: number }> = {
  day: { default: 30, max: 90 },
  week: { default: 12, max: 26 },
  month: { default: 12, max: 12 },
};

export const isoDate = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
/** Monday of the day's week (day 0, 1970-01-01, was a Thursday). */
export const weekStart = (day: number) => day - ((day + 3) % 7);
export function monthStart(day: number, back = 0) {
  const d = new Date(day * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / DAY;
}

/** The buckets of the last `n` units ending on `last`: [first day, last day], the last one cut at `last`. */
export function buckets(unit: StatsUnit, n: number, last: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (unit === 'day') out.push([last - i, last - i]);
    else if (unit === 'week') {
      const a = weekStart(last) - 7 * i;
      out.push([a, Math.min(a + 6, last)]);
    } else {
      const a = monthStart(last, i);
      out.push([a, Math.min(monthStart(last, i - 1) - 1, last)]);
    }
  }
  return out;
}

export interface StatsMarkers {
  rolledFrom: number | null;
  rolledThrough: number | null;
  activitySince: number | null;
}

/** Sums, per-day averages, end-of-period and peak values of one period of daily rows (`get(day, metric)`). */
export function summarize(get: (day: number, metric: string) => number, a: number, b: number, natural: number, mk: StatsMarkers) {
  const covered = mk.rolledFrom === null || mk.rolledThrough === null ? null : ([Math.max(a, mk.rolledFrom), Math.min(b, mk.rolledThrough)] as const);
  const days = covered && covered[0] <= covered[1] ? covered[1] - covered[0] + 1 : 0;
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const dayList = days ? range(covered![0], covered![1]) : [];
  const sum = (metric: string, list = dayList) => list.reduce((s, d) => s + get(d, metric), 0);
  const perDay = (n: number, d: number) => (d ? Math.round((n / d) * 10) / 10 : null);

  const actDays = mk.activitySince === null ? [] : dayList.filter((d) => d >= mk.activitySince!);
  const lastAct = actDays.length ? actDays[actDays.length - 1]! : null;
  // A cohort counts once its week has passed and been rolled up.
  const cohortDays = mk.rolledThrough === null ? [] : dayList.filter((d) => d <= mk.rolledThrough! - COHORT_DAYS);
  const room = (r: Room) => ({ hands: sum(`hands_${r}`), tablesAvg: perDay(sum(`tables_${r}`), days), seats: sum(`seats_${r}`), seatMs: sum(`seat_ms_${r}`) });
  const official = room('official');
  const member = room('member');
  const hands = official.hands + member.hands;
  const seats = official.seats + member.seats;
  const handled = sum('handled');
  return {
    from: isoDate(a),
    to: isoDate(b),
    days,
    /** The period has ended and every day of it is rolled up. */
    complete: b === natural && days === b - a + 1,
    members: {
      signups: sum('signups'),
      dauAvg: perDay(sum('dau', actDays), actDays.length),
      returningAvg: perDay(sum('returning', actDays), actDays.length),
      wau: lastAct === null ? null : get(lastAct, 'wau'),
      mau: lastAct === null ? null : get(lastAct, 'mau'),
      /** Counted from markers that began on activitySince: the first day, and 7- or 30-day windows reaching before it. */
      partial: {
        dau: actDays.length > 0 && actDays[0] === mk.activitySince,
        wau: lastAct !== null && lastAct < mk.activitySince! + 6,
        mau: lastAct !== null && lastAct < mk.activitySince! + 29,
      },
      activityDays: actDays.length,
    },
    activation: { cohort: sum('signups', cohortDays), play1d: sum(COHORT.d1, cohortDays), play7d: sum(COHORT.d7, cohortDays), cohortDays: cohortDays.length },
    play: {
      hands,
      handsPerDay: perDay(hands, days),
      tablesAvg: perDay(sum('tables_official') + sum('tables_member'), days),
      seats,
      avgSeatMs: seats ? Math.round((official.seatMs + member.seatMs) / seats) : null,
      peak: days ? Math.max(...dayList.map((d) => get(d, 'peak'))) : null,
      official,
      member,
    },
    reports: { created: sum('reports'), handled, avgHandleMs: handled ? Math.round(sum('handle_ms') / handled) : null },
    // Counted as events arrive (not rolled up), so the days since they began, rolled up or not.
    academy: Object.fromEntries(ACADEMY_METRICS.map((k) => [k, sum(k, range(a, b))])) as Record<(typeof ACADEMY_METRICS)[number], number>,
  };
}
export type StatsPeriod = ReturnType<typeof summarize>;

/** The page: one entry per period, the whole range, and the hourly concurrency profile over the range's days. */
export function statsReport(rows: Row[], unit: StatsUnit, n: number, last: number, mk: StatsMarkers) {
  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(`${r.day}:${r.metric}`, r.n);
  const get = (day: number, metric: string) => byKey.get(`${day}:${metric}`) ?? 0;
  const list = buckets(unit, n, last);
  const natural = (a: number) => (unit === 'day' ? a : unit === 'week' ? a + 6 : monthStart(a, -1) - 1);
  const periods = list.map(([a, b]) => summarize(get, a, b, natural(a), mk));
  const from = list[0]![0];
  const total = summarize(get, from, last, last, mk);
  const days: number[] = [];
  if (mk.rolledFrom !== null && mk.rolledThrough !== null) for (let d = Math.max(from, mk.rolledFrom); d <= Math.min(last, mk.rolledThrough); d++) days.push(d);
  const hourly = HOURS.map((metric) => {
    const v = days.map((d) => get(d, metric));
    return { avg: v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null, max: v.length ? Math.max(...v) : null };
  });
  return {
    unit,
    n,
    from: isoDate(from),
    to: isoDate(last),
    tz: 'Asia/Seoul',
    utcOffsetMinutes: STATS_TZ_OFFSET_MS / 60_000,
    rolledFrom: mk.rolledFrom === null ? null : isoDate(mk.rolledFrom),
    rolledThrough: mk.rolledThrough === null ? null : isoDate(mk.rolledThrough),
    activitySince: mk.activitySince === null ? null : isoDate(mk.activitySince),
    retentionDays: ACTIVE_DAYS_RETENTION,
    periods,
    total,
    hourly,
  };
}

/** Reads the range's daily rows (one range of the primary key) and the markers, and builds the page. */
export async function operationsStats(db: D1Database, unit: StatsUnit, n: number, now = Date.now()) {
  const last = statsDay(now) - 1;
  const from = buckets(unit, n, last)[0]![0];
  const [rows, mk] = await db.batch([
    db.prepare('SELECT day, metric, n FROM daily_stats WHERE day BETWEEN ?1 AND ?2').bind(from, last),
    db.prepare('SELECT metric, n FROM daily_stats WHERE day = ?1').bind(STATS_MARKER_DAY),
  ]);
  const marks = (mk!.results as { metric: string; n: number }[]).reduce<StatsMarkers>(
    (o, r) => {
      if (r.metric === M.rolledFrom) o.rolledFrom = r.n;
      if (r.metric === M.rolledThrough) o.rolledThrough = r.n;
      if (r.metric === M.activitySince) o.activitySince = r.n;
      return o;
    },
    { rolledFrom: null, rolledThrough: null, activitySince: null },
  );
  return { ...statsReport(rows!.results as Row[], unit, n, last, marks), rowsRead: rowsRead([rows!, mk!]) };
}
