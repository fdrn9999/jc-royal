import type { Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { againHunt, answerHunt, failHunt, huntAt, huntOverdue, pressHunt, RABBIT_SEEN_MS, RABBIT_WAIT_MS, refuseHunt, retryHunt, startHunt } from '../src/game/rabbitHunt';

const c = (s: string) => (s ? (s.split(' ') as Card[]) : []);
const FLOP = c('As 9h 5s');
const REST = c('4c Jd');
const hand = (id = 'h1', board = FLOP) => ({ id, number: 7, board });
const asked = () => startHunt('t1', hand(), 'r1', 1_000);

describe('a rabbit hunt, from the press to what is shown', () => {
  it('is asked for one hand, and answered once with the cards that complete its board', () => {
    const h = asked();
    expect(h).toMatchObject({ tableId: 't1', handId: 'h1', handNumber: 7, board: FLOP, reqId: 'r1', phase: 'requesting', cards: null, late: false });
    const done = answerHunt(h, { handId: 'h1', cards: REST }, 1_400)!;
    expect(done).toMatchObject({ phase: 'success', cards: REST, at: 1_400 });
    // A second copy of the answer, a refusal or a failure of the request changes nothing any more.
    expect(answerHunt(done, { handId: 'h1', cards: c('2c 2d') }, 1_500)).toBe(done);
    expect(refuseHunt(done, 'r1', 'conflict', 1_500)).toBe(done);
    expect(failHunt(done, 'r1', 1_500)).toBe(done);
    expect(retryHunt(done, 'r2', 1_500)).toBe(done);
  });

  it('an answer about another hand is never taken, whatever it holds', () => {
    const h = asked();
    expect(answerHunt(h, { handId: 'h0', cards: REST }, 1_400)).toBe(h);
    expect(answerHunt(null, { handId: 'h1', cards: REST }, 1_400)).toBeNull();
  });

  it('cards that do not complete that board are not shown: too many, too few, or one the board already has', () => {
    for (const cards of [c('4c Jd 2c'), c('4c'), c(''), c('As Jd'), c('4c 4c')]) {
      expect(answerHunt(asked(), { handId: 'h1', cards }, 1_400)).toMatchObject({ phase: 'error', cards: null });
    }
    // Before the flop it is all five; on the turn, the river alone.
    expect(answerHunt(startHunt('t1', hand('h1', []), 'r1', 0), { handId: 'h1', cards: [...FLOP, ...REST] }, 1)).toMatchObject({ phase: 'success' });
    expect(answerHunt(startHunt('t1', hand('h1', c('As 9h 5s 4c')), 'r1', 0), { handId: 'h1', cards: c('Jd') }, 1)).toMatchObject({ phase: 'success' });
  });

  it('a refusal says which: the time is up (or it was never mine to ask), or it went wrong on the way', () => {
    expect(refuseHunt(asked(), 'r1', 'conflict', 2_000)).toMatchObject({ phase: 'expired', at: 2_000 });
    expect(refuseHunt(asked(), 'r1', 'forbidden', 2_000)).toMatchObject({ phase: 'expired' });
    expect(refuseHunt(asked(), 'r1', 'internal', 2_000)).toMatchObject({ phase: 'error' });
    expect(refuseHunt(asked(), 'r1', 'rate_limited', 2_000)).toMatchObject({ phase: 'error' });
    // A refusal of some other request is not this one's.
    const h = asked();
    expect(refuseHunt(h, 'r0', 'conflict', 2_000)).toBe(h);
  });

  it('no answer in time is a failure, asked again as a new request for the same hand', () => {
    const h = asked();
    expect(huntOverdue(h, 1_000 + RABBIT_WAIT_MS - 1)).toBe(false);
    expect(huntOverdue(h, 1_000 + RABBIT_WAIT_MS)).toBe(true);
    const failed = failHunt(h, 'r1', 9_000)!;
    expect(failed).toMatchObject({ phase: 'error', handId: 'h1' });
    expect(huntOverdue(failed, 99_000)).toBe(false);
    // Only while it failed: a press while it is asked sends nothing more.
    expect(retryHunt(h, 'r2', 9_100)).toBe(h);
    const again = retryHunt(failed, 'r2', 9_100)!;
    expect(again).toMatchObject({ phase: 'requesting', reqId: 'r2', handId: 'h1', at: 9_100 });
    // The failure of the request given up is not the new one's; too late for it is said as such.
    expect(failHunt(again, 'r1', 9_200)).toBe(again);
    expect(refuseHunt(again, 'r1', 'internal', 9_200)).toBe(again);
    expect(refuseHunt(again, 'r2', 'conflict', 9_300)).toMatchObject({ phase: 'expired' });
  });

  it('the answer to a request given up is as good as the one waited for: a hand has one rabbit hunt', () => {
    const failed = failHunt(asked(), 'r1', 9_000)!;
    expect(answerHunt(failed, { handId: 'h1', cards: REST }, 9_050)).toMatchObject({ phase: 'success', cards: REST });
    const again = retryHunt(failed, 'r2', 9_100)!;
    expect(answerHunt(again, { handId: 'h1', cards: REST }, 9_150)).toMatchObject({ phase: 'success', cards: REST });
    // Once it is too late, a stray answer does not bring it back.
    const gone = refuseHunt(again, 'r2', 'conflict', 9_200)!;
    expect(answerHunt(gone, { handId: 'h1', cards: REST }, 9_300)).toBe(gone);
  });

  it('when the table moves on, what is still wanted goes beside the game; cards already seen end with their hand', () => {
    const h = asked();
    // The same hand still on the table: nothing changes.
    expect(huntAt(h, 'h1', 2_000)).toBe(h);
    // Asked, the next hand dealt: it waits on as the hand before's, its wait still counted from the press.
    const waiting = huntAt(h, 'h2', 2_000)!;
    expect(waiting).toMatchObject({ late: true, phase: 'requesting', at: 1_000 });
    expect(huntOverdue(waiting, 1_000 + RABBIT_WAIT_MS)).toBe(true);
    const shown = answerHunt(waiting, { handId: 'h1', cards: REST }, 2_300)!;
    expect(shown).toMatchObject({ late: true, phase: 'success', cards: REST });
    // Hands come and go after that: it is the same hunt until it is put away.
    expect(huntAt(shown, 'h3', 9_000)).toBe(shown);
    expect(huntAt(shown, null, 9_000)).toBe(shown);

    // Answered on the board a moment before the deal: shown on. Seen for a while: over.
    const onBoard = answerHunt(asked(), { handId: 'h1', cards: REST }, 2_000)!;
    expect(huntAt(onBoard, 'h2', 2_000 + RABBIT_SEEN_MS - 1)).toMatchObject({ late: true, phase: 'success', at: 2_000 + RABBIT_SEEN_MS - 1 });
    expect(huntAt(onBoard, 'h2', 2_000 + RABBIT_SEEN_MS)).toBeNull();
    expect(huntAt(onBoard, null, 2_000 + RABBIT_SEEN_MS)).toBeNull();
    // A failure is still offered to ask again after the deal (the room keeps the answer a while).
    expect(huntAt(failHunt(asked(), 'r1', 3_000), 'h2', 4_000)).toMatchObject({ late: true, phase: 'error', at: 4_000 });
    expect(huntAt(null, 'h2', 4_000)).toBeNull();
  });
});

describe('which hand a press is about', () => {
  const h1 = { id: 'h1', number: 1, board: [] };
  const h2 = { id: 'h2', number: 2, board: [] };
  const failed = failHunt(startHunt('t1', h1, 'r1', 0), 'r1', 10)!;

  it('the table’s button asks for the hand on the table: once, and again only after it failed', () => {
    expect(pressHunt(null, 't1', null, 'r1', 0)).toBeNull();
    const first = pressHunt(null, 't1', h1, 'r1', 0)!;
    expect(first).toMatchObject({ handId: 'h1', reqId: 'r1', phase: 'requesting', late: false });
    expect(pressHunt(first, 't1', h1, 'r2', 5)).toBeNull();
    expect(pressHunt(answerHunt(first, { handId: 'h1', cards: ['As', 'Kd', '7c', '2h', '9s'] }, 5), 't1', h1, 'r2', 6)).toBeNull();
    expect(pressHunt(refuseHunt(first, 'r1', 'conflict', 5), 't1', h1, 'r2', 6)).toBeNull();
    expect(pressHunt(failed, 't1', h1, 'r2', 20)).toMatchObject({ handId: 'h1', reqId: 'r2', phase: 'requesting' });
  });

  it('with the hand before’s failed hunt still up, the table’s button is about the hand settled now, not that one', () => {
    const before = huntAt(failed, 'h2', 30)!;
    expect(before).toMatchObject({ handId: 'h1', late: true, phase: 'error' });
    expect(pressHunt(before, 't1', h2, 'r2', 40)).toMatchObject({ handId: 'h2', handNumber: 2, reqId: 'r2', phase: 'requesting', late: false });
    // The panel's own button is the one that asks for the hand before again, and for nothing else.
    expect(againHunt(before, 'r3', 40)).toMatchObject({ handId: 'h1', reqId: 'r3', phase: 'requesting', late: true });
    expect(againHunt(failed, 'r3', 40)).toBeNull();
    expect(againHunt(huntAt(startHunt('t1', h1, 'r1', 0), 'h2', 30), 'r3', 40)).toBeNull();
    expect(againHunt(null, 'r3', 40)).toBeNull();
  });

  it('an answer to the request given up on, after the hunt was asked again and refused, changes nothing', () => {
    const again = retryHunt(failed, 'r2', 20)!;
    const done = answerHunt(again, { handId: 'h1', cards: ['As', 'Kd', '7c', '2h', '9s'] }, 25)!;
    expect(done.phase).toBe('success');
    expect(refuseHunt(done, 'r2', 'conflict', 30)).toBe(done);
  });
});
