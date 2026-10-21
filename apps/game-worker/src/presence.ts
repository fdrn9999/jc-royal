import { DurableObject } from 'cloudflare:workers';
import { HUB_QUERY_MAX, id, parseBeat, PresenceBook, time, VIEW_RE, type Leave } from './presence-book';
import type { Env } from './room';

/**
 * Friends' status (docs/PRESENCE.md): which signed-in devices have beaten lately and when the member last did something
 * on each. Kept in memory only, never in D1 or storage: a restarted hub knows nobody until the next beat (at most
 * PRESENCE_HEARTBEAT_MS), which shows friends offline for that long. The one thing that outlives it is each member's
 * last-online time, which the hub asks the api to save (`stampAgo`, at most every PRESENCE_STAMP_MS while online, and as
 * a device closes) and the api keeps in users.last_online_at. Its times reach the api only as how long ago (on its clock
 * alone), never as moments, so the two servers' clocks are never compared. The api authenticates every call and asks
 * only about a member's own devices or their accepted friends; the hub never decides who may see whom, and knows
 * nothing of modes (auto / away / invisible), which the api applies from D1: it only hears whether friends can see the
 * member (`mark`).
 */

export { HUB_BEATS_PER_MIN, HUB_QUERIES_PER_MIN, HUB_QUERY_MAX, PresenceBook } from './presence-book';

/**
 * The hub (one instance, named "hub-0", for now: every member's devices and every question go to it). Internal calls
 * only, authenticated like the table rooms'. POST /beat, /leave, /query, /viewing with a JSON body.
 */
export class PresenceHub extends DurableObject<Env> {
  private book = new PresenceBook();

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.INTERNAL_SECRET || request.headers.get('x-jc-internal') !== this.env.INTERNAL_SECRET) return new Response('forbidden', { status: 403 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const op = new URL(request.url).pathname;
    let body: Record<string, unknown>;
    try {
      const v: unknown = await request.json();
      if (!v || typeof v !== 'object') throw new Error('not an object');
      body = v as Record<string, unknown>;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const now = Date.now();
    const bad = () => new Response('bad request', { status: 400 });
    switch (op) {
      case '/beat': {
        const b = parseBeat(body);
        if (!b) return bad();
        const seen = this.book.beat(now, b);
        return Response.json(seen ? { ok: true, ...seen } : { ok: false, limited: true });
      }
      case '/leave': {
        const at = time(body.at);
        if (!id(body.user) || at === null) return bad();
        const l: Leave = { user: body.user, ...(at !== undefined ? { at } : {}) };
        if (body.conn !== undefined) {
          if (!id(body.conn) || !id(body.session)) return bad();
          l.conn = body.conn;
          l.session = body.session;
        } else if (body.session !== undefined) {
          if (!id(body.session)) return bad();
          l.session = body.session;
        } else if (body.except !== undefined) {
          if (!id(body.except)) return bad();
          l.except = body.except;
        }
        return Response.json({ ok: true, ...this.book.leave(now, l) });
      }
      case '/query': {
        if (!id(body.asker) || !Array.isArray(body.ids) || body.ids.length > HUB_QUERY_MAX || !body.ids.every(id)) return bad();
        const presence = this.book.query(now, body.asker, body.ids as string[]);
        // `seen: true` asks for the last-online times too (the friends list; a member's own status never needs them).
        return Response.json(
          presence ? { ok: true, presence, ...(body.seen === true ? { seenAgo: this.book.seenAgo(now, body.ids as string[]) } : {}) } : { ok: false, limited: true },
        );
      }
      case '/viewing': {
        if (!id(body.user) || typeof body.view !== 'string' || !VIEW_RE.test(body.view)) return bad();
        return Response.json({ ok: true, viewing: this.book.viewing(now, body.user, body.view) });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  }
}
