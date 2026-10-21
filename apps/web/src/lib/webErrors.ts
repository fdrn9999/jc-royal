/**
 * Errors this page ran into, counted for the admin dashboard (POST /api/me/web-error, `web_error`). Only that one
 * happened is sent: no message, page or stack. A page sends a few at most, one at a time and not more often than
 * GAP_MS, so an error repeating in a loop costs nothing; a visitor not signed in is refused and nothing is counted.
 */
const MAX_PER_PAGE = 3;
const GAP_MS = 30_000;
let sent = 0;
let last = -Infinity;

export function reportWebError() {
  const now = performance.now();
  if (sent >= MAX_PER_PAGE || now - last < GAP_MS) return;
  sent += 1;
  last = now;
  fetch('/api/me/web-error', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
}

/** Not errors of the page: a request or a sound it gave up on, a sound the browser would not play without a tap. */
const benign = (e: unknown) => e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError');

/** Counts script errors and promises nobody handled from here on. */
export function watchWebErrors() {
  window.addEventListener('error', (e) => {
    // A script of another origin (an extension) reports nothing but "Script error.": not this page's.
    if (e.error !== undefined && e.error !== null) reportWebError();
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (!benign(e.reason)) reportWebError();
  });
}
