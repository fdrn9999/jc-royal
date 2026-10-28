import { DurableObject } from 'cloudflare:workers';
import { REALTIME_CLOSE, REALTIME_PROTOCOL, RealtimeClientFrameSchema, RealtimeEventSchema } from '@jc/types';
import type { Env } from './room';
import {
  FRAMES_PER_MIN,
  liveSessionsSql,
  parseIdentity,
  REALTIME_MAX_PER_HUB,
  REALTIME_MAX_PER_USER,
  REVOKE_WINDOW_MS,
  revokes,
  stale,
  SWEEP_CHUNK,
  SWEEP_MS,
  SWEEP_RETRY_MS,
  sweepMsOf,
  wants,
  type RealtimeAttachment,
  type Revoke,
} from './realtime-rules';

/**
 * Platform realtime (docs/REALTIME.md): the sockets of signed-in pages outside the tables, sharded by member
 * (`rt-<realtimeShardOf(userId)>`). The hub keeps no state of its own besides recent sign-outs (and, in local tests, a
 * shorter sweep): it hands an event the api or a table room published to the sockets it is for, and nothing a page
 * sends changes anything but the public topics that page gets. Sockets hibernate between events; the page's ping is
 * answered without waking the hub.
 */

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const SWEEP_KEY = 'sweep-ms';

export class RealtimeHub extends DurableObject<Env> {
  /** Frames each socket sent this minute (memory only: a hub woken from hibernation starts them again). */
  private frames = new Map<WebSocket, { n: number; since: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.INTERNAL_SECRET || request.headers.get('x-jc-internal') !== this.env.INTERNAL_SECRET) return new Response('forbidden', { status: 403 });
    const op = new URL(request.url).pathname;
    if (op === '/connect') return this.open(request);
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body: Record<string, unknown>;
    try {
      const v: unknown = await request.json();
      if (!v || typeof v !== 'object') throw new Error('not an object');
      body = v as Record<string, unknown>;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (op === '/publish') return this.publish(body);
    if (op === '/revoke') return this.revoke(body);
    return new Response('not found', { status: 404 });
  }

