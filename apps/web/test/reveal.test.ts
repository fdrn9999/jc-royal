import { describe, expect, it } from 'vitest';
import { DIMS, planHeight, planTable, type Density, type PlanInput, type TablePlan } from '../src/game/layout';
import { cardsCentre, revealSpots, type RevealSpot } from '../src/game/reveal';

const SMALL: Density[] = ['compact', 'dense'];
const ALL: Density[] = ['full', 'compact', 'dense'];
const CHIPS = { stack: 9, bet: 6, pot: 6 };

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const input = (n: number, o: Partial<PlanInput> = {}): PlanInput => ({ n, anchor: 0, me: true, meTop: 0, chars: CHIPS, footer: false, ...o });

/** Each seat as Seat.tsx draws it, from the top of what rises over its cards to its status line (rebuilt from DIMS). */
function seats(plan: TablePlan, p: PlanInput): Box[] {
  const d = DIMS[plan.density];
  return plan.seats.map((s, i) => {
    const mine = p.me && i === p.anchor;
    const card = mine ? d.cardMe : d.cardOther;
    const w = d.plateBase + Math.max(d.nameMax, p.chars.stack * d.digit) + 2 * d.overhang;
    const h = 1.4 * card - d.overlap + d.plateH + d.statusH;
    const top = mine ? Math.max(4, p.meTop) : 6;
    return { l: s.x - w / 2, t: s.y - h / 2 - top, r: s.x + w / 2, b: s.y + h / 2 };
  });
}

/** The two cards at rest, as Seat.tsx draws them (side by side, 4px apart, scaled about their middle). */
function rested(plan: TablePlan, seat: number, mine: boolean, spot: RevealSpot): Box {
  const d = DIMS[plan.density];
  const card = mine ? d.cardMe : d.cardOther;
  const from = cardsCentre(plan, seat, mine)!;
  const w = spot.s * (2 * card + 4);
  const h = spot.s * 1.4 * card;
  const x = from.x + spot.x;
  const y = from.y + spot.y;
  return { l: x - w / 2, t: y - h / 2, r: x + w / 2, b: y + h / 2 };
}

const crosses = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
const away = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.l - x, 0, x - b.r), Math.max(b.t - y, 0, y - b.b));

/** The board with the status line under it (TableScene.tsx): the pot's row above them is empty after the hand. */
function board(plan: TablePlan): Box {
  const k = plan.block;
  return { l: k.x, t: k.y + plan.potRowH + 8, r: k.x + k.w, b: k.y + k.h };
}

/** What is wrong with a resting spot: off the table, over the board or a seat, or nearer another seat than its own. */
function wrong(plan: TablePlan, p: PlanInput, seat: number, spot: RevealSpot, others: Box[] = []): string[] {
  const mine = p.me && seat === p.anchor;
  const r = rested(plan, seat, mine, spot);
  const all = seats(plan, p);
  const out: string[] = [];
  if (r.l < 0 || r.t < 0 || r.r > plan.w || r.b > plan.h) out.push('outside');
  if (crosses(r, board(plan))) out.push('over the board');
  all.forEach((s, i) => crosses(r, s) && out.push(`over seat-${i}`));
  others.forEach((o, i) => crosses(r, o) && out.push(`over winner ${i}`));
  const mx = (r.l + r.r) / 2;
  const my = (r.t + r.b) / 2;
  all.forEach((s, i) => i !== seat && away(s, mx, my) <= away(all[seat]!, mx, my) && out.push(`nearer seat-${i}`));
  if (spot.s < 0.7) out.push(`scale ${spot.s}`);
  return out;
}

// The sizes the layout tests cover (layout.test.ts): the replay's table, the live table and a phone held sideways.
const cases: { name: string; p: PlanInput; plan: TablePlan }[] = [];
for (const [name, w, budget, cap] of [
  ['replay · iPhone SE', 323, 346, 230],
  ['replay · Pixel 7', 360, 520, 386],
  ['replay · landscape phone', 524, 306, 306],
  ['replay · tablet', 680, 740, 600],
  ['replay · desktop', 1206, 640, 500],
] as const)
  for (const n of [2, 6, 9]) {
    const p = input(n);
    cases.push({ name: `${name} · ${n} seats`, p, plan: planHeight(w, budget, cap, p, w < 640 ? SMALL : ALL) });
  }
