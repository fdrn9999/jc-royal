import { DurableObject } from 'cloudflare:workers';
import { mttAbort, mttAnswer, mttCall, mttClock, mttSeed, mttStale, tick, type MttAnswer, type MttBank, type MttCall, type MttReport, type MttState } from './mtt';
import { publishToAll, publishToUsers } from './realtime-publish';
import type { Env } from './room';
import type { Maintenance } from './settlement';
import { syncTournament, toTournamentRow, tournamentJson } from './tournament';

/**
 * A multi-table tournament's coordinator (docs/TOURNAMENT_MTT.md): one Durable Object a tournament
 * (`idFromName(tournamentId)`), which keeps where every player is (mtt.ts) and answers its tables. Internal calls only,
 * authenticated like the table rooms': POST /init (the api's start), /call (a table between its hands), /reload (an
 * operator's pause, resume or abort, read from D1), /status (the console), each with a JSON body naming the tournament.
 *
 * Its storage leads while the tournament runs, and D1 has a copy (places, stacks, each player's table and seat, the
 * clock) written before a table is answered; should the storage be lost, the state is built again from that copy.
 * Calls are taken one at a time, and the coordinator never waits for a table while taking one: tables it has something
 * for are woken once it has answered (`mtt-poke`), so a table calling it and it waking that table cannot wait on each
 * other. An alarm every MTT_TICK_MS moves the level clock on and wakes tables a wake-up missed.
 */

/** How often the coordinator moves the level clock on and looks for a table that missed its wake-up (ms). */
export const MTT_TICK_MS = 15_000;
const KEY = 'mtt';
const TOURNAMENT = /^[a-z0-9]{12}$/;
const TABLE = /^mtt-[a-z0-9]{12}-\d{1,3}$/;

const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const bankOf = (v: unknown): MttBank | null | undefined => {
  if (v === undefined || v === null) return v as null | undefined;
  const b = v as Record<string, unknown>;
  return int(b.ms) && int(b.hands) ? { ms: b.ms, hands: b.hands } : undefined;
};

/** A table's call as it came (null: not one). */
export function parseCall(body: Record<string, unknown>): MttCall | null {
  if (typeof body.table !== 'string' || !TABLE.test(body.table) || !int(body.applied)) return null;
  const r = body.report as Record<string, unknown> | null | undefined;
  if (r === undefined || r === null) return { table: body.table, applied: body.applied, report: null };
  if (!int(r.seq) || !Array.isArray(r.stacks) || !Array.isArray(r.order) || r.stacks.length > 10 || r.order.length > 10) return null;
  const stacks: MttReport['stacks'] = [];
  for (const x of r.stacks as Record<string, unknown>[]) {
    if (typeof x?.userId !== 'string' || !int(x.stack) || !int(x.startStack)) return null;
    const bank = bankOf(x.bank);
    stacks.push({ userId: x.userId, stack: x.stack, startStack: x.startStack, ...(bank !== undefined ? { bank } : {}) });
  }
  if (!(r.order as unknown[]).every((u) => typeof u === 'string')) return null;
  return { table: body.table, applied: body.applied, report: { seq: r.seq, stacks, order: r.order as string[] } };
}

