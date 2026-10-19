import { describe, expect, it, vi } from 'vitest';
import { allowedEndpoint, b64url, deviceLabel, ecdh, encryptPayload, fromB64url, onCurve, pushTopic, sendPush, validKeys, vapidAuthorization, type VapidKeys } from './webpush';

// RFC 8291 Appendix A: the worked example, byte for byte.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function jwk(pub: string, priv?: string): JsonWebKey {
  const p = fromB64url(pub);
  return { kty: 'EC', crv: 'P-256', x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ...(priv ? { d: priv } : {}) };
}

async function ecdhPair(pub: string, priv: string): Promise<CryptoKeyPair> {
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk(pub), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    privateKey: await crypto.subtle.importKey('jwk', jwk(pub, priv), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  };
}

/** The browser's side of RFC 8291, written out separately, to read back what encryptPayload wrote. */
async function decrypt(body: Uint8Array, uaPublic: string, uaPrivate: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ua = await ecdhPair(uaPublic, uaPrivate);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(asKey), ua.privateKey, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...fromB64url(uaPublic), ...asPublic]);
  const ikm = await hk(fromB64url(auth), shared, info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

/** A VAPID key pair made here, at test time (no key is written into the code). */
async function newVapid(): Promise<{ keys: VapidKeys; verifyKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const d = ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d!;
  return { keys: { publicKey: b64url(raw), privateKey: d, subject: 'https://jc-royal.site' }, verifyKey: pair.publicKey };
}

describe('aes128gcm (RFC 8291)', () => {
  it("gives the RFC's example body exactly with its salt and key pair", async () => {
    const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      salt: fromB64url(RFC.salt),
      serverKeys: await ecdhPair(RFC.asPublic, RFC.asPrivate),
    });
    expect(b64url(body)).toBe(RFC.body);
    expect(await decrypt(body, RFC.uaPublic, RFC.uaPrivate, RFC.auth)).toBe(RFC.plaintext);
  });

  it('a new salt and key pair for every message, each readable by the browser alone', async () => {
    const msg = new TextEncoder().encode(JSON.stringify({ t: 'dm', title: '새 메시지', url: '/friends/x' }));
    const a = await encryptPayload(msg, RFC.uaPublic, RFC.auth);
    const b = await encryptPayload(msg, RFC.uaPublic, RFC.auth);
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16)));
    expect(b64url(a.slice(21, 86))).not.toBe(b64url(b.slice(21, 86)));
    expect(JSON.parse(await decrypt(a, RFC.uaPublic, RFC.uaPrivate, RFC.auth))).toEqual({ t: 'dm', title: '새 메시지', url: '/friends/x' });
    // Another auth secret cannot read it.
    await expect(decrypt(a, RFC.uaPublic, RFC.uaPrivate, b64url(new Uint8Array(16)))).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('an ES256 token for the push service origin, at most 24 hours, with the subject, that verifies with the public key', async () => {
    const { keys, verifyKey } = await newVapid();
    const now = Date.UTC(2026, 9, 19, 3, 0, 0);
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
    expect(m).not.toBeNull();
    const [, head, claims, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(head!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const c = JSON.parse(new TextDecoder().decode(fromB64url(claims!)));
    expect(c).toEqual({ aud: 'https://fcm.googleapis.com', exp: expect.any(Number), sub: 'https://jc-royal.site' });
    expect(c.exp - now / 1000).toBeGreaterThan(0);
    expect(c.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(fromB64url(sig!).length).toBe(64);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64url(sig!), new TextEncoder().encode(`${head}.${claims}`));
    expect(ok).toBe(true);
    // Another push service: its own audience.
    const apple = await vapidAuthorization('https://web.push.apple.com/QGuQyavXut', keys, now);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(apple.split('.')[1]!))).aud).toBe('https://web.push.apple.com');
  });

  it('the token is reused within the hour and made again after', async () => {
    const { keys } = await newVapid();
    const now = Date.UTC(2026, 9, 19, 4, 0, 0);
    const ep = 'https://updates.push.services.mozilla.com/wpush/v2/gAAA';
    const a = await vapidAuthorization(ep, keys, now);
    expect(await vapidAuthorization(ep, keys, now + 59 * 60_000)).toBe(a);
    expect(await vapidAuthorization(ep, keys, now + 61 * 60_000)).not.toBe(a);
    // Another key pair (rotated): never the old token.
    const other = await newVapid();
    expect(await vapidAuthorization(ep, other.keys, now)).toContain(`k=${other.keys.publicKey}`);
  });
});

