import { DurableObject } from 'cloudflare:workers';
import { ADMIN_MONITOR_CLOSE, ADMIN_MONITOR_PROTOCOL, AdminMonitorClientFrameSchema, AdminMonitorEventSchema, type AdminChangeKind } from '@jc/types';
import type { Env } from './room';
import {
  ADMIN_ABSOLUTE_MS,
  changeKindsOf,
  hasTableDuty,
  kindsOf,
  liveAdminSessionsSql,
  MONITOR_FRAMES_PER_MIN,
  MONITOR_MAX_PER_ADMIN,
  MONITOR_MAX_PER_HUB,
  MONITOR_SWEEP_CHUNK,
  MONITOR_SWEEP_MS,
  sameKinds,
  staleMonitor,
  watchOf,
  type MonitorAttachment,
} from './admin-monitor-rules';
import { parseIdentity, REVOKE_WINDOW_MS, revokes, SWEEP_RETRY_MS, sweepAlarmFor, sweepMsOf, type Revoke } from './realtime-rules';

/**
 * The control center's sockets (docs/CONTROL_CENTER.md): administrators' console pages, on one hub of their own
 * (ADMIN_MONITOR_HUB), never on the member hubs and never with a member's session. The api checks the console sign-in,
 * the role and table duty and the console's origin before a page reaches here; the hub then hands it what the api and
 * the table rooms publish for the control center, and checks the sign-in and the duty again on its sweep. Nothing a
 * page sends changes anything but which followed rooms' summaries it gets. Another administrator's change to a VIP state or
 * a tournament (admin.monitor.changed) goes only to the pages of administrators with that permission, as the api read it
 * on the handshake and the sweep reads it again.
 */

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const SWEEP_KEY = 'sweep-ms';

/** A sign-out (close for good), or with `reauth` a change of role or duty (close, and let the api check again). */
type MonitorRevoke = Revoke & { reauth?: true };

export class AdminMonitorHub extends DurableObject<Env> {
  /** Frames each socket sent this minute (memory only). */
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
    const kinds = kindsOf(request.headers.get('x-jc-monitor-kinds'));
    if (!kinds) return new Response('bad kinds', { status: 400 });
    const now = Date.now();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const refuse = (code: number, reason: string) => {
      // Accepted only to say why; never hibernated or counted.
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    const hit = (await this.recentRevokes(identity.userId, now)).find((r) => revokes(r, identity, true));
    if (hit) return hit.reauth ? refuse(ADMIN_MONITOR_CLOSE.reauth, 'reauth') : refuse(ADMIN_MONITOR_CLOSE.signedOut, 'signed out');
    if (staleMonitor(identity, now)) return refuse(ADMIN_MONITOR_CLOSE.reauth, 'reauth');
    if (this.ctx.getWebSockets().length >= MONITOR_MAX_PER_HUB) return refuse(1013, 'try again later');
    const mine = this.ctx.getWebSockets(`a:${identity.userId}`);
    if (mine.length >= MONITOR_MAX_PER_ADMIN) {
      const oldest = mine
        .map((ws) => ({ ws, at: this.att(ws)?.authAt ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .slice(0, mine.length - MONITOR_MAX_PER_ADMIN + 1);
      for (const { ws } of oldest) this.close(ws, ADMIN_MONITOR_CLOSE.tooMany, 'too many pages');
    }
    this.ctx.acceptWebSocket(server, [`a:${identity.userId}`]);
    server.serializeAttachment({ ...identity, watch: [], kinds } satisfies MonitorAttachment);
    server.send(JSON.stringify({ t: 'hello', v: ADMIN_MONITOR_PROTOCOL, at: now }));
    // Local tests only: the api passes a shorter sweep (REALTIME_SWEEP_MS), kept for the alarms after this one.
    const every = sweepMsOf(request.headers.get('x-jc-sweep-ms'));
    if (every !== null && every !== (await this.ctx.storage.get<number>(SWEEP_KEY))) await this.ctx.storage.put(SWEEP_KEY, every);
    const due = sweepAlarmFor(await this.ctx.storage.getAlarm(), now, every ?? (await this.sweepMs()));
    if (due !== null) await this.ctx.storage.setAlarm(due);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async sweepMs(): Promise<number> {
    return (await this.ctx.storage.get<number>(SWEEP_KEY)) ?? MONITOR_SWEEP_MS;
  }

  /**
   * Of these sessions, those D1 still has as a console sign-in of an active administrator, with whether they have table
   * duty and the other administrators' changes their permissions let them hear of.
   */
  private async liveSessions(ids: string[], now: number): Promise<Map<string, { duty: boolean; kinds: AdminChangeKind[] }>> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += MONITOR_SWEEP_CHUNK) {
      const part = ids.slice(i, i + MONITOR_SWEEP_CHUNK);
      statements.push(this.env.DB.prepare(liveAdminSessionsSql(part.length)).bind(...part, now, now - ADMIN_ABSOLUTE_MS));
    }
    const live = new Map<string, { duty: boolean; kinds: AdminChangeKind[] }>();
    for (const r of await this.env.DB.batch<{ id: string; role: string; grants: string | null }>(statements))
      for (const row of r.results) live.set(row.id, { duty: hasTableDuty(row.role, row.grants), kinds: changeKindsOf(row.role, row.grants) });
    return live;
  }

  /**
   * An event for every console page, except a followed room's summary, which goes only to the pages following that
   * room, and another administrator's change, only to the pages whose administrator may hear of that kind. Refused unless it is one of the control center's events, with nothing private in it (AdminMonitorEventSchema).
   */
  private publish(body: Record<string, unknown>): Response {
    const parsed = AdminMonitorEventSchema.safeParse(body.event);
    if (!parsed.success) return new Response('bad event', { status: 400 });
    const e = parsed.data;
    const frame = JSON.stringify({ t: 'event', e });
    const now = Date.now();
    let sent = 0;
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const a = this.att(ws);
      if (!a) continue;
      if (staleMonitor(a, now)) {
        this.close(ws, ADMIN_MONITOR_CLOSE.reauth, 'reauth');
        continue;
      }
      if (e.type === 'admin.monitor.room' && !a.watch.includes(e.resourceId)) continue;
      if (e.type === 'admin.monitor.changed' && !(a.kinds ?? []).includes(e.kind)) continue;
      try {
        ws.send(frame);
        sent++;
      } catch {
        this.close(ws, 1011, 'send failed');
      }
    }
    return Response.json({ ok: true, sent, sockets: sockets.length });
  }

  /**
   * Ends an administrator's console sockets: for good after a sign-out, or with `reauth` (a role or duty changed) so the
   * page connects again and the api checks it again. Remembered a minute for handshakes the api checked just before.
   */
  private async revoke(body: Record<string, unknown>): Promise<Response> {
    if (!isId(body.user)) return new Response('bad request', { status: 400 });
    if (body.session !== undefined && !isId(body.session)) return new Response('bad request', { status: 400 });
    if (body.except !== undefined && !isId(body.except)) return new Response('bad request', { status: 400 });
    if (body.reauth !== undefined && body.reauth !== true) return new Response('bad request', { status: 400 });
    const now = Date.now();
    const at = typeof body.at === 'number' && Number.isFinite(body.at) ? Math.min(body.at, now) : now;
    const r: MonitorRevoke = {
      user: body.user,
      at,
      ...(body.session !== undefined ? { session: body.session as string } : body.except !== undefined ? { except: body.except as string } : {}),
      ...(body.reauth ? { reauth: true as const } : {}),
    };
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(`a:${r.user}`)) {
      const a = this.att(ws);
      if (a && revokes(r, a)) {
        if (r.reauth) this.close(ws, ADMIN_MONITOR_CLOSE.reauth, 'reauth');
        else this.close(ws, ADMIN_MONITOR_CLOSE.signedOut, 'signed out');
        closed++;
      }
    }
    const key = `revoke:${r.user}`;
    const kept = ((await this.ctx.storage.get<MonitorRevoke[]>(key)) ?? []).filter((x) => now - x.at < REVOKE_WINDOW_MS);
    await this.ctx.storage.put(key, [...kept.slice(-9), r]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + REVOKE_WINDOW_MS);
    return Response.json({ ok: true, closed });
  }

