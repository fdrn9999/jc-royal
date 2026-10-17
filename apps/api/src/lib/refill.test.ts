// Counting the chips on a member's tables for a refill (refill.ts tableChips): one round of answers from several tables
// can add up to a total the member never held; a second round that finds every table as it was makes the total one the
// member held at a single moment.
import { describe, expect, it } from 'vitest';
import { tableChips } from './refill';

const seat = (tableSessionId: string, stack: number, settled: string | null, more: Record<string, unknown> = {}) => ({ seated: true, tableSessionId, stack, stable: true, inHand: false, settled, ...more });
const SESSIONS = ['s-a', 's-b'];

describe('the chips on the member’s tables', () => {
  it('holds a total read across settlements: table A before its hand settled up, table B after its hand settled down', () => {
    // A: 400 → 600, B: 600 → 400. The member held 1,000 then 1,200 then 1,000, never 800.
    const first = [seat('s-a', 400, 'a-1'), seat('s-b', 400, 'b-2')];
    // One round adds the two moments together.
    expect(tableChips(SESSIONS, first)).toEqual({ tables: 800 });
    // Asked again, A has moved on: the total is not one the member held, so the claim waits.
    expect(tableChips(SESSIONS, first, [seat('s-a', 600, 'a-2'), seat('s-b', 400, 'b-2')])).toEqual({ hold: 'busy' });
  });

  it('counts tables that answer the same twice', () => {
    const first = [seat('s-a', 400, 'a-1'), seat('s-b', 600, null)];
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-1'), seat('s-b', 600, null)])).toEqual({ tables: 1000 });
  });

  it('holds when a hand settled in between, even one that left the stack as it was', () => {
    const first = [seat('s-a', 400, 'a-1'), seat('s-b', 600, 'b-1')];
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-2'), seat('s-b', 600, 'b-1')])).toEqual({ hold: 'busy' });
  });

  it('still compares stacks with a table from before `settled`', () => {
    const old = (id: string, stack: number) => ({ seated: true, tableSessionId: id, stack, stable: true, inHand: false });
    expect(tableChips(SESSIONS, [old('s-a', 400), old('s-b', 600)], [old('s-a', 400), old('s-b', 600)])).toEqual({ tables: 1000 });
    expect(tableChips(SESSIONS, [old('s-a', 400), old('s-b', 600)], [old('s-a', 400), old('s-b', 500)])).toEqual({ hold: 'busy' });
  });

  it('holds when the second round finds a table silent, a seat gone or chips on their way', () => {
    const first = [seat('s-a', 400, 'a-1'), seat('s-b', 600, 'b-1')];
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-1'), null])).toEqual({ hold: 'unreachable' });
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-1'), { seated: false }])).toEqual({ hold: 'busy' });
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-1'), seat('s-b-2', 600, 'b-1')])).toEqual({ hold: 'busy' });
    expect(tableChips(SESSIONS, first, [seat('s-a', 400, 'a-1', { stable: false }), seat('s-b', 600, 'b-1')])).toEqual({ hold: 'busy' });
  });

  it('keeps the first round’s reasons: a silent table, a seat the table does not hold, chips on their way', () => {
    expect(tableChips(SESSIONS, [seat('s-a', 400, null), null])).toEqual({ hold: 'unreachable' });
    expect(tableChips(SESSIONS, [seat('s-a', 400, null), { seated: false }])).toEqual({ hold: 'mismatch' });
    expect(tableChips(SESSIONS, [seat('s-a', 400, null), seat('s-other', 600, null)])).toEqual({ hold: 'mismatch' });
    expect(tableChips(SESSIONS, [seat('s-a', 400, null, { stable: false }), seat('s-b', 600, null)])).toEqual({ hold: 'busy' });
    expect(tableChips([], [])).toEqual({ tables: 0 });
  });
});
