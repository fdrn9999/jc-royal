import type { RealtimeEvent, RealtimeTopic } from '@jc/types';
import { BASE, Client, WEB_ORIGIN } from './client';

/** A page's realtime socket (GET /ws/realtime) for tests: the client's session cookie, every event it got. */
export class RealtimeSocket {
  ws!: WebSocket;
  events: RealtimeEvent[] = [];
  hello = false;
  pongs = 0;
  closed: { code: number; reason: string } | null = null;
  private listeners: (() => void)[] = [];

  /** Resolves once the hub said hello; `refused` resolves on the first close instead (for a socket the hub turns away). */
  static async open(client: Client, opts: { origin?: string; base?: string; topics?: RealtimeTopic[]; refused?: boolean } = {}) {
    const s = new RealtimeSocket();
    const url = `${(opts.base ?? BASE()).replace(/^http/, 'ws')}/ws/realtime`;
    s.ws = new (WebSocket as unknown as new (u: string, init: unknown) => WebSocket)(url, { headers: { Cookie: client.cookieHeader(), Origin: opts.origin ?? WEB_ORIGIN } });
    s.ws.addEventListener('message', (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; e?: RealtimeEvent };
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
    if (!s.hello) throw new Error(`realtime socket closed before hello: ${JSON.stringify(s.closed)}`);
    if (opts.topics) {
      s.send({ t: 'sub', topics: opts.topics });
      // the hub reads frames in order: a ping answered after the sub means the sub was applied
      await s.ping();
    }
    return s;
  }

  send(frame: unknown) {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
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

  /** The first event of this type (already received or the next one). */
  async event<T extends RealtimeEvent['type']>(type: T, ms = 15_000, pred: (e: Extract<RealtimeEvent, { type: T }>) => boolean = () => true) {
    const find = () => this.events.find((e): e is Extract<RealtimeEvent, { type: T }> => e.type === type && pred(e as Extract<RealtimeEvent, { type: T }>));
    await this.until(() => !!find(), ms, type);
    return find()!;
  }

  /**
   * A close the hub starts reaches this client about ten seconds later under wrangler dev (measured: 10.1 s, the same for
   * a table room's socket; a close the client starts takes milliseconds), so the wait leaves room for that and a busy run.
   */
  waitClose(ms = 30_000): Promise<number> {
    return this.until(() => !!this.closed, ms, 'close').then(() => this.closed!.code);
  }

  close() {
    if (!this.closed) this.ws.close(1000);
  }
}
