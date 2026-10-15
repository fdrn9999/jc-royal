import { dayStart, statsDay } from '@jc/db';
import { describe, expect, it } from 'vitest';
import { buckets, hourlyPeaks, isoDate, monthStart, statsReport, weekStart } from './stats';

const H = 3_600_000;
const day = (iso: string) => statsDay(Date.parse(`${iso}T00:00:00+09:00`));

describe('days in Korean time', () => {
  it('cuts at midnight UTC+9 and names the day by its Korean date', () => {
    const midnight = Date.parse('2026-10-16T00:00:00+09:00');
    expect(isoDate(statsDay(midnight))).toBe('2026-10-16');
    expect(isoDate(statsDay(midnight - 1))).toBe('2026-10-15');
    expect(dayStart(statsDay(midnight))).toBe(midnight);
    // 23:59 UTC on the 15th is already the 16th in Korea.
    expect(isoDate(statsDay(Date.parse('2026-10-15T23:59:00Z')))).toBe('2026-10-16');
  });

  it('starts weeks on Monday and months on the 1st', () => {
    expect(isoDate(weekStart(day('2026-10-16')))).toBe('2026-10-12'); // a Friday
    expect(isoDate(weekStart(day('2026-10-12')))).toBe('2026-10-12');
    expect(isoDate(weekStart(day('2026-10-11')))).toBe('2026-10-05'); // a Sunday
    expect(isoDate(monthStart(day('2026-10-16')))).toBe('2026-10-01');
    expect(isoDate(monthStart(day('2026-01-10'), 2))).toBe('2025-11-01');
    expect(isoDate(monthStart(day('2026-12-31'), -1))).toBe('2027-01-01');
  });

  it('lists the last n periods, the current one cut at the last finished day', () => {
    const last = day('2026-10-15'); // a Thursday
    const iso = (u: Parameters<typeof buckets>[0], n: number) => buckets(u, n, last).map(([a, b]) => `${isoDate(a)}..${isoDate(b)}`);
    expect(iso('day', 2)).toEqual(['2026-10-14..2026-10-14', '2026-10-15..2026-10-15']);
    expect(iso('week', 2)).toEqual(['2026-10-05..2026-10-11', '2026-10-12..2026-10-15']);
    expect(iso('month', 3)).toEqual(['2026-08-01..2026-08-31', '2026-09-01..2026-09-30', '2026-10-01..2026-10-15']);
  });
});

describe('concurrent seats per hour', () => {
  const t0 = Date.parse('2026-10-15T00:00:00+09:00');

  it('takes the most seats open at once in each hour', () => {
    const seats = [
      { a: t0 - 5 * H, b: t0 + 30 * 60_000 }, // open before the span, closes in hour 0
      { a: t0 + 10 * 60_000, b: t0 + 2 * H }, // hours 0-1
      { a: t0 + 90 * 60_000, b: null }, // still open
    ];
    expect(hourlyPeaks(seats, t0, 4)).toEqual([2, 2, 1, 1]);
  });

  it('does not count a seat closing at the instant another opens twice', () => {
    const at = t0 + 20 * 60_000;
    expect(hourlyPeaks([{ a: t0, b: at }, { a: at, b: t0 + H }], t0, 1)).toEqual([1]);
  });

  it('ignores seats outside the span and empty ones', () => {
    expect(hourlyPeaks([{ a: t0 - 2 * H, b: t0 - H }, { a: t0 + 5 * H, b: null }, { a: t0 + H, b: t0 + H }], t0, 3)).toEqual([0, 0, 0]);
  });

  it('counts a seat that spans the whole span in every hour', () => {
    expect(hourlyPeaks([{ a: t0 - H, b: t0 + 10 * H }], t0, 3)).toEqual([1, 1, 1]);
  });
});

