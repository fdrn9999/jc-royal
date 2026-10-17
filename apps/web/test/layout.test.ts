import { describe, expect, it } from 'vitest';
import { DIMS, planHeight, planTable, seatLayout, type Density, type PlanInput, type TablePlan } from '../src/game/layout';

const SMALL: Density[] = ['compact', 'dense'];
const ALL: Density[] = ['full', 'compact', 'dense'];
const CHIPS = { stack: 9, bet: 6, pot: 6 };
const BB = { stack: 11, bet: 9, pot: 9 };

interface Box {
  name: string;
  l: number;
  t: number;
  r: number;
  b: number;
}

/**
 * Every part a plan places, rebuilt from the sizes Seat.tsx and TableScene.tsx draw (not from the planner's own
 * boxes): each seat from the top of what rises over its cards to the bottom of its status line, each bet's chips and
 * label, and the pot with the board.
 */
function parts(plan: TablePlan, p: PlanInput): Box[] {
  const d = DIMS[plan.density];
  const out: Box[] = [];
  for (let i = 0; i < p.n; i++) {
    const s = plan.seats[i]!;
    const mine = p.me && i === p.anchor;
    const card = mine ? d.cardMe : d.cardOther;
    const w = d.plateBase + Math.max(d.nameMax, p.chars.stack * d.digit) + 2 * d.overhang;
    const h = 1.4 * card - d.overlap + d.plateH + d.statusH;
    const top = mine ? Math.max(4, p.meTop) : 6;
    out.push({ name: `seat-${i}`, l: s.x - w / 2, t: s.y - h / 2 - top, r: s.x + w / 2, b: s.y + h / 2 });
    const b = plan.bets[i]!;
    const bw = d.chip + 18 + p.chars.bet * 6.6;
    const bh = Math.max(d.chip + 16, 21);
    out.push({ name: `bet-${i}`, l: b.x - bw / 2, t: b.y - bh / 2, r: b.x + bw / 2, b: b.y + bh / 2 });
  }
  const k = plan.block;
  out.push({ name: 'board', l: k.x, t: k.y, r: k.x + k.w, b: k.y + k.h });
  return out;
}

/** Pairs of parts drawn over each other, and parts outside the table's box (rounded to the pixel). */
function problems(plan: TablePlan, p: PlanInput): string[] {
  const boxes = parts(plan, p);
  const out: string[] = [];
  const e = 0.5;
  for (const x of boxes) if (x.l < -e || x.t < -e || x.r > plan.w + e || x.b > plan.h + e) out.push(`${x.name} outside`);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > e && Math.min(a.b, b.b) - Math.max(a.t, b.t) > e) out.push(`${a.name} × ${b.name}`);
    }
  return out;
}

const input = (n: number, o: Partial<PlanInput> = {}): PlanInput => ({ n, anchor: 0, me: true, meTop: 0, chars: CHIPS, footer: false, ...o });

describe('table layout: every seat, bet and the board in a place of its own', () => {
  // The replay's table on phones (portrait and landscape), tablets and desktops: its width, the height the screen
  // leaves (budget) and the height it should not pass at page open (cap).
  const replay: [string, number, number, number][] = [
    ['iPhone SE', 323, 346, 230],
    ['iPhone 15', 341, 530, 410],
    ['Android 360', 308, 480, 360],
    ['Pixel 7', 360, 520, 386],
    ['board post on a 375px phone', 283, 400, 300],
    ['landscape phone', 524, 306, 306],
    ['tablet', 680, 740, 600],
    ['laptop', 1206, 462, 276],
    ['desktop', 1206, 640, 500],
  ];
  for (const [name, w, budget, cap] of replay)
    for (const n of [2, 6, 9])
      for (const chars of [CHIPS, BB])
        it(`replay · ${name} · ${n} seats · ${chars === BB ? 'BB' : 'chips'}`, () => {
          const p = input(n, { chars });
          const plan = planHeight(w, budget, cap, p, w < 640 ? SMALL : ALL);
          expect(plan.overlap).toBe(0);
          expect(problems(plan, p)).toEqual([]);
          expect(plan.w).toBe(w);
          expect(plan.seats).toHaveLength(n);
        });

  // The live table's area (fixed box) on phones, tablets and desktops, with the status line and the show-card buttons.
  const live: [string, number, number][] = [
    ['iPhone SE', 340, 560],
    ['iPhone 15', 374, 600],
    ['Pixel 7', 396, 671],
    ['tablet', 700, 800],
    ['desktop', 1300, 700],
  ];
  for (const [name, w, h] of live)
    for (const n of [2, 6, 9])
      it(`live table · ${name} · ${n} seats`, () => {
        const p = input(n, { meTop: 28, footer: true });
        const plan = planTable(Math.min(w, 2.1 * h), Math.min(h, 1.9 * w), p, w < 640 || h < 520 ? SMALL : ALL);
        expect(plan.overlap).toBe(0);
        expect(problems(plan, p)).toEqual([]);
      });

  it('turns the table so any seat can sit at the bottom', () => {
    for (const anchor of [0, 3, 8]) {
      const p = input(9, { anchor });
      const plan = planHeight(360, 520, 386, p, SMALL);
      expect(plan.overlap).toBe(0);
      expect(problems(plan, p)).toEqual([]);
      // The viewer's seat sits in the middle of the bottom row (its bigger cards may centre it a few px higher).
      expect(plan.seats[anchor]!.x).toBeCloseTo(plan.w / 2, 0);
      expect(plan.seats[anchor]!.y).toBeGreaterThan(Math.max(...plan.seats.map((s) => s.y)) - 8);
    }
  });

  it('lays a table out the same way every time', () => {
    const p = input(6, { chars: BB });
    expect(planHeight(341, 530, 410, p, SMALL)).toEqual(planHeight(341, 530, 410, p, SMALL));
    expect(planTable(700, 560, p, ALL)).toEqual(planTable(700, 560, p, ALL));
  });

  it('takes the room it is given when the seats fit, and no more than the cap', () => {
    const plan = planHeight(1206, 640, 500, input(2), ALL);
    expect(plan.h).toBeLessThanOrEqual(500);
    expect(plan.density).toBe('full');
  });

  it('takes smaller seats over passing the cap, and passes it only when even the smallest need more', () => {
    // A 412px phone's replay: the compact seats would need about 350px, the cap that keeps the controls in view is 289.
    const short = { stack: 4, bet: 3, pot: 3 };
    const two = planHeight(358, 422, 289, input(2, { chars: short }), SMALL);
    expect(two.h).toBeLessThanOrEqual(289);
    expect(two.density).toBe('dense');
    expect(problems(two, input(2, { chars: short }))).toEqual([]);
    // Six seats fit nowhere within 269px: the table takes the least height its seats need.
    const six = planHeight(358, 402, 269, input(6, { chars: short }), SMALL);
    expect(six.h).toBeGreaterThan(269);
    expect(six.overlap).toBe(0);
    expect(problems(six, input(6, { chars: short }))).toEqual([]);
  });

  it('falls back to the least overlap, not a crash, when nothing fits', () => {
    const plan = planTable(120, 90, input(9), SMALL);
    expect(plan.overlap).toBeGreaterThan(0);
    expect(plan.seats).toHaveLength(9);
  });

  it('keeps the fixed seat ring the Academy lessons draw', () => {
    const g = seatLayout(6, 0, false);
    expect(g).toHaveLength(6);
    expect(g[0]!.seat.y).toBeGreaterThan(g[3]!.seat.y);
  });
});
