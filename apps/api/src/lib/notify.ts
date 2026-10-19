import type { OutboxType } from '@jc/db';
import { isKstNight, NOTIFICATION_TYPE_DB, type NotificationType, type PushPayload } from '@jc/types';
import type { Env } from '../env';
import { pushConfigured } from './notification-settings';
import { isViewing } from './presence';
import { pushTopic, SEND_TIMEOUT_MS, sendPush, type PushTarget, type SendResult, type VapidKeys } from './webpush';

/**
 * Sends the push outbox (notification_events, written by packages/db/src/notify.ts after the action a push reports has
 * been committed). Everything is checked again when a push goes out, never trusted from when it was queued: the
 * member is still active, has service consent and the type on, it is not night in Korea (or night consent is given),
 * the friend or request it is about still stands, and only browsers of sign-ins that still exist get it. An event is
 * claimed for a minute (`lease_until`) so two senders never send it twice; it is tried at most MAX_ATTEMPTS times and
 * dropped once it expires. A push that is not sent never changes the action it reports.
 */

/** Tries per event (the first and two retries). */
export const MAX_ATTEMPTS = 3;
/** Wait before the second and third try. */
const RETRY_MS = [60_000, 5 * 60_000];
/** A claim lasts this long; a sender that stops meanwhile leaves the event to the next one. */
const LEASE_MS = 60_000;
/** Kept free at the end of a claim, after the slowest push service's answer, for saving the outcome. */
const LEASE_MARGIN_MS = 15_000;
/** Direct messages from one friend: at most one push a minute (the shown one is replaced, see the tag). */
export const DM_COOLDOWN_MS = 60_000;
/** Direct messages and invites: at most this many pushes an hour per member. */
export const DM_HOURLY_CAP = 30;
/** Pushes (requests to push services) one run may make: the Workers subrequest limit is 50 on the free plan. */
const SEND_BUDGET = 40;
/** A browser refused this many times in a row (not "gone", not busy) is dropped. */
const MAX_DEVICE_FAILURES = 3;

const TYPE_OF: Record<OutboxType, NotificationType> = Object.fromEntries(
  Object.entries(NOTIFICATION_TYPE_DB).map(([camel, db]) => [db, camel as NotificationType]),
) as Record<OutboxType, NotificationType>;

/** Generic words only: never who sent it, what it says, a table's name, a card or an amount (lock screens show it). */
const TEXT: Record<OutboxType, Record<'ko' | 'en', { title: string; body: string }>> = {
  dm: { ko: { title: '새 메시지', body: '친구가 1:1 메시지를 보냈습니다.' }, en: { title: 'New message', body: 'A friend sent you a message.' } },
  invite: { ko: { title: '게임 초대', body: '친구가 테이블에 초대했습니다.' }, en: { title: 'Game invite', body: 'A friend invited you to a table.' } },
  friend_request: { ko: { title: '친구 요청', body: '새 친구 요청이 왔습니다.' }, en: { title: 'Friend request', body: 'You have a new friend request.' } },
  friend_accepted: { ko: { title: '친구 수락', body: '보낸 친구 요청이 수락되었습니다.' }, en: { title: 'Friend request accepted', body: 'Your friend request was accepted.' } },
  tournament_start: { ko: { title: '토너먼트 시작', body: '참가 신청한 토너먼트가 시작되었습니다.' }, en: { title: 'Tournament started', body: 'A tournament you registered for has started.' } },
  tournament_cancel: { ko: { title: '토너먼트 취소', body: '참가한 토너먼트가 취소되었습니다. 내용을 확인해 보세요.' }, en: { title: 'Tournament called off', body: 'A tournament you entered was called off. See the details.' } },
  tournament_result: { ko: { title: '토너먼트 결과', body: '참가한 토너먼트가 끝났습니다. 결과를 확인해 보세요.' }, en: { title: 'Tournament result', body: 'A tournament you played has finished. See the result.' } },
};

export function pushText(type: OutboxType, locale: string | null): { title: string; body: string; lang: 'ko' | 'en' } {
  const lang = locale === 'en' ? 'en' : 'ko';
  return { ...TEXT[type][lang], lang };
}

/** What the member's account says when the push would go out. */
export interface Recipient {
  status: string;
  service: boolean;
  night: boolean;
  typeOn: boolean;
}

