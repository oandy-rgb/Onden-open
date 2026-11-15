const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of the token's UTF-8 text; must equal `tokenHash` in @onden/pairing. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two strings without stopping at the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
