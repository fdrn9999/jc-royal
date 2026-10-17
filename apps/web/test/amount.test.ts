import { formatBB } from '@jc/ui';
import { describe, expect, it } from 'vitest';
import { amounts } from '../src/lib/amount';

describe('formatBB', () => {
  it('reads chips as big blinds at a 20 big blind', () => {
    expect(formatBB(20, 20)).toBe('1 BB');
    expect(formatBB(50, 20)).toBe('2.5 BB');
    expect(formatBB(200, 20)).toBe('10 BB');
    expect(formatBB(0, 20)).toBe('0 BB');
  });

  it('rounds to two decimals for reading, keeping a tiny amount visible', () => {
    expect(formatBB(1, 3)).toBe('0.33 BB');
    expect(formatBB(1, 1000)).toBe('0.001 BB');
    expect(formatBB(-30, 20)).toBe('-1.5 BB');
    expect(formatBB(2_000_000, 20)).toBe('100,000 BB');
  });

  it('shortens only very large amounts when compact', () => {
    expect(formatBB(2_000_000, 20, true)).toBe('100K BB');
    expect(formatBB(199_980, 20, true)).toBe('9,999 BB');
  });
});

describe('amounts', () => {
  it('keeps chips by default, and wherever no big blind is known', () => {
    for (const a of [amounts('chips', 20), amounts('bb', 0)]) {
      expect(a.unit).toBe('chips');
      expect(a.fmt(1250)).toBe('1,250');
      expect(a.fmt(12_500, true)).toBe('12.5K');
      expect(a.exact(50)).toBe('50');
      expect(a.toInput(50)).toBe('50');
      expect(a.clean('1,2a3')).toBe('123');
      expect(a.fromInput('2.5')).toBe(25);
      expect(a.fromInput('')).toBe(0);
    }
  });

  it('reads in big blinds and shows the exact chips where wallet money moves', () => {
    const a = amounts('bb', 20);
    expect(a.unit).toBe('bb');
    expect(a.fmt(50)).toBe('2.5 BB');
    expect(a.exact(50)).toBe('2.5 BB (50)');
    expect(a.exact(20_000)).toBe('1,000 BB (20,000)');
  });

  it('turns a typed big-blind amount into whole chips', () => {
    const a = amounts('bb', 20);
    expect(a.fromInput('2.5')).toBe(50);
    expect(a.fromInput('2,5')).toBe(50);
    expect(a.fromInput('2.55')).toBe(51);
    expect(a.fromInput('2.524')).toBe(50);
    expect(a.fromInput('10')).toBe(200);
    for (const junk of ['', '.', 'abc', '0']) expect(a.fromInput(junk)).toBe(0);
    // A minus sign cannot be typed, as in chips.
    expect(a.fromInput('-3')).toBe(60);
    // Every result is an integer, so nothing fractional can be sent.
    for (const typed of ['0.01', '1.333', '7.77', '99.99']) expect(Number.isInteger(a.fromInput(typed))).toBe(true);
  });

  it('keeps what is being typed to digits and one decimal point', () => {
    const a = amounts('bb', 20);
    expect(a.clean('2.')).toBe('2.');
    expect(a.clean('2..5')).toBe('2.5');
    expect(a.clean('1.2.3')).toBe('1.23');
    expect(a.clean('3,5 BB')).toBe('3.5');
  });

  it('shows a chip amount in the field to two decimals, which reads back to the nearest chip', () => {
    const a = amounts('bb', 20);
    expect(a.toInput(50)).toBe('2.5');
    expect(a.toInput(400)).toBe('20');
    const odd = amounts('bb', 30);
    expect(odd.toInput(100)).toBe('3.33');
    expect(odd.fromInput(odd.toInput(100))).toBe(100);
  });
});
