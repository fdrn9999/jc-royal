/**
 * Where a page sits on the window's scroll. A page reached by a link opens at its top: the router changes the page
 * without touching the scroll, so it would open as far down as the last one was. Going back to a list returns to
 * where it was once its rows are there again: they load after it mounts, so the browser's own restore lands on a
 * page that is still short.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Per history entry (the router's key): how far down its page was. */
const positions = new Map<string, number>();
const entryKey = () => (window.history.state as { key?: string } | null)?.key;

/** In the shell: a new page starts at its top. Back and forward are left to the browser and useKeptScroll. */
export function useTopOnNewPage() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    if (type !== 'POP') window.scrollTo(0, 0);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** On a list page: remembers its scroll and, coming back to it, returns there once `ready` (its rows are shown). */
export function useKeptScroll(ready: boolean) {
  const { key } = useLocation();
  const type = useNavigationType();
  const target = useRef(type === 'POP' ? positions.get(key) : undefined);
  useEffect(() => {
    const save = () => {
      // A scroll after leaving (the next page opening at its top) is that page's, not this one's.
      if (entryKey() === key) positions.set(key, window.scrollY);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [key]);
  useLayoutEffect(() => {
    if (!ready || target.current === undefined) return;
    window.scrollTo(0, target.current);
    target.current = undefined;
  }, [ready]);
}
