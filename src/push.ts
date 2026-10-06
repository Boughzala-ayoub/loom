/** Web Push from Loom's window (docs/phone-notifications-study.md): a task
 * notice encrypted for one phone's subscription (RFC 8291) and signed with
 * Loom's key (VAPID, RFC 8292), all with WebCrypto. remote.rs keeps the
 * subscriptions and posts what this builds. */

/** A phone's subscription: where to post, and its keys, base64url. */
export type PushSub = { endpoint: string; p256dh: string; auth: string };
/** Loom's signing key: the public half phones subscribe with, base64url, and the private half as a JWK. */
export type PushKey = { public: string; private: JsonWebKey };
/** What the phone's service worker shows: remote-sw.js reads these. */
export type PushMessage = { title: string; body: string; url: string; tag: string; at: number };

const text = new TextEncoder();
export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
function cat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function newPushKey(): Promise<PushKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { public: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), private: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/** RFC 8291's aes128gcm body for one subscription: one record, with a fresh
 * key pair and salt unless `fixed` gives them (the RFC's worked example). */
export async function encrypt(plain: Uint8Array, sub: PushSub, fixed?: { pair: CryptoKeyPair; salt: Uint8Array }) {
  const pair = fixed?.pair ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]));
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaPublic = unb64u(sub.p256dh);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, pair.privateKey, 256));
  const ikm = await hkdf(unb64u(sub.auth), shared, cat(text.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The 0x02 ends the last (only) record; no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plain, Uint8Array.of(2))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return cat(head, asPublic, sealed);
}

/** RFC 8292: the Authorization header a push service checks, good for 12 hours. */
export async function vapid(endpoint: string, key: PushKey, now = Date.now()) {
  const signer = await crypto.subtle.importKey("jwk", key.private, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64u(text.encode(JSON.stringify(o)));
  // ponytail: a placeholder contact; push services may write to `sub` about abuse, and Loom has no address to give.
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:loom@localhost" })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, text.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(signature)}, k=${key.public}`;
}

/** The request for one subscription. Topic: a newer message for the same
 * agent replaces one the phone hasn't fetched yet. */
export async function pushRequest(sub: PushSub, key: PushKey, message: PushMessage) {
  const headers: [string, string][] = [
    ["Authorization", await vapid(sub.endpoint, key)],
    ["Content-Encoding", "aes128gcm"],
    ["Content-Type", "application/octet-stream"],
    ["TTL", String(12 * 3600)],
    ["Urgency", "high"],
    ["Topic", message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "loom"],
  ];
  return { endpoint: sub.endpoint, headers, body: await encrypt(text.encode(JSON.stringify(message)), sub) };
}
