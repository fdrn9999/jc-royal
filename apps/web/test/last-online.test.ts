// "Last online N min ago" (src/lib/lastOnline.ts): the buckets, the calendar days, and never more than the server said.
// Times are built on this machine's clock, so the calendar cases hold in any time zone.
import { describe, expect, it } from 'vitest';
import { lastOnlineAgo } from '../src/lib/lastOnline';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const MIN = 60_000;

describe('lastOnlineAgo', () => {
  it('under a minute is just now; a time ahead of this clock too', () => {
    expect(lastOnlineAgo(at(20, 12), at(20, 12))).toEqual({ key: 'now' });
    expect(lastOnlineAgo(at(20, 12), at(20, 12) + 59_999)).toEqual({ key: 'now' });
    expect(lastOnlineAgo(at(20, 12) + 5 * MIN, at(20, 12))).toEqual({ key: 'now' });
  });

  it('minutes, then hours, rounded down', () => {
    expect(lastOnlineAgo(at(20, 12), at(20, 12, 1))).toEqual({ key: 'min', n: 1 });
    expect(lastOnlineAgo(at(20, 12), at(20, 12, 32))).toEqual({ key: 'min', n: 32 });
    expect(lastOnlineAgo(at(20, 12), at(20, 12, 59) + 59_000)).toEqual({ key: 'min', n: 59 });
    expect(lastOnlineAgo(at(20, 12), at(20, 13))).toEqual({ key: 'hour', n: 1 });
    expect(lastOnlineAgo(at(20, 12), at(20, 15, 59))).toEqual({ key: 'hour', n: 3 });
    // Under a day, hours even across midnight.
    expect(lastOnlineAgo(at(19, 22), at(20, 9))).toEqual({ key: 'hour', n: 11 });
  });

  it('a day or more: yesterday by the calendar, then calendar days, then over a month', () => {
    expect(lastOnlineAgo(at(19, 9), at(20, 9))).toEqual({ key: 'yesterday' });
    expect(lastOnlineAgo(at(19, 0, 30), at(20, 23, 30))).toEqual({ key: 'yesterday' });
    // 25 hours, two dates back.
    expect(lastOnlineAgo(at(18, 23, 30), at(20, 0, 30))).toEqual({ key: 'days', n: 2 });
    expect(lastOnlineAgo(at(17, 12), at(20, 9))).toEqual({ key: 'days', n: 3 });
    expect(lastOnlineAgo(new Date(2026, 8, 20, 12).getTime(), at(20, 12))).toEqual({ key: 'days', n: 30 });
    expect(lastOnlineAgo(new Date(2026, 8, 19, 12).getTime(), at(20, 12))).toEqual({ key: 'long' });
  });
});
