/**
 * A page's "← back" link. Opened from a page that passed `state.from` (one this page accepts), it goes back there;
 * while that page is the one behind in the history, it is the browser's back, so the page returns as it was (its
 * filters, how far down it was). Opened any other way (a shared address, a new tab), it goes to `fallback`.
 */
import type { MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

/** A hand's own page, as `state.from` names it. */
export const HAND_PAGE = /^\/me\/hands\/[^/?#]+$/;

export function useBack(accept: RegExp, fallback: string) {
  const { state } = useLocation();
  const nav = useNavigate();
  const raw = (state as { from?: unknown } | null)?.from;
  const from = typeof raw === 'string' && accept.test(raw) ? raw : null;
  const onClick = (e: MouseEvent) => {
    if (!from || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) < 1) return;
    e.preventDefault();
    void nav(-1);
  };
  return { to: from ?? fallback, from, onClick };
}
