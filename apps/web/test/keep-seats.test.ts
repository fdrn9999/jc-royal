import type { SeatView, TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { keepSeats } from '../src/game/keepSeats';

const seat = (seatIndex: number, x: Partial<SeatView> = {}) => ({ seatIndex, state: 'active', userId: `u${seatIndex}`, nickname: `p${seatIndex}`, stack: 1000, streetBet: 0, ...x }) as SeatView;
const view = (seats: SeatView[], x: Partial<TableView> = {}) => ({ version: 1, table: { id: 't1' }, seats, hand: null, ...x }) as unknown as TableView;
/** As every message from the server arrives: parsed into new objects. */
const sent = (v: TableView) => JSON.parse(JSON.stringify(v)) as TableView;

describe('keepSeats: a seat that reads as before stays the object drawn before', () => {
  it('keeps the seats that did not change and takes the ones that did, in the order sent', () => {
    const prev = view([seat(0, { streetBet: 20 }), seat(1, { state: 'folded' }), seat(2)]);
    const next = sent(view([seat(0, { stack: 980 }), seat(1, { state: 'folded' }), seat(2)], { version: 2 }));
    const v = keepSeats(prev, next);
    expect(v.seats[0]).toBe(next.seats[0]);
    expect(v.seats[1]).toBe(prev.seats[1]);
    expect(v.seats[2]).toBe(prev.seats[2]);
    expect(v.version).toBe(2);
    // Nothing the server sent is changed.
    expect(v).toEqual(next);
  });

  it('as sent when nothing is the same, at another table or with nothing before', () => {
    const prev = view([seat(0)]);
    const changed = sent(view([seat(0, { stack: 1 })], { version: 2 }));
    expect(keepSeats(prev, changed)).toBe(changed);
    const elsewhere = sent(view([seat(0)], { table: { id: 't2' } as TableView['table'] }));
    expect(keepSeats(prev, elsewhere)).toBe(elsewhere);
    const first = sent(prev);
    expect(keepSeats(null, first)).toBe(first);
  });

  it('a seat taken by someone else, or holding new cards, is the new one', () => {
    const prev = view([seat(0), seat(1)]);
    const next = sent(view([seat(0, { userId: 'u9', nickname: 'p9' }), seat(1, { holeCards: ['As', 'Kd'] } as Partial<SeatView>)]));
    const v = keepSeats(prev, next);
    expect(v.seats[0]).toBe(next.seats[0]);
    expect(v.seats[1]).toBe(next.seats[1]);
  });
});