describe('push services allowed', () => {
  it('only the browsers’ push services, over https, with no port or credentials', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://api.push.apple.com/3/device/x',
      'https://wns2-bl2p.notify.windows.com/w/?token=x',
    ])
      expect(allowedEndpoint(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilpush.apple.com/x',
      'https://push.apple.com.evil.example/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://169.254.169.254/latest/meta-data',
      'https://jc-royal.site/api/admin',
      'file:///etc/passwd',
      'not a url',
      '',
    ])
      expect(allowedEndpoint(bad), bad).toBe(false);
  });

  it("the browser's keys: a P-256 point and a 16-byte secret", () => {
    expect(validKeys(RFC.uaPublic, RFC.auth)).toBe(true);
    expect(validKeys(RFC.uaPublic.slice(0, 40), RFC.auth)).toBe(false);
    expect(validKeys(RFC.uaPublic, 'AAAA')).toBe(false);
    expect(validKeys('!!!', RFC.auth)).toBe(false);
  });

  it('a point on the curve, not only its shape', async () => {
    expect(await onCurve(RFC.uaPublic)).toBe(true);
    // 65 bytes starting 0x04 ('B' is 000001: the first byte is 0x04), but not a point on P-256.
    const shaped = 'B'.repeat(87);
    expect(validKeys(shaped, RFC.auth)).toBe(true);
    expect(await onCurve(shaped)).toBe(false);
  });
});

describe('sending', () => {
  const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: RFC.uaPublic, auth: RFC.auth };

  it('posts the encrypted body with the headers push services want, never following a redirect', async () => {
    const { keys } = await newVapid();
    const fetcher = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 201 }));
    const topic = await pushTopic('dm:someone');
    const r = await sendPush(target, { t: 'dm', title: 'x' }, keys, { ttl: 3600, urgency: 'high', topic, now: Date.now(), fetcher: fetcher as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, status: 201 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(target.endpoint);
    expect(init!.redirect).toBe('manual');
    expect(init!.method).toBe('POST');
    const h = init!.headers as Record<string, string>;
    expect(h).toMatchObject({ 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Topic: topic });
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(topic).toMatch(/^[\w-]{32}$/);
    expect(JSON.parse(await decrypt(init!.body as Uint8Array, RFC.uaPublic, RFC.uaPrivate, RFC.auth))).toEqual({ t: 'dm', title: 'x' });
  });

  it('gone on 404/410, again later on 429/5xx or no answer, refused otherwise; never sent anywhere not allowed', async () => {
    const { keys } = await newVapid();
    const at = (status: number) => sendPush(target, {}, keys, { ttl: 60, now: Date.now(), fetcher: (async () => new Response(null, { status })) as unknown as typeof fetch });
    expect(await at(404)).toEqual({ ok: false, status: 404, gone: true, retry: false });
    expect(await at(410)).toEqual({ ok: false, status: 410, gone: true, retry: false });
    expect(await at(429)).toEqual({ ok: false, status: 429, gone: false, retry: true });
    expect(await at(503)).toEqual({ ok: false, status: 503, gone: false, retry: true });
    expect(await at(400)).toEqual({ ok: false, status: 400, gone: false, retry: false });
    expect(await at(301)).toEqual({ ok: false, status: 301, gone: false, retry: false });
    const down = await sendPush(target, {}, keys, { ttl: 60, now: Date.now(), fetcher: (async () => Promise.reject(new TypeError('network'))) as unknown as typeof fetch });
    expect(down).toEqual({ ok: false, status: 0, gone: false, retry: true });
    const never = vi.fn();
    const elsewhere = await sendPush({ ...target, endpoint: 'https://169.254.169.254/x' }, {}, keys, { ttl: 60, now: Date.now(), fetcher: never as unknown as typeof fetch });
    expect(elsewhere).toEqual({ ok: false, status: 0, gone: true, retry: false });
    expect(never).not.toHaveBeenCalled();
    // Keys that cannot be encrypted to (stored before the curve check): gone, and nothing is sent.
    const offCurve = await sendPush({ ...target, p256dh: 'B'.repeat(87) }, {}, keys, { ttl: 60, now: Date.now(), fetcher: never as unknown as typeof fetch });
    expect(offCurve).toEqual({ ok: false, status: 0, gone: true, retry: false });
    expect(never).not.toHaveBeenCalled();
  });

  it('judged again right before it goes: not sent once its event ran out, and kept no longer than what is left then', async () => {
    const { keys } = await newVapid();
    const fetcher = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 201 }));
    const t0 = Date.now();
    // Asked with 30 s left; 1.5 s went by while the body was encrypted and signed.
    const r = await sendPush(target, {}, keys, { ttl: 30, now: t0, expiresAt: t0 + 30_000, clock: () => t0 + 1_500, fetcher: fetcher as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, status: 201 });
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).TTL).toBe('28');
    const late = await sendPush(target, {}, keys, { ttl: 30, now: t0, expiresAt: t0 + 30_000, clock: () => t0 + 30_000, fetcher: fetcher as unknown as typeof fetch });
    expect(late).toEqual({ ok: false, status: 0, gone: false, retry: false, expired: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('device names', () => {
  it('browser and system only', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36')).toBe('Samsung Internet · Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge · Windows');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox · macOS');
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel('curl/8')).toBeNull();
  });
});
