// Fuzz: the embed URL helpers (toEmbedUrl, isAllowedEmbedSrc, classifyMedia).
// Invariants: never throw; a host is trusted only on a dot boundary (the
// allowlisted name itself or a subdomain of it, https only, no userinfo
// trick); whatever toEmbedUrl returns is on the allowlist and carries only an
// id that is safe to put in an attribute. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TRUSTED_EMBED_HOSTS, classifyMedia, isAllowedEmbedSrc, toEmbedUrl } from "../mediaEmbed.js";
import { anyString, fuzzParams, hostileInput, loadCorpus, mutated } from "./fuzzSupport.js";

const corpus = loadCorpus("embed");

/** The allowlist rule, stated independently of the implementation: an https
 *  URL whose WHATWG-parsed host is a trusted name or a dot-separated subdomain of one. */
function trustedHost(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" &&
    TRUSTED_EMBED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// Hosts built from the trusted names with the usual boundary mistakes around them.
const trusted = fc.constantFrom(...TRUSTED_EMBED_HOSTS, "youtu.be");
const hostAround = fc.tuple(
  fc.constantFrom("", "www.", "a.", "evil", "evil-", "not", "x.y.", "m."),
  trusted,
  fc.constantFrom("", ".evil.example", ".", "evil", "-x.example", ":8443", "@evil.example", "\\@evil.example", "%2eevil.example", "。com"),
).map(([a, h, z]) => `${a}${h}${z}`);
const urlAround = fc.tuple(fc.constantFrom("https://", "http://", "//", "HTTPS://", "https:/", "https:\\\\"), hostAround, fc.constantFrom("/watch?v=abcdefghijk", "/embed/abcdefghijk", "/123456", "/video/123456", "/shorts/abcdefghijk", "", "/"))
  .map(([scheme, host, path]) => scheme + host + path);

describe("embed URL fuzz", () => {
  it("corpus seeds: never throw; allowed means a trusted host; output is on the allowlist", () => {
    for (const [name, src] of Object.entries(corpus)) {
      const out = toEmbedUrl(src);
      classifyMedia(src);
      if (isAllowedEmbedSrc(src)) expect(trustedHost(src.startsWith("//") ? `https:${src}` : src), `allowed ${name}`).toBe(true);
      if (out !== null) expect(trustedHost(out), `toEmbedUrl ${name} → ${out}`).toBe(true);
    }
  });

  it("isAllowedEmbedSrc matches only trusted hosts, on dot boundaries", () => {
    fc.assert(fc.property(fc.oneof(urlAround, hostileInput(corpus), mutated(corpus), anyString), (src) => {
      const allowed = isAllowedEmbedSrc(src);
      classifyMedia(src);
      if (allowed) expect(trustedHost(src.startsWith("//") ? `https:${src}` : src)).toBe(true);
    }), fuzzParams(1500));
  });

  it("toEmbedUrl returns only an https URL on an allowlisted host with a plain id", () => {
    fc.assert(fc.property(fc.oneof(urlAround, mutated(corpus), anyString), (src) => {
      const out = toEmbedUrl(src);
      if (out === null) return;
      expect(trustedHost(out)).toBe(true);
      expect(out).toMatch(/^https:\/\/(?:www\.youtube-nocookie\.com\/embed\/[\w-]{6,15}|player\.vimeo\.com\/video\/\d+)$/);
    }), fuzzParams(1500));
  });

  // The same dot-boundary rule must hold for the input host, not only the output:
  // toEmbedUrl rewrites a watch URL to an embed, so a look-alike host would be embedded.
  // Found by the nightly fuzz run; the host match now needs a dot boundary (isHostOrSubdomain), so the marker was flipped.
  it("toEmbedUrl refuses look-alike hosts (suffix match without a dot boundary)", () => {
    // "https://notyoutube.com/watch?v=abcdefghijk" becomes a youtube-nocookie embed, and
    // "https://evilvimeo.com/123456" a player.vimeo.com embed: isAllowedEmbedSrc refuses
    // both URLs, toEmbedUrl (and so classifyMedia → "iframe", and the exports' embedFrame)
    // accepts them. Impact: low (the embedded page is always the genuine provider's,
    // never the look-alike's), but the two helpers disagree and a link on a look-alike
    // domain renders as a video.
    for (const src of ["https://notyoutube.com/watch?v=abcdefghijk", "https://evilvimeo.com/123456", "https://evilyoutube-nocookie.com/embed/abcdefghijk"]) {
      expect(toEmbedUrl(src), src).toBeNull();
      expect(classifyMedia(src), src).toBeNull();
    }
  });
});