for (const [name, w, h] of [
  ['live · iPhone SE', 340, 560],
  ['live · iPhone 15', 374, 600],
  ['live · Pixel 7', 396, 671],
  ['live · tablet', 700, 800],
  ['live · desktop', 1300, 700],
] as const)
  for (const n of [2, 6, 9]) {
    const p = input(n, { meTop: 28, footer: true });
    cases.push({ name: `${name} · ${n} seats`, p, plan: planTable(Math.min(w, 2.1 * h), Math.min(h, 1.9 * w), p, w < 640 || h < 520 ? SMALL : ALL) });
  }
for (const n of [2, 6, 9]) {
  const p = input(n, { meTop: 4 });
  cases.push({ name: `live · phone sideways 844×390 · ${n} seats`, p, plan: planTable(624, 338, p, SMALL, Math.round(0.85 * 624)) });
}

describe('winner reveal: shown cards rest by the board, clear of everything, by their own seat', () => {
  for (const { name, p, plan } of cases)
    it(name, () => {
      for (let seat = 0; seat < p.n; seat++) {
        const spot = revealSpots(plan, [{ seat, mine: seat === p.anchor }]).get(seat);
        if (spot) expect(wrong(plan, p, seat, spot), `seat ${seat}`).toEqual([]);
      }
    });

  // My own seat (the anchor, seat 0) is seen by the others elsewhere round their own tables: the room it lacks on a phone
  // upright at six seats (the side seats take the room under the board) costs only my own view of my show.
  it('finds a spot for most winners: every other seat at two and six seats on the live table, and most at nine', () => {
    const missing: string[] = [];
    let tried = 0;
    for (const { name, p, plan } of cases)
      for (let seat = 0; seat < p.n; seat++) {
        tried++;
        if (!revealSpots(plan, [{ seat, mine: seat === p.anchor }]).has(seat)) missing.push(`${name} · seat ${seat}`);
      }
    // Where no spot is clear the cards turn where they lie (as before): few enough that the move is the rule.
    console.log(`reveal spots: ${tried - missing.length}/${tried}\n${missing.join('\n')}`);
    expect(missing.filter((m) => m.startsWith('live') && !m.includes('9 seats') && !m.endsWith('seat 0'))).toEqual([]);
    expect(missing.length / tried).toBeLessThan(0.15);
  });

  it('keeps two winners (a split pot) apart and each by its own seat', () => {
    for (const { name, p, plan } of cases) {
      const pairs = p.n === 2 ? [[0, 1]] : p.n === 6 ? [[0, 3], [1, 4], [2, 5]] : [[0, 4], [2, 7], [3, 5]];
      for (const [a, b] of pairs as [number, number][]) {
        const spots = revealSpots(plan, [
          { seat: a, mine: a === p.anchor },
          { seat: b, mine: b === p.anchor },
        ]);
        const sa = spots.get(a);
        const sb = spots.get(b);
        if (sa) expect(wrong(plan, p, a, sa), `${name} · ${a}`).toEqual([]);
        if (sa && sb) expect(wrong(plan, p, b, sb, [rested(plan, a, a === p.anchor, sa)]), `${name} · ${b}`).toEqual([]);
      }
    }
  });

  it('moves towards the board, never away from it, and grows to the board’s card size at most', () => {
    for (const { p, plan } of cases)
      for (let seat = 0; seat < p.n; seat++) {
        const mine = seat === p.anchor;
        const spot = revealSpots(plan, [{ seat, mine }]).get(seat);
        if (!spot) continue;
        const from = cardsCentre(plan, seat, mine)!;
        const b = board(plan);
        const to = { x: (b.l + b.r) / 2 - from.x, y: (b.t + b.b) / 2 - from.y };
        expect(spot.x * to.x + spot.y * to.y).toBeGreaterThan(0);
        const d = DIMS[plan.density];
        expect(spot.s * (mine ? d.cardMe : d.cardOther)).toBeLessThanOrEqual(Math.max(plan.board, mine ? d.cardMe : d.cardOther) + 1e-9);
      }
  });

  it('works the same out every time', () => {
    const { plan, p } = cases.find((c) => c.name === 'live · Pixel 7 · 9 seats')!;
    const seats = Array.from({ length: p.n }, (_, seat) => ({ seat, mine: seat === 0 }));
    expect([...revealSpots(plan, seats)]).toEqual([...revealSpots(plan, seats)]);
  });

  it('gives no spot for a seat the plan has not, nor for one it was not asked for', () => {
    const { plan } = cases.find((c) => c.name === 'live · desktop · 6 seats')!;
    const spots = revealSpots(plan, [{ seat: 7, mine: false }, { seat: 2, mine: false }]);
    expect(spots.has(7)).toBe(false);
    expect([...spots.keys()]).toEqual([2]);
  });
});
