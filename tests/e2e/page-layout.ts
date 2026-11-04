import type { Page } from '@playwright/test';

/** One thing wrong with a screen as drawn (viewports.spec.ts). */
export interface PageIssue {
  kind: 'hscroll' | 'offscreen' | 'cut' | 'covered' | 'overlap' | 'small' | 'sheet';
  /** The element, by its test id, label or first words (with the nearest test id round it). */
  what: string;
  how: string;
}

export interface PageReport {
  issues: PageIssue[];
  /** Text cut short on purpose, with an ellipsis or a line clamp (a long name): not an issue, listed for the report. */
  shortened: string[];
  /** The controls looked at. */
  controls: number;
  /** The open dialog's panel as drawn, and whether it scrolls inside. */
  sheet: { left: number; top: number; right: number; bottom: number; scrolls: boolean } | null;
}

/**
 * A screen as drawn, at its scroll position (`at`: the page scrolled to its top or to its foot), looked at the same way on
 * every page. Inside an open modal dialog if there is one (what is behind it cannot be used), else the whole page:
 * - `hscroll`: the page is wider than the screen.
 * - `offscreen`: a control or a line of text partly or wholly past the screen's sides (not in a box that scrolls
 *   sideways, nor clipped out of sight), or a control in something fixed that lies past the screen's top or foot (it
 *   cannot be scrolled to).
 * - `cut`: text partly cut off by a box round it that clips and does not scroll. Cut with an ellipsis or a line clamp, it
 *   is shortened on purpose (`shortened`). The room a line's glyphs take beyond its line height is not counted.
 * - `covered`: something else takes the tap at the middle, or a quarter in from a corner, of a control's part in sight.
 *   Under a bar fixed at the top that matters only with the page at its top, under one at the foot only with it at its
 *   foot: otherwise the control can be scrolled out.
 * - `overlap`: two controls (neither inside the other, in the same fixed bar or both in the page) overlap in their hit
 *   areas in sight (one scrolled half out of a strip is not over what is beside the strip). A control inside the
 *   padding a text field leaves for it (a password's show button in the field's right padding) is placed there, not
 *   over it, nor does it cover the field. Also two lines of different text drawn on each other (in the same fixed bar
 *   or both in the page), unless what is drawn on top has a background that hides the other where they meet: told on
 *   the screen only, as `covered` is.
 * - `small` (`touch` only): a control less than 40 px either way (the app's `min-h-10`), its hit area counted with
 *   what a `::before` or `::after` adds round it, a check box or a radio by its label. A link inside a sentence is not
 *   counted (WCAG 2.5.8's inline exception), nor a disabled control.
 * - `sheet`: the open dialog's panel is not inside the screen, or its content is taller and it does not scroll.
 */
