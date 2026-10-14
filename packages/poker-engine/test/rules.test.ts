import { handLabelKey, type Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { HandEngine, nextButtonSeat } from '../src';
import { checkDown, must, nextIntent, stackedDeck, start } from './helpers';

const c = (s: string) => s.split(' ') as Card[];

describe('hand evaluation through showdown (engine evaluator)', () => {
  // Heads-up, button = seat 0 (p0). Deal order: p1 first, then p0.
  const cases: [string, Card[], Card[], Card[], string][] = [
    ['royal flush', c('As Ks'), c('2c 3d'), c('Qs Js Ts 7h 2h'), 'royal-flush'],
    ['straight flush', c('9h 8h'), c('Ac Ad'), c('7h 6h 5h Kc 2d'), 'straight-flush'],
    ['four of a kind', c('Qc Qd'), c('Ac Kd'), c('Qh Qs 7c 4d 2h'), 'four-of-a-kind'],
    ['full house', c('Jc Jd'), c('Ac Kd'), c('Jh 7s 7c 4d 2h'), 'full-house'],
    ['flush', c('Ac 9c'), c('Kd Kh'), c('Qc 7c 4c 3d 2h'), 'flush'],
    ['straight', c('9d 8s'), c('Ac Ad'), c('7h 6c 5d Kc 2s'), 'straight'],
    ['three of a kind', c('7d 7s'), c('Ac Kd'), c('7h Qc 4d 3s 2h'), 'three-of-a-kind'],
    ['two pair', c('Kc Qd'), c('Ac Jd'), c('Kh Qs 7d 3s 2h'), 'two-pair'],
    ['one pair', c('Ac 9d'), c('Kc Jd'), c('As 7c 5d 3s 2h'), 'pair'],
    ['high card', c('Ac Jd'), c('Kc 9d'), c('8s 6c 4d 3s 2h'), 'high-card'],
  ];
  for (const [name, winnerHole, loserHole, board, label] of cases) {
    it(`${name} wins at showdown`, async () => {
      // p1 receives the first two cards; make p1 the winner.
      const h = start([1000, 1000], { deck: stackedDeck([winnerHole, loserHole], board) });
      await checkDown(h);
      expect(h.isSettled).toBe(true);
      const v = h.handView();
      expect(v.result?.winners).toEqual([{ seatIndex: 1, amount: 20, potIds: expect.any(Array) }]);
      const win = v.result!.showdown.find((s) => s.seatIndex === 1)!;
      expect(handLabelKey(win.rankClass, win.bestFive)).toBe(label);
      expect(h.totalChips()).toBe(2000);
    });
  }
});

describe('blinds, positions and betting rules', () => {
  it('3-handed: SB completes for 5, BB keeps the option to check (engine bootstrap fix)', async () => {
    const h = start([1000, 1000, 1000], { button: 0 });
    // button p0, SB p1, BB p2; UTG = button in 3-handed.
    expect(h.handView()).toMatchObject({ buttonSeat: 0, sbSeat: 1, bbSeat: 2, potTotal: 15 });
    await must(h, 'p0', 'call');
    expect(h.legalOptions('p1')).toContainEqual({ type: 'call', amount: 5 });
    await must(h, 'p1', 'call');
    expect(h.legalOptions('p2').map((o) => o.type)).toEqual(expect.arrayContaining(['check', 'raise']));
    await must(h, 'p2', 'check');
    expect(h.stage).toBe('flop');
    expect(h.handView().potTotal).toBe(30);
    // Post-flop the first active seat left of the button acts first.
    expect(h.actorId()).toBe('p1');
  });

  it('heads-up: button posts SB and acts first preflop, BB acts first after the flop', async () => {
    const h = start([500, 500], { button: 0 });
    expect(h.handView()).toMatchObject({ sbSeat: 0, bbSeat: 1 });
    expect(h.actorId()).toBe('p0');
    await must(h, 'p0', 'call');
    await must(h, 'p1', 'check');
    expect(h.stage).toBe('flop');
    expect(h.actorId()).toBe('p1');
  });

  it('minimum raise is one big blind over the current bet, then the size of the last raise', async () => {
    const h = start([1000, 1000, 1000], { button: 0 });
    expect(h.legalOptions('p0')).toContainEqual({ type: 'raise', min: 20, max: 1000 });
    expect((await h.act('p0', { type: 'raise', amount: 15 }, nextIntent(), 2000)).ok).toBe(false);
    await must(h, 'p0', 'raise', 30);
    // last raise was +20 → min re-raise to 50
    expect(h.legalOptions('p1').find((o) => o.type === 'raise')).toMatchObject({ min: 50 });
    await must(h, 'p1', 'raise', 100);
    expect(h.legalOptions('p2').find((o) => o.type === 'raise')).toMatchObject({ min: 170 });
  });

  it('a short all-in does not reopen raising for players who already acted', async () => {
    // p1 has only 140 behind after the blind is posted.
    const h = start([1000, 145, 1000], { button: 0 });
    await must(h, 'p0', 'raise', 100); // UTG/button opens to 100
    await must(h, 'p1', 'allin'); // SB shoves 145 total: raise of 45 < full raise of 90
    await must(h, 'p2', 'call'); // BB calls 145
    const opts = h.legalOptions('p0').map((o) => o.type);
    expect(opts).toContain('call');
    expect(opts).not.toContain('raise');
  });

  it('multi-way all-in with different stacks builds side pots and conserves chips', async () => {
    // Deal order (button 0): p1, p2, p0. Give p0 the best hand, p1 second, p2 worst.
    const deck = stackedDeck([c('Kc Kd'), c('2c 7d'), c('Ac Ad')], c('As 9h 5s 4c Jd'));
    const h = start([300, 700, 1000], { button: 0, deck });
    await must(h, 'p0', 'allin');
    await must(h, 'p1', 'allin');
    await must(h, 'p2', 'allin');
    expect(h.isSettled).toBe(true);
    const winners = Object.fromEntries(h.handView().result!.winners.map((w) => [w.seatIndex, w.amount]));
    // main 900 → p0 (aces), side 800 (p1 vs p2) → p1 (kings), p2 gets its unmatched 300 back.
    expect(winners).toEqual({ 0: 900, 1: 800, 2: 300 });
    expect(h.totalChips()).toBe(2000);
    const stacks = h.finalStacks();
    expect([stacks.get('p0'), stacks.get('p1'), stacks.get('p2')]).toEqual([900, 800, 300]);
  });

  it('split pot on a board play, with an odd chip awarded deterministically', async () => {
    // Board is a broadway straight; everybody plays the board.
    const deck = stackedDeck([c('2c 3d'), c('2d 3c'), c('4h 4s')], c('Ts Jh Qd Kc Ah'));
    const h = start([1000, 1000, 1000], { button: 0, deck });
    await must(h, 'p0', 'call');
    await must(h, 'p1', 'fold'); // SB folds: 5 dead chips → pot 25 between p0 and p2
    await must(h, 'p2', 'check');
    await checkDown(h);
    const res = h.handView().result!;
    const amounts = res.winners.map((w) => w.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([12, 13]);
    expect(amounts[0]! + amounts[1]!).toBe(25);
    expect(h.totalChips()).toBe(3000);
  });

  it('when everyone else folds the last player wins without revealing cards', async () => {
    const h = start([1000, 1000, 1000], { button: 0 });
    await must(h, 'p0', 'raise', 40);
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    expect(h.isSettled).toBe(true);
    const v = h.handView();
    expect(v.result!.winners).toEqual([{ seatIndex: 0, amount: 55, potIds: expect.any(Array) }]);
    expect(v.result!.showdown).toEqual([]);
    const seen = h.seatInfo('p1');
    expect(seen.get(0)!.holeCards).toBeNull();
  });

  it('a player who cannot cover the big blind posts all-in and can still win', async () => {
    const deck = stackedDeck([c('Kc Kd'), c('Ac Ad'), c('2c 7d')], c('As 9h 5s 4c Jd'));
    // p2 (BB) has only 6 chips.
    const h = start([1000, 1000, 6], { button: 0, deck });
    expect(h.handView().potTotal).toBe(11);
    await must(h, 'p0', 'call');
    await must(h, 'p1', 'call');
    await checkDown(h);
    expect(h.isSettled).toBe(true);
    expect(h.totalChips()).toBe(2006);
    // p2 holds aces: wins the 18-chip main pot (6×3); side pot between p0/p1 goes to p1? (p1 KK vs p0 27)
    const w = Object.fromEntries(h.handView().result!.winners.map((x) => [x.seatIndex, x.amount]));
    expect(w[2]).toBe(18);
  });
});

describe('server-side guards', () => {
  it('rejects out-of-turn actions, illegal amounts and duplicate intent ids', async () => {
    const h = start([1000, 1000, 1000]);
    expect((await h.act('p1', { type: 'call' }, nextIntent(), 2000)).ok).toBe(false);
    expect((await h.act('p0', { type: 'check' }, nextIntent(), 2000)).ok).toBe(false); // facing the BB
    expect((await h.act('p0', { type: 'raise', amount: 5000 }, nextIntent(), 2000)).ok).toBe(false);
    const id = nextIntent();
    expect((await h.act('p0', { type: 'call' }, id, 2000)).ok).toBe(true);
    const dup = await h.act('p0', { type: 'call' }, id, 2001);
    expect(dup).toMatchObject({ ok: false, code: 'duplicate' });
    // same intent id resubmitted by the next actor is still a duplicate
    expect((await h.act('p1', { type: 'call' }, id, 2002)).ok).toBe(false);
    expect(h.totalChips()).toBe(3000);
  });

  it('turn timeout checks when free and folds when facing a bet', async () => {
    const h = start([1000, 1000, 1000]);
    const r = await h.timeout('p0', 30_000);
    expect(r.ok).toBe(true);
    expect(h.seatInfo(null).get(0)!.folded).toBe(true);
    await must(h, 'p1', 'call');
    const r2 = await h.timeout('p2', 60_000); // BB with the option: checks
    expect(r2.ok).toBe(true);
    expect(h.stage).toBe('flop');
    expect(h.seatInfo(null).get(2)!.folded).toBe(false);
  });

  it('never exposes other players hole cards before showdown', async () => {
    const h = start([1000, 1000, 1000]);
    const view = h.seatInfo('p1');
    expect(view.get(1)!.holeCards).toHaveLength(2);
    expect(view.get(0)!.holeCards).toBeNull();
    expect(view.get(2)!.holeCards).toBeNull();
    const spectator = h.seatInfo(null);
    for (const s of spectator.values()) expect(s.holeCards).toBeNull();
    expect(JSON.stringify(h.handView())).not.toMatch(/remainingDeck|holeCards/);
  });

  it('restores from a JSON-serialised log mid-hand and continues identically', async () => {
    const deck = stackedDeck([c('Kc Kd'), c('2c 7d'), c('Ac Ad')], c('As 9h 5s 4c Jd'));
    const a = start([1000, 1000, 1000], { deck });
    const b = start([1000, 1000, 1000], { deck });
    for (const h of [a, b]) {
      await must(h, 'p0', 'raise', 30);
      await must(h, 'p1', 'call');
    }
    const restored = HandEngine.restore(JSON.parse(JSON.stringify(a.persist())), 5_000);
    expect(restored.snapshot).toEqual(a.snapshot);
    for (const h of [restored, b]) {
      await must(h, 'p2', 'call');
      await checkDown(h);
    }
    expect(restored.handView().result).toEqual(b.handView().result);
    // Intents applied before the restart are still recognised as duplicates.
    const persisted = a.persist();
    const again = HandEngine.restore(JSON.parse(JSON.stringify(persisted)), 5_000);
    const actor = again.actorId()!;
    expect(await again.act(actor, { type: 'call' }, persisted.appliedIntents[0]!, 6_000)).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('rotates the dealer button to the next dealt seat', () => {
    expect(nextButtonSeat(null, [2, 4, 5], 6)).toBe(2);
    expect(nextButtonSeat(2, [2, 4, 5], 6)).toBe(4);
    expect(nextButtonSeat(5, [2, 4, 5], 6)).toBe(2);
    expect(nextButtonSeat(3, [0, 8], 9)).toBe(8);
  });

  it('produces a hand record with public actions and per-player net results', async () => {
    const h = start([1000, 1000, 1000]);
    await must(h, 'p0', 'raise', 40);
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    const rec = h.record(9_000);
    expect(rec.potTotal).toBe(55);
    expect(rec.players.map((p) => p.net)).toEqual([15, -5, -10]);
    expect(rec.actions.map((a) => a.type)).toEqual(['post-sb', 'post-bb', 'raise', 'fold', 'fold']);
    expect(rec.players.reduce((a, p) => a + p.net, 0)).toBe(0);
  });
});
