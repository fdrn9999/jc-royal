import { HandEngine } from '@jc/poker-engine';
import { describe, expect, it } from 'vitest';
import { keepRabbit, keptRabbitFor, RABBIT_KEEP_MS } from './rabbit';

function hand() {
  return HandEngine.start({
    handId: 'h1',
    rules: { maxSeats: 6, smallBlind: 5, bigBlind: 10, turnMs: 30_000 },
    seats: [
      { playerId: 'a', displayName: 'A', seatIndex: 0, stack: 1000 },
      { playerId: 'b', displayName: 'B', seatIndex: 3, stack: 1000 },
      { playerId: 'c', displayName: 'C', seatIndex: 4, stack: 1000 },
    ],
    buttonSeat: 0,
    now: 1_000,
  });
}

/** Everybody folds to the last player. */
async function foldOut(h: HandEngine) {
  for (let n = 0; n < 10 && !h.isSettled; n++) {
    const r = await h.act(h.actorId()!, { type: 'fold' }, `fold-${n}`, 2_000);
    expect(r.ok).toBe(true);
  }
  expect(h.isSettled).toBe(true);
}

describe('the rabbit hunt a hand leaves behind at the next deal', () => {
  it('is what the hand itself answers, for the seats it dealt in, until its time is up', async () => {
    const h = hand();
    expect(keepRabbit(h, 5_000)).toBeNull(); // still played: nothing to keep, nothing told
    await foldOut(h);
    const cards = h.rabbitHunt()!;
    expect(cards).toHaveLength(5);
    const kept = keepRabbit(h, 5_000)!;
    expect(kept).toEqual({ handId: 'h1', cards, seats: { a: 0, b: 3, c: 4 }, until: 5_000 + RABBIT_KEEP_MS });
    // It is plain data (the room saves it with its state: a restart reads the same cards), and the hand's are unchanged.
    expect(JSON.parse(JSON.stringify(kept))).toEqual(kept);
    expect(h.rabbitHunt()).toEqual(cards);
    // None of them a card a player holds.
    const holes = ['a', 'b', 'c'].flatMap((id) => h.holeCardsOf(id)!);
    expect(new Set([...cards, ...holes]).size).toBe(11);

    expect(keptRabbitFor(kept, 'h1', 5_000)).toBe(kept);
    expect(keptRabbitFor(kept, 'h1', kept.until - 1)).toBe(kept);
    expect(keptRabbitFor(kept, 'h1', kept.until)).toBeNull();
    expect(keptRabbitFor(kept, 'h2', 5_000)).toBeNull();
    expect(keptRabbitFor(null, 'h1', 5_000)).toBeNull();
    expect(keptRabbitFor(undefined, 'h1', 5_000)).toBeNull();
  });
});
