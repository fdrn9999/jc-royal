/**
 * Rabbit hunting (`HandEngine.rabbitHunt`): after a hand that ended before the river, the community cards that would
 * have come, from the deck as it lies. Nothing of the hand changes, and nothing is told while it is played.
 */
import type { Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { HandEngine, standardDeck } from '../src';
import { checkDown, must, stackedDeck, start } from './helpers';

const c = (s: string) => s.split(' ') as Card[];
// Deal order (button 0, three seats): p1, p2, p0.
const HOLES = [c('Kc Kd'), c('2c 7d'), c('Ac Ad')];
const BOARD = c('As 9h 5s 4c Jd');
const deck = () => stackedDeck(HOLES, BOARD);
const state = (h: HandEngine) => JSON.stringify({ kept: h.persist(), view: h.handView(), record: h.record(99), stacks: [...h.finalStacks()] });
const passive = async (h: HandEngine) => {
  const id = h.actorId()!;
  await must(h, id, h.legalOptions(id).some((o) => o.type === 'check') ? 'check' : 'call');
};

/** Everybody calls or checks to `stage`, then the first to act bets and the others fold. */
async function foldAt(h: HandEngine, stage: 'preflop' | 'flop' | 'turn' | 'river') {
  if (stage === 'preflop') {
    await must(h, 'p0', 'raise', 30);
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    return;
  }
  for (let guard = 0; guard < 30 && h.stage !== stage; guard++) await passive(h);
  expect(h.stage).toBe(stage);
  await must(h, 'p1', 'bet', 20);
  await must(h, 'p2', 'fold');
  await must(h, 'p0', 'fold');
}

describe('rabbit hunting', () => {
  it('a hand that ended before the flop: the five cards the deck held for the board, the burned cards left out', async () => {
    const d = deck();
    const h = start([1000, 1000, 1000], { button: 0, deck: [...d] });
    await foldAt(h, 'preflop');
    expect(h.isSettled).toBe(true);
    expect(h.handView().board).toEqual([]);
    expect(h.rabbitHunt()).toEqual(BOARD);
    // The deck's own order: six hole cards, a burn, the flop, a burn, the turn, a burn, the river.
    expect(h.rabbitHunt()).toEqual([d[7], d[8], d[9], d[11], d[13]]);
    for (const burn of [d[6], d[10], d[12]]) expect(h.rabbitHunt()).not.toContain(burn);
  });

  it('ended on the flop: the turn and the river; ended on the turn: the river', async () => {
    const flop = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await foldAt(flop, 'flop');
    expect(flop.handView().board).toEqual(BOARD.slice(0, 3));
    expect(flop.rabbitHunt()).toEqual(BOARD.slice(3));

    const turn = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await foldAt(turn, 'turn');
    expect(turn.handView().board).toEqual(BOARD.slice(0, 4));
    expect(turn.rabbitHunt()).toEqual(BOARD.slice(4));
  });

  it('nothing to show once the river is out: a fold on the river, a showdown, an all-in run out', async () => {
    const river = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await foldAt(river, 'river');
    expect(river.isSettled).toBe(true);
    expect(river.rabbitHunt()).toBeNull();

    const shown = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await checkDown(shown);
    expect(shown.handView().result!.showdown.length).toBeGreaterThan(0);
    expect(shown.rabbitHunt()).toBeNull();

    const allin = start([300, 300, 300], { button: 0, deck: deck() });
    await must(allin, 'p0', 'allin');
    await must(allin, 'p1', 'allin');
    await must(allin, 'p2', 'fold');
    expect(allin.isSettled).toBe(true);
    expect(allin.handView().board).toEqual(BOARD);
    expect(allin.rabbitHunt()).toBeNull();
  });

  it('never while the hand is played, on any street', async () => {
    const h = start([1000, 1000, 1000], { button: 0, deck: deck() });
    const streets = new Set<string>();
    for (let guard = 0; guard < 30 && !h.isSettled; guard++) {
      streets.add(h.stage);
      expect(h.rabbitHunt()).toBeNull();
      await passive(h);
    }
    expect([...streets]).toEqual(['preflop', 'flop', 'turn', 'river']);
    expect(h.isSettled).toBe(true);
  });

  it('changes nothing: asked again and again, the same cards, and the hand, its result and its record as they were', async () => {
    const h = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await foldAt(h, 'flop');
    const before = state(h);
    const version = h.version;
    const first = h.rabbitHunt();
    for (let i = 0; i < 5; i++) expect(h.rabbitHunt()).toEqual(first);
    expect(state(h)).toBe(before);
    expect(h.version).toBe(version);
    expect(h.totalChips()).toBe(3000);
    // The pot the folds left went to the bettor, whatever the cards to come were.
    expect(h.handView().result!.winners.map((w) => w.seatIndex)).toEqual([1]);
    expect(h.record(99).board).toEqual(BOARD.slice(0, 3));
  });

  it('the same after the hand is kept and restored (a room that restarted)', async () => {
    const h = start([1000, 1000, 1000], { button: 0, deck: deck() });
    await foldAt(h, 'preflop');
    const again = HandEngine.restore(JSON.parse(JSON.stringify(h.persist())), 9_000);
    expect(again.rabbitHunt()).toEqual(BOARD);
    expect(again.rabbitHunt()).toEqual(h.rabbitHunt());
  });

  it('a shuffled deck: the deck’s next cards, none twice, none of them a hole card, a board card or a burned card', async () => {
    for (let n = 0; n < 40; n++) {
      const d = standardDeck();
      // A different order each time, the same every run.
      let k = n * 7919 + 1;
      for (let i = d.length - 1; i > 0; i--) {
        k = (k * 1103515245 + 12345) & 0x7fffffff;
        const j = k % (i + 1);
        [d[i], d[j]] = [d[j]!, d[i]!];
      }
      const players = 2 + (n % 5);
      const h = start(Array.from({ length: players }, () => 1000), { button: n % players, deck: [...d] });
      const stop = (['preflop', 'flop', 'turn'] as const)[n % 3]!;
      for (let guard = 0; guard < 60 && h.stage !== stop; guard++) await passive(h);
      // One bets (or raises before the flop), everybody else folds.
      for (let guard = 0; guard < 20 && !h.isSettled; guard++) {
        const id = h.actorId()!;
        const legal = h.legalOptions(id);
        const open = guard === 0 ? legal.find((o) => o.type === 'bet' || o.type === 'raise') : undefined;
        if (open && 'min' in open) await must(h, id, open.type, open.min);
        else await must(h, id, 'fold');
      }
      expect(h.isSettled).toBe(true);
      const board = h.handView().board;
      const rabbit = h.rabbitHunt()!;
      expect(board.length).toBe(stop === 'preflop' ? 0 : stop === 'flop' ? 3 : 4);
      // The deck as dealt: two cards each, then a burn and three, a burn and one, a burn and one.
      const at = players * 2;
      expect([...board, ...rabbit]).toEqual([d[at + 1], d[at + 2], d[at + 3], d[at + 5], d[at + 7]]);
      const holes = h.startingSeats.flatMap((p) => h.holeCardsOf(p.playerId) ?? []);
      expect(holes.length).toBe(at);
      expect(new Set([...holes, ...board, ...rabbit]).size).toBe(at + 5);
      for (const burn of [d[at], d[at + 4], d[at + 6]]) expect(rabbit).not.toContain(burn);
    }
  });
});
