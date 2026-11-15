// node:crypto 的瀏覽器替身：只含後端用到的 randomUUID / randomBytes / createHash（同步 SHA-256，用 @noble/hashes）。
// 沒有：createCipheriv / createDecipheriv（API 金鑰加密；試用版的金鑰存在使用者自己的瀏覽器，見 README §8）。
import { sha256 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { Buffer } from "buffer";
export const randomUUID = () => crypto.randomUUID();
export const randomBytes = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
export function createHash(alg) {
  const f = { sha256, sha1 }[alg];
  if (!f) throw new Error(`createHash(${alg}) is not available in the browser trial`);
  const chunks = [];
  const h = {
    update(d, enc) { chunks.push(typeof d === "string" ? Buffer.from(d, enc) : d); return h; },
    digest(enc) { const out = Buffer.from(f(Buffer.concat(chunks))); return enc ? out.toString(enc) : out; },
  };
  return h;
}
export const createCipheriv = () => { throw new Error("crypto.createCipheriv is not available in the browser trial"); };
export const createDecipheriv = createCipheriv;
export const timingSafeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
export const webcrypto = globalThis.crypto;
export default { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual, webcrypto };
