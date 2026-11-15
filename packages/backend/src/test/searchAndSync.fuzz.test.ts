// Fuzz: the parsers of what a client sends: the search query, the paging
// query, the membership bucket prefixes and the membership digest.
// Invariants: never throw (a typed validation error is fine), bounded time,
// output within its documented range. Extends the property test in
// properties/searchQuery.property.test.ts with hostile input: quotes,
// `#` paths, NUL, lone surrogates, very long text.
// Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ATTRIBUTE_KEY, normalizeText } from "@onden/markdown";
import { parseSearchQuery } from "@onden/markdown";
import { MAX_OFFSET, parsePage, safeParsePage } from "../services/paging.js";
import { membershipDigestOf, parseBucketPrefixes, MEMBERSHIP_BUCKET_CHARS } from "../services/sync/membership.js";
import { anyString, expectLinearGrowth, expectWithinBudget, fuzzParams, hostileInput, loadCorpus } from "./fuzzSupport.js";

const corpus = loadCorpus("search");
const query = hostileInput(corpus);

describe("search query fuzz", () => {
  it("never throws, stays in budget, and every token lands in a well-formed place", () => {
    const keyRe = new RegExp(`^(?:${ATTRIBUTE_KEY})$`, "u");
    fc.assert(fc.property(query, (raw) => {
      expectWithinBudget("parseSearchQuery", raw, 100, () => {
        const parsed = parseSearchQuery(raw);
        expect(typeof parsed.text).toBe("string");
        for (const tag of parsed.tags) {
          expect(tag).toMatch(/^[^\s#"]+$/u);
          expect(tag).toBe(normalizeText(tag).toLowerCase());
        }
        for (const attr of parsed.attrs) {
          expect(attr.key).toMatch(keyRe);
          expect(typeof attr.value).toBe("string");
        }
        expect(parsed.text).toBe(parsed.text.trim());
      });
    }), fuzzParams(1000));
  });

  it("no input text is lost without a trace: a query of plain words keeps every word in text", () => {
    const word = fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,7}$/);
    fc.assert(fc.property(fc.array(word, { minLength: 1, maxLength: 8 }), fc.constantFrom(" ", "  ", "\t", "\n", " 　"), (words, sep) => {
      expect(parseSearchQuery(words.join(sep)).text.split(" ")).toEqual(words);
    }), fuzzParams(300));
  });

  it("repeated shapes grow linearly", () => {
    for (const unit of ['"', "#", "a:", "#a/", "a ", "\u0000", '"a b" ', "k:v ", "\ud800"]) {
      expectLinearGrowth(`parseSearchQuery ${JSON.stringify(unit)}`, unit, (t) => { parseSearchQuery(t); }, { n: 20000, fastMs: 40 });
    }
  });
});

describe("paging and sync query fuzz", () => {
  it("parsePage / safeParsePage: a page inside the limits or a typed refusal, never another throw", () => {
    const value = fc.oneof(fc.constant(undefined), fc.constant(null), anyString, fc.integer({ min: -5, max: 2_000_000 }).map(String), fc.constantFrom("", " ", "0", "-1", "1e3", "0x10", "1.5", "९", " 7 ", "99999999999999999999"));
    fc.assert(fc.property(value, value, fc.integer({ min: 1, max: 500 }), (limit, offset, max) => {
      const opts = { default: Math.min(50, max), max };
      const safe = safeParsePage({ limit, offset }, opts);
      let thrown: unknown = null;
      let page = null;
      try { page = parsePage({ limit, offset }, opts); } catch (error) { thrown = error; }
      expect(safe.ok).toBe(thrown === null);
      if (thrown !== null) expect((thrown as { name?: string }).name).toBe("ZodError");
      if (page) {
        expect(Number.isInteger(page.limit) && page.limit >= 1 && page.limit <= max).toBe(true);
        expect(Number.isInteger(page.offset) && page.offset >= 0 && page.offset <= MAX_OFFSET).toBe(true);
      }
    }), fuzzParams(2000));
  });

  it("parseBucketPrefixes: null (every bucket) or a de-duplicated list of lower-case hex prefixes", () => {
    const part = fc.oneof(fc.constantFrom("ab", "00", "ff", "AB", "a", "abc", "", " ", "zz", "a b", "\u0000\u0000"), anyString);
    fc.assert(fc.property(fc.oneof(anyString, fc.array(part, { maxLength: 6 }).map((p) => p.join(","))), (raw) => {
      const prefixes = parseBucketPrefixes(raw);
      if (prefixes === null) return;
      expect(prefixes.length).toBeGreaterThan(0);
      expect(new Set(prefixes).size).toBe(prefixes.length);
      for (const p of prefixes) expect(p).toMatch(new RegExp(`^[0-9a-f]{${MEMBERSHIP_BUCKET_CHARS}}$`));
    }), fuzzParams(2000));
  });

  it("membership digest: independent of order, one entry per id prefix, any id text accepted", () => {
    fc.assert(fc.property(fc.array(anyString, { maxLength: 40 }), fc.integer(), (ids, seed) => {
      const unique = [...new Set(ids)];
      const shuffled = [...unique].sort((a, b) => ((a.length * 31 + seed) % 7) - ((b.length * 31 + seed) % 7));
      const a = membershipDigestOf(unique);
      const b = membershipDigestOf(shuffled);
      expect(b).toEqual(a);
      expect(a.count).toBe(unique.length);
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
      for (const id of unique) expect(a.buckets[id.slice(0, MEMBERSHIP_BUCKET_CHARS)]).toMatch(/^[0-9a-f]{16}$/);
    }), fuzzParams(500));
  });
});
