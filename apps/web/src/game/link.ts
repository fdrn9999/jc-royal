/**
 * Delivery rules for a table connection, kept apart from the socket so they can run on a fake clock.
 *
 * - Every command carries an id the room applies once. One whose answer has not come is sent again, with the same
 *   id, on the next connection. It is not repeated on a connection that still answers: the copy would only wait
 *   behind the first.
 * - A late answer, or a connection that has gone quiet, makes the heartbeat ask for a sign of life. A connection
 *   that stays silent is given up and replaced.
 * - A command still unanswered `DEADLINE_MS` after it was handed over gives up; the next state shows what happened.
 */

/** An answer later than this makes the heartbeat check the connection. */
export const ACK_LATE_MS = 5_000;
/** A command is given up this long after it was handed over. */
export const DEADLINE_MS = 20_000;
/** A connection that has carried nothing for this long is pinged. */
export const QUIET_MS = 25_000;
/** A connection that answers nothing for this long after a ping is dead. */
export const PONG_WAIT_MS = 10_000;

export interface Outgoing<M, H> {
  id: string;
  msg: M;
  /** Caller's handlers and data, untouched. */
  h: H;
  /** When it was handed over; the deadline counts from here. */
  at: number;
  /** When it last went out (null: waiting for a connection). */
  sentAt: number | null;
  /** How many times it went out. */
  sends: number;
  /** The heartbeat already checked the connection for this send. */
  probed: boolean;
}

/** Commands waiting for their answer. */
export class Outbox<M, H> {
  private items = new Map<string, Outgoing<M, H>>();

  get size() {
    return this.items.size;
  }

  values(): Outgoing<M, H>[] {
    return [...this.items.values()];
  }

  /** Records a command that has just gone out. */
  add(id: string, msg: M, h: H, now: number) {
    this.items.set(id, { id, msg, h, at: now, sentAt: now, sends: 1, probed: false });
  }

  /** Removes and returns the command with this id (its answer came). */
  take(id: string): Outgoing<M, H> | undefined {
    const o = this.items.get(id);
    this.items.delete(id);
    return o;
  }

  /** Every command to put on a fresh connection, marked as sent again. */
  resend(now: number): Outgoing<M, H>[] {
    const out = this.values();
    for (const o of out) {
      o.sentAt = now;
      o.sends += 1;
      o.probed = false;
    }
    return out;
  }

  /** The connection is gone: nothing is in flight until the next one. */
  detach() {
    for (const o of this.items.values()) o.sentAt = null;
  }

  /**
   * `late`: some answer is overdue on the current connection (each send counts once). `expired`: commands past the
   * deadline, removed.
   */
  sweep(now: number): { late: boolean; expired: Outgoing<M, H>[] } {
    let late = false;
    const expired: Outgoing<M, H>[] = [];
    for (const o of this.items.values()) {
      if (now - o.at >= DEADLINE_MS) expired.push(o);
      else if (o.sentAt !== null && !o.probed && now - o.sentAt >= ACK_LATE_MS) {
        o.probed = true;
        late = true;
      }
    }
    for (const o of expired) this.items.delete(o.id);
    return { late, expired };
  }

  /** Removes and returns everything (the connection ended for good). */
  drain(): Outgoing<M, H>[] {
    const out = this.values();
    this.items.clear();
    return out;
  }
}

/**
 * Liveness of one connection. Any message from the server counts. A ping goes out only after `QUIET_MS` without
 * one (a table in play talks far more often), or when asked to check.
 */
export class Heartbeat {
  private lastRx = 0;
  private askedAt: number | null = null;

  /** A new connection opened. */
  reset(now: number) {
    this.lastRx = now;
    this.askedAt = null;
  }

  received(now: number) {
    this.lastRx = now;
    this.askedAt = null;
  }

  /** Check now (an answer is late, the page came back). True when the caller should send something answerable. */
  check(now: number): boolean {
    if (this.askedAt !== null) return false;
    this.askedAt = now;
    return true;
  }

  /** `ping`: send one. `dead`: nothing came back in time; replace the connection. */
  tick(now: number): 'ping' | 'dead' | null {
    if (this.askedAt !== null) return now - this.askedAt >= PONG_WAIT_MS ? 'dead' : null;
    if (now - this.lastRx >= QUIET_MS) {
      this.askedAt = now;
      return 'ping';
    }
    return null;
  }
}
