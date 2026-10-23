import { describe, expect, it } from 'vitest';
import { DIMS, drawnOver, planForText, planHeight, planTable, scalePlan, seatLayout, type Density, type PlanInput, type TablePlan } from '../src/game/layout';

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
 * label, the pot (its row draws only the pot, in the middle) and the board with the status line under it.
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
  const potW = d.potChip + 18 + p.chars.pot * 6.6;
  out.push({ name: 'pot', l: k.x + k.w / 2 - potW / 2, t: k.y, r: k.x + k.w / 2 + potW / 2, b: k.y + plan.potRowH });
  out.push({ name: 'board', l: k.x, t: k.y + plan.potRowH + 8, r: k.x + k.w, b: k.y + k.h });
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

/** Bets nearer another seat as drawn (from its cards to its status line) than their own: they read as that seat's. */
function astray(plan: TablePlan, p: PlanInput): string[] {
  const seats = parts(plan, p)
    .filter((x) => x.name.startsWith('seat-'))
    .map((x, i) => ({ ...x, t: x.t + (p.me && i === p.anchor ? Math.max(4, p.meTop) : 6) }));
  const out: string[] = [];
  plan.bets.forEach((b, i) => {
    const away = (s: Box) => Math.hypot(Math.max(s.l - b.x, 0, b.x - s.r), Math.max(s.t - b.y, 0, b.y - s.b));
    for (const s of seats) if (s.name !== `seat-${i}` && away(s) <= away(seats[i]!)) out.push(`bet-${i} by ${s.name}`);
  });
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
        // Nine seats fit a small phone's area (iPhone SE) only with some bets nearer a neighbour (TEST_REPORT).
        if (!(name === 'iPhone SE' && n === 9)) expect(astray(plan, p)).toEqual([]);
      });

  // Another player's bet once they fold, their cards gone (Seat.tsx keeps their room, empty), where TableScene draws it
  // (`folds`): still nearer them than any other seat, and over nothing. And the viewer's own bet nearer their plate at
  // its least width (a short name) than any other seat. CI's areas: nine seats on a 360×800 phone waiting for the hand
  // (a folded seat's bet read as its neighbour's by 5px), six on a 412×839 one (the viewer's by 2px).
  const folding: [string, number, number, number][] = [
    // Nine seats on an iPhone SE have bets astray as it is (above).
    ...live.flatMap(([name, w, h]) => [2, 6, 9].map((n): [string, number, number, number] => [name, w, h, n])).filter(([name, , , n]) => !(name === 'iPhone SE' && n === 9)),
    ['Android 360×800, waiting', 344, 564, 9],
    ['Pixel 7 412×839', 396, 603, 6],
  ];
  for (const [name, w, h, n] of folding)
    it(`live table · ${name} · ${n} seats: a folded seat's bet, and the viewer's by a short name, by their own seat`, () => {
      const p = input(n, { meTop: 28, footer: true });
      const plan = planTable(Math.min(w, 2.1 * h), Math.min(h, 1.9 * w), p, w < 640 || h < 520 ? SMALL : ALL);
      const d = DIMS[plan.density];
      const all = parts(plan, p);
      const seats = all.filter((x) => x.name.startsWith('seat-')).map((x, i) => ({ ...x, t: x.t + (i === p.anchor ? Math.max(4, p.meTop) : 6) }));
      const away = (s: Box, x: number, y: number) => Math.hypot(Math.max(s.l - x, 0, x - s.r), Math.max(s.t - y, 0, y - s.b));
      const out: string[] = [];
      const bw = d.chip + 18 + p.chars.bet * 6.6;
      const bh = Math.max(d.chip + 16, 21);
      for (let i = 0; i < n; i++) {
        const own =
          i === p.anchor
            ? { ...seats[i]!, l: plan.seats[i]!.x - d.plateMin / 2, r: plan.seats[i]!.x + d.plateMin / 2 }
            : { ...seats[i]!, t: seats[i]!.t + 1.4 * d.cardOther - d.overlap };
        const b = i === p.anchor ? plan.bets[i]! : plan.folds[i]!;
        for (const s of seats) if (s.name !== `seat-${i}` && away(s, b.x, b.y) <= away(own, b.x, b.y)) out.push(`bet-${i} by ${s.name}`);
        if (i === p.anchor) continue;
        const c = { l: b.x - bw / 2, t: b.y - bh / 2, r: b.x + bw / 2, b: b.y + bh / 2 };
        if (c.l < -0.5 || c.t < -0.5 || c.r > plan.w + 0.5 || c.b > plan.h + 0.5) out.push(`fold-${i} outside`);
        for (const x of all) {
          if (x.name === `bet-${i}`) continue;
          const z = x.name === `seat-${i}` ? own : x;
          if (Math.min(c.r, z.r) - Math.max(c.l, z.l) > 0.5 && Math.min(c.b, z.b) - Math.max(c.t, z.t) > 0.5) out.push(`fold-${i} × ${x.name}`);
        }
      }
      expect(out).toEqual([]);
    });

  // A phone held sideways (short.ts): the area beside the controls' column on a 844×390 screen, no status line under
  // the table, the cards' raised room cut to 4px, and the table free to narrow by 15%.
  for (const chars of [CHIPS, BB])
    for (const n of [2, 6, 9])
      it(`live table · phone sideways 844×390 · ${n} seats · ${chars === BB ? 'BB' : 'chips'}`, () => {
        const p = input(n, { meTop: 4, chars });
        const plan = planTable(624, 338, p, SMALL, Math.round(0.85 * 624));
        expect(plan.overlap).toBe(0);
        expect(problems(plan, p)).toEqual([]);
        expect(astray(plan, p)).toEqual([]);
      });

  it('narrows the table, within what it is let, where that keeps every bet by its own seat', () => {
    const p = input(9, { meTop: 4 });
    // At its full width nine seats fit, but bets lie nearer a neighbour; 8px narrower each lies by its own. (At 608×308,
    // where this was once so, the board drawn in the middle now leaves each by its own at the full width: TEST_REPORT.)
    const full = planTable(640, 268, p, SMALL);
    expect(full.overlap).toBe(0);
    expect(astray(full, p)).not.toEqual([]);
    const narrow = planTable(640, 268, p, SMALL, Math.round(0.85 * 640));
    expect(narrow.w).toBeLessThan(640);
    expect(narrow.overlap).toBe(0);
    expect(problems(narrow, p)).toEqual([]);
    expect(astray(narrow, p)).toEqual([]);
  });

  it('keeps every bet by its own seat at 800×360 sideways: a bet may lie beside the pot, not under a neighbour', () => {
    // The pot's row draws only the pot, in its middle: the top row's middle seats' bets lie under them, beside it.
    const p = input(9, { meTop: 4 });
    const plan = planTable(580, 308, p, SMALL, Math.round(0.85 * 580));
    expect(plan.overlap).toBe(0);
    expect(problems(plan, p)).toEqual([]);
    expect(astray(plan, p)).toEqual([]);
  });

  it('keeps a fit with nothing overlapping over every bet by its own seat when it cannot have both', () => {
    // Nine seats in 576×300 fit, at whatever width they are let, only with a bet nearer a neighbour.
    const p = input(9, { meTop: 4 });
    const plan = planTable(576, 300, p, SMALL, Math.round(0.85 * 576));
    expect(plan.overlap).toBe(0);
    expect(problems(plan, p)).toEqual([]);
    expect(astray(plan, p)).not.toEqual([]);
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

  it('passes the cap by as little as it can: a smaller cap never makes a taller table', () => {
    // A heads-up replay on a 390px phone (Pixel 7), the cap a few px under what the smallest seats need: the table
    // took the larger seats' least height (359px), 91px over the cap, and pushed the controls under the bottom bar.
    const p = input(2, { chars: { stack: 9, bet: 5, pot: 5 } });
    const under = planHeight(336, 440, 260, p, SMALL);
    expect(under.h).toBeGreaterThan(260);
    expect(under.h).toBeLessThanOrEqual(272);
    expect(under.density).toBe('dense');
    expect(under.overlap).toBe(0);
    expect(problems(under, p)).toEqual([]);
    for (const [w, n, chars] of [[336, 2, CHIPS], [336, 6, CHIPS], [358, 9, BB], [1206, 2, CHIPS], [1206, 9, BB]] as const) {
      const q = input(n, { chars });
      let last = 0;
      for (let cap = 120; cap <= 520; cap += 8) {
        const h = planHeight(w, 540, cap, q, w < 640 ? SMALL : ALL).h;
        expect(h, `${w}px · ${n} seats · cap ${cap}`).toBeGreaterThanOrEqual(last);
        last = h;
      }
    }
  });

  it('falls back to the least overlap, not a crash, when nothing fits', () => {
    const plan = planTable(120, 90, input(9), SMALL);
    expect(plan.overlap).toBeGreaterThan(0);
    expect(plan.seats).toHaveLength(9);
  });

  it('where nothing fits, lays no bet over the board’s cards nor nearer another seat: they come before the bets', () => {
    // A 320px phone upright, the raise panel open: the six-seat table has 312×209, where no way fits (it would need some
    // 360px). The player's own bet lay over the board's middle card; now it lies on its own seat's room (TEST_REPORT).
    const p = input(6, { footer: true });
    const plan = planTable(312, 209, p, SMALL);
    expect(plan.overlap).toBeGreaterThan(0);
    const k = plan.block;
    const top = k.y + plan.potRowH + 8;
    const cards = { l: k.x, t: top, r: k.x + k.w, b: top + 1.4 * plan.board + 2 * DIMS[plan.density].boardPad };
    const over = parts(plan, p).filter((x) => x.name.startsWith('bet-') && Math.min(x.r, cards.r) - Math.max(x.l, cards.l) > 0.5 && Math.min(x.b, cards.b) - Math.max(x.t, cards.t) > 0.5);
    expect(over.map((x) => x.name)).toEqual([]);
    expect(astray(plan, p)).toEqual([]);
  });

  it('keeps the fixed seat ring the Academy lessons draw', () => {
    const g = seatLayout(6, 0, false);
    expect(g).toHaveLength(6);
    expect(g[0]!.seat.y).toBeGreaterThan(g[3]!.seat.y);
  });
});

