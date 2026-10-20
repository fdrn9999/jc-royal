import type { PushDeviceDto, PushSubscribeResult, SwOwnerMessage, SwReadMessage } from '@jc/types';
import { api, ApiError } from './api';

/**
 * This browser's part of push notifications: whether it can get them, its permission, and its subscription, which is
 * registered for the member signed in here. The service worker (public/sw.js) is installed only when a member turns
 * pushes on in this browser and caches nothing. It is told who is signed in, so a push for another account is never
 * shown; signing out turns pushes off in this browser, and another account signing in here removes the previous
 * one's registration.
 */

export type PushSupport = 'supported' | 'ios-install' | 'unsupported';

/** Feature detection only. iPhone and iPad have Web Push in Home Screen apps alone (iOS 16.4+). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'supported';
  // Only Apple's mobile browsers have navigator.standalone: in Safari, not in a Home Screen app, push is not there yet.
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (typeof standalone === 'boolean' && !standalone && !window.matchMedia?.('(display-mode: standalone)').matches) return 'ios-install';
  return 'unsupported';
}

export function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** The member who turned pushes on in this browser (the subscription is theirs). */
const OWNER_KEY = 'jc-push-owner';
function lastOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}
function setLastOwner(uid: string | null) {
  try {
    if (uid) localStorage.setItem(OWNER_KEY, uid);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    /* private mode: the service worker's own record still decides what is shown */
  }
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (pushSupport() !== 'supported') return undefined;
  return navigator.serviceWorker.getRegistration('/').catch(() => undefined);
}

function tellOwner(reg: ServiceWorkerRegistration, uid: string | null) {
  const msg: SwOwnerMessage = { type: 'jc-owner', uid };
  (reg.active ?? reg.waiting ?? reg.installing)?.postMessage(msg);
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

async function register(sub: PushSubscription): Promise<PushSubscribeResult> {
  const j = sub.toJSON();
  return api<PushSubscribeResult>('/api/me/notifications/subscriptions', { body: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } } });
}

async function forget(sub: PushSubscription | null, tellServer: boolean) {
  if (!sub) return;
  if (tellServer) await api('/api/me/notifications/subscriptions/remove', { body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}

export type EnableResult = { ok: true; device: PushDeviceDto } | { ok: false; reason: 'unsupported' | 'denied' | 'dismissed' };

/** Turns pushes on in this browser for `uid`. Called from a tap: the permission prompt needs one. */
export async function enableDevice(uid: string): Promise<EnableResult> {
  if (pushSupport() !== 'supported') return { ok: false, reason: 'unsupported' };
  // Asked first, while the tap still counts (Safari shows the prompt only then).
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (p !== 'granted') return { ok: false, reason: p === 'denied' ? 'denied' : 'dismissed' };
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  tellOwner(reg, uid);
  const { publicKey } = await api<{ publicKey: string }>('/api/me/notifications/push-key');
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Made with another key (the server's was replaced): a new one.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await forget(sub, true);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { device } = await register(sub);
  setLastOwner(uid);
  return { ok: true, device };
}

/** Turns pushes off in this browser (the registration and the browser's subscription both go). */
export async function disableDevice(): Promise<void> {
  const reg = await registration();
  await forget((await reg?.pushManager.getSubscription()) ?? null, true);
  setLastOwner(null);
}

/** Consent withdrawn here: the server removed every registration; this browser's subscription goes too. */
export async function consentWithdrawn(): Promise<void> {
  const reg = await registration();
  await forget((await reg?.pushManager.getSubscription()) ?? null, false);
  setLastOwner(null);
}

/**
 * Once signed out (auth.tsx): pushes stop here, and what is shown goes from the screen. The server removes this
 * sign-in's registration with the sign-out itself, so nothing is asked of it here.
 */
export async function pushSignOut(): Promise<void> {
  const reg = await registration();
  if (!reg) return;
  tellOwner(reg, null);
  await forget(await reg.pushManager.getSubscription(), false);
  setLastOwner(null);
}

/**
 * A conversation read here: its pushes still shown in this browser (the friend's messages and invites) go, if it is
 * still read here (`reading`) once the service worker is found; left meanwhile, a push shown since may be for a newer
 * message, still unread. Nothing where pushes were never turned on. Other devices keep theirs until tapped; nothing
 * more is pushed for a read message.
 */
export async function closeReadPushes(friend: string, reading: () => boolean): Promise<void> {
  const reg = await registration();
  if (!reading()) return;
  const msg: SwReadMessage = { type: 'jc-read', tags: [`dm:${friend}`, `invite:${friend}`] };
  reg?.active?.postMessage(msg);
}

/**
 * While the app is open, from the moment the sign-in is known: tells the service worker who is signed in (or nobody),
 * keeps this browser's registration current for the member who turned it on here (one request when the page opens;
 * the server writes nothing when it is the same), removes it when someone else is signed in or the permission was
 * taken back. Nothing at all when pushes were never turned on in this browser. (A tapped push is followed to its page
 * by push-nav.ts, listening from the start.)
 */
export function startPush(uid: string | null): () => void {
  let stopped = false;
  void (async () => {
    const reg = await registration();
    if (!reg || stopped) return;
    tellOwner(reg, uid);
    void reg.update().catch(() => undefined);
    if (!uid) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || stopped) return;
    if (lastOwner() !== uid || Notification.permission !== 'granted') {
      // Turned on by another account, or no longer allowed: not this member's to keep.
      await forget(sub, true);
      setLastOwner(null);
      return;
    }
    try {
      const { publicKey } = await register(sub);
      const key = keyBytes(publicKey);
      if (stopped || sameKey(sub.options.applicationServerKey, key)) return;
      // The server's key was replaced: subscriptions made with the old one no longer get pushes. A new one (the
      // permission is already given, so no prompt).
      await forget(sub, true);
      await register(await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    } catch (e) {
      // Consent withdrawn (on any device) took every registration with it: it is turned on again by hand.
      if (e instanceof ApiError && e.code === 'push_consent_required') {
        await forget(sub, false);
        setLastOwner(null);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
