// Web Push encryption and signing (push.ts) against RFC 8291's worked example.
// Run: node --experimental-strip-types src/push.test.ts
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
import { b64u, encrypt, pushRequest, unb64u, vapid, newPushKey, type PushSub } from "./push.ts";

const join = (s: string) => s.replace(/\s+/g, "");
// RFC 8291, section 5 and appendix A.
const rfc = {
  plain: "When I grow up, I want to be a watermelon",
  asPublic: join("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: join("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: join(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};
const text = new TextEncoder();

/** An ECDH key pair from a raw private scalar and its uncompressed public point. */
async function ecdh(priv: string, pub: string): Promise<CryptoKeyPair> {
  const p = unb64u(pub);
  const jwk = { kty: "EC", crv: "P-256", d: priv, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)) };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", p, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
}

/** What the phone does with a body: RFC 8291 from the receiving end. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, sub: PushSub) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen);
  const as = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, ua.privateKey, 256));
  const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const uaPublic = unb64u(sub.p256dh);
  const ikm = await hkdf(unb64u(sub.auth), shared, new Uint8Array([...text.encode("WebPush: info\0"), ...uaPublic, ...asPublic]), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  assert.equal(plain[plain.length - 1], 2, "one record, ended with the 0x02 delimiter");
  return new TextDecoder().decode(plain.slice(0, -1));
}

{
  const sub = { endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV", p256dh: rfc.uaPublic, auth: rfc.auth };
  const body = await encrypt(text.encode(rfc.plain), sub, { pair: await ecdh(rfc.asPrivate, rfc.asPublic), salt: unb64u(rfc.salt) });
  assert.equal(b64u(body), rfc.body, "RFC 8291's example, byte for byte");
  assert.equal(await decrypt(body, await ecdh(rfc.uaPrivate, rfc.uaPublic), sub), rfc.plain);
  console.log("ok   RFC 8291's worked example encrypts byte for byte");
}

{
  // A fresh subscription and Loom's fresh key, as a real push uses them.
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc:def", p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const key = await newPushKey();
  const message = { title: "work:1 · Claude finished · 4m", body: "Done: the login test passes.", url: "/#/pane/p1/work%3A1", tag: "muwivnwj-9", at: 1 };
  const r = await pushRequest(sub, key, message);
  assert.deepEqual(JSON.parse(await decrypt(r.body, ua, sub)), message, "the phone reads what Loom sent");
  const h = Object.fromEntries(r.headers);
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.Urgency, "high");
  assert.equal(h.Topic, "muwivnwj-9");
  assert.equal(r.endpoint, sub.endpoint);

  // The VAPID token: signed with Loom's key, for this push service, for 12 hours.
  const now = Date.UTC(2026, 9, 6, 12);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(await vapid(sub.endpoint, key, now))!;
  assert.equal(k, key.public);
  const [head, claims, signature] = token.split(".");
  const verifier = await crypto.subtle.importKey("raw", unb64u(key.public), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, unb64u(signature), text.encode(`${head}.${claims}`)), "the signature verifies with the public key");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64u(head))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64u(claims))), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:loom@localhost" });
  assert.equal(Object.fromEntries((await pushRequest(sub, key, { ...message, tag: "a b/c+d" })).headers).Topic, "abcd", "a Topic keeps to base64url");
  console.log("ok   a push decrypts on the phone's side and its VAPID token verifies");
}
