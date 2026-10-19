// Makes a VAPID key pair for Web Push (RFC 8292) with WebCrypto and prints it, nothing else: no file is written, and
// the private key is meant to go straight into a secret (docs/DEPLOYMENT.md):
//   node tools/vapid-keys.mjs
//   wrangler secret put VAPID_PUBLIC_KEY -c apps/api/wrangler.jsonc --env production    (paste the public key)
//   wrangler secret put VAPID_PRIVATE_KEY -c apps/api/wrangler.jsonc --env production   (paste the private key)
// The public key is not secret (every browser gets it), but keeping the pair together means one place to change it.
// VAPID_SUBJECT is in apps/api/wrangler.jsonc vars.
// A new pair makes every browser subscription made with the old one useless: browsers register again when they open
// the site (apps/web/src/lib/push.ts), and pushes to the old ones fail and are dropped.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
const b64url = (b) => Buffer.from(b).toString('base64url');
process.stdout.write(`VAPID_PUBLIC_KEY=${b64url(raw)}\nVAPID_PRIVATE_KEY=${d}\n`);
