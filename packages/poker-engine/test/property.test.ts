import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TableCue } from '@jc/types';
import { HandEngine, type MaxSeats } from '../src';

/**
 * Property: for any table size, stacks, button and sequence of legal actions,
 *  - total chips (stacks + pots) never change,
 *  - the hand always reaches `settled` (never stuck without an actor),
 *  - payouts equal the chips that left the stacks,
 *  - rebuilding from the persisted event log yields the identical snapshot,
 *  - no viewer ever sees another player's hole cards before showdown.
 */
const tableArb = fc
  .constantFrom<MaxSeats>(2, 6, 9)
  .chain((maxSeats) =>
    fc.record({
      maxSeats: fc.constant(maxSeats),
      players: fc.uniqueArray(fc.integer({ min: 0, max: maxSeats - 1 }), { minLength: 2, maxLength: maxSeats }),
      stacks: fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: maxSeats, maxLength: maxSeats }),
      button: fc.integer({ min: 0, max: maxSeats - 1 }),
      choices: fc.array(fc.nat(), { minLength: 200, maxLength: 200 }),
      restoreAt: fc.integer({ min: 0, max: 30 }),
    }),
  );

const coverage = { hands: 0, showdowns: 0, sidePots: 0, stalls: 0, returned: 0 };

type TableCase = typeof tableArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * Chips nobody called go back with the action that ends the betting (or the stall of a hand whose blinds put everyone
 * all in), while still in front of the seat: only actions before them, never a card that takes the bets to the pot.
 */
function checkBatch(cues: TableCue[]) {
  const at = cues.findIndex((c) => c.kind === 'returned');
  if (at < 0) return;
  expect(cues.slice(0, at).every((c) => c.kind === 'action'), JSON.stringify(cues)).toBe(true);
}

