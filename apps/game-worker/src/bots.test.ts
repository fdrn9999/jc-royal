// A bounded wait (bots.ts `within`): the room reads the bots' settings with it, so a slow D1 never holds a deal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { within } from './bots';

describe('within', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the answer that comes in time, and its error', async () => {
    await expect(within(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(within(Promise.reject(new Error('d1 down')), 50)).rejects.toThrow('d1 down');
  });

  it('gives up once the time passed, and drops an answer that comes after', async () => {
    vi.useFakeTimers();
    let answer!: (v: number) => void;
    const slow = new Promise<number>((r) => {
      answer = r;
    });
    let got: number | undefined;
    const waited = within(slow, 2_000).then((v) => {
      got = v;
      return v;
    });
    const settled = expect(waited).rejects.toThrow('no answer in 2000 ms');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    answer(9);
    await Promise.resolve();
    expect(got).toBeUndefined();
  });

  it('leaves no timer behind once answered', async () => {
    vi.useFakeTimers();
    await within(Promise.resolve(1), 2_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
