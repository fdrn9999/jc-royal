import type { HandPotDto } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { replayBlinds, replayLog, replayPlayer, replaySettlement, type SettlementRow } from './community';

const pot = (amount: number, eligibleSeats: number[], winners: [seat: number, amount: number][], uncalled = false): HandPotDto => ({
  amount,
  eligibleSeats,
  winners: winners.map(([seatIndex, amount]) => ({ seatIndex, amount })),
  uncalled,
});
/** A player row with its statistics filled: pot_won is won less what came back to them (handStats.ts). */
const row = (seatIndex: number, won: number, back = 0): SettlementRow => ({ seatIndex, won, potWon: won - back });

/** The sums a replay relies on: each pot's winners add up to it, each player's to what they won, the pots to the total. */
function balanced(pots: HandPotDto[], rows: SettlementRow[], total: number) {
  expect(pots.reduce((x, p) => x + p.amount, 0)).toBe(total);
  for (const p of pots) expect(p.winners.reduce((x, w) => x + w.amount, 0)).toBe(p.amount);
  for (const r of rows) expect(pots.flatMap((p) => p.winners).filter((w) => w.seatIndex === r.seatIndex).reduce((x, w) => x + w.amount, 0)).toBe(r.won);
}

describe('replaySettlement', () => {
  // Seat 0 raises to 300 over the blinds of 50 and 100; both fold. The engine pays one pot of 450.
  const raiseFold = [pot(450, [0], [[0, 450]])];
  const raiseFoldRows = [row(0, 450, 200), row(1, 0), row(2, 0)];

  it('takes a raise everyone folded to out of the pot that paid it, by what the statistics say came back', () => {
    const out = replaySettlement(raiseFold, raiseFoldRows);
    expect(out).toEqual({ pots: [pot(250, [0], [[0, 250]]), pot(200, [0], [[0, 200]], true)], returned: { seatIndex: 0, amount: 200 } });
    balanced(out.pots!, raiseFoldRows, 450);
  });

  it('leaves the pots as stored when the engine already paid the handed-back chips as their own pot', () => {
    // Seat 0 all in for 100, seat 1 for 500, seat 2 calls 300: seat 1's last 200 had no caller.
    const pots = [pot(300, [0, 1, 2], [[0, 300]]), pot(400, [1, 2], [[2, 400]]), pot(200, [1], [[1, 200]], true)];
    const rows = [row(0, 300), row(1, 200, 200), row(2, 400)];
    expect(replaySettlement(pots, rows)).toEqual({ pots, returned: { seatIndex: 1, amount: 200 } });
    // A stored pot the statistics don't match is not second-guessed: nothing is said to have come back.
    expect(replaySettlement(pots, [row(0, 300), row(1, 200, 150), row(2, 400)])).toEqual({ pots, returned: null });
  });

  it('changes nothing when nothing came back: every bet was called', () => {
    const pots = [pot(650, [0, 2], [[0, 650]])];
    expect(replaySettlement(pots, [row(0, 650), row(1, 0), row(2, 0)])).toEqual({ pots, returned: null });
  });

  it('finds the handed-back chips in the last pot the bettor won when an all-in split the pots and a folded player shares that pot', () => {
    // Seat 0 is all in for 100; seat 1 puts in 500; seat 2 puts in 300 and folds. One side pot holds seat 1's 400 and
    // seat 2's 200 above the all-in: 200 of it is seat 1's own, nobody called.
    const pots = [pot(300, [0, 1], [[0, 300]]), pot(600, [1], [[1, 600]])];
    const rows = [row(0, 300), row(1, 600, 200), row(2, 0)];
    const out = replaySettlement(pots, rows);
    expect(out).toEqual({ pots: [pot(300, [0, 1], [[0, 300]]), pot(400, [1], [[1, 400]]), pot(200, [1], [[1, 200]], true)], returned: { seatIndex: 1, amount: 200 } });
    balanced(out.pots!, rows, 900);
  });

  it('gives the handed-back chips for hands recorded before pots were stored', () => {
    expect(replaySettlement(null, raiseFoldRows)).toEqual({ pots: null, returned: { seatIndex: 0, amount: 200 } });
  });

  it('sends the pots as stored, and nothing handed back, while the statistics are not filled or do not fit the pots', () => {
    const asStored = { pots: raiseFold, returned: null };
    // Not filled yet: the game worker fills them right after recording the hand.
    expect(replaySettlement(raiseFold, [row(0, 450, 200), { seatIndex: 1, won: 0, potWon: null }, row(2, 0)])).toEqual(asStored);
    expect(replaySettlement(null, [{ seatIndex: 0, won: 450, potWon: null }, row(1, 0)])).toEqual({ pots: null, returned: null });
    // More than the player's share of the pot, two players handed chips back, or chips back to a player who won no pot.
    expect(replaySettlement(raiseFold, [row(0, 450, 451), row(1, 0), row(2, 0)])).toEqual(asStored);
    expect(replaySettlement(raiseFold, [row(0, 450, 200), row(1, 10, 10), row(2, 0)])).toEqual(asStored);
    expect(replaySettlement(raiseFold, [row(0, 450), row(1, 10, 10), row(2, 0)])).toEqual(asStored);
  });

  it('keeps the other winners of a split pot the chips came out of', () => {
    const pots = [pot(500, [0, 1], [[0, 300], [1, 200]])];
    const rows = [row(0, 300, 100), row(1, 200)];
    const out = replaySettlement(pots, rows);
    expect(out.pots).toEqual([pot(400, [0, 1], [[0, 200], [1, 200]]), pot(100, [0], [[0, 100]], true)]);
    balanced(out.pots!, rows, 500);
  });
});

