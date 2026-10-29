import http from 'node:http';
import type { AdminMonitorEvent } from '@jc/types';
import { BASE, Client } from './client';

export const ADMIN_ORIGIN = 'http://localhost:5174';
const PATH = '/ws/admin/monitor';

/**
 * A control center page's socket (GET /ws/admin/monitor) for tests: the client's console cookie, every event it got,
 * and every frame as it came (to check the text itself for anything private).
 */
export class AdminMonitorSocket {
  ws!: WebSocket;
  events: AdminMonitorEvent[] = [];
  frames: string[] = [];
  hello = false;
  pongs = 0;
  closed: { code: number; reason: string } | null = null;
  private listeners: (() => void)[] = [];

  /**
   * Resolves once the hub said hello; `refused` resolves on open instead (for a socket the hub accepts only to close).
   * `headers`: more request headers, as a page cannot send but a crafted client can.
   */
  static async open(client: Client, opts: { origin?: string; refused?: boolean; headers?: Record<string, string> } = {}) {
    const s = new AdminMonitorSocket();
    const url = `${BASE().replace(/^http/, 'ws')}${PATH}`;
    s.ws = new (WebSocket as unknown as new (u: string, init: unknown) => WebSocket)(url, { headers: { ...opts.headers, Cookie: client.cookieHeader(), Origin: opts.origin ?? ADMIN_ORIGIN } });
    s.ws.addEventListener('message', (ev) => {
      const raw = String(ev.data);
      s.frames.push(raw);
      const f = JSON.parse(raw) as { t: string; e?: AdminMonitorEvent };
      if (f.t === 'hello') s.hello = true;
      if (f.t === 'pong') s.pongs++;
      if (f.t === 'event' && f.e) s.events.push(f.e);
      for (const l of [...s.listeners]) l();
    });
    s.ws.addEventListener('close', (ev) => {
      s.closed = { code: ev.code, reason: ev.reason };
      for (const l of [...s.listeners]) l();
    });
    await new Promise<void>((res, rej) => {
      s.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
      s.ws.addEventListener('open', () => res(), { once: true });
    });
    if (opts.refused) return s;
    await s.until(() => s.hello || !!s.closed, 15_000, 'hello');
    if (!s.hello) throw new Error(`console socket closed before hello: ${JSON.stringify(s.closed)}`);
    return s;
  }

  send(frame: unknown) {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Follows these rooms' summaries (the page asks the rooms with `follow` too); applied once the ping after it is answered. */
  async watch(tables: string[]) {
    this.send({ t: 'watch', tables });
    await this.ping();
  }

  /** A ping and its pong (answered by the hub without waking it). */
  async ping(ms = 10_000) {
    const want = this.pongs + 1;
    this.ws.send('{"t":"ping"}');
    await this.until(() => this.pongs >= want, ms, 'pong');
  }

  until(pred: () => boolean, ms = 15_000, label = 'condition'): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        this.listeners.splice(this.listeners.indexOf(check), 1);
        clearTimeout(h);
        resolve();
      };
      const h = setTimeout(() => {
        this.listeners.splice(this.listeners.indexOf(check), 1);
        reject(new Error(`timeout waiting for ${label}; events: ${JSON.stringify(this.events.map((e) => e.type))} closed: ${JSON.stringify(this.closed)}`));
      }, ms);
      this.listeners.push(check);
    });
  }

  /** The first event of this type (already received or the next one) that `pred` accepts. */
  async event<T extends AdminMonitorEvent['type']>(type: T, ms = 15_000, pred: (e: Extract<AdminMonitorEvent, { type: T }>) => boolean = () => true) {
    const find = () => this.events.find((e): e is Extract<AdminMonitorEvent, { type: T }> => e.type === type && pred(e as Extract<AdminMonitorEvent, { type: T }>));
    await this.until(() => !!find(), ms, type);
    return find()!;
  }

  /** A close the hub starts reaches this client about ten seconds later under wrangler dev (tests/support/realtime.ts). */
  waitClose(ms = 30_000): Promise<number> {
    return this.until(() => !!this.closed, ms, 'close').then(() => this.closed!.code);
  }

  close() {
    if (!this.closed) this.ws.close(1000);
  }
}

/** The status the api answers a console socket handshake with, 101 when it opens (fetch() forbids the Upgrade header). */
export function monitorHandshake(client: Client, origin: string | null = ADMIN_ORIGIN): Promise<number> {
  const u = new URL(`${BASE()}${PATH}`);
  const headers: Record<string, string> = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
  if (origin) headers.Origin = origin;
  if (client.cookies.size) headers.Cookie = client.cookieHeader();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}