export type Skip = 'expired' | 'inactive' | 'no_consent' | 'type_off' | 'night';

/**
 * The account checks, at `now`. Night is judged on the server's clock in Korean time, both when the event happened and
 * now: an event from the night is never sent in the morning (nothing is held for later).
 */
export function gate(ev: { createdAt: number; expiresAt: number }, r: Recipient | null, now: number): Skip | null {
  if (now >= ev.expiresAt) return 'expired';
  if (!r || r.status !== 'active') return 'inactive';
  if (!r.service) return 'no_consent';
  if (!r.typeOn) return 'type_off';
  if (!r.night && (isKstNight(ev.createdAt) || isKstNight(now))) return 'night';
  return null;
}

/** When to try again after `attempts` tries; null: no more tries (too many, or past the event's expiry). */
export function retryAt(attempts: number, now: number, expiresAt: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const at = now + (RETRY_MS[attempts - 1] ?? RETRY_MS[RETRY_MS.length - 1]!);
  return at < expiresAt ? at : null;
}

/**
 * The event's outcome from its browsers' answers: sent to any is sent (the others are not tried again). Run out right
 * before it went to one of them: over, as it would be at the next try.
 */
export function outcome(results: readonly SendResult[]): 'sent' | 'expired' | 'retry' | 'gone' | 'refused' {
  if (results.some((r) => r.ok)) return 'sent';
  if (results.some((r) => !r.ok && r.expired)) return 'expired';
  if (results.some((r) => !r.ok && r.retry)) return 'retry';
  return results.every((r) => !r.ok && r.gone) ? 'gone' : 'refused';
}

/** The friend a social event is about, from its coalescing key (`dm:<id>`, `invite:<id>`, `fr:<id>`, `fa:<id>`). */
function otherOf(coalesceKey: string | null): string | null {
  const m = coalesceKey?.match(/^(?:dm|invite|fr|fa):([A-Za-z0-9_-]{1,64})$/);
  return m ? m[1]! : null;
}

/** The notification_settings column of each type (fixed names, written into the SQL). */
const COLUMN: Record<OutboxType, string> = {
  dm: 'dm',
  invite: 'invite',
  friend_request: 'friend_request',
  friend_accepted: 'friend_accepted',
  tournament_start: 'tournament_start',
  tournament_cancel: 'tournament_cancel',
  tournament_result: 'tournament_result',
};

const URGENCY: Record<OutboxType, 'normal' | 'high'> = {
  dm: 'high',
  invite: 'high',
  friend_request: 'normal',
  friend_accepted: 'normal',
  tournament_start: 'high',
  tournament_cancel: 'normal',
  tournament_result: 'normal',
};

interface EventRow {
  id: string;
  user_id: string;
  type: OutboxType;
  url: string;
  coalesce_key: string | null;
  attempts: number;
  expires_at: number;
  created_at: number;
  lease_until: number;
}

interface DeviceRow extends PushTarget {
  id: string;
  failures: number;
}

/**
 * Development and tests only: pushes go to a local address (tests/support/push-sink.ts) with the push service's
 * address in a header, instead of to the push service. Never in production, and only to 127.0.0.1.
 */
function fetcherFor(env: Env): typeof fetch | undefined {
  const sink = env.PUSH_SINK_URL;
  if (!sink || env.ENVIRONMENT === 'production' || !/^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9/_-]*$/.test(sink)) return undefined;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(sink, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-push-endpoint': String(input) } })) as typeof fetch;
}

