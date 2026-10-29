/**
 * Admin console host (admin.<domain>): serves the built console and forwards
 * only /api/admin/* to the API worker through a service binding, so the admin
 * session cookie stays on the admin origin. Of the sockets, only the control
 * center's (/ws/admin/monitor, exactly) is forwarded, with its upgrade: the API
 * checks the console sign-in and origin there. Every other /ws/ path, the game's
 * and the member pages' included, is not served here.
 */
const MONITOR_SOCKET = '/ws/admin/monitor';

interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) return env.API.fetch(request);
    if (url.pathname === MONITOR_SOCKET) return env.API.fetch(request);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return new Response('not found', { status: 404 });
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('X-Frame-Options', 'DENY');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers });
  },
} satisfies ExportedHandler<Env>;
