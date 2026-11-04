import { describe, expect, it } from 'vitest';
import { buildReplay, type ReplayInput } from '../src/game/replay';
import type { Card } from '@jc/types';
import {
  beforeOnStreet,
  callPrice,
  decisionsOf,
  educationalFor,
  handClass,
  handNow,
  requestOf,
  SOLVER_PROVIDERS,
  solverFor,
  solverUnavailable,
  sprOf,
  type Decision,
  type SolverProvider,
  type SolverRequest,
  type SolverStatus,
} from '../src/game/strategy';

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

  it('offers a raise again after acting only once the bet grew by a full raise, as the engine does', () => {
    // The viewer opens to 300 (a raise of 200); the small blind shoves 400 (a raise of 100) or 500 (a full raise of 200);
    // the big blind, yet to act, may raise either way, and calls.
    const shove = (to: number) => {
      const h = hand({
        actions: [
          a(4, 'preflop', 'post-sb', 50),
          a(5, 'preflop', 'post-bb', 100),
          a(0, 'preflop', 'raise', 300),
          a(1, 'preflop', 'fold'),
          a(2, 'preflop', 'fold'),
          a(3, 'preflop', 'fold'),
          a(4, 'preflop', 'allin', to - 50),
          a(5, 'preflop', 'call', to - 100),
          a(0, 'preflop', 'call', to - 300),
        ],
      });
      h.players[4] = player(4, to);
      return h;
    };
    expect(decisions(shove(400), 5)[0]).toMatchObject({ toCall: 300, options: ['fold', 'call', 'raise'] });
    expect(decisions(shove(400))[1]).toMatchObject({ toCall: 100, facing: { kind: 'raise', to: 400 }, options: ['fold', 'call'], did: 'call' });
    expect(decisions(shove(500))[1]).toMatchObject({ toCall: 200, options: ['fold', 'call', 'raise'] });

    // Facing a lone all-in the table still offers a raise (the engine's own options), so the record does too.
    const lone = hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'raise', 300), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'allin', 2000), a(4, 'preflop', 'fold'), a(5, 'preflop', 'fold'), a(0, 'preflop', 'call', 1700)] });
    lone.players[3] = player(3, 2000);
    expect(decisions(lone)[1]).toMatchObject({ toCall: 1700, options: ['fold', 'call', 'raise'] });
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
  /** A provider that answers `r` after `running` looks at its status (or the status `end` then). */
  const provider = (r: Awaited<ReturnType<SolverProvider['getResult']>>, o: { running?: number; end?: SolverStatus; covers?: boolean; seen?: SolverRequest[] } = {}): SolverProvider => {
    let looks = 0;
    return {
      id: 'test',
      analyze: async (req) => {
        o.seen?.push(req);
        return o.covers === false ? null : 'job-1';
      },
      getStatus: async () => (looks++ < (o.running ?? 0) ? 'running' : (o.end ?? 'done')),
      getResult: async () => r,
    };
  };
  const now = { sleep: async () => {} };
  const freqs = [
    { choice: 'fold' as const, share: 0.2 },
    { choice: 'call' as const, share: 0.5 },
    { choice: 'raise' as const, share: 0.3 },
  ];

  it('ships with no solver: every decision reads as unavailable for that, none as a solver’s answer', async () => {
    expect(SOLVER_PROVIDERS).toHaveLength(0);
    const h = hand();
    for (const d of decisions(h)) {
      expect(solverUnavailable(d)).toEqual({ kind: 'unsupported', reason: 'noSolver' });
      expect(await solverFor(d, h, 0)).toEqual({ kind: 'unsupported', reason: 'noSolver' });
    }
    // Without a position the record states plainly, no spot can be looked up at all, a solver or not.
    const noButton = hand({ buttonSeat: null });
    const [d] = decisions(noButton);
    expect(d!.position).toBeNull();
    const seen: SolverRequest[] = [];
    expect(await solverFor(d!, noButton, 0, [provider({ source: 'S', freqs }, { seen })], now)).toEqual({ kind: 'unsupported', reason: 'noPosition' });
    expect(seen).toEqual([]);
  });

  it('shows a provider’s frequencies with its source once its analysis is done, and refuses any that do not fit the decision', async () => {
    const h = hand();
    const call = decisions(h)[2]!;
    const answer = { source: 'Test solver · 6-max 100bb', freqs };
    expect(await solverFor(call, h, 0, [provider(answer)], now)).toEqual({ kind: 'solver', ...answer });
    // Taking its time: followed until done.
    expect(await solverFor(call, h, 0, [provider(answer, { running: 3 })], now)).toEqual({ kind: 'solver', ...answer });
    // No source; a choice the viewer did not have (check, facing a bet); shares not adding up to 1; an unusable EV; no result.
    for (const bad of [
      { source: ' ', freqs },
      { source: 'S', freqs: [{ choice: 'check' as const, share: 1 }] },
      { source: 'S', freqs: freqs.slice(0, 2) },
      { source: 'S', freqs, ev: [{ choice: 'call' as const, bb: Number.NaN }] },
      null,
    ]) {
      expect(await solverFor(call, h, 0, [provider(bad)], now)).toEqual({ kind: 'unsupported', reason: 'noData' });
    }
    // A spot it does not cover, or one it calls unsupported.
    expect(await solverFor(call, h, 0, [provider(answer, { covers: false })], now)).toEqual({ kind: 'unsupported', reason: 'noData' });
    expect(await solverFor(call, h, 0, [provider(answer, { end: 'unsupported' })], now)).toEqual({ kind: 'unsupported', reason: 'noData' });
  });

  it('reads a failed, thrown or overlong analysis as failed, unless another provider answers', async () => {
    const h = hand();
    const call = decisions(h)[2]!;
    const answer = { source: 'S', freqs };
    const throws: SolverProvider = { id: 'x', analyze: async () => Promise.reject(new Error('down')), getStatus: async () => 'done', getResult: async () => answer };
    expect(await solverFor(call, h, 0, [provider(answer, { end: 'failed' })], now)).toEqual({ kind: 'failed' });
    expect(await solverFor(call, h, 0, [throws], now)).toEqual({ kind: 'failed' });
    // Still running after the time it may take: given up, never shown half done.
    expect(await solverFor(call, h, 0, [provider(answer, { running: 1000 })], { ...now, pollMs: 1000, timeoutMs: 5000 })).toEqual({ kind: 'failed' });
    expect(await solverFor(call, h, 0, [throws, provider(answer)], now)).toEqual({ kind: 'solver', ...answer });
    // A call that never comes back: given up once its time is out, or once the review closes.
    const hangs: SolverProvider = { id: 'h', analyze: async () => 'job-1', getStatus: () => new Promise<SolverStatus>(() => {}), getResult: async () => answer };
    expect(await solverFor(call, h, 0, [hangs], { ...now, timeoutMs: 50 })).toEqual({ kind: 'failed' });
    expect(await solverFor(call, h, 0, [hangs, provider(answer)], { ...now, timeoutMs: 50 })).toEqual({ kind: 'solver', ...answer });
    const closing = new AbortController();
    setTimeout(() => closing.abort(), 20);
    expect(await solverFor(call, h, 0, [hangs], { ...now, signal: closing.signal })).toEqual({ kind: 'failed' });
    // Stopped (the review closed): no answer taken.
    const stop = new AbortController();
    stop.abort();
    expect(await solverFor(call, h, 0, [provider(answer)], { ...now, signal: stop.signal })).toEqual({ kind: 'failed' });
  });

  it('asks only what the viewer knew then: never another player’s cards, a card still to come or an action after', async () => {
    const h = hand();
    // The button showed its cards at the end of the hand; the record has the whole board.
    h.players[3] = player(3, 10_000, ['Qs', 'Qd']);
    const flopCall = decisions(h)[2]!;
    const seen: SolverRequest[] = [];
    await solverFor(flopCall, h, 0, [provider(null, { seen })], now);
    const [req] = seen;
    expect(req).toEqual(requestOf(flopCall, h, 0));
    expect(req).toMatchObject({ stage: 'flop', position: 'UTG', heroSeat: 0, cards: ['Ah', 'Kh'], board: ['Kd', '7c', '2s'], toCall: 375, options: ['fold', 'call', 'raise'] });
    expect(req!.line).toEqual(h.actions.slice(0, flopCall.action).map((x) => ({ stage: x.stage, seat: x.seatIndex, type: x.type, amount: x.amount })));
    const text = JSON.stringify(req);
    for (const hidden of ['Qs', 'Qd', '9h', '4d']) expect(text).not.toContain(hidden);
    expect(Object.keys(req!)).not.toContain('players');
  });
});