export interface FlushResult {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

/**
 * Whether a push may still go out at `now` under a claim that ends at `leaseUntil`: the slowest push service's answer
 * (SEND_TIMEOUT_MS) and the save after it must fit, or another sender could take the event once the claim ran out and
 * send it again.
 */
export function canSend(now: number, leaseUntil: number): boolean {
  return now + SEND_TIMEOUT_MS + LEASE_MARGIN_MS <= leaseUntil;
}

/**
 * What becomes of an event whose handling broke off with an error (D1, signing) on its `attempts`-th try: sent when a
 * browser already got it; otherwise tried again after the usual wait, until MAX_ATTEMPTS or its expiry.
 */
export function afterError(
  results: readonly SendResult[] | null,
  attempts: number,
  now: number,
  expiresAt: number,
): { status: 'sent' } | { status: 'failed' } | { status: 'pending'; at: number } {
  if (results?.some((r) => r.ok)) return { status: 'sent' };
  const at = retryAt(attempts, now, expiresAt);
  return at === null ? { status: 'failed' } : { status: 'pending', at };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Sends what is due: one member's (right after an action queued it) or anyone's (the minute cron). Returns at once,
 * without touching D1, when the server has no push keys.
 *
 * Every check reads the clock again (a run can take a while; tests pass their own `clock`), and each event's outcome is
 * saved before the next event is looked at, so a member's cooldown and hourly cap count what this run has just sent (a
 * run that cannot save an outcome stops there and gives the rest back). Both count pushes by when they went out. A member's
 * direct messages and invites are claimed by one sender at a time (none while another sender holds one of them), so
 * two runs at once never both send what the cooldown allows once. A push goes out only while the claim outlasts the
 * push service's slowest answer (canSend); otherwise the event and the rest are given back untried.
 */
export async function flushPush(env: Env, opts: { user?: string; limit?: number; clock?: () => number } = {}): Promise<FlushResult> {
  const out: FlushResult = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 };
  if (!pushConfigured(env)) return out;
  const db = env.DB;
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  const { results: events } = await db
    .prepare(
      `UPDATE notification_events SET lease_until = ?2, attempts = attempts + 1
        WHERE id IN (SELECT n.id FROM notification_events n
                      WHERE n.status = 'pending' AND n.next_attempt_at <= ?1 AND (n.lease_until IS NULL OR n.lease_until <= ?1)
                        ${opts.user ? 'AND n.user_id = ?4' : ''}
                        AND NOT (n.type IN ('dm', 'invite') AND EXISTS (
                              SELECT 1 FROM notification_events o
                               WHERE o.user_id = n.user_id AND o.type IN ('dm', 'invite') AND o.status = 'pending' AND o.lease_until > ?1))
                      ORDER BY n.next_attempt_at LIMIT ?3)
          AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?1)
        RETURNING id, user_id, type, url, coalesce_key, attempts, expires_at, created_at, lease_until`,
    )
    .bind(start, start + LEASE_MS, Math.min(opts.limit ?? 20, 50), ...(opts.user ? [opts.user] : []))
    .all<EventRow>();
  out.claimed = events.length;
  if (!events.length) return out;
  // Oldest first (RETURNING keeps no order): of a friend's messages a minute apart, the first is the one sent.
  events.sort((x, y) => x.created_at - y.created_at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const keys: VapidKeys = { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! };
  const fetcher = fetcherFor(env);
  let budget = SEND_BUDGET;
  // Only the claim this run holds is finished by it.
  const finish = (ev: EventRow, status: 'sent' | 'skipped' | 'failed' | 'expired', reason: string | null, at: number) =>
    db
      .prepare(`UPDATE notification_events SET status = ?2, reason = ?3, sent_at = ?4, lease_until = NULL WHERE id = ?1 AND lease_until = ?5 AND status = 'pending'`)
      .bind(ev.id, status, reason, status === 'sent' ? at : null, ev.lease_until);
  const later = (ev: EventRow, at: number, reason: string) =>
    db.prepare(`UPDATE notification_events SET next_attempt_at = ?2, reason = ?3, lease_until = NULL WHERE id = ?1 AND lease_until = ?4 AND status = 'pending'`).bind(ev.id, at, reason, ev.lease_until);
  /** Gives back the events from `from` on, untried: the next run takes them (these tries are not counted). */
  const giveBack = async (from: number) => {
    const rest = events
      .slice(from)
      .map((ev) => db.prepare(`UPDATE notification_events SET attempts = attempts - 1, lease_until = NULL WHERE id = ?1 AND lease_until = ?2 AND status = 'pending'`).bind(ev.id, ev.lease_until));
    if (rest.length) await db.batch(rest).catch((e: unknown) => console.warn('push events not given back', message(e)));
  };
  const skip = async (ev: EventRow, why: string) => {
    await finish(ev, why === 'expired' ? 'expired' : 'skipped', why, clock()).run();
    out.skipped++;
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    let results: SendResult[] | null = null;
    try {
      // Tried MAX_ATTEMPTS times already (a sender that stopped, or could not save, left it claimed): no more tries.
      if (ev.attempts > MAX_ATTEMPTS) {
        await finish(ev, 'failed', 'retries', clock()).run();
        out.failed++;
        continue;
      }
      const col = COLUMN[ev.type];
      if (!col) {
        await skip(ev, 'unknown_type');
        continue;
      }
      const r = await db
        .prepare(
          `SELECT u.status, u.locale, COALESCE(ns.service, 0) AS service, COALESCE(ns.night, 0) AS night, COALESCE(ns.${col}, 0) AS typeOn
             FROM users u LEFT JOIN notification_settings ns ON ns.user_id = u.id WHERE u.id = ?1`,
        )
        .bind(ev.user_id)
        .first<{ status: string; locale: string | null; service: number; night: number; typeOn: number }>();
      const recipient: Recipient | null = r ? { status: r.status, service: !!r.service, night: !!r.night, typeOn: !!r.typeOn } : null;
      const times = { createdAt: ev.created_at, expiresAt: ev.expires_at };
      const why = gate(times, recipient, clock());
      if (why) {
        await skip(ev, why);
        continue;
      }
      const other = otherOf(ev.coalesce_key);
      if (ev.type === 'dm' || ev.type === 'invite' || ev.type === 'friend_request' || ev.type === 'friend_accepted') {
        // The friendship (or the request) still stands, the friend is still an active member, and neither blocked the other.
        if (!other) {
          await skip(ev, 'no_relation');
          continue;
        }
        const [a, b] = ev.user_id < other ? [ev.user_id, other] : [other, ev.user_id];
        const rel = await db
          .prepare(
            `SELECT 1 AS ok FROM friendships f JOIN users s ON s.id = ?3 AND s.status = 'active'
              WHERE f.user_a = ?1 AND f.user_b = ?2
                AND ${ev.type === 'friend_request' ? `f.status = 'pending' AND f.requester_id = ?3` : `f.status = 'accepted'`}
                AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id = ?1 AND ub.blocked_id = ?2) OR (ub.blocker_id = ?2 AND ub.blocked_id = ?1))`,
          )
          .bind(a, b, other)
          .first<{ ok: number }>();
        if (!rel) {
          await skip(ev, 'no_relation');
          continue;
        }
      }
      if (ev.type === 'dm' || ev.type === 'invite') {
        // What was sent is saved before the next event is looked at (below), so this counts this run's pushes too.
        // Counted by when they went out (an event that waited is a push of the hour it was sent in).
        const now = clock();
        const recent = await db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM notification_events WHERE user_id = ?1 AND type IN ('dm', 'invite') AND status = 'sent' AND sent_at > ?2) AS hour,
                    (SELECT MAX(sent_at) FROM notification_events WHERE user_id = ?1 AND coalesce_key = ?3 AND status = 'sent' AND sent_at > ?2) AS last`,
          )
          .bind(ev.user_id, now - 3_600_000, ev.coalesce_key)
          .first<{ hour: number; last: number | null }>();
        if ((recent?.hour ?? 0) >= DM_HOURLY_CAP) {
          await skip(ev, 'hourly_cap');
          continue;
        }
        // The friend's earlier push is still shown (same tag): no second one within the minute.
        if (recent?.last && now - recent.last < DM_COOLDOWN_MS) {
          await skip(ev, 'cooldown');
          continue;
        }
        // Reading that conversation right now: the page shows it already.
        if (await isViewing(env, ev.user_id, `dm:${other}`)) {
          await skip(ev, 'viewing');
          continue;
        }
      }
      // Browsers of sign-ins that still exist (signing out removes them too; this also covers a sign-in that ran out).
      const { results: devices } = await db
        .prepare(
          `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, ps.failures FROM push_subscriptions ps
             JOIN sessions s ON s.id = ps.session_id AND s.user_id = ps.user_id AND s.kind = 'user' AND s.expires_at > ?2
            WHERE ps.user_id = ?1 AND ps.disabled_at IS NULL
            ORDER BY ps.updated_at DESC LIMIT 10`,
        )
        .bind(ev.user_id, clock())
        .all<DeviceRow>();
      if (!devices.length) {
        await skip(ev, 'no_device');
        continue;
      }
      const sendAt = clock();
      // Over this run's budget, or too little of the claim left to send and save: this one and the rest wait for the
      // next run.
      if (devices.length > budget || !canSend(sendAt, ev.lease_until)) {
        await giveBack(i);
        break;
      }
      // Night may have begun, or the event expired, while the checks above ran: judged again right before it goes.
      const late = gate(times, recipient, sendAt);
      if (late) {
        await skip(ev, late);
        continue;
      }
      budget -= devices.length;
      const text = pushText(ev.type, r!.locale);
      const tag = ev.coalesce_key ?? `${ev.type}:${ev.id}`;
      const payload: PushPayload = { t: TYPE_OF[ev.type], title: text.title, body: text.body, lang: text.lang, url: ev.url, to: ev.user_id, tag, ts: ev.created_at };
      const topic = ev.coalesce_key ? await pushTopic(ev.coalesce_key) : undefined;
      // Kept by the push service no longer than the event lasts (a browser offline until then never gets it late).
      const ttl = Math.max(0, Math.floor((ev.expires_at - sendAt) / 1000));
      // Each judged again right before it goes (expiresAt): what ran out meanwhile is not sent.
      results = await Promise.all(
        devices.map((d) => sendPush(d, payload, keys, { ttl, urgency: URGENCY[ev.type], topic, now: sendAt, expiresAt: ev.expires_at, clock, fetcher })),
      );
      const done = clock();
      const writes: D1PreparedStatement[] = [];
      results.forEach((res, k) => {
        const d = devices[k]!;
        if (res.ok) writes.push(db.prepare(`UPDATE push_subscriptions SET last_success_at = ?2, failures = 0 WHERE id = ?1`).bind(d.id, done));
        // Not sent: nothing to say about the browser.
        else if (res.expired) return;
        else if (res.gone || (!res.retry && d.failures + 1 >= MAX_DEVICE_FAILURES)) writes.push(db.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(d.id));
        else writes.push(db.prepare(`UPDATE push_subscriptions SET last_failure_at = ?2, failures = failures + 1 WHERE id = ?1`).bind(d.id, done));
      });
      const o = outcome(results);
      const at = o === 'retry' ? retryAt(ev.attempts, done, ev.expires_at) : null;
      if (o === 'sent') writes.push(finish(ev, 'sent', null, done));
      else if (o === 'expired') writes.push(finish(ev, 'expired', 'expired', done));
      else if (o === 'retry' && at !== null) writes.push(later(ev, at, 'retry'));
      else writes.push(finish(ev, 'failed', o === 'retry' ? 'retries' : o, done));
      // Saved before the next event is looked at: its cooldown and hourly cap count this one.
      await db.batch(writes);
      if (o === 'sent') out.sent++;
      else if (o === 'expired') out.skipped++;
      else if (o === 'retry' && at !== null) out.retried++;
      else out.failed++;
    } catch (e) {
      console.warn('push event not sent', message(e));
      // Recorded, not left claimed: an error that repeats never gets more than MAX_ATTEMPTS tries.
      const next = afterError(results, ev.attempts, clock(), ev.expires_at);
      try {
        if (next.status === 'pending') await later(ev, next.at, 'error').run();
        else await finish(ev, next.status, next.status === 'sent' ? null : 'error', clock()).run();
        if (next.status === 'sent') out.sent++;
        else if (next.status === 'pending') out.retried++;
        else out.failed++;
      } catch {
        // Left claimed: the next run after the claim takes it, and stops at MAX_ATTEMPTS (above). Nothing more is sent
        // in this run: what went out could not be saved, so the next event's cooldown and hourly cap would miss it.
        await giveBack(i + 1);
        break;
      }
    }
  }
  return out;
}

/**
 * Queues pushes for an action that has already been committed, and sends them in the background when there is a
 * request to wait on (otherwise the minute cron does). A failure is only logged: the action stands.
 */
export async function queuePush(env: Env, statements: D1PreparedStatement[], ctx?: Pick<ExecutionContext, 'waitUntil'>, user?: string): Promise<number> {
  // Without the push keys nothing could be sent: nothing is queued (and D1 is not asked).
  if (!statements.length || !pushConfigured(env)) return 0;
  try {
    const res = await env.DB.batch(statements);
    const queued = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    if (queued > 0 && ctx && pushConfigured(env))
      ctx.waitUntil(flushPush(env, user ? { user, limit: 5 } : { limit: 20 }).then(() => undefined, (e: unknown) => console.warn('push flush failed', e instanceof Error ? e.message : String(e))));
    return queued;
  } catch (e) {
    console.warn('push not queued', e instanceof Error ? e.message : String(e));
    return 0;
  }
}
