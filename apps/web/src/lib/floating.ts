/**
 * Where a floating panel goes beside the control that opened it (Floating.tsx): drawn on the page's top layer, so no box
 * round the control clips it, and placed in the room the screen has. Each side asked for is tried at the control and,
 * past what it must not cover (`avoid`, each with a weight: the turn's controls, my cards), clear of each: beside a
 * column of controls, past the column, not only past the control; above or below a thing, as tall as the room there
 * lets it. The panel keeps inside `bounds` (the screen less its safe edges and the header), taller content scrolling in
 * it. Of the places wide and tall enough to read, the one that covers least wins (weighted), then the one that shows the
 * most of it; the sides' order breaks a tie.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type Side = 'top' | 'bottom' | 'left' | 'right';
export interface Avoid {
  rect: Rect;
  /** How much covering it costs, per pixel: a control the turn needs far more than a part of the table. */
  weight: number;
}
export interface Placement {
  side: Side;
  left: number;
  top: number;
  width: number;
  /** The height it is given: its own, or less (it scrolls) where the room is less. */
  height: number;
  /** The weighted area of what it covers (0: nothing it was asked to keep clear of). */
  covers: number;
}

/** Shorter or narrower than this (or than itself), a place is not worth taking while another is not. */
const MIN_HEIGHT = 96;
const MIN_WIDTH = 240;

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export function placeFloating(anchor: Rect, want: { width: number; height: number }, bounds: Rect, sides: Side[], avoid: Avoid[] = [], gap = 8): Placement {
  const room = { w: bounds.right - bounds.left, h: bounds.bottom - bounds.top };
  const cx = (anchor.left + anchor.right) / 2;
  const tries: Placement[] = [];
  const add = (side: Side, left: number, top: number, width: number, height: number) => {
    if (width < 1 || height < 1) return;
    const r = { left, top, right: left + width, bottom: top + height };
    const covers = avoid.reduce((sum, a) => sum + a.weight * overlap(r, a.rect), 0);
    tries.push({ side, left, top, width, height, covers });
  };
  for (const side of sides) {
    if (side === 'top' || side === 'bottom') {
      const width = Math.min(want.width, room.w);
      const left = clamp(cx - width / 2, bounds.left, bounds.right - width);
      const x = { left, right: left + width };
      const across = avoid.filter((a) => a.rect.left < x.right && a.rect.right > x.left);
      if (side === 'top') {
        // Its foot at the control, or above each thing it must not cover.
        const feet = [anchor.top - gap, ...across.map((a) => a.rect.top - gap)].filter((y) => y <= anchor.top - gap);
        for (const foot of feet) add(side, left, Math.max(bounds.top, foot - want.height), width, Math.min(want.height, foot - bounds.top));
      } else {
        const heads = [anchor.bottom + gap, ...across.map((a) => a.rect.bottom + gap)].filter((y) => y >= anchor.bottom + gap);
        for (const head of heads) add(side, left, head, width, Math.min(want.height, bounds.bottom - head));
      }
    } else {
      // Its inner edge at the control, or past each thing on that side of it (the column the control is in).
      const edges =
        side === 'left'
          ? [anchor.left - gap, ...avoid.filter((a) => a.rect.left < anchor.left).map((a) => a.rect.left - gap)].filter((e) => e <= anchor.left - gap)
          : [anchor.right + gap, ...avoid.filter((a) => a.rect.right > anchor.right).map((a) => a.rect.right + gap)].filter((e) => e >= anchor.right + gap);
      for (const edge of edges) {
        const width = Math.min(want.width, side === 'left' ? edge - bounds.left : bounds.right - edge);
        const left = side === 'left' ? edge - width : edge;
        const height = Math.min(want.height, room.h);
        const across = avoid.filter((a) => a.rect.left < left + width && a.rect.right > left);
        // Level with the control's foot, its head, or above or below each thing it must not cover; inside the bounds.
        const tops = [anchor.bottom - height, anchor.top, ...across.flatMap((a) => [a.rect.top - gap - height, a.rect.bottom + gap])];
        for (const t of tops) add(side, left, clamp(t, bounds.top, bounds.bottom - height), width, height);
        // Or as tall as the room above or below each of them lets it.
        for (const a of across) {
          const fits = Math.min(want.height, a.rect.top - gap - bounds.top);
          add(side, left, a.rect.top - gap - fits, width, fits);
          const head = a.rect.bottom + gap;
          add(side, left, head, width, Math.min(want.height, bounds.bottom - head));
        }
      }
    }
  }
  const tall = Math.min(want.height, MIN_HEIGHT);
  const wide = Math.min(want.width, MIN_WIDTH);
  const enough = (p: Placement) => p.height >= tall && p.width >= wide;
  let best: Placement | null = null;
  for (const p of tries) {
    if (!best) {
      best = p;
      continue;
    }
    const pOk = enough(p);
    const bOk = enough(best);
    if (pOk !== bOk) {
      if (pOk) best = p;
      continue;
    }
    if (p.covers < best.covers - 0.5 || (Math.abs(p.covers - best.covers) <= 0.5 && p.height * p.width > best.height * best.width)) best = p;
  }
  // No room at all (a screen smaller than the panel's least): under the control, as much of it as there is.
  return best ?? { side: 'bottom', left: bounds.left, top: bounds.top, width: room.w, height: Math.max(0, room.h), covers: 0 };
}
