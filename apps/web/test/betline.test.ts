import { dealOrder, HandEngine, stackedDeck, type HandRecord } from '@jc/poker-engine';
import type { ActionType, Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { betActs, betLine, betWord, type BetAct } from '../src/game/betLine';
import { buildReplay, type ReplayInput } from '../src/game/replay';

type Move = [seat: number, type: ActionType, amount?: number];

/**
 * Plays a hand on the real engine (button seat 0, blinds 50/100): `moves` in turn, each by the seat named, then the
 * rest checked (or called) down. Its record is what the game worker stores.
 */
async function play(stacks: number[], moves: Move[], o: { holes?: string[]; board?: string; muck?: boolean } = {}): Promise<{ rec: HandRecord; maxSeats: number }> {
  const maxSeats = stacks.length === 2 ? 2 : stacks.length <= 6 ? 6 : 9;
  const cards = (s: string) => s.split(' ') as Card[];
  const h = HandEngine.start({
    handId: 'bl',
    rules: { maxSeats: maxSeats as 2 | 6 | 9, smallBlind: 50, bigBlind: 100, turnMs: 60_000 },
    seats: stacks.map((stack, i) => ({ playerId: `p${i}`, seatIndex: i, stack, displayName: `P${i}` })),
    buttonSeat: 0,
    now: 0,
    // `holes` by seat; the engine deals from the seat after the button round to it.
    deck: o.holes && o.board ? stackedDeck(dealOrder(stacks.length, 0).map((s) => cards(o.holes![s]!)), cards(o.board)) : undefined,
  });
  let g = 0;
  for (const [seat, type, amount] of moves) {
    const a = h.actorId();
    expect(a && h.seatOf(a), `move ${g}`).toBe(seat);
    const r = await h.act(a!, amount === undefined ? { type } : { type, amount }, `i${g}`, ++g);
    expect(r.ok, `move ${g}: ${r.ok ? '' : r.reason}`).toBe(true);
  }
  while (!h.isSettled) {
    const a = h.actorId();
    if (!a) throw new Error('stalled');
    const type = h.legalOptions(a).some((o) => o.type === 'check') ? 'check' : 'call';
    await h.act(a, { type }, `i${g}`, ++g);
  }
  // `muck`: every loser who may muck at the showdown does, as the table's auto-muck setting would have it.
  return { rec: h.record(g + 1, o.muck ? new Set(stacks.map((_, i) => `p${i}`)) : undefined), maxSeats };
}

/** The record as the API sends it to `viewer`: their own cards, and only the hands shown at the showdown besides. */
function input(rec: HandRecord, maxSeats: number, viewer: number | null): ReplayInput {
  return {
    id: rec.handId,
    tableName: 'T',
    handNumber: 1,
    board: rec.board,
    potTotal: rec.potTotal,
    smallBlind: rec.blinds.sb,
    bigBlind: rec.blinds.bb,
    maxSeats,
    buttonSeat: rec.buttonSeat,
    pots: rec.pots,
    returned: null,
    actions: rec.actions.map(({ seatIndex, stage, type, amount }) => ({ seatIndex, stage, type, amount })),
    players: rec.players.map((p) => {
      const visible = p.seatIndex === viewer || p.shown;
      return {
        seatIndex: p.seatIndex,
        nickname: `P${p.seatIndex}`,
        holeCards: visible ? p.holeCards : null,
        stackStart: p.stackStart,
        net: p.net,
        won: p.won,
        rankClass: visible ? p.rankClass : null,
        bestFive: visible ? p.bestFive : null,
        ...(p.wentToShowdown && !p.shown ? { mucked: true as const } : {}),
      };
    }),
  } as ReplayInput;
}

const WORDS = { sb: 'SB', bb: 'BB', fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in', nbet: (n: number) => `${n}-Bet` };
/** "Raise 250", "Fold": each act as a line says it. */
const said = (acts: BetAct[]) => acts.map((x) => `${x.seat} ${betWord(x, WORDS)}${x.amount === null ? '' : ` ${x.amount}`}`);

describe('betActs on the engine’s records', () => {
  it('reads an open, a 3-bet, a 4-bet and a call preflop, then a bet and an all-in raise on the flop', async () => {
    // Six players: 0 BTN, 1 SB, 2 BB, 3 UTG, 4 HJ, 5 CO.
    const { rec, maxSeats } = await play(
      [10_000, 10_000, 10_000, 10_000, 20_000, 10_000],
      [
        [3, 'fold'],
        [4, 'raise', 250],
        [5, 'raise', 800],
        [0, 'fold'],
        [1, 'fold'],
        [2, 'fold'],
        [4, 'raise', 2_000],
        [5, 'call'],
        [4, 'bet', 2_000],
        [5, 'allin'],
        [4, 'call'],
      ],
    );
    const h = input(rec, maxSeats, 4);
    const acts = betActs(h, h.actions);
    expect(said(acts)).toEqual([
      '1 SB 50',
      '2 BB 100',
      '3 Fold',
      '4 Raise 250',
      '5 3-Bet 800',
      '0 Fold',
      '1 Fold',
      '2 Fold',
      '4 4-Bet 2000',
      // A call by what it put in, the raises by the street total they reach.
      '5 Call 1200',
      '4 Bet 2000',
      '5 All-in 8000',
      '4 Call 6000',
    ]);
    expect(acts.map((x) => x.added)).toEqual([50, 100, 0, 250, 800, 0, 0, 0, 1_750, 1_200, 2_000, 8_000, 6_000]);
    // The 3-bet and 4-bet stand out; so does the flop all-in, more than the pot; the flop bet of 2000 into 4150 does not.
    expect(acts.filter((x) => x.big).map((x) => x.amount)).toEqual([800, 2_000, 8_000]);
    expect(acts.filter((x) => x.allIn).map((x) => x.seat)).toEqual([5]);
    expect(acts.map((x) => x.stage)).toEqual([...Array(10).fill('preflop'), 'flop', 'flop', 'flop']);
  });

  it('keeps the level at an all-in short of a full raise, and reads an all-in for less than the price as an all-in', async () => {
    // Four players: 0 BTN (450 chips), 1 SB, 2 BB, 3 UTG. UTG raises to 300 (by 200); the button's all-in to 450 raises by
    // only 150, so it is no re-raise, and the action does not open again for UTG.
    const { rec, maxSeats } = await play([450, 10_000, 10_000, 10_000], [
      [3, 'raise', 300],
      [0, 'allin'],
      [1, 'fold'],
      [2, 'call'],
      [3, 'call'],
    ]);
    const h = input(rec, maxSeats, null);
    const acts = betActs(h, h.actions);
    expect(said(acts.slice(0, 7))).toEqual(['1 SB 50', '2 BB 100', '3 Raise 300', '0 All-in 450', '1 Fold', '2 Call 350', '3 Call 150']);
    expect(acts[3]).toMatchObject({ kind: 'allin', level: 2, raised: true, allIn: true });
    // A short stack's all-in under the price: an all-in, its total said, no raise.
    const short = await play([10_000, 10_000, 120], [[0, 'raise', 300], [1, 'fold'], [2, 'allin']]);
    const sh = input(short.rec, short.maxSeats, null);
    expect(betActs(sh, sh.actions).at(-1)).toMatchObject({ seat: 2, kind: 'allin', amount: 120, added: 20, raised: false, allIn: true });
  });

  it('reads heads-up blinds, a completed small blind and the big blind’s check', async () => {
    const { rec, maxSeats } = await play([5_000, 5_000], [
      [0, 'call'],
      [1, 'check'],
    ]);
    const h = input(rec, maxSeats, 0);
    expect(said(betActs(h, h.actions).slice(0, 4))).toEqual(['0 SB 50', '1 BB 100', '0 Call 50', '1 Check']);
  });

  it('reads a call that puts a player’s last chips in as an all-in, and time-outs as what they became', () => {
    const h = { bigBlind: 100, players: [{ seatIndex: 0, stackStart: 5_000 }, { seatIndex: 1, stackStart: 300 }, { seatIndex: 2, stackStart: 5_000 }] };
    const acts = betActs(h, [
      { seatIndex: 1, stage: 'preflop', type: 'post-sb', amount: 50 },
      { seatIndex: 2, stage: 'preflop', type: 'post-bb', amount: 100 },
      { seatIndex: 0, stage: 'preflop', type: 'raise', amount: 300 },
      { seatIndex: 1, stage: 'preflop', type: 'call', amount: 250 },
      { seatIndex: 2, stage: 'preflop', type: 'timeout-fold', amount: 0 },
      { seatIndex: 0, stage: 'flop', type: 'timeout-check', amount: 0 },
    ]);
    expect(acts.slice(2).map((x) => [x.kind, x.amount, x.timeout])).toEqual([
      ['raise', 300, false],
      ['allin', 300, false],
      ['fold', null, true],
      ['check', null, true],
    ]);
  });

  it('marks a bet after the flop of at least the pot, and needs no blinds to read the actions', () => {
    const players = [{ seatIndex: 0, stackStart: 5_000 }, { seatIndex: 1, stackStart: 5_000 }];
    const acts = betActs({ bigBlind: null, players }, [
      { seatIndex: 0, stage: 'preflop', type: 'post-sb', amount: 50 },
      { seatIndex: 1, stage: 'preflop', type: 'post-bb', amount: 100 },
      { seatIndex: 0, stage: 'preflop', type: 'call', amount: 50 },
      { seatIndex: 1, stage: 'preflop', type: 'check', amount: 0 },
      { seatIndex: 1, stage: 'flop', type: 'bet', amount: 200 },
      { seatIndex: 0, stage: 'flop', type: 'raise', amount: 900 },
    ]);
    expect(acts.slice(4).map((x) => [betWord(x, WORDS), x.amount, x.big])).toEqual([
      ['Bet', 200, true],
      ['Raise', 900, true],
    ]);
  });
});

describe('betLine', () => {
  // HJ (seat 4) wins with aces; CO (seat 5) loses to them and, with `muck`, mucks.
  const sixWay = (muck = false) =>
    play(
      [10_000, 10_000, 10_000, 10_000, 20_000, 10_000],
      [
        [3, 'fold'],
        [4, 'raise', 250],
        [5, 'call'],
        [0, 'fold'],
        [1, 'fold'],
        [2, 'call'],
        [2, 'check'],
        [4, 'bet', 400],
        [5, 'call'],
        [2, 'fold'],
      ],
      { holes: ['Qs Js', 'Qc Jd', 'Tc 6d', '5s 2s', 'Ac Ad', '2c 7d'], board: 'Kh 9s 8d 4c 3h', muck },
    );

  it('lays the line out street by street, with each street’s board and the pot it began with, and the positions', async () => {
    const { rec, maxSeats } = await sixWay();
    const h = input(rec, maxSeats, 4);
    const steps = buildReplay(h, 4);
    const line = betLine(h, steps, steps.length - 1, 4);
    expect(line.complete).toBe(true);
    expect(line.streets.map((s) => [s.stage, s.cards.length, s.board.length, s.pot])).toEqual([
      ['preflop', 0, 0, 0],
      ['flop', 3, 3, 800],
      ['turn', 1, 4, 1_600],
      ['river', 1, 5, 1_600],
    ]);
    expect(said(line.streets[0]!.acts)).toEqual(['1 SB 50', '2 BB 100', '3 Fold', '4 Raise 250', '5 Call 250', '0 Fold', '1 Fold', '2 Call 150']);
    expect(said(line.streets[1]!.acts)).toEqual(['2 Check', '4 Bet 400', '5 Call 400', '2 Fold']);
    expect(line.streets[1]!.board).toEqual(rec.board.slice(0, 3));
    expect([...line.positions]).toEqual([
      [0, 'BTN'],
      [1, 'SB'],
      [2, 'BB'],
      [3, 'UTG'],
      [4, 'HJ'],
      [5, 'CO'],
    ]);
    expect(line.showdown?.map((x) => x.seat).sort()).toEqual([4, 5]);
    // The payout and the viewer's own result, from the record.
    expect(line.result!.pot).toBe(rec.potTotal);
    expect(line.result!.heroNet).toBe(rec.players[4]!.net);
    expect(line.result!.winners.reduce((a, w) => a + w.amount, 0)).toBe(rec.potTotal);
  });

  it('never says what came after the step: no later action, board card, shown hand or payout', async () => {
    const { rec, maxSeats } = await sixWay();
    const h = input(rec, maxSeats, 4);
    const steps = buildReplay(h, 4);
    const full = betLine(h, steps, steps.length - 1, 4);
    const allActs = full.streets.flatMap((s) => s.acts);
    steps.forEach((s, k) => {
      const line = betLine(h, steps, k, 4);
      const acts = line.streets.flatMap((x) => x.acts);
      const taken = steps.slice(0, k + 1).reduce((n, x) => n + x.actions.length, 0);
      expect(acts).toEqual(allActs.slice(0, taken));
      const board = s.view.hand!.board;
      for (const x of line.streets) expect(board.slice(0, x.board.length)).toEqual(x.board);
      expect(line.streets.at(-1)!.board).toEqual(board);
      expect(line.showdown === null).toBe(!steps.slice(0, k + 1).some((x) => x.kind === 'showdown'));
      expect(line.result === null).toBe(k < steps.length - 1);
      expect(line.complete).toBe(k === steps.length - 1);
    });
    // On the flop's first action the flop is all there is after the preflop.
    const flopBet = steps.findIndex((s) => s.kind === 'action' && s.stage === 'flop');
    expect(betLine(h, steps, flopBet, 4).streets.map((s) => s.stage)).toEqual(['preflop', 'flop']);
  });

  it('shows the hands the record shows at the showdown and a mucked one face down, and no result for a spectator', async () => {
    for (const muck of [false, true]) {
      const { rec, maxSeats } = await sixWay(muck);
      expect(rec.players[5]!.shown).toBe(!muck);
      const h = input(rec, maxSeats, null);
      const steps = buildReplay(h, null);
      const line = betLine(h, steps, steps.length - 1, null);
      expect(line.result!.heroNet).toBeNull();
      expect(line.result!.winners).toEqual([{ seat: 4, amount: rec.potTotal }]);
      expect(line.showdown).toEqual([
        { seat: 4, muck: false, cards: ['Ac', 'Ad'], rankClass: 'pair', bestFive: rec.players[4]!.bestFive },
        muck
          ? { seat: 5, muck: true, cards: null, rankClass: null, bestFive: [] }
          : { seat: 5, muck: false, cards: ['2c', '7d'], rankClass: 'high-card', bestFive: rec.players[5]!.bestFive },
      ]);
      // A mucked hand shows no card of it anywhere in the line.
      if (muck) expect(JSON.stringify(line)).not.toMatch(/"2c"|"7d"/);
    }
  });

  it('reads a viewer who mucked as mucking, though they still see their own cards', async () => {
    const { rec, maxSeats } = await sixWay(true);
    const h = input(rec, maxSeats, 5);
    const steps = buildReplay(h, 5);
    const sd = steps.find((s) => s.kind === 'showdown')!;
    expect(sd.line.filter((x) => x.kind === 'shows' || x.kind === 'mucks').map((x) => [x.kind, 'seat' in x ? x.seat : null])).toEqual([
      ['shows', 4],
      ['mucks', 5],
    ]);
    expect(sd.view.seats[5]?.holeCards).toEqual(['2c', '7d']);
    expect(betLine(h, steps, steps.length - 1, 5).showdown![1]).toMatchObject({ seat: 5, muck: true, cards: null });
  });

  it('ends without a showdown, and reads no positions where the blinds are not where the button puts them', async () => {
    const { rec, maxSeats } = await play([5_000, 5_000, 5_000], [
      [0, 'raise', 300],
      [1, 'fold'],
      [2, 'fold'],
    ]);
    const h = input(rec, maxSeats, 0);
    const steps = buildReplay(h, 0);
    const line = betLine(h, steps, steps.length - 1, 0);
    expect(line.showdown).toBeNull();
    expect(line.streets.map((s) => s.stage)).toEqual(['preflop']);
    expect(line.result!.heroNet).toBe(150);
    expect([...line.positions.values()]).toEqual(['BTN', 'SB', 'BB']);
    const moved = { ...h, buttonSeat: 1 };
    expect(betLine(moved, buildReplay(moved, 0), 0, 0).positions.size).toBe(0);
    expect(betLine({ ...h, buttonSeat: null }, steps, 0, 0).positions.size).toBe(0);
  });

  it('gives positions for 2 to 9 players from the engine’s own blinds', async () => {
    for (const n of [2, 3, 6, 9]) {
      const { rec, maxSeats } = await play(Array(n).fill(5_000), []);
      const h = input(rec, maxSeats, 0);
      const line = betLine(h, buildReplay(h, 0), 0, 0);
      expect(line.positions.size, `${n} players`).toBe(n);
      expect(line.positions.get(0)).toBe(n === 2 ? 'BTN/SB' : 'BTN');
      expect(line.positions.get(rec.actions.find((a) => a.type === 'post-bb')!.seatIndex)).toBe('BB');
    }
  });
});
