/**
 * A stand-in for the push services (FCM, Mozilla, Apple), on 127.0.0.1 only: the test worker sends its pushes here
 * (PUSH_SINK_URL, honoured outside production only) with the push service's address in `x-push-endpoint`, and the
 * tests read back what arrived. The answer follows the subscription's last path segment, so a test picks how the
 * "push service" behaves: `gone-…` 410, `busy-…` 503, `bad-…` 400, anything else 201.
 */
import { createServer, type Server } from 'node:http';

export interface SinkRecord {
  endpoint: string;
  headers: Record<string, string>;
  /** The aes128gcm body, base64. */
  body: string;
  status: number;
  at: number;
}

export interface PushSink {
  url: string;
  close(): Promise<void>;
}

const KEPT_HEADERS = ['authorization', 'content-encoding', 'content-type', 'ttl', 'urgency', 'topic'];

export async function startPushSink(): Promise<PushSink> {
  const records: SinkRecord[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/received') {
      const endpoint = url.searchParams.get('endpoint');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(records.filter((r) => r.endpoint === endpoint)));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/push') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const endpoint = String(req.headers['x-push-endpoint'] ?? '');
      const last = endpoint.split('/').pop() ?? '';
      const status = last.startsWith('gone-') ? 410 : last.startsWith('busy-') ? 503 : last.startsWith('bad-') ? 400 : 201;
      const headers: Record<string, string> = {};
      for (const h of KEPT_HEADERS) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h] as string;
      records.push({ endpoint, headers, body: Buffer.concat(chunks).toString('base64'), status, at: Date.now() });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('push sink did not start');
  return {
    url: `http://127.0.0.1:${addr.port}/push`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
