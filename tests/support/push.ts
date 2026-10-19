/**
 * The browser's side of Web Push for integration tests: a subscription with real keys (as PushManager.subscribe makes
 * one), reading back what the local push service stand-in received (push-sink.ts), and decrypting it as the browser
 * would (RFC 8291 aes128gcm), so a test sees exactly what a device would show.
 */
import { BASE, type Client } from './client';
import type { SinkRecord } from './push-sink';

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

/** Bytes WebCrypto takes (backed by a plain ArrayBuffer). */
type Bytes = Uint8Array<ArrayBuffer>;

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: CryptoKey;
  publicRaw: Bytes;
  authSecret: Bytes;
}

/**
 * A subscription at the FCM address with a fresh key pair. `behaviour`: how the stand-in answers pushes to it
 * ('gone' 410, 'busy' 503, 'bad' 400, otherwise 201).
 */
export async function browserSubscription(behaviour: 'ok' | 'gone' | 'busy' | 'bad' = 'ok'): Promise<BrowserSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const token = `${behaviour === 'ok' ? 'ok' : behaviour}-${crypto.randomUUID()}`;
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys: { p256dh: b64url(publicRaw), auth: b64url(authSecret) }, privateKey: pair.privateKey, publicRaw, authSecret };
}

/** What the page posts to register it. */
export const subscriptionBody = (s: BrowserSubscription) => ({ endpoint: s.endpoint, keys: s.keys });

export const subscribe = (c: Client, s: BrowserSubscription) => c.post('/api/me/notifications/subscriptions', subscriptionBody(s));

/** Every push the stand-in got for this subscription, oldest first. */
export async function received(s: BrowserSubscription | string): Promise<SinkRecord[]> {
  const sink = process.env.TEST_PUSH_SINK;
  if (!sink) throw new Error('no push sink (tests/support/global-setup.ts starts one)');
  const endpoint = typeof s === 'string' ? s : s.endpoint;
  const res = await fetch(`${new URL(sink).origin}/received?endpoint=${encodeURIComponent(endpoint)}`);
  return (await res.json()) as SinkRecord[];
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** RFC 8291 / 8188: the browser's decryption of an aes128gcm push body. */
export async function decrypt(s: BrowserSubscription, record: SinkRecord): Promise<Record<string, unknown>> {
  const body = new Uint8Array(Buffer.from(record.body, 'base64'));
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, s.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...s.publicRaw, ...asPublic]);
  const ikm = await hkdf(s.authSecret, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  // The last record ends with the 0x02 delimiter, after any zero padding is stripped from the end.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('push record has no last-record delimiter');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end))) as Record<string, unknown>;
}

/** Runs the minute cron once (the push outbox), as the scheduler would. */
export async function runPushCron(): Promise<void> {
  const res = await fetch(`${BASE()}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  await res.body?.cancel();
  if (!res.ok) throw new Error(`scheduled run failed: ${res.status}`);
}

/** Waits until `check` holds (pushes go out in the background after the request that queued them answers). */
export async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (check(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}
