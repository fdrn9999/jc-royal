import type { Page } from '@playwright/test';

export interface LayoutIssue {
  kind: 'clipped' | 'covered' | 'overlap' | 'offscreen' | 'truncated';
  item: string;
  by?: string;
  px?: number;
}

export interface LayoutReport {
  items: string[];
  issues: LayoutIssue[];
  viewport: { w: number; h: number };
  /** The visible band between the sticky header and the bottom navigation. */
  band: { top: number; bottom: number };
  table: { top: number; bottom: number; left: number; right: number };
  controls: { top: number; bottom: number } | null;
  /** Where a table drawn in a scrolling window (upright phones) is scrolled to, how far it goes and how much shows. */
  window: { top: number; max: number; view: number } | null;
}

/**
 * Everything the replay must keep readable — each nickname, stack, hole card, the board's five places, bets, pots, the
 * dealer button, each seat's action or win line, the step text, the controls and the settlement — checked where it is
 * drawn: inside the table area and the screen, not under anything else (hit tests at several points of each), and not
 * overlapping another seat's or the board's pieces. `scroll: 'table'` first scrolls the replay (its step line, or the
 * table where there is none) to just under the header, as a player looking at it would; `'bottom'` scrolls its end (the
 * controls, or the settlement under them) to just above the bottom navigation; `'controls'` scrolls the controls' end
 * there, as a player reaching for them would; `'none'` measures the page as it opened.
 *
 * A table drawn in a scrolling window is whole inside the window's scrolled extent (else it is cut off); a piece past
 * the part showing is off screen for now, as one past the bottom navigation is. `windowTo` scrolls the window first.
 */