describe('replayLog', () => {
  it('reads the public part of the log and settles its pots with the player rows', () => {
    const log = JSON.stringify({ actions: [{ seatIndex: 0, stage: 'preflop', type: 'raise', amount: 300, playerId: 'u0', at: 1 }], button: 0, pots: [pot(450, [0], [[0, 450]])], engine: 'x' });
    expect(replayLog(log, [row(0, 450, 200), row(1, 0), row(2, 0)])).toEqual({
      actions: [{ seatIndex: 0, stage: 'preflop', type: 'raise', amount: 300 }],
      buttonSeat: 0,
      smallBlind: null,
      bigBlind: null,
      pots: [pot(250, [0], [[0, 250]]), pot(200, [0], [[0, 200]], true)],
      returned: { seatIndex: 0, amount: 200 },
    });
    // A log from before the button and pots were stored.
    expect(replayLog(JSON.stringify({ actions: [] }), [row(0, 450, 200), row(1, 0)])).toEqual({
      actions: [],
      buttonSeat: null,
      smallBlind: null,
      bigBlind: null,
      pots: null,
      returned: { seatIndex: 0, amount: 200 },
    });
  });

  it('gives the blinds the hand was dealt at, stored with it', () => {
    const log = JSON.stringify({ actions: [], button: 0, blinds: { sb: 200, bb: 400 }, pots: null, engine: 'x' });
    expect(replayLog(log, [row(0, 0), row(1, 0)])).toMatchObject({ smallBlind: 200, bigBlind: 400 });
  });
});

describe('replayPlayer', () => {
  const hp = (o: { userId: string; wentToShowdown: boolean; shown: boolean | null }) => ({
    handId: 'h',
    seatIndex: 1,
    holeCards: '["Ah","Kd"]',
    stackStart: 1000,
    stackEnd: 0,
    net: -1000,
    won: 0,
    rankClass: 'pair',
    rankValue: 1,
    bestFive: '["Ah","Ad","Kd","9c","7s"]',
    endedAt: 1,
    position: null,
    vpip: null,
    pfr: null,
    sawFlop: null,
    potWon: null,
    ...o,
  });
  const user = { nickname: 'x', role: 'user', status: 'active', isBot: false, vipColor: null };

  it('says a hand went in face down at the showdown, never what it held, to everyone but its player', () => {
    const other = replayPlayer(hp({ userId: 'u1', wentToShowdown: true, shown: false }), user, 'viewer');
    expect(other).toMatchObject({ mucked: true, holeCards: null, rankClass: null, bestFive: null });
    const own = replayPlayer(hp({ userId: 'u1', wentToShowdown: true, shown: false }), user, 'u1');
    expect(own).toMatchObject({ mucked: true, holeCards: ['Ah', 'Kd'], rankClass: 'pair' });
  });

  it('flags no hand shown down, folded, or recorded before mucking existed', () => {
    for (const row of [hp({ userId: 'u1', wentToShowdown: true, shown: true }), hp({ userId: 'u1', wentToShowdown: false, shown: false }), hp({ userId: 'u1', wentToShowdown: true, shown: null })])
      expect(replayPlayer(row, user, 'viewer')).not.toHaveProperty('mucked');
  });
});

describe('replayBlinds', () => {
  const sb = { seatIndex: 1, type: 'post-sb', amount: 50 };
  const bb = { seatIndex: 2, type: 'post-bb', amount: 100 };

  it('prefers the stored blinds, and ignores stored values that are no chip counts', () => {
    expect(replayBlinds({ sb: 25, bb: 50 }, [sb, bb], [])).toEqual({ smallBlind: 25, bigBlind: 50 });
    expect(replayBlinds({ sb: 0, bb: 50 }, [], [])).toEqual({ smallBlind: null, bigBlind: null });
    expect(replayBlinds({ sb: '25', bb: 50.5 }, [], [])).toEqual({ smallBlind: null, bigBlind: null });
  });

  it('reads an older hand blinds off posts made by players who had chips left', () => {
    const rows = [{ seatIndex: 1, stackStart: 5_000 }, { seatIndex: 2, stackStart: 5_000 }];
    expect(replayBlinds(null, [sb, bb], rows)).toEqual({ smallBlind: 50, bigBlind: 100 });
  });

  it('does not guess a blind a short stack posted all in, nor one without a starting stack', () => {
    // The big blind had 60 and posted all of it: the blind was 60 or more, which is not known.
    const shortBb = { seatIndex: 2, type: 'post-bb', amount: 60 };
    expect(replayBlinds(null, [sb, shortBb], [{ seatIndex: 1, stackStart: 5_000 }, { seatIndex: 2, stackStart: 60 }])).toEqual({ smallBlind: 50, bigBlind: null });
    expect(replayBlinds(undefined, [sb, bb], [{ seatIndex: 1 }])).toEqual({ smallBlind: null, bigBlind: null });
    expect(replayBlinds(undefined, [], [])).toEqual({ smallBlind: null, bigBlind: null });
  });
});