  private async recentRevokes(user: string, now: number): Promise<MonitorRevoke[]> {
    const list = await this.ctx.storage.get<MonitorRevoke[]>(`revoke:${user}`);
    return (list ?? []).filter((r) => now - r.at < REVOKE_WINDOW_MS);
  }

  /**
   * Closes sockets past their check; those whose console sign-in D1 no longer has (signed out, expired, past the
   * absolute limit, the account no longer an active administrator) for good; and those of an administrator who no
   * longer has table duty (which the api then refuses), or whose other permissions changed, for a fresh check. One D1 batch for all sockets, never one per event.
   */
  override async alarm() {
    const now = Date.now();
    const open: { ws: WebSocket; a: MonitorAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (!a || staleMonitor(a, now)) this.close(ws, ADMIN_MONITOR_CLOSE.reauth, 'reauth');
      else open.push({ ws, a });
    }
    let checked = true;
    if (open.length > 0) {
      try {
        const live = await this.liveSessions([...new Set(open.map(({ a }) => a.sessionId))], now);
        for (const { ws, a } of open) {
          const held = live.get(a.sessionId);
          if (held === undefined) this.close(ws, ADMIN_MONITOR_CLOSE.signedOut, 'signed out');
          else if (!held.duty || !sameKinds(a.kinds, held.kinds)) this.close(ws, ADMIN_MONITOR_CLOSE.reauth, 'reauth');
        }
      } catch (e) {
        checked = false;
        console.warn('admin monitor session check failed', e instanceof Error ? e.message : String(e));
      }
    }
    const old = await this.ctx.storage.list<MonitorRevoke[]>({ prefix: 'revoke:' });
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
    if (count.n > MONITOR_FRAMES_PER_MIN) {
      this.close(ws, 1008, 'too many messages');
      return;
    }
    const a = this.att(ws);
    if (!a || typeof raw !== 'string' || raw.length > 400) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = AdminMonitorClientFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    ws.serializeAttachment({ ...a, watch: watchOf(parsed.data.tables) } satisfies MonitorAttachment);
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

  private att(ws: WebSocket): MonitorAttachment | null {
    try {
      return (ws.deserializeAttachment() as MonitorAttachment | null) ?? null;
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
