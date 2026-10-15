import type { HandStage, SeatState, TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { preActionSpot } from '../src/game/preAction';

/** Three seats, the viewer in seat 2, seat 0 to act; `bets` are this street's bets by seat. */
function view(o: { stage?: HandStage; actor?: number | null; you?: number | null; bets?: number[]; state?: SeatState; noHand?: boolean } = {}): TableView {
  const bets = o.bets ?? [10, 5, 10];
  const you = o.you === undefined ? 2 : o.you;
  return {
    seats: bets.map((b, i) => ({ seatIndex: i, state: i === you ? (o.state ?? 'active') : 'active', stack: 990, streetBet: b, hasCards: true, connected: true })),
    hand: o.noHand ? null : { id: 'h-1', stage: o.stage ?? 'preflop', actorSeat: o.actor === undefined ? 0 : o.actor },
    you: { seatIndex: you, legal: [] },
  } as unknown as TableView;
}

describe('preActionSpot', () => {
  it('offers Check/Fold and Check when nothing is to call, with the street and amount the room checks', () => {
    expect(preActionSpot(view())).toEqual({ handId: 'h-1', stage: 'preflop', toCall: 0, choices: ['checkFold', 'check'] });
    expect(preActionSpot(view({ stage: 'river', bets: [0, 0, 0] }))).toMatchObject({ stage: 'river', toCall: 0, choices: ['checkFold', 'check'] });
  });

  it('offers only Fold against a bet: never a call, raise or all-in', () => {
    expect(preActionSpot(view({ you: 1 }))).toMatchObject({ toCall: 5, choices: ['fold'] });
    expect(preActionSpot(view({ bets: [80, 0, 30] }))).toMatchObject({ toCall: 50, choices: ['fold'] });
  });

  it('offers nothing on the viewer’s own turn, between streets, or with no hand', () => {
    expect(preActionSpot(view({ actor: 2 }))).toBeNull();
    expect(preActionSpot(view({ actor: null }))).toBeNull();
    expect(preActionSpot(view({ stage: 'showdown' }))).toBeNull();
    expect(preActionSpot(view({ stage: 'settled' }))).toBeNull();
    expect(preActionSpot(view({ noHand: true }))).toBeNull();
  });

  it('offers nothing to a spectator, or once the viewer folded, is all in or sits out', () => {
    expect(preActionSpot(view({ you: null }))).toBeNull();
    for (const state of ['folded', 'allin', 'sittingOut', 'waiting'] as SeatState[]) expect(preActionSpot(view({ state })), state).toBeNull();
  });
});
