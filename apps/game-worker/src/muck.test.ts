// The account auto-muck the api pushes to a seat (muck.ts): pushes can arrive out of order, and the seat keeps the value
// of the highest settings revision it was sent, so an older "off" arriving late never turns a losing hand's cards over.
import { describe, expect, it } from 'vitest';
import { muckRevParam, takePushedMuck } from './muck';

describe('pushed auto-muck', () => {
  it('ignores a push older than the last one the seat took', () => {
    // Saved "off" as revision 4, then "on" as 5; the push for 5 arrives first.
    const seat: { autoMuck?: boolean; muckRev?: number } = {};
    expect(takePushedMuck(seat, true, 5)).toBe('show');
    expect(seat).toEqual({ autoMuck: true, muckRev: 5 });
    expect(takePushedMuck(seat, false, 4)).toBe('none');
    expect(seat).toEqual({ autoMuck: true, muckRev: 5 });
    // The same push sent again changes nothing either.
    expect(takePushedMuck(seat, true, 5)).toBe('none');
  });

  it('takes newer pushes, saving a revision that moved even when the value did not', () => {
    const seat = { autoMuck: true, muckRev: 5 };
    expect(takePushedMuck(seat, true, 7)).toBe('save');
    expect(seat).toEqual({ autoMuck: true, muckRev: 7 });
    expect(takePushedMuck(seat, false, 8)).toBe('show');
    expect(seat).toEqual({ autoMuck: false, muckRev: 8 });
  });

  it("follows the player's own command between pushes, and a newer push after it", () => {
    const seat = { autoMuck: true, muckRev: 5 };
    // The 'muck' command sets the value without a revision.
    seat.autoMuck = false;
    expect(takePushedMuck(seat, true, 5)).toBe('none');
    expect(seat.autoMuck).toBe(false);
    expect(takePushedMuck(seat, true, 6)).toBe('show');
    expect(seat.autoMuck).toBe(true);
  });

  it('applies a push without a revision (an older api) as before, without moving the revision', () => {
    const seat = { autoMuck: true, muckRev: 5 };
    expect(takePushedMuck(seat, false, null)).toBe('show');
    expect(seat).toEqual({ autoMuck: false, muckRev: 5 });
    expect(takePushedMuck(seat, false, null)).toBe('none');
    const fresh: { autoMuck?: boolean; muckRev?: number } = {};
    expect(takePushedMuck(fresh, false, null)).toBe('none');
    expect(fresh).toEqual({});
  });

  it('reads the revision only as a whole number', () => {
    expect(muckRevParam('12')).toBe(12);
    expect(muckRevParam('0')).toBe(0);
    for (const bad of [null, '', '-1', '1.5', 'abc', '1e3', '9999999999999999']) expect(muckRevParam(bad)).toBeNull();
  });
});