export function measureReplay(page: Page, scroll: 'table' | 'bottom' | 'controls' | 'none', root = '[data-testid=hand-replay]', windowTo?: number): Promise<LayoutReport> {
  return page.evaluate(
    ([scrollMode, rootSel, windowAt]) => {
      const host = document.querySelector(rootSel)!;
      const surface = (host.querySelector('[data-testid=replay-table]') ?? host.querySelector('.jc-game-surface'))!;
      const win = surface instanceof HTMLElement && surface.dataset.window === '1' ? surface : null;
      if (win && windowAt !== null) win.scrollTop = windowAt;
      // Where the header ends, its own content included: on a tablet its labels wrap and run past its 64px box, and
      // whatever lies under them is under the header.
      const headerEl = document.querySelector('header');
      const headerEnd = () => Math.max(headerEl?.getBoundingClientRect().bottom ?? 0, ...Array.from(headerEl?.querySelectorAll('*') ?? []).map((e) => e.getBoundingClientRect().bottom));
      const header = headerEnd();
      const first = host.querySelector('[data-testid=replay-status]') ?? surface;
      const vw = document.documentElement.clientWidth;
      const vh = innerHeight;
      const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
      const bottom = nav ? nav.getBoundingClientRect().top : vh;
      if (scrollMode === 'table') scrollBy(0, Math.min(first.getBoundingClientRect().top, surface.getBoundingClientRect().top) - Math.max(0, header));
      if (scrollMode === 'bottom') scrollBy(0, host.getBoundingClientRect().bottom - bottom);
      const controlsEl = host.querySelector('[data-testid=replay-controls]');
      if (scrollMode === 'controls' && controlsEl) scrollBy(0, controlsEl.getBoundingClientRect().bottom - bottom);
      const top = Math.max(0, headerEnd());
      const s = surface.getBoundingClientRect();
      // The table's whole extent, and the part of it showing (the window's inside, or all of it).
      const whole = win ? { left: s.left, right: s.right, top: s.top + win.clientTop - win.scrollTop, bottom: s.top + win.clientTop - win.scrollTop + win.scrollHeight } : s;
      const shown = win ? { top: s.top + win.clientTop, bottom: s.top + win.clientTop + win.clientHeight } : { top: -Infinity, bottom: Infinity };

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
      for (const seat of Array.from(host.querySelectorAll('[data-testid^="seat-"][data-state]'))) {
        const i = seat.getAttribute('data-testid')!.slice(5);
        const group = `seat-${i}`;
        const name = seat.querySelector('[data-testid=member-name]');
        add(`name-${i}`, name, { group, text: true });
        add(`stack-${i}`, seat.querySelector(`[data-testid="stack-${i}"]`), { group, text: true });
        Array.from(seat.querySelectorAll('.jc-card')).forEach((c, k) => add(`card-${i}-${k}`, c, { owner: c.parentElement, group }));
        add(`dealer-${i}`, seat.querySelector('[data-testid=dealer-button]'), { group });
        const status = seat.querySelector(`[data-testid="seat-status-${i}"]`) ?? seat.lastElementChild?.lastElementChild;
        if (status?.textContent?.trim()) Array.from(status.children).forEach((x, k) => add(`status-${i}-${k}`, x, { group, text: true }));
      }
      host.querySelectorAll('[data-testid^="bet-"]').forEach((b) => add(b.getAttribute('data-testid')!, b, { text: true }));
      host.querySelectorAll('[data-testid=board] > *').forEach((c, k) => add(`board-${k}`, c, { group: 'board' }));
      host.querySelectorAll('[data-testid=pot] > *').forEach((c, k) => add(`pot-${k}`, c, { group: 'pot', text: true }));
      const status = host.querySelector('[data-testid=table-status]');
      if (status?.textContent?.trim()) add('table-status', status, { text: true });
      const controls = host.querySelector('[data-testid=replay-controls]');
      for (const id of ['replay-step', 'replay-index', 'replay-pot', 'replay-side-pots', 'replay-action']) add(id, host.querySelector(`[data-testid=${id}]`), { table: false, text: true });
      add('replay-slider', host.querySelector('[data-testid=replay-slider]'), { table: false });
      controls?.querySelectorAll('button').forEach((b, k) => add(`control-${b.getAttribute('data-testid') ?? k}`, b, { table: false }));
      host.querySelectorAll('[data-testid=replay-pot-row]').forEach((x, k) => add(`settlement-${k}`, x, { table: false }));

      const issues: { kind: string; item: string; by?: string; px?: number }[] = [];
      const describe = (e: Element | null) => {
        if (!e) return 'nothing';
        const t = e.closest('[data-testid]')?.getAttribute('data-testid') ?? '';
        return `${t}>${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? `.${e.className.split(' ')[0]}` : ''}`;
      };
      const out = (r: DOMRect, b: { left: number; right: number; top: number; bottom: number }) =>
        Math.max(b.left - r.left, r.right - b.right, b.top - r.top, r.bottom - b.bottom, 0);
      for (const it of items) {
        const r = it.el.getBoundingClientRect();
        // What of the screen this piece can show in: the band, and for the table's pieces the window's inside.
        const lo = it.table ? Math.max(top, shown.top) : top;
        const hi = it.table ? Math.min(bottom, shown.bottom) : bottom;
        if (it.table) {
          const px = out(r, whole);
          if (px > 0.5) issues.push({ kind: 'clipped', item: it.id, by: 'table', px: Math.round(px) });
        }
        const sx = Math.max(-r.left, r.right - vw, 0);
        if (sx > 0.5) issues.push({ kind: 'clipped', item: it.id, by: 'screen', px: Math.round(sx) });
        if (r.top < lo - 0.5 || r.bottom > hi + 0.5) issues.push({ kind: 'offscreen', item: it.id, px: Math.round(Math.max(lo - r.top, r.bottom - hi)) });
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
          if (x < 0 || x > vw - 1 || y < lo || y > hi - 1) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !it.owner.contains(hit)) by.add(describe(hit));
        }
        if (by.size) issues.push({ kind: 'covered', item: it.id, by: [...by].join(' | ') });
        if (it.text && it.id.startsWith('name-')) {
          const cut = it.el.querySelector('.truncate');
          if (cut && cut.scrollWidth > cut.clientWidth + 1) issues.push({ kind: 'truncated', item: it.id });
        }
      }
      const table = items.filter((x) => x.table);
      for (let a = 0; a < table.length; a++) {
        for (let b = a + 1; b < table.length; b++) {
          if (table[a]!.group === table[b]!.group) continue;
          const p = table[a]!.el.getBoundingClientRect();
          const q = table[b]!.el.getBoundingClientRect();
          const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          if (w > 1 && h > 1) issues.push({ kind: 'overlap', item: table[a]!.id, by: table[b]!.id, px: Math.round(Math.min(w, h)) });
        }
      }
      const c = controls?.getBoundingClientRect();
      return {
        items: items.map((x) => x.id),
        issues,
        viewport: { w: vw, h: vh },
        band: { top: Math.round(top), bottom: Math.round(bottom) },
        table: { top: Math.round(s.top), bottom: Math.round(s.bottom), left: Math.round(s.left), right: Math.round(s.right) },
        controls: c ? { top: Math.round(c.top), bottom: Math.round(c.bottom) } : null,
        window: win ? { top: Math.round(win.scrollTop), max: win.scrollHeight - win.clientHeight, view: win.clientHeight } : null,
      } as LayoutReport;
    },
    [scroll, root, windowTo ?? null] as const,
  );
}
