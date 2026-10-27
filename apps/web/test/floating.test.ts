import { describe, expect, it } from 'vitest';
import { placeFloating, type Rect } from '../src/lib/floating';

const rect = (left: number, top: number, w: number, h: number): Rect => ({ left, top, right: left + w, bottom: top + h });
const inside = (p: { left: number; top: number; width: number; height: number }, b: Rect) =>
  p.left >= b.left - 0.01 && p.top >= b.top - 0.01 && p.left + p.width <= b.right + 0.01 && p.top + p.height <= b.bottom + 0.01;

// A 320×568 phone upright under a 60px header: the "?" in the band under the table, my seat just above the band.
const PHONE = rect(8, 68, 304, 492);
const HELP = rect(272, 380, 36, 36);
const MY_SEAT = rect(100, 300, 120, 72);
const BAR = rect(8, 430, 304, 112);
const BOARD = rect(60, 180, 200, 60);

describe('a floating panel beside the control that opened it', () => {
  it('stays inside the screen and under the header, and scrolls what it has no room for', () => {
    const p = placeFloating(HELP, { width: 352, height: 900 }, PHONE, ['top', 'bottom']);
    expect(inside(p, PHONE)).toBe(true);
    expect(p.width).toBe(304);
    expect(p.height).toBeLessThan(900);
    expect(p.top).toBeGreaterThanOrEqual(68);
  });

  it('goes above the control, not over the action bar under it', () => {
    const p = placeFloating(HELP, { width: 300, height: 200 }, PHONE, ['top', 'bottom'], [{ rect: BAR, weight: 100 }]);
    expect(p.side).toBe('top');
    expect(p.top + p.height).toBeLessThanOrEqual(HELP.top);
    expect(p.covers).toBe(0);
  });

  it('clears my seat when the room above it holds the panel, covering the board rather than my cards', () => {
    const avoid = [
      { rect: BAR, weight: 100 },
      { rect: MY_SEAT, weight: 40 },
      { rect: BOARD, weight: 3 },
    ];
    const p = placeFloating(HELP, { width: 300, height: 180 }, PHONE, ['top', 'bottom'], avoid);
    expect(p.top + p.height).toBeLessThanOrEqual(MY_SEAT.top);
    expect(inside(p, PHONE)).toBe(true);
  });

  it('flips below when the room above is too small, and keeps a usable height', () => {
    const anchor = rect(140, 90, 36, 36);
    const p = placeFloating(anchor, { width: 280, height: 220 }, PHONE, ['top', 'bottom']);
    expect(p.side).toBe('bottom');
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(p.height).toBe(220);
  });

  it('beside a column at the right edge (a phone on its side), it goes left of it, inside the screen', () => {
    const side = rect(8, 56, 828, 326);
    const anchor = rect(640, 200, 36, 36);
    const p = placeFloating(anchor, { width: 352, height: 160 }, side, ['left', 'top']);
    expect(p.side).toBe('left');
    expect(p.left + p.width).toBeLessThanOrEqual(anchor.left);
    expect(inside(p, side)).toBe(true);
  });

  it('on a phone on its side, it goes left of the whole column of controls, above my cards rather than over them', () => {
    // 568×320: the column (12.5rem) at the right, the "?" at its right end, the action bar under it; my seat low on the felt.
    const side = rect(8, 56, 552, 256);
    const anchor = rect(516, 116, 36, 36);
    const bar = rect(368, 200, 192, 104);
    const banner = rect(368, 84, 150, 24);
    const mine = rect(136, 220, 90, 84);
    const board = rect(100, 170, 200, 44);
    const avoid = [
      { rect: bar, weight: 100 },
      { rect: banner, weight: 40 },
      { rect: mine, weight: 40 },
      { rect: board, weight: 3 },
    ];
    const p = placeFloating(anchor, { width: 352, height: 250 }, side, ['left', 'top'], avoid);
    expect(p.side).toBe('left');
    expect(p.left + p.width).toBeLessThanOrEqual(bar.left);
    expect(p.top + p.height).toBeLessThanOrEqual(mine.top);
    expect(p.height).toBeGreaterThanOrEqual(96);
    expect(p.width).toBeGreaterThanOrEqual(240);
    expect(inside(p, side)).toBe(true);
  });

  it('on a screen smaller than its least, it still takes what there is', () => {
    const tiny = rect(8, 8, 120, 60);
    const p = placeFloating(rect(40, 30, 20, 20), { width: 352, height: 300 }, tiny, ['top', 'bottom']);
    expect(p.width).toBeLessThanOrEqual(120);
    expect(p.height).toBeGreaterThan(0);
    expect(inside(p, tiny)).toBe(true);
  });
});
