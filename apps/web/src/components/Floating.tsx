/**
 * A panel opened from a control (a beginner's "?", a bot's style) on the page's top layer: no box round the control (the
 * dock's band of one height, the short screen's column, a seat) clips or scrolls it out of sight, and it is placed in the
 * room the screen has (placeFloating, lib/floating.ts): on the sides asked for, inside the screen less its safe edges and
 * less what is outside `area` (the header over the table), off what it is to keep clear of (`keepClear`: the turn's
 * controls, my cards), its text scrolling inside it where the room is less than it. Its title and close button stay in
 * sight whatever it holds. Not modal: the table goes on under it and focus stays where it was (the turn's shortcuts with
 * it); a tap elsewhere, Escape, or its control going (the raise panel hides it) closes it. Placed again as the screen,
 * the control or what it holds changes, before it is drawn.
 */
import { cx, XIcon } from '@jc/ui';
import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { placeFloating, type Avoid, type Rect, type Side } from '../lib/floating';
import { useI18n } from '../lib/i18n';

export interface KeepClear {
  selector: string;
  /** Per pixel covered (lib/floating.ts): 100 for a control the turn needs, a few for a part of the table. */
  weight: number;
}

/** From the screen's edges (and its safe edges) at the least. */
const EDGE = 8;

let probe: HTMLDivElement | null = null;
/** The screen's safe edges (a notch, a rounded corner, a home bar) as CSS gives them. */
function safeInsets() {
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

/** What of the screen is in sight (less a phone's keyboard, a pinch's zoom), less its safe edges and what `area` leaves out. */
function boundsOf(area: HTMLElement | null | undefined): Rect {
  const vv = window.visualViewport;
  const w = Math.min(document.documentElement.clientWidth || innerWidth, vv ? vv.width : innerWidth);
  const h = vv ? vv.height : innerHeight;
  const x = vv?.offsetLeft ?? 0;
  const y = vv?.offsetTop ?? 0;
  const safe = safeInsets();
  const b = { left: x + Math.max(EDGE, safe.left), top: y + Math.max(EDGE, safe.top), right: x + w - Math.max(EDGE, safe.right), bottom: y + h - Math.max(EDGE, safe.bottom) };
  const a = area?.getBoundingClientRect();
  if (a && a.width > 0 && a.height > 0) {
    b.left = Math.max(b.left, a.left);
    b.top = Math.max(b.top, a.top + EDGE);
    b.right = Math.min(b.right, a.right);
    b.bottom = Math.min(b.bottom, a.bottom);
  }
  return b;
}

export function Floating({
  anchor,
  area,
  title,
  sides,
  keepClear = [],
  width = 352,
  onClose,
  children,
  className,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>;
  /** The part of the page it keeps to (the game's column, under the header); the whole screen without it. */
  area?: RefObject<HTMLElement | null>;
  title: ReactNode;
  sides: Side[];
  keepClear?: KeepClear[];
  /** Its width where the screen has it, in CSS pixels. */
  width?: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Read in the listeners, which are set once.
  const latest = useRef({ onClose, sides, keepClear, width, area });
  latest.current = { onClose, sides, keepClear, width, area };

  useLayoutEffect(() => {
    const el = panel.current;
    const inner = body.current;
    if (!el || !inner) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const a = anchor.current;
      const { sides, keepClear, width, area, onClose } = latest.current;
      const at = a?.getBoundingClientRect();
      // Its control hidden (display: none) or gone: so is it.
      if (!a || !at || (at.width === 0 && at.height === 0)) return onClose();
      const bounds = boundsOf(area?.current);
      const avoid: Avoid[] = [];
      for (const k of keepClear)
        for (const e of Array.from(document.querySelectorAll(k.selector))) {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && !e.contains(a)) avoid.push({ rect: r, weight: k.weight });
        }
      // Its own height at a width, as it would be with room for it all.
      const natural = (w: number) => {
        el.style.width = `${w}px`;
        el.style.height = '';
        return el.offsetHeight - inner.clientHeight + inner.scrollHeight;
      };
      let w = Math.min(width, bounds.right - bounds.left);
      let p = placeFloating(at, { width: w, height: natural(w) }, bounds, sides, avoid);
      // Narrower beside the control than asked for, its text wraps taller: placed once more for that.
      for (let i = 0; i < 2 && Math.abs(p.width - w) > 0.5; i++) {
        w = p.width;
        p = placeFloating(at, { width: w, height: natural(w) }, bounds, sides, avoid);
      }
      el.style.width = `${p.width}px`;
      el.style.height = `${p.height}px`;
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.dataset.side = p.side;
      el.style.visibility = '';
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    if (anchor.current) ro?.observe(anchor.current);
    if (content.current) ro?.observe(content.current);
    const outside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && !el.contains(target) && !anchor.current?.contains(target)) latest.current.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current.onClose();
    };
    addEventListener('resize', soon);
    // A box round the control scrolled moves the control.
    addEventListener('scroll', soon, true);
    window.visualViewport?.addEventListener('resize', soon);
    window.visualViewport?.addEventListener('scroll', soon);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      removeEventListener('resize', soon);
      removeEventListener('scroll', soon, true);
      window.visualViewport?.removeEventListener('resize', soon);
      window.visualViewport?.removeEventListener('scroll', soon);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-labelledby={`${id}-title`}
      // Hidden until placed (in the same frame, before it is drawn).
      style={{ visibility: 'hidden', left: 0, top: 0 }}
      className={cx('jc-panel fixed z-[70] flex flex-col overflow-hidden text-xs shadow-2xl', className)}
      data-testid={testId}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 py-0.5 pl-3 pr-0.5">
        <b id={`${id}-title`} className="min-w-0 text-[13px] text-gold-300">
          {title}
        </b>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="jc-tap grid size-9 shrink-0 place-items-center rounded-full text-ink-300 hover:text-ivory" data-testid={testId ? `${testId}-close` : undefined}>
          <XIcon className="size-4" />
        </button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-scroll>
        <div ref={content} className="p-3">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
