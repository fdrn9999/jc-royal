import type { SwNavigateMessage, SwNavigateReply } from '@jc/types';

/**
 * A tapped push's page, opened in this window when the service worker asks (public/sw.js). Listening from the moment
 * the app starts, so a tap that brought this window forward is not missed while the rest loads, and answering on the
 * message's port: the worker takes the window there itself when no page answers. A game table is never left this way
 * (the member may be in a hand): the push stays shown for later.
 */
export function followPushTaps(navigate: (url: string) => void): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<SwNavigateMessage>) => {
    if (e.data?.type !== 'jc-navigate') return;
    const url = e.data.url;
    const reply = (r: SwNavigateReply) => e.ports?.[0]?.postMessage(r);
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\') || location.pathname.startsWith('/table/')) {
      reply({ ok: false });
      return;
    }
    navigate(url);
    reply({ ok: true });
  });
}
