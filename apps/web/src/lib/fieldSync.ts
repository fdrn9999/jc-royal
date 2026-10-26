import { useEffect, useRef, type RefObject } from 'react';

/** How often fields are read again while the page is in front, for values that arrived with no event at all. */
export const FIELD_POLL_MS = 700;

/**
 * Calls `read` whenever the fields under `root` may hold something React was not told about, so `read` can take the
 * values from the page itself. The fields stay uncontrolled: a value an in-app browser, password manager or date picker
 * put in without the input event React listens for (autofill setting `.value`, a picker that only blurs, WKWebView
 * skipping `change`) is then still seen, and no re-render writes over it with an empty state.
 *
 * Read on: every input/change/blur/composition end under `root`, any tap or key on the page (before a click submits),
 * coming back to the page (pageshow, tab or app switch), and a light poll while the page is visible.
 */
export function useFieldSync(root: RefObject<HTMLElement | null>, read: () => void) {
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const run = () => latest.current();
    const own = ['input', 'change', 'focusout', 'compositionend', 'keyup'] as const;
    const page = ['pointerdown', 'keydown'] as const;
    for (const t of own) el.addEventListener(t, run, true);
    for (const t of page) document.addEventListener(t, run, true);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('pageshow', run);
    window.addEventListener('focus', run);
    const poll = setInterval(() => document.visibilityState === 'visible' && run(), FIELD_POLL_MS);
    run();
    return () => {
      for (const t of own) el.removeEventListener(t, run, true);
      for (const t of page) document.removeEventListener(t, run, true);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('pageshow', run);
      window.removeEventListener('focus', run);
      clearInterval(poll);
    };
  }, [root]);
}