export function measurePage(page: Page, opts: { width: number; height: number; touch: boolean; at: 'top' | 'bottom' }): Promise<PageReport> {
  return page.evaluate(({ W, H, touch, at }) => {
    const issues: { kind: string; what: string; how: string }[] = [];
    const shortened: string[] = [];
    const px = (v: number) => Math.round(v);
    const words = (e: Element) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    const name = (e: Element) => {
      const own = e.getAttribute('data-testid') ?? (words(e) || e.tagName.toLowerCase());
      const near = e.parentElement?.closest('[data-testid]')?.getAttribute('data-testid');
      return near && near !== own ? `${near} › ${own}` : own;
    };
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      // Laid out but not drawn: a closed <details>' body (content-visibility: hidden) has boxes that run on past the
      // summary over what follows. The sweep opens such a box where it matters and looks at it drawn.
      if (!e.checkVisibility()) return false;
      for (let a: Element | null = e; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        // sr-only: what only a screen reader hears.
        if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') return false;
        if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) return false;
      }
      return true;
    };
    const scrolls = (a: Element, axis: 'x' | 'y') => {
      const s = getComputedStyle(a);
      const o = axis === 'x' ? s.overflowX : s.overflowY;
      return (o === 'auto' || o === 'scroll') && (axis === 'x' ? a.scrollWidth > a.clientWidth + 1 : a.scrollHeight > a.clientHeight + 1);
    };
    const scroller = (e: Element, axis: 'x' | 'y') => {
      for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (scrolls(a, axis)) return a;
      return null;
    };
    const fixedOf = (e: Element) => {
      for (let a: Element | null = e; a; a = a.parentElement) {
        const p = getComputedStyle(a).position;
        if (p === 'fixed' || p === 'sticky') return a;
      }
      return null;
    };
    /** Whether a box round it that clips leaves it wholly out of sight (a closed drawer, a slid-away panel). */
    const clippedAway = (e: Element, r: DOMRect) => {
      for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const b = a.getBoundingClientRect();
        if (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) return true;
      }
      return false;
    };

    type Box = { left: number; right: number; top: number; bottom: number };
    /**
     * The boxes from `from` out that clip up to the page, for a rect `r` it draws (`spare`: glyph room above and below a
     * line not counted): the first that cuts it partly, how much of it is left in sight, and whether it lies in a box that
     * scrolls sideways or up and down. What is scrolled out of a box that scrolls is not cut; what is left of it in sight
     * (at most the box) is still cut by a box further out that clips.
     */
    const clipping = (from: Element | null, r: Box, spare = 0) => {
      const seen = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      let sideways = false;
      let upright = false;
      let cut: { by: Element; x: boolean } | null = null;
      for (let a = from; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        // A box that scrolls clips too (what is scrolled out of it is out of sight), but nothing in it is cut off. One set
        // to scroll whose content fits does not scroll: what is past it is past a box that clips.
        const clipsX = s.overflowX === 'hidden' || s.overflowX === 'clip';
        const clipsY = s.overflowY === 'hidden' || s.overflowY === 'clip';
        const hidesX = s.overflowX !== 'visible';
        const hidesY = s.overflowY !== 'visible';
        if (scrolls(a, 'x')) sideways = true;
        if (scrolls(a, 'y')) upright = true;
        if (!hidesX && !hidesY) continue;
        const b = a.getBoundingClientRect();
        const partX = clipsX && (seen.left < b.left - 1 || seen.right > b.right + 1);
        const partY = clipsY && (seen.top + spare < b.top - 1 || seen.bottom - spare > b.bottom + 1);
        if (!cut && (partX || partY)) cut = { by: a, x: partX };
        if (hidesX) Object.assign(seen, { left: Math.max(seen.left, b.left), right: Math.min(seen.right, b.right) });
        if (hidesY) Object.assign(seen, { top: Math.max(seen.top, b.top), bottom: Math.min(seen.bottom, b.bottom) });
      }
      return { seen, sideways, upright, cut };
    };
    const shortenedOnPurpose = (el: Element, by: Element) => {
      const clamp = (getComputedStyle(by) as unknown as { webkitLineClamp?: string }).webkitLineClamp;
      return getComputedStyle(el).textOverflow === 'ellipsis' || getComputedStyle(by).textOverflow === 'ellipsis' || (!!clamp && clamp !== 'none');
    };

    const width = document.documentElement.scrollWidth;
    if (width > W + 1) issues.push({ kind: 'hscroll', what: 'page', how: `${width} > ${W}` });

    const dialogs = Array.from(document.querySelectorAll('[role=dialog][aria-modal=true]')).filter(shown);
    const root = dialogs.at(-1) ?? document.body;

    const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, label, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=link], [role=option]';
    const controls = Array.from(root.querySelectorAll(SEL)).filter((e) => {
      if (!shown(e)) return false;
      if ((e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true') return false;
      // A label counts only as a hidden check box's or radio's face; a shown one is measured by its label below.
      if (e.tagName === 'LABEL') {
        const box = e.querySelector('input[type=checkbox], input[type=radio]');
        return !!box && !shown(box);
      }
      return !clippedAway(e, e.getBoundingClientRect());
    });
    const rects = controls.map((e) => e.getBoundingClientRect());
    const bars = controls.map(fixedOf);

    /** Where a tap lands on it: its box, a check box or radio by its label, and what a positioned ::before/::after adds. */
    const target = (e: Element): Box & { el: Element } => {
      const label = e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio') ? (e.labels?.[0] ?? null) : null;
      const el = label ?? e;
      const r = el.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (const p of ['::before', '::after']) {
        const s = getComputedStyle(el, p);
        if (s.content === 'none' || s.content === 'normal' || s.position !== 'absolute') continue;
        const v = (x: string) => (x.endsWith('px') ? parseFloat(x) : NaN);
        if (!isNaN(v(s.top))) top = Math.min(top, r.top + v(s.top));
        if (!isNaN(v(s.bottom))) bottom = Math.max(bottom, r.bottom - v(s.bottom));
        if (!isNaN(v(s.left))) left = Math.min(left, r.left + v(s.left));
        if (!isNaN(v(s.right))) right = Math.max(right, r.right - v(s.right));
      }
      return { el, left, top, right, bottom };
    };
    /** A link inside a sentence (WCAG 2.5.8's inline exception). */
    const inline = (e: Element) => e.tagName === 'A' && getComputedStyle(e).display === 'inline' && (e.parentElement?.textContent ?? '').trim().length > (e.textContent ?? '').trim().length;

    /** Whether `o` lies in the padding a text field `field` (drawn at `r`) leaves beside its text. */
    const inPadding = (field: Element, r: DOMRect, o: { left: number; right: number }) => {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return false;
      const s = getComputedStyle(field);
      const textLeft = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
      const textRight = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
      return o.left >= textRight - 1 || o.right <= textLeft + 1;
    };
    const visible: Box[] = [];
    /** Each control's hit area (`target`) as far as it is in sight, and the element that takes the tap. */
    const hits: (Box & { el: Element })[] = [];

    controls.forEach((e, i) => {
      const r = rects[i]!;
      const c = clipping(e.parentElement, r);
      visible[i] = c.seen;
      const t = target(e);
      hits[i] = { el: t.el, ...clipping(t.el.parentElement, t).seen };
      if (c.cut && !shortenedOnPurpose(e, c.cut.by)) {
        const b = c.cut.by.getBoundingClientRect();
        issues.push({ kind: 'cut', what: name(e), how: `by ${name(c.cut.by)} ${c.cut.x ? `x ${px(r.left)}–${px(r.right)} of ${px(b.left)}–${px(b.right)}` : `y ${px(r.top)}–${px(r.bottom)} of ${px(b.top)}–${px(b.bottom)}`}` });
      }
      if ((c.seen.left < -1 || c.seen.right > W + 1) && !c.sideways) issues.push({ kind: 'offscreen', what: name(e), how: `x ${px(c.seen.left)}–${px(c.seen.right)} of ${W}` });
      const f = bars[i];
      if (f && getComputedStyle(f).position === 'fixed' && (r.bottom > H + 1 || r.top < -1) && !scroller(e, 'y')) issues.push({ kind: 'offscreen', what: name(e), how: `y ${px(r.top)}–${px(r.bottom)} of ${H}` });
      if (touch && !inline(e)) {
        const w = t.right - t.left;
        const h = t.bottom - t.top;
        if (w < 39.5 || h < 39.5) issues.push({ kind: 'small', what: name(e), how: `${px(w)}×${px(h)}` });
      }
      // Tapped where it is in sight: one partly scrolled out of a box is tapped on what is left of it, or scrolled to. Its
      // middle and four points a quarter in from its corners (inside a round button), so an edge covered counts too.
      const at4 = (f: number, g: number) => [c.seen.left + (c.seen.right - c.seen.left) * f, c.seen.top + (c.seen.bottom - c.seen.top) * g] as const;
      for (const [cx, cy] of [at4(0.5, 0.5), at4(0.25, 0.25), at4(0.75, 0.25), at4(0.25, 0.75), at4(0.75, 0.75)]) {
        if (!(cx >= 0 && cx < W && cy >= 0 && cy < H)) continue;
        const hit = document.elementFromPoint(cx, cy);
        const labels = (e as HTMLInputElement).labels ? Array.from((e as HTMLInputElement).labels!) : [];
        const own = hit && (e.contains(hit) || hit.contains(e) || labels.some((l) => l.contains(hit)));
        const over = hit && !own ? hit.closest(SEL) : null;
        if (over && inPadding(e, r, over.getBoundingClientRect())) continue;
        if (hit && !own) {
          const bar = fixedOf(hit);
          let counts = true;
          if (bar && !bar.contains(e)) {
            const b = bar.getBoundingClientRect();
            const top = (b.top + b.bottom) / 2 < H / 2;
            counts = top ? at === 'top' : at === 'bottom';
          }
          if (counts) {
            issues.push({ kind: 'covered', what: name(e), how: `under ${name(hit)} at ${px(cx)},${px(cy)}` });
            break;
          }
        }
      }
    });
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]!;
        const b = controls[j]!;
        if (bars[i] !== bars[j] || a.contains(b) || b.contains(a)) continue;
        // Their hit areas: two drawn apart whose widened areas meet still share a spot. A check box's label holding a
        // control is where that control is.
        const ra = hits[i]!;
        const rb = hits[j]!;
        if (ra.el.contains(b) || rb.el.contains(a)) continue;
        if (inPadding(a, rects[i]!, rb) || inPadding(b, rects[j]!, ra)) continue;
        const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (x > 2 && y > 2) issues.push({ kind: 'overlap', what: `${name(a)} / ${name(b)}`, how: `${px(x)}×${px(y)}` });
      }

    // Each line of text: past the screen's sides, or partly cut off by a box round it that clips.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const range = document.createRange();
    const seen = new Set<string>();
    /** Each line's glyphs as far as they are in sight, for the text drawn on other text below. */
    const texts: { node: Node; el: Element; bar: Element | null; box: Box }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !shown(el)) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || clippedAway(el, r)) continue;
      const text = (n.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
      const t = getComputedStyle(el);
      // A line's glyph box is taller than its line height when the line height is tight (leading-none): that much
      // above and below the box is not the glyphs, and not counted as cut.
      const size = parseFloat(t.fontSize);
      const line = t.lineHeight === 'normal' ? size * 1.2 : parseFloat(t.lineHeight);
      const lines = Math.max(1, Math.round(r.height / Math.max(line, 1)));
      const spare = Math.max(0, (r.height - lines * line) / 2);
      // The text's own element clips it too (an ellipsis is set on the element that holds the text).
      const c = clipping(el, r, spare);
      if (c.cut) {
        const key = `${name(el)}|${name(c.cut.by)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const b = c.cut.by.getBoundingClientRect();
          if (shortenedOnPurpose(el, c.cut.by)) shortened.push(`${name(el)}: ${text}`);
          else issues.push({ kind: 'cut', what: `${name(el)}: ${text}`, how: `by ${name(c.cut.by)} ${c.cut.x ? `x ${px(r.left)}–${px(r.right)} of ${px(b.left)}–${px(b.right)}` : `y ${px(r.top)}–${px(r.bottom)} of ${px(b.top)}–${px(b.bottom)}`}` });
        }
      }
      // What is left in sight after the clipping, past the screen's sides (a strip that scrolls sideways may).
      if (!c.sideways && (c.seen.left < -1 || c.seen.right > W + 1) && !seen.has(`${name(el)}|screen`)) {
        seen.add(`${name(el)}|screen`);
        issues.push({ kind: 'offscreen', what: `${name(el)}: ${text}`, how: `x ${px(c.seen.left)}–${px(c.seen.right)} of ${W}` });
      }
      const bar = fixedOf(el);
      for (const l of Array.from(range.getClientRects())) {
        const sp = Math.max(0, (l.height - line) / 2);
        const box = { left: Math.max(l.left, c.seen.left), right: Math.min(l.right, c.seen.right), top: Math.max(l.top + sp, c.seen.top), bottom: Math.min(l.bottom - sp, c.seen.bottom) };
        if (box.right - box.left > 1 && box.bottom - box.top > 1) texts.push({ node: n, el, bar, box });
      }
    }

    /** A colour's alpha as getComputedStyle gives it: rgb(), rgba(), or a space-separated colour with `/ alpha`. */
    const alpha = (v: string) => {
      if (v === 'transparent') return 0;
      const slash = v.match(/\/\s*([\d.]+)(%?)\s*\)$/);
      if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1);
      const rgba = v.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
      return rgba ? parseFloat(rgba[1]!) : 1;
    };
    /** Something from `e` out to `upTo` (not counted) with a background that hides what is under it at x, y. */
    const hides = (e: Element, upTo: Element, x: number, y: number) => {
      for (let a: Element | null = e; a && a !== upTo; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.backgroundImage === 'none' && alpha(s.backgroundColor) < 0.85) continue;
        const b = a.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
      }
      return false;
    };
    const common = (a: Element, b: Element) => {
      let c: Element | null = a;
      while (c && !c.contains(b)) c = c.parentElement;
      return c ?? document.documentElement;
    };
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i]!;
        const b = texts[j]!;
        if (a.node === b.node || a.bar !== b.bar) continue;
        const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (!(x > 2 && y > 2)) continue;
        const key = `${name(a.el)}|${name(b.el)}|text`;
        if (seen.has(key)) continue;
        const cx = Math.max(a.box.left, b.box.left) + x / 2;
        const cy = Math.max(a.box.top, b.box.top) + y / 2;
        const ca = common(a.el, b.el);
        const hidA = hides(a.el, ca, cx, cy);
        const hidB = hides(b.el, ca, cx, cy);
        // Neither has a background there: both are seen, whichever is on top. Else the one on top (the first of the two
        // hit there, on the screen only) hides the other if it has one; something else on top of both hides them both.
        if (hidA || hidB) {
          if (!(cx >= 0 && cx < W && cy >= 0 && cy < H)) continue;
          const stack = document.elementsFromPoint(cx, cy);
          const first = stack.find((h) => h === ca || !ca.contains(h) || h.contains(a.el) || a.el.contains(h) || h.contains(b.el) || b.el.contains(h));
          if (!first || first === ca || !ca.contains(first)) continue;
          const topA = first.contains(a.el) || a.el.contains(first);
          if (topA ? hidA : hidB) continue;
        }
        seen.add(key);
        issues.push({ kind: 'overlap', what: `text ${name(a.el)} / ${name(b.el)}`, how: `${px(x)}×${px(y)} at ${px(cx)},${px(cy)}` });
      }

    let sheet = null as { left: number; top: number; right: number; bottom: number; scrolls: boolean } | null;
    if (root !== document.body) {
      // The dialog's panel: its smallest shown child (the rest is the backdrop), or the dialog itself.
      const kids = Array.from(root.children).filter(shown);
      const area = (e: Element) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
      const panel = kids.length > 1 ? kids.sort((a, b) => area(a) - area(b))[0]! : root;
      const p = panel.getBoundingClientRect();
      const inner = [panel, ...Array.from(panel.querySelectorAll('*'))].some((e) => scrolls(e, 'y'));
      sheet = { left: px(p.left), top: px(p.top), right: px(p.right), bottom: px(p.bottom), scrolls: inner };
      if (p.left < -0.5 || p.right > W + 0.5 || p.top < -0.5 || p.bottom > H + 0.5) issues.push({ kind: 'sheet', what: name(panel), how: `${px(p.left)},${px(p.top)}–${px(p.right)},${px(p.bottom)} of ${W}×${H}` });
      const s = getComputedStyle(panel);
      if (panel.scrollHeight > panel.clientHeight + 1 && !inner && s.overflowY !== 'visible') issues.push({ kind: 'sheet', what: name(panel), how: `content ${panel.scrollHeight} in ${panel.clientHeight}, no scroll` });
    }
    return { issues, shortened, controls: controls.length, sheet };
  },{ W: opts.width, H: opts.height, touch: opts.touch, at: opts.at }) as Promise<PageReport>;
}
