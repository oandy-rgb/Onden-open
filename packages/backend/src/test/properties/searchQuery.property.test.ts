// Property-based hardening of the search-query parser (services/searchQuery).
//
// DB-free, fixed fc seed (CI determinism), capped runs.
//
//   1. total: parse never throws on ANY string and always returns the
//      ParsedSearchQuery shape.
//   2. round-trip: a query reconstructed from generated structured tokens
//      (#tags, key:value attrs, plain words) parses back to the same AST
//      modulo ordering of tags/attrs.
//   3. quoting: a "quoted phrase" containing spaces / hashes / colons stays
//      one text token and never corrupts the adjacent #tag / attr tokens.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { parseSearchQuery } from "@onden/markdown";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// ── Generators ───────────────────────────────────────────────────────────────

// Hostile raw input: quotes, hashes, colons, CJK, emoji, whitespace soup.
const hostileChar = fc.constantFrom(
  "a", "z", "0", "#", '"', ":", " ", "\t", "\n", "-", "_", ".",
  "字", "測", "😀", "é", "\\", "'", "|", "(", ")",
);
const hostile = fc.array(hostileChar, { maxLength: 40 }).map((a) => a.join(""));

// Valid token material (kept inside each token's grammar):
const tagName = fc.stringMatching(/^[a-z0-9_][a-z0-9_-]{0,7}$/);          // TAG_RE charset, pre-lowercased
const attrKey = fc.stringMatching(/^[a-z_作者][a-z0-9_作者-]{0,7}$/);       // ATTR_RE key (ATTRIBUTE_KEY)
// No spaces, quotes or colon, and not `//` first (`key://…` is a URL, text).
const attrValue = fc.stringMatching(/^[a-z0-9_.@/-]{1,8}$/).filter((v) => !v.startsWith("//"));
// A plain word: must not look like a tag or attr (no leading #, no colon).
const plainWord = fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,7}$/);

type Tok =
  | { kind: "tag"; name: string }
  | { kind: "attr"; key: string; value: string }
  | { kind: "word"; word: string };

const token: fc.Arbitrary<Tok> = fc.oneof(
  tagName.map((name): Tok => ({ kind: "tag", name })),
  fc.record({ key: attrKey, value: attrValue }).map(({ key, value }): Tok => ({ kind: "attr", key, value })),
  plainWord.map((word): Tok => ({ kind: "word", word })),
);

const tokenList = fc.array(token, { maxLength: 10 });

// Whitespace separators (parser splits on any \s run outside quotes).
const sep = fc.constantFrom(" ", "  ", "\t", " \n ");

// ── Properties ───────────────────────────────────────────────────────────────

describe("searchQuery parser properties", () => {
  it("never throws and always returns the full shape, on any input", () => {
    fc.assert(
      fc.property(hostile, (raw) => {
        const out = parseSearchQuery(raw);
        expect(typeof out.text).toBe("string");
        expect(Array.isArray(out.tags)).toBe(true);
        expect(Array.isArray(out.attrs)).toBe(true);
        for (const t of out.tags) expect(typeof t).toBe("string");
        for (const a of out.attrs) {
          expect(typeof a.key).toBe("string");
          expect(typeof a.value).toBe("string");
        }
      }),
      fcOpts,
    );
  });

  it("round-trips structured tokens (modulo tag/attr ordering)", () => {
    fc.assert(
      fc.property(tokenList, sep, (toks, s) => {
        const raw = toks
          .map((t) =>
            t.kind === "tag" ? `#${t.name}`
            : t.kind === "attr" ? `${t.key}:${t.value}`
            : t.word,
          )
          .join(s);
        const parsed = parseSearchQuery(raw);

        const wantTags = toks.filter((t) => t.kind === "tag").map((t) => (t as { name: string }).name);
        const wantAttrs = toks
          .filter((t) => t.kind === "attr")
          .map((t) => `${(t as { key: string }).key}=${(t as { value: string }).value}`);
        const wantText = toks
          .filter((t) => t.kind === "word")
          .map((t) => (t as { word: string }).word)
          .join(" ");

        expect([...parsed.tags].sort()).toEqual([...wantTags].sort());
        expect(parsed.attrs.map((a) => `${a.key}=${a.value}`).sort()).toEqual([...wantAttrs].sort());
        expect(parsed.text).toBe(wantText);

        // Reparse of a canonical reconstruction is a fixpoint (stability).
        const canonical = [
          ...parsed.tags.map((t) => `#${t}`),
          ...parsed.attrs.map((a) => `${a.key}:${a.value}`),
          parsed.text,
        ].join(" ").trim();
        const reparsed = parseSearchQuery(canonical);
        expect([...reparsed.tags].sort()).toEqual([...parsed.tags].sort());
        expect(reparsed.attrs.map((a) => `${a.key}=${a.value}`).sort())
          .toEqual(parsed.attrs.map((a) => `${a.key}=${a.value}`).sort());
        expect(reparsed.text).toBe(parsed.text);
      }),
      fcOpts,
    );
  });

  it("a quoted phrase (with embedded spaces/#/:) stays whole and never corrupts adjacent tokens", () => {
    // Phrase interior: anything except the quote character itself.
    const phraseChar = fc.constantFrom("a", "z", " ", "#", ":", "字", "😀", "-", ".");
    const phrase = fc.array(phraseChar, { minLength: 1, maxLength: 12 }).map((a) => a.join(""));
    fc.assert(
      fc.property(tagName, attrKey, attrValue, phrase, (tag, key, value, ph) => {
        const raw = `#${tag} "${ph}" ${key}:${value}`;
        const parsed = parseSearchQuery(raw);
        expect(parsed.tags).toEqual([tag]);
        expect(parsed.attrs).toEqual([{ key, value }]);
        // The phrase survives as one quoted text token (whitespace inside intact).
        expect(parsed.text).toBe(`"${ph}"`);
      }),
      fcOpts,
    );
  });

  it("tags are lowercased; mixed-case input maps to the same tag", () => {
    fc.assert(
      fc.property(tagName, (name) => {
        const upper = name.toUpperCase();
        const parsed = parseSearchQuery(`#${upper}`);
        expect(parsed.tags).toEqual([upper.toLowerCase()]);
      }),
      fcOpts,
    );
  });
});
