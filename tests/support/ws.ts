import type { ServerMessage, TableView } from '@jc/types';
import { BASE, Client, WEB_ORIGIN } from './client';

/** Table socket for tests: authenticated with the client's session cookie, records every message. */
export class TableSocket {
  ws!: WebSocket;
  messages: ServerMessage[] = [];
  state: TableView | null = null;
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  static async open(client: Client, tableId: string, opts: { code?: string; base?: string } = {}) {
    const s = new TableSocket();
    const base = (opts.base ?? BASE()).replace(/^http/, 'ws');
    const url = `${base}/ws/tables/${tableId}${opts.code ? `?code=${encodeURIComponent(opts.code)}` : ''}`;
    // undici's WebSocket accepts headers as a (non-standard) init option.
    s.ws = new (WebSocket as unknown as new (u: string, init: unknown) => WebSocket)(url, { headers: { Cookie: client.cookieHeader(), Origin: WEB_ORIGIN } });
    s.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      s.messages.push(m);
      if (m.t === 'state') s.state = m.state;
      for (const w of [...s.waiters]) {
        if (w.pred(m)) {
          s.waiters.splice(s.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    s.ws.addEventListener('close', (ev) => (s.closed = { code: ev.code, reason: ev.reason }));
    await new Promise<void>((res, rej) => {
      s.ws.addEventListener('open', () => res(), { once: true });
      s.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
    await s.waitState(() => true);
    return s;
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  wait(pred: (m: ServerMessage) => boolean, ms = 15_000, label = 'message'): Promise<ServerMessage> {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${label}; last state: ${JSON.stringify(this.state?.hand ?? null)?.slice(0, 400)}`));
        }
      }, ms);
    });
  }

  /** Wait for a state message (current or future) satisfying pred. */
  async waitState(pred: (s: TableView) => boolean, ms = 15_000, label = 'state'): Promise<TableView> {
    if (this.state && pred(this.state)) return this.state;
    const m = await this.waitNext((x) => x.t === 'state' && pred(x.state), ms, label);
    return (m as Extract<ServerMessage, { t: 'state' }>).state;
  }

  /** Like wait() but ignores already-received messages. */
  waitNext(pred: (m: ServerMessage) => boolean, ms = 15_000, label = 'message'): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${label}; last hand: ${JSON.stringify(this.state?.hand ?? null)?.slice(0, 400)}`));
        }
      }, ms);
    });
  }

  /** Send a request carrying reqId and resolve with its ack or error. */
  async request(msg: Record<string, unknown> & { t: string }): Promise<ServerMessage> {
    const reqId = `r-${Math.random().toString(36).slice(2, 12)}`;
    const p = this.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === reqId, 15_000, `ack ${msg.t}`);
    this.send({ ...msg, reqId });
    return p;
  }

  async act(type: string, amount?: number) {
    const h = this.state!.hand!;
    const intentId = `i-${Math.random().toString(36).slice(2, 12)}`;
    const p = this.waitNext((m) => (m.t === 'state' && m.state.hand?.seq !== h.seq) || (m.t === 'error' && m.reqId === intentId), 15_000, `act ${type}`);
    this.send({ t: 'action', intentId, handId: h.id, seq: h.seq, type, amount });
    return { result: await p, intentId, seq: h.seq, handId: h.id };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export const isMyTurn = (s: TableView) => !!s.hand && s.you.seatIndex !== null && s.hand.actorSeat === s.you.seatIndex && s.you.legal.length > 0;
