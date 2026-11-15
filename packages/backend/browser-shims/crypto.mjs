// node:crypto：後端用到的 randomUUID / randomBytes / createHash（同步 SHA-256；WebCrypto 是非同步的，utils.ts 的 sha256Hex 是同步呼叫）。
// 沒有 createCipheriv：API 金鑰加密（AES）在瀏覽器版不提供（沒有伺服器就沒有「伺服器用你的金鑰」）。
import { sha256 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { Buffer } from "buffer";
export const randomUUID = () => crypto.randomUUID();
/** npm 的 `buffer`（Node 的 Buffer 在瀏覽器的替身）不認得 "base64url"；權杖、邀請連結、管理密碼都用它。 */
export function withBase64url(buffer) {
  const plain = buffer.toString.bind(buffer);
  buffer.toString = (enc, ...rest) => (enc === "base64url" ? plain("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : plain(enc, ...rest));
  return buffer;
}
export const randomBytes = (n) => withBase64url(Buffer.from(crypto.getRandomValues(new Uint8Array(n))));
export function createHash(alg) {
  const f = { sha256, sha1 }[alg];
  if (!f) throw new Error(`createHash(${alg}) is not available in the browser app`);
  const chunks = [];
  const h = {
    update(d, enc) { chunks.push(typeof d === "string" ? Buffer.from(d, enc) : d); return h; },
    digest(enc) { const out = withBase64url(Buffer.from(f(Buffer.concat(chunks)))); return enc ? out.toString(enc) : out; },
  };
  return h;
}
export const createCipheriv = () => { throw new Error("crypto.createCipheriv is not available in the browser app"); };
export const createDecipheriv = createCipheriv;
export const timingSafeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
export const webcrypto = globalThis.crypto;
export default { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual, webcrypto };
