import { describe, expect, it } from 'vitest';
import { cardsToShow, legacyMuckStep } from '../src/game/olderRooms';

describe('a room from an older game worker', () => {
  it('has auto-muck turned on for my seat once per connection, and a current room is never asked', () => {
    // A current room reports nothing (and not seated, nothing is passed): nothing is sent.
    expect(legacyMuckStep(false, true, undefined)).toEqual({ send: false, sent: false });
    expect(legacyMuckStep(false, true, null)).toEqual({ send: false, sent: false });
    // An older room with it off: turned on, then not again while the answer is awaited.
    expect(legacyMuckStep(false, true, false)).toEqual({ send: true, sent: true });
    expect(legacyMuckStep(true, true, false)).toEqual({ send: false, sent: true });
    // On: nothing pending, so a later "off" (from an older API) is answered again.
    expect(legacyMuckStep(true, true, true)).toEqual({ send: false, sent: false });
    expect(legacyMuckStep(false, true, false)).toEqual({ send: true, sent: true });
    // A command sent while the connection was down is not kept: sent again once it is back.
    expect(legacyMuckStep(true, false, false)).toEqual({ send: false, sent: false });
    expect(legacyMuckStep(false, true, false)).toEqual({ send: true, sent: true });
  });

  it('is sent "both" as the two single-card commands, without a card already shown or on its way', () => {
    const none = () => false;
    expect(cardsToShow('both', [], none)).toEqual([0, 1]);
    expect(cardsToShow(0, [], none)).toEqual([0]);
    expect(cardsToShow(1, [], none)).toEqual([1]);
    // The first card tapped a moment before "both": only the second goes.
    expect(cardsToShow('both', [0], none)).toEqual([1]);
    // The second already shown.
    expect(cardsToShow('both', [], (i) => i === 1)).toEqual([0]);
    expect(cardsToShow(1, [], (i) => i === 1)).toEqual([]);
    expect(cardsToShow('both', [0, 1], none)).toEqual([]);
  });
});
