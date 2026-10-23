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
 * How many places the table and the player's seat (its centre: the seat's width follows its countdown) are drawn in,
 * read at every frame, from just before `start` until `ms` after it: 1 when nothing moved, 2 when they moved once. The
 * raise panel opening or closing moves neither, not even for a frame (Table.tsx's dockBand; TEST_REPORT).
 */
export async function tablePlaces(page: Page, seat: string, start: () => Promise<void>, ms = 1_200): Promise<number> {
  await page.evaluate((id) => {
    const w = window as unknown as { __places?: string[] };
    const read = () => {
      const t = document.querySelector('[data-testid=table]')?.getBoundingClientRect();
      const s = document.querySelector(`[data-testid="seat-${id}"]`)?.getBoundingClientRect();
      const half = (v: number) => Math.round(v * 2) / 2;
      return [t ? [t.left, t.top, t.width, t.height].map(half).join(',') : '-', s ? [s.left + s.width / 2, s.top + s.height / 2].map(half).join(',') : '-'].join('|');
    };
    const places = (w.__places = [read()]);
    const tick = () => {
      const now = read();
      if (now !== places[places.length - 1]) places.push(now);
      if (w.__places === places) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, seat);
  await start();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const w = window as unknown as { __places?: string[] };
    const n = w.__places?.length ?? 0;
    w.__places = undefined;
    return n;
  });
}

/** Every button and field of the action bar smaller than 40px either way, by what it says and its size. */
export function smallTargets(page: Page): Promise<string[]> {
  return page.getByTestId('action-bar').evaluate((bar) =>
    Array.from(bar.querySelectorAll('button, input'))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 40 || r.height < 40))
      .map(({ e, r }) => `${e.getAttribute('aria-label') ?? e.textContent?.trim()} ${Math.round(r.width)}×${Math.round(r.height)}`),
  );
}

/**
 * The live table as drawn: each seat's name, stack, cards, dealer button and status, each empty seat, the bets, the
 * board, the pot and the table status, and every control and line of the stack under the table (the action bar or the
 * pre-actions, the status line, the beginner aids). Each must lie inside the screen below the header, not under anything
 * else (hit tests at several points of each: a seat's own pieces may lie on one another, nothing from elsewhere may),
 * and no seat's or the board's piece may overlap another's, or any piece of the stack, and each bet must lie nearer its
 * own seat than any other (else it reads as that seat's). A box that paints nothing (no
 * background, border, shadow or text of its own, one that only places others, like the room kept for the pot and the
 * board) hides nothing under it; over a control (a sit button, the stack's) it would take the taps, so there it counts.
 * `dense`: the pieces (by id) hit-tested over a grid of their text (or, cards, of their face) rather than at a few points,
 * so a thin edge laid over a rank, a suit or an amount is found too.
 */
export function measureTable(page: Page, dense?: RegExp): Promise<TableReport> {
  return page.evaluate((denseSource) => {
    const denseRe = denseSource === null ? null : new RegExp(denseSource);
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
      // The plate carries a button over itself (a seat's card): what is hit there is still the seat.
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
      // A piece of a seat named for itself (its player's name, the dealer button) is still that seat's.
      const seat = e.closest('[data-testid^="seat-"][data-state]')?.getAttribute('data-testid');
      const at = seat && seat !== t ? `${seat}>${t}` : t;
      return `${at}>${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? `.${e.className.split(' ')[0]}` : ''}`;
    };
    /** What a piece's content takes: its text and the boxes inside it, without its own padding, within its own box (a
     * name cut short with an ellipsis lays out its whole text past it). */
    const textBox = (e: Element) => {
      const own = e.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(e);
      const rs = Array.from(range.getClientRects()).filter((q) => q.width > 0 && q.height > 0);
      if (!rs.length) return own;
      const l = Math.max(own.left, Math.min(...rs.map((q) => q.left)));
      const t = Math.max(own.top, Math.min(...rs.map((q) => q.top)));
      const r = Math.min(own.right, Math.max(...rs.map((q) => q.right)));
      const b = Math.min(own.bottom, Math.max(...rs.map((q) => q.bottom)));
      return r > l && b > t ? new DOMRect(l, t, r - l, b - t) : own;
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
      const grid = denseRe?.test(it.id);
      // Densely, over the text itself (its glyphs and chips, not the padding round them) or a card's whole face.
      const area = grid && it.text ? textBox(it.el) : r;
      const pts = grid
        ? [0.1, 0.3, 0.5, 0.7, 0.9].flatMap((fx) => (it.text ? [0.25, 0.5, 0.75] : [0.1, 0.3, 0.5, 0.7, 0.9]).map((fy) => [fx, fy]))
        : it.text
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
        const x = area.left + area.width * fx!;
        const y = area.top + area.height * fy!;
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
    // A bet nearer another seat than its own reads as that seat's ('astray', by the nearer seat): from its centre to the
    // nearest point of each seat as drawn (all its pieces, and the plate they sit on).
    const seatBox = new Map<string, { l: number; t: number; r: number; b: number }>();
    const grow = (g: string, r: DOMRect) => {
      const u = seatBox.get(g);
      seatBox.set(g, u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom });
    };
    for (const it of items) if (it.group.startsWith('seat-')) grow(it.group, box(it.el));
    for (const g of seatBox.keys()) {
      const plate = scene.querySelector(`[data-testid="stack-${g.slice(5)}"]`)?.parentElement?.parentElement;
      if (plate) grow(g, box(plate));
    }
    for (const it of items) {
      if (!/^bet-\d+$/.test(it.id)) continue;
      const own = seatBox.get(`seat-${it.id.slice(4)}`);
      if (!own) continue;
      const r = box(it.el);
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      const away = (u: { l: number; t: number; r: number; b: number }) => Math.hypot(Math.max(u.l - x, 0, x - u.r), Math.max(u.t - y, 0, y - u.b));
      const d = away(own);
      for (const [g, u] of seatBox) if (g !== `seat-${it.id.slice(4)}` && away(u) <= d) issues.push({ kind: 'astray', item: it.id, by: g, px: Math.round(d - away(u)) });
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
  }, dense?.source ?? null);
}
