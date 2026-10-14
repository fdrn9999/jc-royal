import { describe, expect, it } from 'vitest';
import { HandEngine } from '../src';

describe('persisted size', () => {
  it('a long 9-handed hand stays well below the Durable Object value limit (2 MiB)', async () => {
    const seats = Array.from({ length: 9 }, (_, i) => ({ playerId: `00000000-0000-4000-8000-00000000000${i}`, seatIndex: i, stack: 100_000, displayName: `player-${i}` }));
    const h = HandEngine.start({ handId: 'size', rules: { maxSeats: 9, smallBlind: 50, bigBlind: 100, turnMs: 20_000 }, seats, buttonSeat: 0, now: 1 });
    let n = 0;
    // min-raise wars on every street, then call down
    while (!h.isSettled && n < 300) {
      if (h.isStalled()) { await h.resolveStall(n); continue; }
      const actor = h.actorId()!;
      const legal = h.legalOptions(actor);
      const raise = legal.find((o) => o.type === 'raise' || o.type === 'bet');
      const pick = raise && n % 3 !== 2 && n < 120 ? { type: raise.type, amount: raise.min } : legal.find((o) => o.type === 'check') ? { type: 'check' as const } : { type: 'call' as const };
      const r = await h.act(actor, pick, `s${n}`, 10 + n);
      expect(r.ok).toBe(true);
      n++;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(h.persist())).length;
    console.log(`events=${n} persisted=${(bytes / 1024).toFixed(1)} KiB`);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