export class TournamentCoordinator extends DurableObject<Env> {
  private s: MttState | null = null;
  private maint: Maintenance | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** One call at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

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
    const id = body.tournamentId;
    if (typeof id !== 'string' || !TOURNAMENT.test(id)) return new Response('bad request', { status: 400 });
    const missing = () => new Response('not found', { status: 404 });
    switch (op) {
      case '/init':
      case '/reload': {
        const r = await this.run(() => this.reload(id));
        if (!r) return missing();
        this.wake(r.wake);
        return Response.json({ ok: true, status: r.status, tables: r.tables });
      }
      case '/call': {
        const call = parseCall(body);
        if (!call) return new Response('bad request', { status: 400 });
        const r = await this.run(() => this.call(id, call));
        if (!r) return missing();
        this.wake(r.wake);
        // D1 does not have it yet: the table asks again (its alarm), and is answered once it does.
        if (!r.answer) return new Response('unavailable', { status: 503 });
        // The maintenance window as this write read it back (the table takes it on as from its own D1 writes).
        return Response.json({ ...r.answer, maintenance: this.maint });
      }
      case '/status': {
        const s = await this.run(() => this.load(id));
        if (!s) return missing();
        return Response.json({ ok: true, ...status(s) });
      }
      default:
        return missing();
    }
  }

  override async alarm() {
    await this.run(async () => {
      const s = this.s ?? (await this.ctx.storage.get<MttState>(KEY)) ?? null;
      if (!s) return;
      this.s = s;
      const now = Date.now();
      tick(s, now);
      await this.save(s);
      const wake = mttStale(s);
      await this.persist(s, now);
      this.wake(wake);
      await this.arm(s);
    });
  }

  /** The state: kept, or (the first time, or should the storage be lost) built from D1. Null: no such tournament. */
  private async load(id: string): Promise<MttState | null> {
    if (this.s?.t.id === id) return this.s;
    const kept = await this.ctx.storage.get<MttState>(KEY);
    if (kept) {
      if (kept.t.id !== id) return null;
      return (this.s = kept);
    }
    const row = toTournamentRow((await this.env.DB.prepare(`SELECT (${tournamentJson('tn.id = ?1')}) AS t`).bind(id).first<{ t: string | null }>())?.t);
    if (!row || row.format !== 'mtt' || (row.status !== 'running' && row.status !== 'finished' && row.status !== 'aborted')) return null;
    const { results } = await this.env.DB.prepare(`SELECT id, status FROM tables WHERE tournament_id = ?1 ORDER BY id`).bind(id).all<{ id: string; status: string }>();
    const now = Date.now();
    const s = mttSeed(row, results.map((t) => ({ id: t.id, open: t.status === 'open' })), row.tableSeats, now);
    mttClock(s, !s.t.pauseRequested, now);
    this.s = s;
    await this.save(s);
    return s;
  }

  private async save(s: MttState) {
    await this.ctx.storage.put(KEY, s);
  }

  /** The next alarm, while the tournament runs or a table still has to hear how it ended. */
  private async arm(s: MttState) {
    const open = s.t.status === 'running' || Object.values(s.tables).some((t) => t.rev > t.told);
    if (!open) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + MTT_TICK_MS);
  }

  /**
   * Reads the tournament in D1 again (the start, an operator's pause or resume, an abort) and wakes every table, which
   * then calls for what changed.
   */
  private async reload(id: string): Promise<{ status: string; tables: number; wake: string[] } | null> {
    const s = await this.load(id);
    if (!s) return null;
    const now = Date.now();
    const back = await this.env.DB.prepare(`SELECT status, pause_requested AS pauseRequested FROM tournaments WHERE id = ?1`).bind(id).first<{ status: string; pauseRequested: number }>();
    if (back?.status === 'aborted') mttAbort(s, now);
    else if (s.t.status === 'running' && back) s.t.pauseRequested = back.pauseRequested === 1;
    await this.persist(s, now);
    await this.arm(s);
    return { status: s.t.status, tables: Object.values(s.tables).filter((t) => !t.broken).length, wake: Object.keys(s.tables).sort() };
  }

  /** A table's call: taken (mtt.ts), saved, written to D1, and answered (null answer: D1 could not be written). */
  private async call(id: string, call: MttCall): Promise<{ answer: (MttAnswer & { seq: number }) | null; wake: string[] } | null> {
    const s = await this.load(id);
    if (!s || !s.tables[call.table]) return null;
    const now = Date.now();
    const wake = mttCall(s, call, now, (n) => {
      const r = new Uint32Array(1);
      crypto.getRandomValues(r);
      return r[0]! % n;
    });
    await this.save(s);
    const written = await this.persist(s, now);
    await this.arm(s);
    return { answer: written ? { ...mttAnswer(s, call.table), seq: s.tables[call.table]!.seq } : null, wake };
  }

  /**
   * Writes what D1 does not have yet (syncTournament: places, stacks, the clock, the finish; and each moved player's
   * table and seat), then takes on what D1 answers: an abort, the pause request, a maintenance. The clock stops while
   * either keeps the tables from dealing, and runs again once both are over. A failed write is retried by the alarm
   * (false: D1 has not got it).
   */
  private async persist(s: MttState, now: number): Promise<boolean> {
    for (let pass = 0; pass < 2; pass++) {
      if (!s.t.dirty && s.touched.length === 0 && pass > 0) break;
      const db = this.env.DB;
      const moved = s.touched.map((u) => s.players[u]).filter((p) => !!p && !p.out);
      const extra = [
        ...moved.map((p) =>
          db
            .prepare(
              `UPDATE tournament_entries SET table_id = ?3, seat_index = ?4, updated_at = ?5
                WHERE tournament_id = ?1 AND user_id = ?2 AND status = 'playing' AND (table_id IS NOT ?3 OR seat_index IS NOT ?4)`,
            )
            .bind(s.t.id, p!.userId, p!.table, p!.seat, now),
        ),
        db
          .prepare(`UPDATE tournaments SET tables_left = ?2 WHERE id = ?1 AND status = 'running' AND tables_left IS NOT ?2`)
          .bind(s.t.id, Object.values(s.tables).filter((t) => !t.broken).length),
      ];
      let r: Awaited<ReturnType<typeof syncTournament>>;
      try {
        r = await syncTournament(db, s.t, moved.map((p) => ({ userId: p!.userId, stack: p!.stack })), now, { placesFrom: s.t.confirmed, extra });
      } catch (e) {
        console.error('tournament coordinator sync failed; will retry', e instanceof Error ? e.message : String(e));
        return false;
      }
      s.t.dirty = false;
      s.touched = [];
      this.maint = r.maintenance;
      // A bust or the finish, now in D1, for the tournament pages (once, here, not by each table); the finish for the
      // members' bells.
      if (r.standings) this.ctx.waitUntil(publishToAll(this.env, { scope: 'lobby', type: 'tournament.changed', resourceId: s.t.id }));
      if (r.finished) this.ctx.waitUntil(publishToUsers(this.env, Object.keys(s.t.players), { scope: 'user', type: 'notification.changed' }));
      // Aborted first: none of this write was taken (it is all conditional on the tournament running), so the places
      // D1 has are those confirmed before it.
      if (r.status === 'aborted') mttAbort(s, now);
      else {
        s.t.confirmed = s.t.places.length;
        if (s.t.status === 'running') s.t.pauseRequested = r.pauseRequested;
      }
      const m = this.maint;
      // The clock as D1 now has it changes only when a pause or a maintenance began or ended: written on the second pass.
      mttClock(s, !s.t.pauseRequested && !(m && m.startsAt <= now && now < m.endsAt), now);
      await this.save(s);
    }
    return true;
  }

  /** Wakes `tables` (after the answer, never while a call is being taken). */
  private wake(tables: readonly string[]) {
    for (const id of tables) {
      this.ctx.waitUntil(
        (async () => {
          try {
            const stub = this.env.TABLES!.get(this.env.TABLES!.idFromName(id));
            await stub.fetch(`https://room/internal/${id}/mtt-poke`, { method: 'POST', headers: { 'x-jc-internal': this.env.INTERNAL_SECRET } });
          } catch (e) {
            // The alarm wakes it again (mttStale).
            console.warn('tournament table not woken', id, e instanceof Error ? e.message : String(e));
          }
        })(),
      );
    }
  }
}

/** The console's view: each table's players, the moves under way, the clock. No card, nothing a hand holds. */
function status(s: MttState) {
  const ps = Object.values(s.players);
  return {
    status: s.t.status,
    level: s.t.level,
    levelEndsAt: s.t.levelEndsAt,
    levelLeftMs: s.t.levelLeftMs,
    paused: s.t.pauseRequested,
    hands: s.t.hands,
    playersLeft: ps.filter((p) => !p.out).length,
    final: s.final,
    tables: Object.values(s.tables)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => ({
        id: t.id,
        broken: t.broken,
        players: ps.filter((p) => !p.out && p.table === t.id && !p.moving).length,
        leaving: ps.filter((p) => !p.out && p.table === t.id && p.moving).length,
        behind: t.rev > t.applied,
        hands: t.seq,
      })),
  };
}
