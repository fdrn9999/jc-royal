import { describe, expect, it } from 'vitest';
import { wonFrom } from '../src/game/won';

describe('wonFrom: what each player won, without the chips nobody called', () => {
  it('takes the chips handed back off the player they went back to', () => {
    // A raise everyone folded to: 55 paid, 30 of it the raiser's own.
    expect(wonFrom({ winners: [{ seatIndex: 0, amount: 55, potIds: ['pot-main-0'] }], returned: { seatIndex: 0, amount: 30 }, showdown: [] })).toEqual([{ seatIndex: 0, amount: 25, potIds: ['pot-main-0'] }]);
  });

  it('a covering all-in that lost won nothing: only the winner is left', () => {
    const r = {
      winners: [
        { seatIndex: 1, amount: 1000, potIds: ['pot-main-0'] },
        { seatIndex: 0, amount: 500, potIds: ['pot-side-1'] },
      ],
      returned: { seatIndex: 0, amount: 500 },
      showdown: [],
    };
    expect(wonFrom(r)).toEqual([{ seatIndex: 1, amount: 1000, potIds: ['pot-main-0'] }]);
  });

  it('as paid when nothing went back (and from an older room); nothing without a result', () => {
    const winners = [{ seatIndex: 2, amount: 40, potIds: ['pot-main-0'] }];
    expect(wonFrom({ winners, showdown: [] })).toEqual(winners);
    expect(wonFrom(null)).toEqual([]);
    expect(wonFrom(undefined)).toEqual([]);
  });
});
