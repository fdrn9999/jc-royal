import { describe, expect, it } from 'vitest';
import { buildReplay, type ReplayInput } from '../src/game/replay';
import { decisionsOf, educationalFor, handClass, SOLVER_PROVIDERS, solverFor, type StrategyProvider } from '../src/game/strategy';

const a = (seatIndex: number, stage: string, type: string, amount = 0) => ({ seatIndex, stage, type, amount });
const player = (seatIndex: number, stackStart: number, holeCards: string[] | null = null) => ({
  seatIndex,
  nickname: `p${seatIndex}`,
  holeCards,
  stackStart,
  net: 0,
  won: 0,
  rankClass: null,
  bestFive: null,
});

/**
 * Six-handed at 50/100, button 3 (so seat 0 is UTG), everyone 100 big blinds deep. The viewer (seat 0, AKs) opens to
 * 300, the button calls; the viewer checks the flop and calls a half-pot bet, then checks the turn and folds to a
 * three-quarter-pot bet.
 */
function hand(o: { stack?: number; buttonSeat?: number | null; seats?: number; actions?: ReturnType<typeof a>[] } = {}): ReplayInput {
  const stack = o.stack ?? 10_000;
  const seats = o.seats ?? 6;
  return {
    id: 'h',
    tableName: 'T',
    handNumber: 1,
    board: ['Kd', '7c', '2s', '9h', '4d'],
    potTotal: 2625,
    smallBlind: 50,
    bigBlind: 100,
    maxSeats: 9,
    buttonSeat: o.buttonSeat === undefined ? 3 : o.buttonSeat,
    pots: null,
    returned: null,
    actions: o.actions ?? [
      a(4, 'preflop', 'post-sb', 50),
      a(5, 'preflop', 'post-bb', 100),
      a(0, 'preflop', 'raise', 300),
      a(1, 'preflop', 'fold'),
      a(2, 'preflop', 'fold'),
      a(3, 'preflop', 'call', 300),
      a(4, 'preflop', 'fold'),
      a(5, 'preflop', 'fold'),
      a(0, 'flop', 'check'),
      a(3, 'flop', 'bet', 375),
      a(0, 'flop', 'call', 375),
      a(0, 'turn', 'check'),
      a(3, 'turn', 'bet', 1125),
      a(0, 'turn', 'fold'),
    ],
    players: Array.from({ length: seats }, (_, s) => player(s, s === 0 ? stack : 10_000, s === 0 ? ['Ah', 'Kh'] : null)),
  };
}

const decisions = (h: ReplayInput, hero: number | null = 0) => decisionsOf(h, buildReplay(h, hero), hero);

describe('decisionsOf: the viewer’s own decisions, from the record alone', () => {
  it('finds every decision but the blinds, at the replay step that shows it, with the situation as it came to the viewer', () => {
    const h = hand();
    const steps = buildReplay(h, 0);
    const ds = decisionsOf(h, steps, 0);
    expect(ds.map((d) => [d.stage, d.did])).toEqual([
      ['preflop', 'raise'],
      ['flop', 'check'],
      ['flop', 'call'],
      ['turn', 'check'],
      ['turn', 'fold'],
    ]);
    for (const d of ds) {
      expect(steps[d.step]!.kind).toBe('action');
      expect(steps[d.step]!.actions[0]).toBe(h.actions[d.action]);
      expect(h.actions[d.action]!.seatIndex).toBe(0);
    }
    const [open, check, call, , fold] = ds;
    expect(open).toMatchObject({ position: 'UTG', dealt: 6, live: 6, pot: 150, toCall: 100, stack: 10_000, effective: 10_000, unopened: true, facing: null, options: ['fold', 'call', 'raise'], amount: 300, cards: ['Ah', 'Kh'], board: [] });
    expect(check).toMatchObject({ live: 2, pot: 750, toCall: 0, options: ['check', 'bet'], streetPot: 750, effective: 9700, unopened: false, board: ['Kd', '7c', '2s'] });
    expect(call).toMatchObject({ toCall: 375, pot: 1125, facing: { kind: 'bet', to: 375, potBefore: 750, raises: 1 }, amount: 375, odds: { toCall: 375, pot: 1125, need: 25 } });
    expect(fold).toMatchObject({ toCall: 1125, pot: 2625, facing: { kind: 'bet', to: 1125, potBefore: 1500 }, amount: 0, board: ['Kd', '7c', '2s', '9h'] });
  });

  it('has none for a hand the viewer was not dealt into, or did not act in', () => {
    expect(decisions(hand(), null)).toEqual([]);
    expect(decisions(hand(), 8)).toEqual([]);
    // The big blind, folded round to: the blind was the only chips the viewer put in.
    expect(decisions(hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'fold'), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'fold'), a(4, 'preflop', 'fold')] }), 5)).toEqual([]);
  });

  it('reads the big blind’s option after a limp as check or raise, and a short call as all the viewer had', () => {
    const limp = hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'call', 100), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'fold'), a(4, 'preflop', 'fold'), a(5, 'preflop', 'check')] });
    expect(decisions(limp, 5)[0]).toMatchObject({ position: 'BB', toCall: 0, options: ['check', 'raise'], did: 'check', unopened: false });
    expect(decisions(limp, 0)[0]).toMatchObject({ did: 'call', amount: 100, unopened: true });

    // 20 big blinds facing a raise to 50: calling all in is the most the viewer can put in.
    const shove = hand({ stack: 2000, actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'raise', 5000), a(4, 'preflop', 'fold'), a(5, 'preflop', 'fold'), a(0, 'preflop', 'allin', 2000)] });
    expect(decisions(shove)[0]).toMatchObject({ toCall: 2000, stack: 2000, options: ['fold', 'call'], did: 'call', allIn: true, facing: { kind: 'raise', to: 5000, raises: 1 } });
  });

  it('marks a choice the clock made', () => {
    const h = hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'timeout-fold')] });
    expect(decisions(h)[0]).toMatchObject({ did: 'fold', timedOut: true });
  });
});

