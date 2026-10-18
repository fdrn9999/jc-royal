import type { Page } from '@playwright/test';
import type { LayoutIssue } from './replay-layout';

export interface TableReport {
  items: string[];
  issues: LayoutIssue[];
  viewport: { w: number; h: number };
  /** The table's column: below the header (and any bar under it), down to the bottom of the screen. */
  band: { top: number; bottom: number };
  table: { top: number; bottom: number; left: number; right: number };
  /** The stack under the table: the action bar or the pre-actions, the status line, the aids. */
  stack: { top: number; bottom: number; left: number; right: number } | null;
}

/**
 * The live table as drawn: each seat's name, stack, cards, dealer button and status, each empty seat, the bets, the
 * board, the pot and the table status, and every control and line of the stack under the table (the action bar or the
 * pre-actions, the status line, the beginner aids). Each must lie inside the screen below the header, not under anything
 * else (hit tests at several points of each: a seat's own pieces may lie on one another, nothing from elsewhere may),
 * and no seat's or the board's piece may overlap another's, or any piece of the stack. A box that paints nothing (no
 * background, border, shadow or text of its own, one that only places others, like the room kept for the pot and the
 * board) hides nothing under it; over a control (a sit button, the stack's) it would take the taps, so there it counts.
 */
export function measureTable(page: Page): Promise<TableReport> {
  return page.evaluate(() => {
    const scene = document.querySelector('[data-testid=table]')!;
    const stackEl = document.querySelector('[data-testid=table-stack]');
    const column = (stackEl?.parentElement ?? scene.parentElement)!;
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const col = column.getBoundingClientRect();
    const top = Math.max(0, col.top);
    const bottom = Math.min(vh, col.bottom);
    const box = (e: Element) => e.getBoundingClientRect();

    interface Item {
      id: string;
      el: Element;
      owner: Element;
      group: string;
      table: boolean;
      text: boolean;
    }
    const items: Item[] = [];
    const add = (id: string, el: Element | null | undefined, o: { owner?: Element | null; group?: string; table?: boolean; text?: boolean } = {}) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') return;
      items.push({ id, el, owner: o.owner ?? el, group: o.group ?? id, table: o.table ?? true, text: o.text ?? false });
    };
    for (const seat of Array.from(scene.querySelectorAll('[data-testid^="seat-"][data-state]'))) {
      const i = seat.getAttribute('data-testid')!.slice(5);
      // The plate carries a button over itself (a seat's card, my reactions): what is hit there is still the seat.
      const o = { owner: seat, group: `seat-${i}` };
      add(`name-${i}`, seat.querySelector('[data-testid=member-name]'), { ...o, text: true });
      add(`stack-${i}`, seat.querySelector(`[data-testid="stack-${i}"]`), { ...o, text: true });
      Array.from(seat.querySelectorAll('.jc-card')).forEach((c, k) => add(`card-${i}-${k}`, c, o));
      add(`dealer-${i}`, seat.querySelector('[data-testid=dealer-button]'), o);
      const status = seat.querySelector(`[data-testid="seat-status-${i}"]`);
      if (status?.textContent?.trim()) Array.from(status.children).forEach((x, k) => add(`status-${i}-${k}`, x, { ...o, text: true }));
    }
    scene.querySelectorAll('[data-testid^="sit-"]').forEach((b) => add(b.getAttribute('data-testid')!, b));
    scene.querySelectorAll('[data-testid^="bet-"]').forEach((b) => add(b.getAttribute('data-testid')!, b, { text: true }));
    scene.querySelectorAll('[data-testid=board] > *').forEach((c, k) => add(`board-${k}`, c, { group: 'board' }));
    scene.querySelectorAll('[data-testid=pot] > *').forEach((c, k) => add(`pot-${k}`, c, { group: 'pot', text: true }));
    const tableStatus = scene.querySelector('[data-testid=table-status]');
    if (tableStatus?.textContent?.trim()) add('table-status', tableStatus, { text: true });
    // The stack: each of its controls, and each line or box of it that holds none.
    const lines: Element[] = [];
    for (const child of Array.from(stackEl?.children ?? [])) {
      // What only a screen reader hears (sr-only: clipped away, though its padding may still give it a box).
      const cs = getComputedStyle(child);
      if (box(child).width <= 1 || box(child).height <= 1 || cs.clipPath !== 'none' || (cs.clip !== 'auto' && cs.clip !== '')) continue;
      const controls = Array.from(child.querySelectorAll('button, input:not([type=hidden]), select'));
      const id = child.getAttribute('data-testid') ?? `line-${lines.length}`;
      if (controls.length) controls.forEach((c, k) => add(`${id}:${c.getAttribute('data-testid') ?? c.getAttribute('aria-label') ?? c.textContent?.trim() ?? k}`, c, { group: 'stack', table: false }));
      else add(id, child, { group: 'stack', table: false, text: true });
      lines.push(child);
    }

    const issues: LayoutIssue[] = [];
    const describe = (e: Element | null) => {
      if (!e) return 'nothing';
      const t = e.closest('[data-testid]')?.getAttribute('data-testid') ?? '';
      return `${t}>${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? `.${e.className.split(' ')[0]}` : ''}`;
    };
    const clear = (c: string) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
    const paints = (e: Element) => {
      if (!(e instanceof HTMLElement) || e.matches('button, a, input, select, textarea, img, canvas, video')) return true;
      const cs = getComputedStyle(e);
      if (!clear(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || (cs.backdropFilter || 'none') !== 'none') return true;
      if ((['Top', 'Right', 'Bottom', 'Left'] as const).some((s) => parseFloat(cs[`border${s}Width`]) > 0 && !clear(cs[`border${s}Color`]))) return true;
      return Array.from(e.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '');
    };
    for (const it of items) {
      const control = it.el.matches('button, a, input, select');
      const r = it.el.getBoundingClientRect();
      const sx = Math.max(-r.left, r.right - vw, 0);
      if (sx > 0.5) issues.push({ kind: 'clipped', item: it.id, by: 'screen', px: Math.round(sx) });
      if (r.top < top - 0.5 || r.bottom > bottom + 0.5) issues.push({ kind: 'offscreen', item: it.id, px: Math.round(Math.max(top - r.top, r.bottom - bottom)) });
      // A hit test passes through what takes no pointer (the stack's plain lines): only the box checks below see those.
      if (getComputedStyle(it.el).pointerEvents === 'none') continue;
      const pts = it.text
        ? [
            [0.5, 0.5],
            [0.12, 0.5],
            [0.88, 0.5],
          ]
        : [
            [0.5, 0.5],
            [0.25, 0.3],
            [0.75, 0.3],
            [0.25, 0.6],
            [0.75, 0.6],
          ];
      const by = new Set<string>();
      for (const [fx, fy] of pts) {
        const x = r.left + r.width * fx!;
        const y = r.top + r.height * fy!;
        // Within a pixel of the screen's edge Chrome rounds the point out of the viewport and finds nothing there.
        if (x < 0 || x > vw - 1 || y < top || y > bottom - 1) continue;
        let hit = 'nothing';
        for (const e of document.elementsFromPoint(x, y)) {
          if (it.owner.contains(e)) {
            hit = '';
            break;
          }
          if (control || paints(e)) {
            hit = describe(e);
            break;
          }
        }
        if (hit) by.add(hit);
      }
      if (by.size) issues.push({ kind: 'covered', item: it.id, by: [...by].join(' | ') });
    }
    const overlap = (p: DOMRect, q: DOMRect) => {
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      return w > 1 && h > 1 ? Math.round(Math.min(w, h)) : 0;
    };
    const table = items.filter((x) => x.table);
    for (let a = 0; a < table.length; a++) {
      for (let b = a + 1; b < table.length; b++) {
        if (table[a]!.group === table[b]!.group) continue;
        const px = overlap(box(table[a]!.el), box(table[b]!.el));
        if (px) issues.push({ kind: 'overlap', item: table[a]!.id, by: table[b]!.id, px });
      }
    }
    // The stack's lines, whole (a bar's padding included), against every piece of the table.
    for (const line of lines) {
      const id = line.getAttribute('data-testid') ?? `line-${lines.indexOf(line)}`;
      const l = box(line);
      if (l.width < 1 || l.height < 1) continue;
      for (const it of table) {
        const px = overlap(l, box(it.el));
        if (px) issues.push({ kind: 'overlap', item: it.id, by: id, px });
      }
    }
    const s = scene.getBoundingClientRect();
    const k = stackEl && lines.length ? lines.map(box) : null;
    return {
      items: items.map((x) => x.id),
      issues,
      viewport: { w: vw, h: vh },
      band: { top: Math.round(top), bottom: Math.round(bottom) },
      table: { top: Math.round(s.top), bottom: Math.round(s.bottom), left: Math.round(s.left), right: Math.round(s.right) },
      stack: k
        ? {
            top: Math.round(Math.min(...k.map((x) => x.top))),
            bottom: Math.round(Math.max(...k.map((x) => x.bottom))),
            left: Math.round(Math.min(...k.map((x) => x.left))),
            right: Math.round(Math.max(...k.map((x) => x.right))),
          }
        : null,
    };
  });
}
