import { bytesToHex } from "./hex";
// crypto.randomUUID() is a SECURE-CONTEXT-ONLY API. localhost (even over plain
// HTTP) counts as secure, so it works on the dev machine — but a phone hitting
// the self-hosted stack over a LAN IP (http://100.x.x.x:5000) is an INSECURE
// context, where `crypto.randomUUID` is simply `undefined`. Every mutation mints
// an event/idempotency id with it, so on the phone create/delete/etc. threw
// `crypto.randomUUID is not a function` and silently did nothing — reads (which
// never mint an id) kept working, which is exactly the "can read but can't write
// over LAN" symptom. crypto.getRandomValues() is NOT secure-context-gated, so we
// build a spec-correct v4 UUID from it as the fallback.
//
// installUuidPolyfill() patches the missing global so all 50+ existing
// `crypto.randomUUID()` call sites (and any future ones) keep working unchanged;
// randomUUID() is the same logic as a direct export for new code that prefers it.

function v4FromRandomBytes(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  return (
    hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + "-" +
    hex[b[4]] + hex[b[5]] + "-" +
    hex[b[6]] + hex[b[7]] + "-" +
    hex[b[8]] + hex[b[9]] + "-" +
    hex[b[10]] + hex[b[11]] + hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
  );
}

/** A v4 UUID that works in insecure contexts too (LAN-IP HTTP self-host). */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return v4FromRandomBytes();
}

/** Install the getRandomValues fallback onto crypto.randomUUID when the native
 *  one is absent (insecure context). Idempotent; call once per JS realm — the
 *  main thread (main.tsx) AND each Worker have their own `crypto`, so the worker
 *  installs it separately. A no-op where the native API already exists. */
export function installUuidPolyfill(): void {
  if (typeof crypto === "undefined") return;
  if (typeof crypto.randomUUID === "function") return;
  try {
    Object.defineProperty(crypto, "randomUUID", {
      value: v4FromRandomBytes,
      configurable: true,
      writable: true,
    });
  } catch {
    /* read-only crypto (very old engines) — direct randomUUID() callers still work */
  }
}

/** A name-based (version 5, RFC 9562) UUID: the same `name` in the same
 *  `namespace` gives the same id on every device. For a record that must exist
 *  once per natural key (today's note per person and date, lib/data/dayNotes.ts),
 *  so two offline creates converge on one id instead of minting two. Pure and
 *  synchronous: crypto.subtle is secure-context-only (absent over plain-HTTP
 *  LAN, see above), so SHA-1 is computed here. */
export function nameBasedUUID(namespace: string, name: string): string {
  const ns = namespace.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(ns)) throw new Error(`namespace is not a UUID: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const b = sha1(input).subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** SHA-1 (FIPS 180-4) of `bytes` — only for name-based ids, never for security. */
function sha1(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 || i >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = next;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0; h[4] = (h[4]! + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}