  private async open(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
    const identity = parseIdentity(request.headers.get('x-jc-identity'));
    if (!identity) return new Response('bad identity', { status: 400 });
    const now = Date.now();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const refuse = (code: number, reason: string) => {
      // Accepted only to say why; never hibernated or counted.
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    const recent = await this.recentRevokes(identity.userId, now);
    if (recent.some((r) => revokes(r, identity, true))) return refuse(REALTIME_CLOSE.signedOut, 'signed out');
    if (stale(identity, now)) return refuse(REALTIME_CLOSE.reauth, 'reauth');
    const all = this.ctx.getWebSockets();
    if (all.length >= REALTIME_MAX_PER_HUB) return refuse(1013, 'try again later');
    const mine = this.ctx.getWebSockets(`u:${identity.userId}`);
    if (mine.length >= REALTIME_MAX_PER_USER) {
      const oldest = mine
        .map((ws) => ({ ws, at: this.att(ws)?.authAt ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .slice(0, mine.length - REALTIME_MAX_PER_USER + 1);
      for (const { ws } of oldest) this.close(ws, REALTIME_CLOSE.tooMany, 'too many pages');
    }
    const attachment: RealtimeAttachment = { ...identity, topics: [] };
    this.ctx.acceptWebSocket(server, [`u:${identity.userId}`]);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ t: 'hello', v: REALTIME_PROTOCOL }));
    // Local tests only: the api passes a shorter sweep (REALTIME_SWEEP_MS), kept for the alarms after this one.
    const every = sweepMsOf(request.headers.get('x-jc-sweep-ms'));
    if (every !== null && every !== (await this.ctx.storage.get<number>(SWEEP_KEY))) await this.ctx.storage.put(SWEEP_KEY, every);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + (every ?? (await this.sweepMs())));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async sweepMs(): Promise<number> {
    return (await this.ctx.storage.get<number>(SWEEP_KEY)) ?? SWEEP_MS;
  }

  /** Which of these sessions D1 still has as a member's sign-in, for an active account (one batch, SWEEP_CHUNK a query). */
  private async liveSessions(ids: string[]): Promise<Set<string>> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += SWEEP_CHUNK) {
      const part = ids.slice(i, i + SWEEP_CHUNK);
      statements.push(this.env.DB.prepare(liveSessionsSql(part.length)).bind(...part));
    }
    const live = new Set<string>();
    for (const r of await this.env.DB.batch<{ id: string }>(statements)) for (const row of r.results) live.add(row.id);
    return live;
  }

  /**
   * `users`: the members a personal event is for (scope user, required); without it a public event goes to every socket
   * that wants its topic. A personal event is never sent to everyone, and a public one never carries `users`.
   */
  private publish(body: Record<string, unknown>): Response {
    const parsed = RealtimeEventSchema.safeParse(body.event);
    if (!parsed.success) return new Response('bad event', { status: 400 });
    const e = parsed.data;
    const users = body.users;
    const personal = e.scope === 'user';
    if (personal !== (users !== undefined)) return new Response('bad audience', { status: 400 });
    if (personal && (!Array.isArray(users) || users.length === 0 || users.length > 500 || !users.every(isId))) return new Response('bad audience', { status: 400 });
    const frame = JSON.stringify({ t: 'event', e });
    const now = Date.now();
    let sent = 0;
    const targets = personal ? [...new Set(users as string[])].flatMap((u) => this.ctx.getWebSockets(`u:${u}`)) : this.ctx.getWebSockets();
    for (const ws of targets) {
      const a = this.att(ws);
      if (!a) continue;
      if (stale(a, now)) {
        this.close(ws, REALTIME_CLOSE.reauth, 'reauth');
        continue;
      }
      if (!personal && !wants(a, e)) continue;
      try {
        ws.send(frame);
        sent++;
      } catch {
        this.close(ws, 1011, 'send failed');
      }
    }
    return Response.json({ ok: true, sent });
  }

  /** Ends the sockets of a sign-out, and remembers it a minute for handshakes the api checked just before. */
  private async revoke(body: Record<string, unknown>): Promise<Response> {
    if (!isId(body.user)) return new Response('bad request', { status: 400 });
    if (body.session !== undefined && !isId(body.session)) return new Response('bad request', { status: 400 });
    if (body.except !== undefined && !isId(body.except)) return new Response('bad request', { status: 400 });
    const now = Date.now();
    const at = typeof body.at === 'number' && Number.isFinite(body.at) ? Math.min(body.at, now) : now;
    const r: Revoke = { user: body.user, at, ...(body.session !== undefined ? { session: body.session as string } : body.except !== undefined ? { except: body.except as string } : {}) };
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(`u:${r.user}`)) {
      const a = this.att(ws);
      if (a && revokes(r, a)) {
        this.close(ws, REALTIME_CLOSE.signedOut, 'signed out');
        closed++;
      }
    }
    const key = `revoke:${r.user}`;
    const kept = ((await this.ctx.storage.get<Revoke[]>(key)) ?? []).filter((x) => now - x.at < REVOKE_WINDOW_MS);
    await this.ctx.storage.put(key, [...kept.slice(-9), r]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + REVOKE_WINDOW_MS);
    return Response.json({ ok: true, closed });
  }

  private async recentRevokes(user: string, now: number): Promise<Revoke[]> {
    const list = await this.ctx.storage.get<Revoke[]>(`revoke:${user}`);
    return (list ?? []).filter((r) => now - r.at < REVOKE_WINDOW_MS);
  }

  /**
   * Closes sockets past their check, and those whose sign-in has ended in D1 though no revoke said so (it was lost on
   * the way): one read of D1 for all the hub's sockets, never one per event. Forgets old sign-outs; wakes again only
   * while there is something left. A failed read closes nothing and is tried again sooner; past REALTIME_MAX_AGE_MS a
   * socket is closed for a fresh check all the same.
   */
  override async alarm() {
    const now = Date.now();
    const open: { ws: WebSocket; a: RealtimeAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (!a || stale(a, now)) this.close(ws, REALTIME_CLOSE.reauth, 'reauth');
      else open.push({ ws, a });
    }
    let checked = true;
    if (open.length > 0) {
      try {
        const live = await this.liveSessions([...new Set(open.map(({ a }) => a.sessionId))]);
        for (const { ws, a } of open) if (!live.has(a.sessionId)) this.close(ws, REALTIME_CLOSE.signedOut, 'signed out');
      } catch (e) {
        checked = false;
        console.warn('realtime session check failed', e instanceof Error ? e.message : String(e));
      }
    }
    const old = await this.ctx.storage.list<Revoke[]>({ prefix: 'revoke:' });
    let left = false;
    for (const [key, list] of old) {
      const kept = list.filter((r) => now - r.at < REVOKE_WINDOW_MS);
      if (kept.length === 0) await this.ctx.storage.delete(key);
      else {
        left = true;
        if (kept.length !== list.length) await this.ctx.storage.put(key, kept);
      }
    }
    const every = await this.sweepMs();
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(now + (checked ? every : Math.min(every, SWEEP_RETRY_MS)));
    else if (left) await this.ctx.storage.setAlarm(now + REVOKE_WINDOW_MS);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const now = Date.now();
    const f = this.frames.get(ws);
    const count = f && now - f.since < 60_000 ? f : { n: 0, since: now };
    count.n++;
    this.frames.set(ws, count);
    if (count.n > FRAMES_PER_MIN) {
      this.close(ws, 1008, 'too many messages');
      return;
    }
    const a = this.att(ws);
    if (!a || typeof raw !== 'string' || raw.length > 200) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = RealtimeClientFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    ws.serializeAttachment({ ...a, topics: [...new Set(parsed.data.topics)] } satisfies RealtimeAttachment);
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    this.frames.delete(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011);
  }

  private att(ws: WebSocket): RealtimeAttachment | null {
    try {
      return (ws.deserializeAttachment() as RealtimeAttachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private close(ws: WebSocket, code: number, reason: string) {
    this.frames.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
