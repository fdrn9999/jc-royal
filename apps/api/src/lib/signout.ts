import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { adminMonitorRevoke } from './admin-monitor';
import { presenceSignOut, type SignOutScope } from './presence';
import { realtimeSignOut } from './realtime';

export type { SignOutScope };

/**
 * What ends with sign-ins besides their session rows, called after those rows are deleted: the devices' status on the
 * presence hub, their pages' realtime sockets, the control center's sockets of those that were console sign-ins (the
 * same scope: a member's sign-in has none there), and the browsers registered for pushes in them. A failure here never
 * fails the sign-out: a push is only ever sent to a subscription whose sign-in still exists (lib/notify.ts), so a row
 * left behind is never used.
 */
export function signedOut(c: Context<AppEnv>, scope: SignOutScope) {
  presenceSignOut(c, scope);
  realtimeSignOut(c, scope);
  adminMonitorRevoke(c, scope);
  const db = c.env.DB;
  const drop =
    'session' in scope
      ? db.prepare('DELETE FROM push_subscriptions WHERE session_id = ?1').bind(scope.session)
      : 'except' in scope
        ? db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?1 AND session_id <> ?2').bind(scope.user, scope.except)
        : db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?1').bind(scope.user);
  c.executionCtx.waitUntil(drop.run().then(() => undefined, () => console.warn('push subscriptions not removed at sign-out')));
}
