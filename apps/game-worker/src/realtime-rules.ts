import { realtimeTopicOf, type RealtimeEvent, type RealtimeTopic } from '@jc/types';

/** The realtime hub's rules (realtime.ts), apart from the Durable Object so they can be tested on their own. */

/** What the api verified for the handshake (x-jc-identity). The page never names a member. */
export interface RealtimeIdentity {
  userId: string;
  sessionId: string;
  authAt: number;
  /** The session's expiry when it was checked (the api reads it without sliding it). */
  expiresAt: number;
}

export interface RealtimeAttachment extends RealtimeIdentity {
  topics: RealtimeTopic[];
}

/** A socket is checked against D1 again at least this often: the hub closes it (REALTIME_CLOSE.reauth) and the page reconnects. */
export const REALTIME_MAX_AGE_MS = 60 * 60_000;
/** A member's pages per hub; a newer one closes the oldest. */
export const REALTIME_MAX_PER_USER = 10;
/** Sockets per hub (a Durable Object holds about 32k hibernated ones); past it a handshake is refused with 1013. */
export const REALTIME_MAX_PER_HUB = 16_000;
/** How long a sign-out also turns away handshakes the api checked just before it, and the clock slack allowed. */
export const REVOKE_WINDOW_MS = 60_000;
const REVOKE_SKEW_MS = 2_000;
/** While sockets are open the hub wakes this often to close those past their check, even with no event to deliver. */
export const SWEEP_MS = 15 * 60_000;
/** Messages a page may send a minute (topic changes on navigation); past it its socket closes. */
export const FRAMES_PER_MIN = 30;

/** A sign-out to apply: one session, every session but one, or all of the member's. */
export interface Revoke {
  user: string;
  session?: string;
  except?: string;
  at: number;
}

/** Whether a sign-out ends this socket (or the handshake it was checked for, when that came before the sign-out). */
export function revokes(r: Revoke, a: RealtimeIdentity, handshake = false): boolean {
  if (a.userId !== r.user) return false;
  if (handshake && a.authAt >= r.at + REVOKE_SKEW_MS) return false;
  if (r.session !== undefined) return a.sessionId === r.session;
  if (r.except !== undefined) return a.sessionId !== r.except;
  return true;
}

/** Whether a socket must be checked again before it gets anything more. */
export const stale = (a: RealtimeIdentity, now: number) => now >= a.expiresAt || now - a.authAt >= REALTIME_MAX_AGE_MS;

/** Whether a public event goes to a socket that asked for these topics. */
export function wants(a: Pick<RealtimeAttachment, 'topics'>, e: RealtimeEvent): boolean {
  const topic = realtimeTopicOf(e.type);
  return topic === undefined || a.topics.includes(topic);
}

export const parseIdentity = (raw: string | null): RealtimeIdentity | null => {
  try {
    const v = JSON.parse(decodeURIComponent(raw ?? '')) as Partial<RealtimeIdentity>;
    if (typeof v.userId !== 'string' || !v.userId || typeof v.sessionId !== 'string' || !v.sessionId) return null;
    if (typeof v.authAt !== 'number' || typeof v.expiresAt !== 'number') return null;
    return { userId: v.userId, sessionId: v.sessionId, authAt: v.authAt, expiresAt: v.expiresAt };
  } catch {
    return null;
  }
};