describe('handClass', () => {
  it('names two cards by class, the higher rank first', () => {
    expect(handClass(['Ah', 'Kh'])).toBe('AKs');
    expect(handClass(['Kd', 'Ac'])).toBe('AKo');
    expect(handClass(['7c', '7d'])).toBe('77');
    expect(handClass(['9c', 'Tc'])).toBe('T9s');
    expect(handClass(null)).toBeNull();
    expect(handClass(['Ah'])).toBeNull();
  });
});

describe('solverFor: solver frequencies only from real solver data, always with its source', () => {
  it('ships with no solver data: every decision reads as unsupported, none as a solver’s answer', () => {
    expect(SOLVER_PROVIDERS).toHaveLength(0);
    const h = hand();
    for (const d of decisions(h)) expect(solverFor(d, h)).toEqual({ kind: 'unsupported', reason: 'noData' });
    // Without a position the record states plainly, no spot can be looked up at all.
    const [d] = decisions(hand({ buttonSeat: null }));
    expect(d!.position).toBeNull();
    expect(solverFor(d!, h)).toEqual({ kind: 'unsupported', reason: 'noPosition' });
  });

  it('shows a provider’s frequencies with its source, and refuses any that do not fit the decision', () => {
    const h = hand();
    const call = decisions(h)[2]!;
    const provider = (r: ReturnType<StrategyProvider['lookup']>): StrategyProvider => ({ id: 'test', lookup: () => r });
    const freqs = [
      { choice: 'fold' as const, share: 0.2 },
      { choice: 'call' as const, share: 0.5 },
      { choice: 'raise' as const, share: 0.3 },
    ];
    expect(solverFor(call, h, [provider({ source: 'Test solver · 6-max 100bb', freqs })])).toEqual({ kind: 'solver', source: 'Test solver · 6-max 100bb', freqs });
    // No source; a choice the viewer did not have (check, facing a bet); shares not adding up to 1; an unusable EV; a spot it does not cover.
    for (const bad of [
      { source: ' ', freqs },
      { source: 'S', freqs: [{ choice: 'check' as const, share: 1 }] },
      { source: 'S', freqs: freqs.slice(0, 2) },
      { source: 'S', freqs, ev: [{ choice: 'call' as const, bb: Number.NaN }] },
      null,
    ]) {
      expect(solverFor(call, h, [provider(bad)])).toEqual({ kind: 'unsupported', reason: 'noData' });
    }
  });
});

describe('educationalFor: plain arithmetic, and the academy’s example range only where it was drawn for', () => {
  it('gives pot odds, the bet’s size and the SPR of the decision', () => {
    const h = hand();
    const [open, check, call] = decisions(h);
    expect(educationalFor(check!, 100)).toEqual([{ kind: 'spr', ratio: 9700 / 750, effective: 9700, pot: 750 }]);
    expect(educationalFor(call!, 100)).toEqual([
      { kind: 'potOdds', odds: { toCall: 375, pot: 1125, need: 25 } },
      { kind: 'betSize', to: 375, potBefore: 750, share: 0.5 },
      { kind: 'spr', ratio: 9700 / 750, effective: 9700, pot: 750 },
    ]);
    expect(educationalFor(open!, 100)).toEqual([{ kind: 'openRange', seat: 'UTG', hand: 'AKs', inRange: true, opened: true }]);
  });

  it('compares with the example opening range only six-handed, about 100 big blinds deep, raise first in', () => {
    const range = (h: ReplayInput, hero = 0) => educationalFor(decisions(h, hero)[0]!, 100).filter((n) => n.kind === 'openRange');
    // 300 deep against everyone's 100: the effective stack is still 100 big blinds. Shallow, or nine-handed: no range.
    expect(range(hand({ stack: 30_000 }))).toEqual([{ kind: 'openRange', seat: 'UTG', hand: 'AKs', inRange: true, opened: true }]);
    expect(range(hand({ stack: 4000 }))).toEqual([]);
    expect(range(hand({ seats: 9 }))).toEqual([]);
    // Facing a raise is no longer raise first in.
    const facing = hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(1, 'preflop', 'raise', 300), a(2, 'preflop', 'fold'), a(3, 'preflop', 'fold'), a(4, 'preflop', 'fold'), a(5, 'preflop', 'fold'), a(0, 'preflop', 'fold')] });
    expect(range(facing)).toEqual([]);
    // A hand outside the example range, folded: the comparison says both, without a verdict.
    const weak = hand();
    weak.players[0] = player(0, 10_000, ['7h', '2c']);
    weak.actions = [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'fold')];
    expect(range(weak)).toEqual([{ kind: 'openRange', seat: 'UTG', hand: '72o', inRange: false, opened: false }]);
  });
});