describe('handNow: what the viewer’s cards made and drew to with the board then, and nothing still to come', () => {
  const flop = decisions(hand())[1]!;
  const at = (cards: string[], board: string[], stage: Decision['stage'] = 'flop') => handNow({ ...flop, stage, cards: cards as Card[], board: board as Card[] });

  it('ranks a pair against the board', () => {
    expect(at(['Ah', 'Kh'], ['Kd', '7c', '2s'])).toMatchObject({ made: { rankClass: 'pair' }, pair: 'top', draws: [] });
    expect(at(['7h', '6h'], ['Kd', '7c', '2s'])?.pair).toBe('second');
    expect(at(['2h', '3h'], ['Kd', '7c', '2s'])?.pair).toBe('low');
    expect(at(['Ac', 'Ad'], ['Kd', '7c', '2s'])?.pair).toBe('over');
    expect(at(['Qc', 'Qd'], ['Kd', '7c', '2s'])?.pair).toBe('pocket');
    // The board's own pair is everyone's: two overcards still draw.
    expect(at(['Ah', 'Jc'], ['7d', '7c', '2s'])).toMatchObject({ pair: 'board', draws: ['overcards'] });
  });

  it('names the draws as the bots read them, only where they would beat what is made', () => {
    expect(at(['Ah', 'Th'], ['Kh', '7h', '2c'])).toMatchObject({ made: { rankClass: 'high-card' }, draws: ['nutFlush'] });
    expect(at(['Qh', 'Jh'], ['Kh', '7h', 'Tc'])?.draws).toEqual(['flush', 'straight']);
    expect(at(['9s', '7d'], ['8c', '5h', 'Kd'])?.draws).toEqual(['gutshot']);
    expect(at(['As', 'Qd'], ['8c', '5h', '2d'])?.draws).toEqual(['overcards']);
    expect(at(['Ah', '3h'], ['Kh', '7c', '2c'])?.draws).toEqual(['backdoorFlush']);
    // Made: a flush draws to nothing more here, a straight still to a flush.
    expect(at(['Ah', 'Th'], ['Kh', '7h', '2h'])).toMatchObject({ made: { rankClass: 'flush' }, draws: [] });
    expect(at(['9h', '8h'], ['Th', 'Jh', '7c'])).toMatchObject({ made: { rankClass: 'straight' }, draws: ['flush'] });
    // Nothing is left to come on the river.
    expect(at(['Qh', 'Jh'], ['Kh', '7h', 'Tc', '2d', '3s'], 'river')?.draws).toEqual([]);
  });

  it('reads the board only as far as the decision’s street, and the two cards alone preflop', () => {
    // A board the record has whole: at the flop the turn and river were still to come.
    expect(at(['Qh', 'Jh'], ['Kh', '7h', 'Tc', 'Ah', '9h'])).toMatchObject({ made: { rankClass: 'high-card' }, draws: ['flush', 'straight'] });
    expect(at(['Ac', 'Ad'], ['Kd', '7c', '2s'], 'preflop')).toMatchObject({ made: { rankClass: 'pair' }, pair: null, draws: [] });
    expect(at(['Ac', 'Kd'], [], 'preflop')).toMatchObject({ made: { rankClass: 'high-card' }, pair: null, draws: [] });
    expect(handNow({ ...flop, cards: null })).toBeNull();
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

describe('the figures of the moment: what a call cost, the SPR, what came before on the street', () => {
  it('prices a call wherever there was one to make in full, raised or not, and the SPR from the flop on', () => {
    const h = hand();
    const [open, check, call, , fold] = decisions(h);
    // Raising the big blind: what calling it cost then. Nothing to call on a check.
    expect(callPrice(open!)).toEqual({ toCall: 100, pot: 150, need: 40 });
    expect(callPrice(check!)).toBeNull();
    // A call or a fold: the hand page's certain pot odds, the same numbers.
    expect(callPrice(call!)).toEqual(call!.odds);
    expect(callPrice(fold!)).toEqual({ toCall: 1125, pot: 2625, need: 30 });
    expect(sprOf(open!)).toBeNull();
    expect(sprOf(check!)).toBe(9700 / 750);
    expect(sprOf(fold!)).toBe(9325 / 1500);

    // A three-bet over an open: the open's price, as calling it would have cost.
    const three = hand({ actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(0, 'preflop', 'raise', 300), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'raise', 900), a(4, 'preflop', 'fold'), a(5, 'preflop', 'fold'), a(0, 'preflop', 'fold')] });
    expect(callPrice(decisions(three, 3)[0]!)).toEqual({ toCall: 300, pot: 450, need: 40 });
  });

  it('prices nothing the record leaves uncertain: a bet bigger than the stack, folded to', () => {
    const short = hand({ stack: 2000, actions: [a(4, 'preflop', 'post-sb', 50), a(5, 'preflop', 'post-bb', 100), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(3, 'preflop', 'raise', 5000), a(4, 'preflop', 'fold'), a(5, 'preflop', 'fold'), a(0, 'preflop', 'fold')] });
    const [d] = decisions(short);
    expect(d!.toCall).toBe(2000);
    expect(callPrice(d!)).toBeNull();
  });

  it('lists the street’s actions before each decision, the blinds included preflop, and none from another street', () => {
    const h = hand();
    const [open, check, call, , fold] = decisions(h);
    expect(beforeOnStreet(h, open!)).toEqual([0, 1]);
    expect(beforeOnStreet(h, check!)).toEqual([]);
    expect(beforeOnStreet(h, call!)).toEqual([8, 9]);
    expect(beforeOnStreet(h, fold!)).toEqual([11, 12]);
  });
});
