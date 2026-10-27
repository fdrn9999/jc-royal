import { holeOrder, inHoleOrder } from '@jc/ui';
import { describe, expect, it } from 'vitest';

describe('hole cards in order (higher rank on the left)', () => {
  it('puts the higher rank first, whatever order they came in', () => {
    expect(inHoleOrder(['7c', 'Ah'])).toEqual(['Ah', '7c']);
    expect(inHoleOrder(['Ah', '7c'])).toEqual(['Ah', '7c']);
    expect(inHoleOrder(['2d', 'Ts'])).toEqual(['Ts', '2d']);
    expect(inHoleOrder(['Qh', 'Kd'])).toEqual(['Kd', 'Qh']);
    expect(inHoleOrder(['Jc', 'Td'])).toEqual(['Jc', 'Td']);
    expect(inHoleOrder(['3s', '2s'])).toEqual(['3s', '2s']);
  });

  it('keeps a pair as dealt: suits have no order', () => {
    expect(inHoleOrder(['8h', '8s'])).toEqual(['8h', '8s']);
    expect(inHoleOrder(['8s', '8h'])).toEqual(['8s', '8h']);
    expect(holeOrder(['Ac', 'Ad'])).toEqual([0, 1]);
  });

  it('gives the indices of the cards as dealt, which stay as they were', () => {
    const dealt = ['5d', 'Kh'] as const;
    expect(holeOrder(dealt)).toEqual([1, 0]);
    expect(dealt).toEqual(['5d', 'Kh']);
  });

  it('leaves cards alone while any is face down', () => {
    expect(holeOrder([null, null])).toBeNull();
    expect(holeOrder(['2c', null])).toBeNull();
    expect(holeOrder([null, 'Ac'])).toBeNull();
    expect(inHoleOrder([null, 'Ac'])).toEqual([null, 'Ac']);
    expect(holeOrder([])).toBeNull();
  });

  it('orders every rank, A down to 2', () => {
    const ranks = 'AKQJT98765432';
    for (let a = 0; a < ranks.length; a++)
      for (let b = a + 1; b < ranks.length; b++) expect(inHoleOrder([`${ranks[b]}c`, `${ranks[a]}d`])).toEqual([`${ranks[a]}d`, `${ranks[b]}c`]);
  });
});
