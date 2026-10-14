/**
 * Admin console host (admin.<domain>): serves the built console and forwards
 * only /api/admin/* to the API worker through a service binding, so the admin
 * session cookie stays on the admin origin.
 */
interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) return env.API.fetch(request);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return new Response('not found', { status: 404 });
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('X-Frame-Options', 'DENY');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers });
  },
} satisfies ExportedHandler<Env>;
