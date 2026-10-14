import { ageOn, BirthDateSchema, MIN_SIGNUP_AGE } from '@jc/types';
import { describe, expect, it } from 'vitest';

describe('ageOn', () => {
  it('counts full years, turning over on the birthday', () => {
    expect(ageOn('2012-10-14', '2026-10-13')).toBe(13);
    expect(ageOn('2012-10-14', '2026-10-14')).toBe(MIN_SIGNUP_AGE);
    expect(ageOn('2012-02-29', '2026-02-28')).toBe(13);
    expect(ageOn('2012-02-29', '2026-03-01')).toBe(14);
  });
});

describe('BirthDateSchema', () => {
  it('accepts real past dates only', () => {
    expect(BirthDateSchema.safeParse('1990-05-17').success).toBe(true);
    expect(BirthDateSchema.safeParse('1990-02-30').success).toBe(false);
    expect(BirthDateSchema.safeParse('1990-5-17').success).toBe(false);
    expect(BirthDateSchema.safeParse('1899-12-31').success).toBe(false);
    expect(BirthDateSchema.safeParse('2999-01-01').success).toBe(false);
  });
});