describe('table layout with the text larger: the seats are sized in rem', () => {
  // As useTableLayout lays the real table out for text at u times 16px: in the area u times smaller, drawn u times larger
  // (short: a phone on its side, realTableOptions).
  const at = (aw: number, ah: number, n: number, short = false) => (u: number) => {
    const w = aw / u;
    const h = ah / u;
    const bw = Math.min(w, 2.1 * h);
    const p = input(n, short ? { meTop: 4 } : { meTop: 28, footer: true });
    return scalePlan(planTable(bw, Math.min(h, 1.9 * w), p, w < 640 || h < 520 ? SMALL : ALL, Math.round((short ? 0.85 : 1) * bw)), u);
  };
  const unit = (plan: TablePlan) => plan.dims.cardMe / DIMS[plan.density].cardMe;
  // What a plan costs drawn at k: what it left overlapping itself and what its seats drawn larger add (planForText).
  const cost = (plan: TablePlan, k: number) => plan.overlap + drawnOver(plan, k / unit(plan)).all - drawnOver(plan, 1).all;

  it('draws a plan k times larger, every part with it', () => {
    const p = at(340, 493, 6)(1);
    const q = scalePlan(p, 1.25);
    expect([q.w, q.h, q.seats[2]!.x, q.block.w, q.dims.cardMe]).toEqual([p.w, p.h, p.seats[2]!.x, p.block.w, p.dims.cardMe].map((x) => x * 1.25));
    expect(drawnOver(q, 1).all).toBeCloseTo(drawnOver(p, 1).all * 1.25 ** 2);
  });

  it('keeps the larger text where its seats keep off the board', () => {
    // Six seats on a 360×640 phone at 125%: the table has 340×493.
    const plan = planForText(1.25, at(340, 493, 6));
    expect(unit(plan)).toBeCloseTo(1.25);
    expect(drawnOver(plan, 1).board).toBe(0);
  });

  it('where the seats at the larger text would reach over the board, takes the plan that costs least so drawn', () => {
    // Nine seats on a 320×568 phone at 125%: the table has 300×344, where no way has room for nine seats that size. Laid
    // out for 125%, they lay over the board and up to 81px past the screen (TEST_REPORT).
    const lay = at(300, 344, 9);
    const big = lay(1.25);
    expect(drawnOver(big, 1).board).toBeGreaterThan(0);
    const plan = planForText(1.25, lay);
    expect(unit(plan)).toBeLessThan(1.25);
    expect(cost(plan, 1.25)).toBeLessThan(big.overlap);
  });

  it('counts the bets a plan leaves off the table, not only its seats', () => {
    // Nine seats on a 667×375 phone on its side at 125%: the table has 393×311. Laid out for 125%, two bets lie off the
    // table (one drawn 47px past the screen) and the board over a seat's name; laid out for 16px, the seats drawn 25%
    // larger crowd each other a little more but leave the board and the bets clear (TEST_REPORT).
    const lay = at(393, 311, 9, true);
    const big = lay(1.25);
    expect(big.bets.some((b) => b.x < 0 || b.x > big.w)).toBe(true);
    const plan = planForText(1.25, lay);
    expect(unit(plan)).toBeCloseTo(1);
    expect(drawnOver(plan, 1.25).all).toBeGreaterThan(drawnOver(big, 1).all);
    expect(cost(plan, 1.25)).toBeLessThan(big.overlap);
  });

  it('keeps the larger text where what it leaves over the board costs less than the others drawn larger', () => {
    // Six seats on a 667×375 phone on its side at 125%: a seat's room meets the board's corner (none of its cards).
    const lay = at(393, 311, 6, true);
    expect(drawnOver(lay(1.25), 1).board).toBeGreaterThan(0);
    expect(unit(planForText(1.25, lay))).toBeCloseTo(1.25);
  });

  it('lays out at 16px and smaller text without trying another', () => {
    const tried: number[] = [];
    for (const k of [1, 0.875]) planForText(k, (u) => (tried.push(u), at(300, 344, 9)(u)));
    expect(tried).toEqual([1, 0.875]);
  });
});
