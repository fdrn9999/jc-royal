/**
 * JC ROYAL's minimum raise: a raise must make it at least double the highest bet of the street
 * (`minRaisePolicy: 'double-highest-bet'`, patches/poker-engine-ts@0.1.3.patch). The standard no-limit rule (the bet
 * plus the size of the last raise) is lower whenever the last raise was smaller than the bet it raised.
 */
import type { Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { BOT_LEVELS, HandEngine, botView, buildSessionConfig, decideBot, handCounters, handFactsOf } from '../src';
import { checkDown, must, nextIntent, stackedDeck, start } from './helpers';

const c = (s: string) => s.split(' ') as Card[];
const BB100 = { smallBlind: 50, bigBlind: 100 };
const raiseOf = (h: HandEngine, id: string) => h.legalOptions(id).find((o) => o.type === 'raise');
const betOf = (h: HandEngine, id: string) => h.legalOptions(id).find((o) => o.type === 'bet');
const types = (h: HandEngine, id: string) => h.legalOptions(id).map((o) => o.type);
const refused = async (h: HandEngine, id: string, type: 'bet' | 'raise' | 'allin', amount?: number) => {
  const before = h.version;
  const r = await h.act(id, { type, amount }, nextIntent(), 2_000);
  expect(r).toMatchObject({ ok: false, code: 'illegal_action' });
  expect(h.version).toBe(before);
  expect(h.actorId()).toBe(id);
};
const six = (over: Record<number, number> = {}) => Array.from({ length: 6 }, (_, i) => over[i] ?? 10_000);

describe('minimum raise: double the highest bet of the street', () => {
  it('the session stays no-limit, with the double-highest-bet policy', () => {
    const cfg = buildSessionConfig({ maxSeats: 6, ...BB100, turnMs: 20_000 });
    expect(cfg.bettingStructure).toBe('no-limit');
    expect(cfg.ruleSet.minRaisePolicy).toBe('double-highest-bet');
    expect(cfg.ruleSet.maxRaisePolicy).toBeUndefined();
  });

  it('first raise before the flop: two big blinds (150 is refused, 200 is taken)', async () => {
    // 6 seats, button 0: p1 small blind, p2 big blind, p3 first to act.
    const h = start(six(), { button: 0, rules: BB100 });
    expect(raiseOf(h, 'p3')).toEqual({ type: 'raise', min: 200, max: 10_000 });
    await refused(h, 'p3', 'raise', 150);
    await must(h, 'p3', 'raise', 200);
    expect(raiseOf(h, 'p4')).toEqual({ type: 'raise', min: 400, max: 10_000 });
  });

  it('a 2.5 BB open: the minimum 3-bet is 5 BB (400 and 450 are refused, 500 is taken)', async () => {
    const h = start(six(), { button: 0, rules: BB100 });
    await must(h, 'p3', 'raise', 250);
    expect(raiseOf(h, 'p4')).toEqual({ type: 'raise', min: 500, max: 10_000 });
    await refused(h, 'p4', 'raise', 400);
    await refused(h, 'p4', 'raise', 450);
    await refused(h, 'p4', 'raise', 499);
    await must(h, 'p4', 'raise', 500);
  });

  it('raise after raise: 250, 500, 1,000, 2,000 — each at least double the one before', async () => {
    const h = start(six(), { button: 0, rules: BB100 });
    await must(h, 'p3', 'raise', 250);
    await must(h, 'p4', 'raise', 500);
    expect(raiseOf(h, 'p5')!.min).toBe(1_000);
    await refused(h, 'p5', 'raise', 900);
    await must(h, 'p5', 'raise', 1_000);
    expect(raiseOf(h, 'p0')!.min).toBe(2_000);
    await refused(h, 'p0', 'raise', 1_999);
    await must(h, 'p0', 'raise', 2_000);
    // The blinds raise over their own posted chips: still to a total of double.
    expect(raiseOf(h, 'p1')!.min).toBe(4_000);
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    // Back to the first raiser: 2,000 is a full raise over the 250 they acted on.
    expect(raiseOf(h, 'p3')!.min).toBe(4_000);
    expect(h.totalChips()).toBe(60_000);
  });

  it('after the flop: the opening bet is one big blind, a raise doubles the bet (300 → 600, 700 → 1,400)', async () => {
    const h = start([10_000, 10_000, 10_000], { button: 0, rules: BB100 });
    await must(h, 'p0', 'call');
    await must(h, 'p1', 'call');
    await must(h, 'p2', 'check');
    expect(h.stage).toBe('flop');
    expect(betOf(h, 'p1')).toEqual({ type: 'bet', min: 100, max: 9_900 });
    await refused(h, 'p1', 'bet', 99);
    await must(h, 'p1', 'bet', 300);
    expect(raiseOf(h, 'p2')!.min).toBe(600);
    await refused(h, 'p2', 'raise', 500);
    await must(h, 'p2', 'raise', 700);
    expect(raiseOf(h, 'p0')!.min).toBe(1_400);
    await refused(h, 'p0', 'raise', 1_399);
    await must(h, 'p0', 'raise', 1_400);
    expect(raiseOf(h, 'p1')!.min).toBe(2_800);
  });

  it('the same rule on the flop, the turn and the river', async () => {
    const h = start([10_000, 10_000], { button: 0, rules: BB100 });
    await must(h, 'p0', 'call');
    await must(h, 'p1', 'check');
    for (const stage of ['flop', 'turn', 'river'] as const) {
      expect(h.stage).toBe(stage);
      await must(h, 'p1', 'bet', 250);
      expect(raiseOf(h, 'p0')!.min).toBe(500);
      await refused(h, 'p0', 'raise', 400);
      await must(h, 'p0', 'call');
    }
    expect(h.isSettled).toBe(true);
  });

  it('a stack short of the minimum raise may still go all in (250 bet, 400 all in), and that does not reopen the betting', async () => {
    // p4 has 400 in all.
    const h = start(six({ 4: 400 }), { button: 0, rules: BB100 });
    await must(h, 'p3', 'raise', 250);
    // The minimum (500) is more than the stack: the only raise is the whole stack.
    expect(h.legalOptions('p4')).toContainEqual({ type: 'allin', amount: 400 });
    expect(raiseOf(h, 'p4')).toEqual({ type: 'raise', min: 400, max: 400 });
    await refused(h, 'p4', 'raise', 350);
    await must(h, 'p4', 'allin');
    expect(h.seatInfo(null).get(4)).toMatchObject({ allIn: true, stack: 0, streetBet: 400 });
    // A player who has not acted may raise: to double the 400 now standing.
    expect(raiseOf(h, 'p5')!.min).toBe(800);
    await refused(h, 'p5', 'raise', 650);
    await must(h, 'p5', 'call');
    await must(h, 'p0', 'fold');
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    // The 400 all-in is not a full raise over the 250 the opener acted on: call or fold only.
    expect(types(h, 'p3').sort()).toEqual(['call', 'fold']);
    await refused(h, 'p3', 'raise', 800);
    await refused(h, 'p3', 'allin');
    await must(h, 'p3', 'call');
    expect(h.stage).toBe('flop');
    expect(h.totalChips()).toBe(50_400);
  });

  it('an all-in that is a full raise by the standard rule but not double the bet does not reopen the betting', async () => {
    // p3 opens to 250; p4 (450 in all) is all in; p5 raises to 1,000; p0 (1,900 in all) is all in: 900 more would be a
    // full raise by the standard rule, but 1,900 is not double 1,000.
    const h = start(six({ 0: 1_900, 4: 450 }), { button: 0, rules: BB100 });
    await must(h, 'p3', 'raise', 250);
    await must(h, 'p4', 'allin');
    expect(raiseOf(h, 'p5')!.min).toBe(900);
    await must(h, 'p5', 'raise', 1_000);
    expect(raiseOf(h, 'p0')).toEqual({ type: 'raise', min: 1_900, max: 1_900 });
    await must(h, 'p0', 'allin');
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    // p3 last acted on 250: 1,900 is far more than double. Raising is open, to 3,800.
    expect(raiseOf(h, 'p3')).toEqual({ type: 'raise', min: 3_800, max: 10_000 });
    await must(h, 'p3', 'call');
    // p5 last acted on 1,000: 1,900 is not double it. Call or fold.
    expect(types(h, 'p5').sort()).toEqual(['call', 'fold']);
    await refused(h, 'p5', 'raise', 3_800);
    await refused(h, 'p5', 'allin');
    await must(h, 'p5', 'call');
    expect(h.totalChips()).toBe(42_350);
  });

  it('short all-ins one after another add up: raising reopens once the bet is double what the player acted on', async () => {
    // p3 opens 250; p4 all in 400; p5 all in 550: neither is a full raise, together 550 >= 2 x 250.
    const h = start(six({ 4: 400, 5: 550 }), { button: 0, rules: BB100 });
    await must(h, 'p3', 'raise', 250);
    await must(h, 'p4', 'allin');
    expect(h.legalOptions('p5')).toContainEqual({ type: 'allin', amount: 550 });
    await must(h, 'p5', 'allin');
    await must(h, 'p0', 'fold');
    await must(h, 'p1', 'fold');
    await must(h, 'p2', 'fold');
    expect(raiseOf(h, 'p3')).toEqual({ type: 'raise', min: 1_100, max: 10_000 });
    await must(h, 'p3', 'call');
    expect(h.totalChips()).toBe(40_950);
  });

  it('an amount typed as a raise that is the whole stack is taken as all in; a stack of exactly the minimum raises to it', async () => {
    const short = start(six({ 4: 450 }), { button: 0, rules: BB100 });
    await must(short, 'p3', 'raise', 250);
    await refused(short, 'p4', 'raise', 449);
    await must(short, 'p4', 'raise', 450);
    expect(short.seatInfo(null).get(4)).toMatchObject({ allIn: true, stack: 0, streetBet: 450 });

    const exact = start(six({ 4: 500 }), { button: 0, rules: BB100 });
    await must(exact, 'p3', 'raise', 250);
    expect(raiseOf(exact, 'p4')).toEqual({ type: 'raise', min: 500, max: 500 });
    await must(exact, 'p4', 'raise', 500);
    expect(exact.seatInfo(null).get(4)!.allIn).toBe(true);
  });

  it('side pots are paid as before when stacks go all in under the rule', async () => {
    // Deal order (button 0): p1, p2, p0.
    const deck = stackedDeck([c('Kc Kd'), c('2c 7d'), c('Ac Ad')], c('As 9h 5s 4c Jd'));
    const h = start([300, 700, 1000], { button: 0, deck });
    await must(h, 'p0', 'raise', 30);
    await refused(h, 'p1', 'raise', 50);
    await must(h, 'p1', 'raise', 60);
    await must(h, 'p2', 'allin');
    await must(h, 'p0', 'allin');
    await must(h, 'p1', 'allin');
    expect(h.isSettled).toBe(true);
    const winners = Object.fromEntries(h.handView().result!.winners.map((w) => [w.seatIndex, w.amount]));
    expect(winners).toEqual({ 0: 900, 1: 800, 2: 300 });
    expect(h.totalChips()).toBe(2000);
  });

  it('a hand dealt under the old rule keeps it after a restore, and the amounts already bet stay as they were', async () => {
    const h = start([10_000, 10_000, 10_000], { button: 0, rules: BB100 });
    await must(h, 'p0', 'raise', 250);
    const kept = JSON.parse(JSON.stringify(h.persist()));
    // What a hand dealt by an older build holds.
    kept.session.config.ruleSet.minRaisePolicy = 'double-last-bet';
    const old = HandEngine.restore(kept, 5_000);
    expect(raiseOf(old, 'p1')!.min).toBe(400);
    await must(old, 'p1', 'raise', 400);
    const again = HandEngine.restore(JSON.parse(JSON.stringify(old.persist())), 6_000);
    expect(again.publicActions().filter((a) => a.type === 'raise').map((a) => a.amount)).toEqual([250, 350]);
    // The same hand under the new rule.
    expect(raiseOf(HandEngine.restore(JSON.parse(JSON.stringify(h.persist())), 5_000), 'p1')!.min).toBe(500);
  });

  it('the record says which rule the hand was played under, and what is counted from it follows that rule', async () => {
    // The button opens to 300, the small blind shoves 500 (a full raise by the earlier rule, short of double), the big
    // blind calls: under the rule the button may only call; under the earlier one they could have raised again.
    const play = async (old: boolean) => {
      let h = start([10_000, 500, 10_000], { button: 0, rules: BB100 });
      if (old) {
        const kept = JSON.parse(JSON.stringify(h.persist()));
        kept.session.config.ruleSet.minRaisePolicy = 'double-last-bet';
        h = HandEngine.restore(kept, 5_000);
      }
      await must(h, 'p0', 'raise', 300);
      await must(h, 'p1', 'allin');
      await must(h, 'p2', 'call');
      expect(types(h, 'p0').includes('raise')).toBe(old);
      await must(h, 'p0', 'call');
      await checkDown(h);
      expect(h.isSettled).toBe(true);
      return h.record(99);
    };
    const now = await play(false);
    expect(now.minRaise).toBe('double');
    expect(handFactsOf(now, 100).doubleRaise).toBe(true);
    expect(handCounters(handFactsOf(now, 100)).get(0)).toMatchObject({ fourBetOpp: 0 });
    const before = await play(true);
    expect(before).not.toHaveProperty('minRaise');
    expect(handFactsOf(before, 100).doubleRaise).toBe(false);
    expect(handCounters(handFactsOf(before, 100)).get(0)).toMatchObject({ fourBetOpp: 1 });
  });
});

describe('bots under the minimum raise rule', () => {
  it('only ask for what the engine takes, through raising wars and short stacks, and every hand ends', async () => {
    let raises = 0;
    let allins = 0;
    let hands = 0;
    for (const level of BOT_LEVELS) {
      for (let n = 0; n < 25; n++) {
        const stacks = [300 + ((n * 977) % 4000), 150 + ((n * 613) % 2500), 10_000, 220 + ((n * 389) % 900), 5_000, 450];
        const h = start(stacks, { button: n % 6, rules: BB100 });
        let k = n * 7919 + 13;
        const rand = () => ((k = (k * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
        for (let guard = 0; guard < 300 && !h.isSettled; guard++) {
          if (h.isStalled()) {
            await h.resolveStall(3_000);
            continue;
          }
          const id = h.actorId()!;
          const v = botView(h, id, 100)!;
          // Every third decision is the smallest raise on offer (a raising war); the rest are the bot's own.
          const win = v.legal.find((o) => o.type === 'raise');
          const req = guard % 3 === 0 && win && win.type === 'raise' ? { type: 'raise' as const, amount: win.min } : decideBot(level, v, rand);
          const r = await h.act(id, req, nextIntent(), 3_000);
          if (!r.ok) throw new Error(`${level} bot ${id} ${JSON.stringify(req)} refused with ${JSON.stringify(v.legal)}: ${r.reason}`);
          if (req.type === 'raise') raises++;
          if (req.type === 'allin') allins++;
        }
        expect(h.isSettled).toBe(true);
        expect(h.totalChips()).toBe(stacks.reduce((a, b) => a + b, 0));
        hands++;
      }
    }
    expect(hands).toBe(BOT_LEVELS.length * 25);
    expect(raises).toBeGreaterThan(hands);
    expect(allins).toBeGreaterThan(0);
  });
});
