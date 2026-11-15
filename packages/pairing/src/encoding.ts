// Byte helpers shared by the pairing module. Hand-written only because the module may not rely on
// DOM (`btoa`) or Node (`Buffer`) globals; none of this is cryptography.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REVERSE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

/** Strict inverse of `toBase64Url`: rejects padding, other alphabets and non-canonical trailing bits. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("invalid_base64url");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    const group = text.slice(i, i + 4);
    for (const ch of group) {
      const v = REVERSE.get(ch);
      if (v === undefined) throw new Error("invalid_base64url");
      n = (n << 6) | v;
    }
    n <<= 6 * (4 - group.length);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
    const unusedBits = group.length === 2 ? n & 0xffff : group.length === 3 ? n & 0xff : 0;
    if (unusedBits !== 0 && group.length < 4) throw new Error("invalid_base64url");
  }
  return out;
}

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** 8-byte big-endian unsigned integer (chunk indexes and manifest sequence numbers; below 2^53). */
export function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_u64");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function readU64be(bytes: Uint8Array, offset = 0): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_u64");
  return Number(value);
}

/** Length-prefixed concatenation, so two different field lists can never encode to the same bytes. */
export function lengthPrefixed(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += 4 + p.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    view.setUint32(o, p.length);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
}
