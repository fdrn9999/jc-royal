// The console host (worker/index.ts): what it forwards to the api through the service binding. Only the console's own
// routes and the control center's socket, exactly; the game's and the member pages' sockets are not served here.
import { describe, expect, it } from 'vitest';
import worker from '../worker/index';

function host() {
  const seen: string[] = [];
  const binding = (name: string) => ({
    fetch: async (r: Request) => {
      seen.push(`${name} ${new URL(r.url).pathname} ${r.headers.get('upgrade') ?? ''}`.trim());
      return new Response(name);
    },
  });
  const env = { API: binding('api'), ASSETS: binding('assets') } as never;
  const get = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://admin.example${path}`, { headers }), env);
  return { seen, get };
}

describe('the console host', () => {
  it('forwards the console routes and the control center socket, with its upgrade', async () => {
    const { seen, get } = host();
    expect(await (await get('/api/admin/monitor/tables')).text()).toBe('api');
    expect(await (await get('/ws/admin/monitor', { Upgrade: 'websocket' })).text()).toBe('api');
    expect(seen).toEqual(['api /api/admin/monitor/tables', 'api /ws/admin/monitor websocket']);
  });

  it('serves no other socket or api path', async () => {
    const { seen, get } = host();
    for (const path of ['/ws/realtime', '/ws/tables/t1', '/ws/admin/monitor/', '/ws/admin/monitorx', '/ws/admin', '/api/tables', '/api/auth/me']) {
      const res = await get(path, { Upgrade: 'websocket' });
      expect(res.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('serves the built console with its framing and indexing headers', async () => {
    const { seen, get } = host();
    const res = await get('/control-center');
    expect(await res.text()).toBe('assets');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(seen).toEqual(['assets /control-center']);
  });
});
