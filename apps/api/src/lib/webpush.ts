/**
 * Web Push from a Worker with WebCrypto alone (no Node library): the VAPID signature the push service checks (RFC 8292,
 * ES256) and the message encrypted to the browser (RFC 8291 over RFC 8188 aes128gcm), so the push service carries it
 * without being able to read it. Only push services on the list below are ever called, over HTTPS, without following a
 * redirect; an endpoint is never logged or returned (it is a secret of the browser's subscription).
 */

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The push services browsers subscribe with: Chrome, Edge (Chromium), Samsung Internet and Opera (FCM), Firefox
 * (Mozilla), Safari (Apple), and Edge on Windows' own service. Anything else, a port, credentials in the URL or plain
 * HTTP is refused, so a subscription can't point the worker at another host.
 */
export function allowedEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return (
    h === 'fcm.googleapis.com' ||
    h === 'updates.push.services.mozilla.com' ||
    h === 'web.push.apple.com' ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/.test(h) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(h)
  );
}

/** A P-256 public point as browsers give it (65 bytes, uncompressed) and an auth secret of 16 bytes. */
export function validKeys(p256dh: string, auth: string): boolean {
  try {
    const p = fromB64url(p256dh);
    return p.length === 65 && p[0] === 4 && fromB64url(auth).length === 16;
  } catch {
    return false;
  }
}

/** Whether the public key is a point on P-256 (the shape alone, as validKeys checks, would take one that is not). */
export async function onCurve(p256dh: string): Promise<boolean> {
  try {
    await crypto.subtle.importKey('raw', fromB64url(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch {
    return false;
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * ECDH with the other side's public key. WebCrypto names the field `public` (so do workerd and Node at run time); the
 * Workers typings spell it `$public`, so only the type is bent here.
 */
export const ecdh = (other: CryptoKey) => ({ name: 'ECDH', public: other }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

/** The record size written in the header (one record carries the whole message). */
const RECORD_SIZE = 4096;

export interface EncryptOptions {
  /** For the RFC's test vectors only: otherwise a new salt and a new key pair for every message. */
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
}

/** RFC 8291: `plaintext` encrypted to the browser's key `p256dh` with its `auth` secret, as the aes128gcm body. */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = opts.serverKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(uaKey), as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record, the last: the message and the 0x02 delimiter, no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

export interface VapidKeys {
  /** base64url of the 65-byte public point (what browsers subscribe with as applicationServerKey). */
  publicKey: string;
  /** base64url of the 32-byte private scalar (a secret: wrangler secret put VAPID_PRIVATE_KEY). */
  privateKey: string;
  /** An https URL (or mailto:) the push services can reach the operator at. */
  subject: string;
}

let signing: { pair: string; key: Promise<CryptoKey> } | null = null;
function signingKey(k: VapidKeys): Promise<CryptoKey> {
  const pair = `${k.publicKey}.${k.privateKey}`;
  if (signing?.pair !== pair) {
    const pub = fromB64url(k.publicKey);
    const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: k.privateKey, ext: false };
    signing = { pair, key: crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    signing.key.catch(() => (signing = null));
  }
  return signing.key;
}

/** The token is good for 12 hours (the most is 24); reused for an hour per push service. */
const VAPID_TTL_S = 12 * 3600;
const tokens = new Map<string, { value: string; until: number }>();

/** RFC 8292: `Authorization: vapid t=<ES256 JWT for the push service's origin>, k=<public key>`. */
export async function vapidAuthorization(endpoint: string, k: VapidKeys, now: number): Promise<string> {
  const aud = new URL(endpoint).origin;
  const cached = tokens.get(aud);
  if (cached && cached.until > now && cached.value.endsWith(`k=${k.publicKey}`)) return cached.value;
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: k.subject })));
  // WebCrypto's ECDSA signature is r || s (64 bytes), which is what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(k), enc.encode(`${head}.${claims}`));
  const value = `vapid t=${head}.${claims}.${b64url(sig)}, k=${k.publicKey}`;
  tokens.set(aud, { value, until: now + 3_600_000 });
  return value;
}

/** The Topic header (at most 32 base64url characters): pushes with the same one replace each other while undelivered. */
export async function pushTopic(key: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(key))).slice(0, 32);
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  /** Seconds the push service may hold it while the device is offline. */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  now: number;
  /**
   * When what the push reports runs out: judged again by `clock` right before the push goes (encrypting and signing
   * take a moment), and the TTL is no more than what is left then.
   */
  expiresAt?: number;
  clock?: () => number;
  fetcher?: typeof fetch;
}

/**
 * `gone`: the subscription is no more (404/410, or never allowed): never use it again. `retry`: the push service is busy
 * or failed (429, 5xx, no answer): try later. Neither: refused (400/401/403/413): counted as a failure. `expired`: not
 * sent, what it reports ran out just before (nothing is wrong with the subscription).
 */
export type SendResult = { ok: true; status: number } | { ok: false; status: number; gone: boolean; retry: boolean; expired?: true };

/** A push service gets this long to answer; no answer by then is tried again later (as a busy one). */
export const SEND_TIMEOUT_MS = 10_000;

export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, opts: SendOptions): Promise<SendResult> {
  if (!allowedEndpoint(target.endpoint) || !validKeys(target.p256dh, target.auth)) return { ok: false, status: 0, gone: true, retry: false };
  let body: Uint8Array;
  try {
    body = await encryptPayload(enc.encode(JSON.stringify(payload)), target.p256dh, target.auth);
  } catch {
    // Keys no browser could have made: never deliverable, so the subscription goes.
    return { ok: false, status: 0, gone: true, retry: false };
  }
  const authorization = await vapidAuthorization(target.endpoint, keys, opts.now);
  let ttl = opts.ttl;
  if (opts.expiresAt !== undefined) {
    const left = opts.expiresAt - (opts.clock ?? Date.now)();
    if (left <= 0) return { ok: false, status: 0, gone: false, retry: false, expired: true };
    ttl = Math.min(ttl, left / 1000);
  }
  const headers: Record<string, string> = {
    Authorization: authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(ttl))),
    Urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.Topic = opts.topic;
  let res: Response;
  try {
    res = await (opts.fetcher ?? fetch)(target.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 0, gone: false, retry: true };
  }
  // The answer's body is not read: nothing in it is needed, and it may echo the endpoint.
  await res.body?.cancel().catch(() => undefined);
  const s = res.status;
  if (s >= 200 && s < 300) return { ok: true, status: s };
  return { ok: false, status: s, gone: s === 404 || s === 410, retry: s === 429 || s >= 500 };
}

/** A coarse device name for the member's own list ("Chrome · Android"), from the browser's description. */
export function deviceLabel(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /SamsungBrowser\//.test(ua)
    ? 'Samsung Internet'
    : /Whale\//.test(ua)
      ? 'Whale'
      : /Edg(A|iOS)?\//.test(ua)
        ? 'Edge'
        : /OPR\//.test(ua)
          ? 'Opera'
          : /Firefox\/|FxiOS\//.test(ua)
            ? 'Firefox'
            : /Chrome\/|CriOS\//.test(ua)
              ? 'Chrome'
              : /Safari\//.test(ua)
                ? 'Safari'
                : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const label = [browser, os].filter(Boolean).join(' · ');
  return label || null;
}