async function playRandomHand(t: TableCase, avoidFold: boolean) {
        const seats = t.players.map((seatIndex, i) => ({ playerId: `u${seatIndex}`, seatIndex, stack: t.stacks[i]!, displayName: `U${seatIndex}` }));
        const total = seats.reduce((a, s) => a + s.stack, 0);
        let h = HandEngine.start({
          handId: 'prop',
          rules: { maxSeats: t.maxSeats, smallBlind: 5, bigBlind: 10, turnMs: 20_000 },
          seats,
          buttonSeat: t.button,
          now: 1,
        });
        let step = 0;
        // The cues as a room sends them: an action's, with those of the stalls it leads to.
        let batch: TableCue[] = [];
        const sent: TableCue[] = [];
        while (!h.isSettled) {
          if (h.isStalled()) {
            coverage.stalls++;
            batch.push(...(await h.resolveStall(10 + step)));
            expect(h.totalChips()).toBe(total);
            expect(h.isStalled()).toBe(false);
            continue;
          }
          const actor = h.actorId();
          // privacy check from a non-acting viewer
          const viewer = seats.find((s) => s.playerId !== actor)!.playerId;
          for (const [, info] of h.seatInfo(viewer)) {
            if (info.holeCards && h.stage !== 'settled') expect(seats.find((s) => s.playerId === viewer)!.seatIndex).toBeDefined();
          }
          const foreign = [...h.seatInfo(viewer)].filter(([seatIndex, info]) => info.holeCards && seats.find((s) => s.seatIndex === seatIndex)!.playerId !== viewer);
          expect(foreign).toEqual([]);

          const all = h.legalOptions(actor!);
          expect(all.length).toBeGreaterThan(0);
          const legal = avoidFold && all.length > 1 ? all.filter((o) => o.type !== 'fold') : all;
          const pick = legal[t.choices[step % t.choices.length]! % legal.length]!;
          let amount: number | undefined;
          if (pick.type === 'bet' || pick.type === 'raise') {
            const span = pick.max - pick.min;
            amount = pick.min + (span > 0 ? t.choices[(step + 7) % t.choices.length]! % (span + 1) : 0);
          }
          const r = step % 13 === 12 ? await h.timeout(actor!, 10 + step) : await h.act(actor!, { type: pick.type, amount }, `i${step}`, 10 + step);
          expect(r.ok, JSON.stringify({ pick, amount, r })).toBe(true);
          checkBatch(batch);
          sent.push(...batch);
          batch = r.ok ? [...r.cues] : [];
          expect(h.totalChips()).toBe(total);
          for (const s of h.snapshot.seating.seats) expect(s.stack).toBeGreaterThanOrEqual(0);
          step++;
          if (step === t.restoreAt) {
            const restored = HandEngine.restore(JSON.parse(JSON.stringify(h.persist())), 10 + step);
            expect(JSON.parse(JSON.stringify(restored.snapshot))).toEqual(JSON.parse(JSON.stringify(h.snapshot)));
            h = restored;
          }
          expect(step).toBeLessThan(400);
        }
        checkBatch(batch);
        sent.push(...batch);
        const rec = h.record(99);
        coverage.hands++;
        // Chips nobody called go back once: what the one who put in the most put in above the next most (as pot_won
        // leaves out), the record's uncalled pot when it has one; with the payouts they are what the engine paid.
        const back = sent.filter((c) => c.kind === 'returned');
        expect(back.length).toBeLessThanOrEqual(1);
        const [top, next] = rec.players.map((p) => [p.seatIndex, p.won - p.net] as const).sort((a, b) => b[1] - a[1]);
        expect(back.map((c) => [c.seatIndex, c.amount])).toEqual(top![1] > next![1] ? [[top![0], top![1] - next![1]]] : []);
        for (const p of rec.pots!.filter((x) => x.uncalled)) expect(back.map((c) => [c.seatIndex, c.amount])).toEqual([[p.winners[0]!.seatIndex, p.amount]]);
        expect(h.handView().result!.returned).toEqual(back[0] ? { seatIndex: back[0].seatIndex, amount: back[0].amount } : undefined);
        if (back[0]) coverage.returned++;
        const cued = new Map<number, number>();
        for (const c of sent) if (c.kind === 'payout' || c.kind === 'returned') cued.set(c.seatIndex, (cued.get(c.seatIndex) ?? 0) + c.amount);
        for (const p of rec.players) expect(cued.get(p.seatIndex) ?? 0).toBe(p.won);
        if (rec.players.some((p) => p.wentToShowdown)) coverage.showdowns++;
        if ((h.snapshot.hand.payouts?.entries ?? []).some((e) => e.amount > 0 && e.potIds.some((id) => id.includes('side')))) coverage.sidePots++;
        expect(rec.players.reduce((a, p) => a + p.net, 0)).toBe(0);
        expect(rec.players.reduce((a, p) => a + p.won, 0)).toBe(rec.potTotal);
        // The replay's pot breakdown always exists and pays out exactly what each player won.
        expect(rec.pots).not.toBeNull();
        const fromPots = new Map<number, number>();
        for (const pot of rec.pots!) {
          expect(pot.winners.reduce((a, w) => a + w.amount, 0)).toBe(pot.amount);
          for (const w of pot.winners) fromPots.set(w.seatIndex, (fromPots.get(w.seatIndex) ?? 0) + w.amount);
        }
        for (const p of rec.players) expect(fromPots.get(p.seatIndex) ?? 0).toBe(p.won);
        expect(rec.buttonSeat).toBe(t.button);
        const final = [...h.finalStacks().values()].reduce((a, b) => a + b, 0);
        expect(final).toBe(total);
}

describe('property: random legal play', () => {
  it('uniform choices: conserves chips, settles, replays identically, keeps cards private', async () => {
    await fc.assert(fc.asyncProperty(tableArb, (t) => playRandomHand(t, false)), { numRuns: 2000 });
  }, 300_000);

  it('fold-averse choices (reaches showdowns and side pots)', async () => {
    const before = { ...coverage };
    await fc.assert(fc.asyncProperty(tableArb, (t) => playRandomHand(t, true)), { numRuns: 2000 });
    const showdowns = coverage.showdowns - before.showdowns;
    const sidePots = coverage.sidePots - before.sidePots;
    const returned = coverage.returned - before.returned;
    console.log('coverage', JSON.stringify({ hands: coverage.hands - before.hands, showdowns, sidePots, stalls: coverage.stalls - before.stalls, returned }));
    expect(showdowns).toBeGreaterThan(500);
    expect(sidePots).toBeGreaterThan(100);
    expect(returned).toBeGreaterThan(100);
  }, 300_000);
});
