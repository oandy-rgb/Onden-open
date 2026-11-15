/** Lower-case hex of bytes, two digits each. */
export function bytesToHex(bytes: Iterable<number>): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 of a UTF-8 string, lower-case hex. */
export type Sha256Hex = (text: string) => Promise<string>;

/** Web Crypto's SHA-256, or null where it is missing (a page served over plain
 *  HTTP to a LAN address is not a secure context: no crypto.subtle). */
export function webCryptoSha256(): Sha256Hex | null {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle || typeof TextEncoder === "undefined") return null;
  return async (text) => bytesToHex(new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