describe('the stats page', () => {
  const first = day('2026-10-01');
  const last = day('2026-10-15');
  const rows = (list: [string, string, number][]) => list.map(([d, metric, n]) => ({ day: day(d), metric, n }));

  it('sums, averages per day, and takes the end-of-period active counts', () => {
    const r = statsReport(
      rows([
        ['2026-10-14', 'signups', 3],
        ['2026-10-15', 'signups', 1],
        ['2026-10-14', 'dau', 10],
        ['2026-10-15', 'dau', 20],
        ['2026-10-14', 'wau', 25],
        ['2026-10-15', 'wau', 30],
        ['2026-10-15', 'mau', 40],
        ['2026-10-14', 'hands_official', 30],
        ['2026-10-15', 'hands_member', 10],
        ['2026-10-14', 'tables_official', 2],
        ['2026-10-15', 'tables_member', 1],
        ['2026-10-15', 'seats_official', 4],
        ['2026-10-15', 'seat_ms_official', 4 * 600_000],
        ['2026-10-14', 'peak', 5],
        ['2026-10-15', 'peak', 7],
        ['2026-10-15', 'peak_h21', 7],
        ['2026-10-14', 'peak_h21', 3],
        ['2026-10-15', 'reports', 2],
        ['2026-10-15', 'handled', 2],
        ['2026-10-15', 'handle_ms', 2 * 3_600_000],
        ['2026-10-15', 'ac_lesson_start', 4],
        ['2026-10-15', 'ac_lesson_done', 1],
      ]),
      'week',
      1,
      last,
      { rolledFrom: first, rolledThrough: last, activitySince: day('2026-10-14') },
    );
    const p = r.periods[0]!;
    expect(p.from).toBe('2026-10-12');
    expect(p.to).toBe('2026-10-15');
    expect(p.days).toBe(4);
    expect(p.complete).toBe(false); // the week is not over
    expect(p.members).toMatchObject({ signups: 4, dauAvg: 15, wau: 30, mau: 40, activityDays: 2, partial: { dau: true, wau: true, mau: true } });
    expect(p.play).toMatchObject({ hands: 40, handsPerDay: 10, tablesAvg: 0.8, seats: 4, avgSeatMs: 600_000, peak: 7 });
    expect(p.play.official.hands).toBe(30);
    expect(p.play.member.hands).toBe(10);
    expect(p.reports).toEqual({ created: 2, handled: 2, avgHandleMs: 3_600_000 });
    expect(p.academy).toMatchObject({ ac_lesson_start: 4, ac_lesson_done: 1, ac_answer: 0 });
    // Hourly profile over the range's 4 rolled-up days (Monday to Thursday).
    expect(r.hourly[21]).toEqual({ avg: 2.5, max: 7 });
  });

  it('counts only the days rolled up, and activity only from the first marker day', () => {
    const r = statsReport(rows([['2026-10-15', 'dau', 8]]), 'day', 3, last, { rolledFrom: day('2026-10-14'), rolledThrough: last, activitySince: day('2026-10-15') });
    expect(r.periods.map((p) => p.days)).toEqual([0, 1, 1]);
    expect(r.periods.map((p) => p.members.dauAvg)).toEqual([null, null, 8]);
    expect(r.periods[2]!.members.partial).toEqual({ dau: true, wau: true, mau: true });
    expect(r.periods[0]!.complete).toBe(false); // before the rollup started
    expect(r.periods[1]!.complete).toBe(true);
  });

  it('leaves the activity partial flags off once the windows are inside the marker days', () => {
    const since = day('2026-09-01');
    const r = statsReport([], 'day', 1, last, { rolledFrom: since, rolledThrough: last, activitySince: since });
    expect(r.periods[0]!.members.partial).toEqual({ dau: false, wau: false, mau: false });
  });

  it('counts a sign-up cohort only once its week has been rolled up', () => {
    const r = statsReport(
      rows([
        ['2026-10-07', 'signups', 4],
        ['2026-10-07', 'cohort_play_1d', 1],
        ['2026-10-07', 'cohort_play_7d', 2],
        ['2026-10-10', 'signups', 5], // its week ends after the 15th
      ]),
      'week',
      2,
      last,
      { rolledFrom: first, rolledThrough: last, activitySince: null },
    );
    expect(r.periods[0]!.activation).toEqual({ cohort: 4, play1d: 1, play7d: 2, cohortDays: 4 });
    expect(r.periods[1]!.activation.cohort).toBe(0);
    expect(r.total.members.signups).toBe(9);
    expect(r.total.members.dauAvg).toBeNull();
  });

  it('shows nothing as rolled up before the first rollup', () => {
    const r = statsReport([], 'month', 2, last, { rolledFrom: null, rolledThrough: null, activitySince: null });
    expect(r.periods.map((p) => [p.from, p.to, p.days])).toEqual([
      ['2026-09-01', '2026-09-30', 0],
      ['2026-10-01', '2026-10-15', 0],
    ]);
    expect(r.hourly.every((h) => h.avg === null && h.max === null)).toBe(true);
    expect(r.rolledThrough).toBeNull();
  });
});
