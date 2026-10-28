// The room's occupancy mirror to D1 (settlement.ts oneAtATime, room.ts publishStats): one write at a time, the last
// with the latest state, so a place on the waitlist given up is never written back by an older write landing late.
import { describe, expect, it } from 'vitest';
import { oneAtATime } from './settlement';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('oneAtATime', () => {
  it('never has two writes out, and the last one written holds the latest state', async () => {
    let waitlist = ['a', 'b'];
    const written: string[][] = [];
    const landing: (() => void)[] = [];
    let out = 0;
    let most = 0;
    const publish = oneAtATime(async () => {
      const seen = [...waitlist];
      most = Math.max(most, ++out);
      await new Promise<void>((r) => landing.push(r));
      written.push(seen);
      out--;
    });

    void publish();
    waitlist = ['b']; // a leaves the waitlist
    void publish();
    waitlist = []; // b sits
    void publish();
    // Only the first write is out; the two asked meanwhile wait for it, as one.
    expect(landing).toHaveLength(1);

    landing.shift()!();
    await tick();
    expect(written).toEqual([['a', 'b']]);
    // The one after it reads the state as it is now, not as it was when asked.
    expect(landing).toHaveLength(1);
    landing.shift()!();
    await tick();

    expect(written).toEqual([['a', 'b'], []]);
    expect(most).toBe(1);
    expect(landing).toHaveLength(0);

    // Nothing out: the next ask writes at once.
    waitlist = ['c'];
    const done = publish();
    expect(landing).toHaveLength(1);
    landing.shift()!();
    await done;
    expect(written.at(-1)).toEqual(['c']);
  });

  it('a later ask shares the write it waits behind', async () => {
    const landing: (() => void)[] = [];
    let writes = 0;
    const publish = oneAtATime(async () => {
      writes++;
      await new Promise<void>((r) => landing.push(r));
    });
    const first = publish();
    const second = publish();
    expect(second).toBe(first);
    landing.shift()!();
    await tick();
    landing.shift()!();
    await second;
    expect(writes).toBe(2);
  });
});
