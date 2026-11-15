import { acceptInvite, completeOnPage, completeOnPhone, createInvite, type RandomSource } from "./index.ts";

/** Deterministic bytes for tests only: a counter-based stream, never used in production code. */
export function seededRandom(seed: number): RandomSource {
  let n = seed;
  return (length) => Uint8Array.from({ length }, () => ((n = (n * 1103515245 + 12345) >>> 0), (n >>> 16) & 255));
}

export function pairedSession(relayUrl = "https://relay.example", seed?: number) {
  const random = seed === undefined ? undefined : seededRandom(seed);
  const page = createInvite(relayUrl, random);
  const { phone, hello } = acceptInvite(page.invite, random);
  return { page, phone, hello, pageKeys: completeOnPage(page, hello), phoneKeys: completeOnPhone(phone) };
}
