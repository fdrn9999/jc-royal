export * from './bot';
export * from './deck';
export * from './evaluate';
export * from './hand';
export * from './tutorial';
export { ENGINE_VERSION } from 'poker-engine-ts';

/**
 * Moves the dealer button to the next seat (clockwise) that is dealt into the
 * new hand. With no previous hand the lowest occupied seat gets the button.
 */
export function nextButtonSeat(previous: number | null, dealtSeats: readonly number[], maxSeats: number): number {
  const sorted = [...dealtSeats].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('no seats');
  if (previous === null) return sorted[0]!;
  for (let off = 1; off <= maxSeats; off++) {
    const idx = (previous + off) % maxSeats;
    if (sorted.includes(idx)) return idx;
  }
  return sorted[0]!;
}
