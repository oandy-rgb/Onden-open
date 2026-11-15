// Property tests: names in note text — slugs, link targets, #tags — under the
// text a Chinese-writing person actually produces: NFC and NFD forms,
// full-width letters and punctuation, zero-width characters, BOM, NBSP, CJK
// extension characters, emoji. Generators: helpers/unicodeText.ts. Seed and run
// count from PROPS_SEED / PROPS_RUNS.
//
// "Current behaviour" cases pin what the code does today where the answer is a
// product decision (listed in the PR); they are plain tests so a change shows.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { titleText, unicodeText, plainWord, invisibleChar, toFullwidth } from "../helpers/unicodeText.js";
import {
  slugify, normalizeText, linkNameKey, wikilinkTarget, scanWikilinks, linkNamesNote, HASHTAG_RE, wikilinkBodies, servedLinkTarget,
} from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const ZERO_WIDTH = ["​", "‌", "‍", "﻿", "⁠", "­"];
/** `text` with a zero-width character after each of the given positions. */
const withZeroWidth = (text: string, marks: string[]) => [...text].map((c, i) => c + (marks[i % marks.length] ?? "")).join("");

describe("slugify", () => {
  it("is one slug for NFC and NFD forms of a title", () => {
    fc.assert(fc.property(titleText, (title) => {
      expect(slugify(title.normalize("NFD"))).toBe(slugify(title.normalize("NFC")));
    }), fcOpts);
  });

  it("is idempotent and holds only letters, marks, digits and single dashes", () => {
    fc.assert(fc.property(titleText, (title) => {
      const slug = slugify(title);
      expect(slugify(slug)).toBe(slug);
      expect(slug).toMatch(/^[\p{L}\p{M}\p{N}-]+$/u);
      expect(slug).not.toMatch(/--|^-|-$/);
      expect(slug).toBe(slug.normalize("NFC"));
    }), fcOpts);
  });

  // FINDING: slugify is not idempotent. "a😀" + U+0301: NFC leaves the mark after
  // the emoji, the emoji is then stripped, and the mark ends up on "a" without being
  // composed -> "a\u0301"; slugify of that slug composes it to "\u00e1".
  // Fix the NFC step to run after stripping (or strip first), then drop `.fails`.
  it("FINDING slugify is not idempotent when a stripped character separated a letter from its mark", () => {
    const slug = slugify("a\u{1F600}\u0301");
    expect(slugify(slug)).toBe(slug);
  });

  it("is not changed by zero-width characters, BOM, soft hyphens or NBSP in place of a space", () => {
    fc.assert(fc.property(titleText, fc.array(fc.constantFrom(...ZERO_WIDTH), { minLength: 1, maxLength: 4 }), (title, marks) => {
      expect(slugify(withZeroWidth(title, marks))).toBe(slugify(title));
      expect(slugify(title.replace(/ /g, " "))).toBe(slugify(title));
    }), fcOpts);
  });

  it("survives a trip through a URL path: percent-encoding and decoding give the slug back", () => {
    fc.assert(fc.property(titleText, (title) => {
      const slug = slugify(title);
      const url = `/site/${encodeURIComponent(slug)}`;
      expect(decodeURIComponent(url.slice("/site/".length))).toBe(slug);
      expect(url).toMatch(/^[\x20-\x7e]*$/); // ASCII on the wire
    }), fcOpts);
  });
});

describe("link names", () => {
  it("a link typed in NFD names a note titled in NFC, and the reverse", () => {
    fc.assert(fc.property(titleText, (title) => {
      const note = { title: title.normalize("NFC") };
      expect(linkNamesNote(`${title.normalize("NFD")}`, note)).toBe(true);
      expect(linkNamesNote(`${title.normalize("NFC")}|alias#heading`, { title: title.normalize("NFD") })).toBe(true);
      expect(linkNameKey(title.normalize("NFD"))).toBe(linkNameKey(title.normalize("NFC")));
    }), fcOpts);
  });

  it("wikilinkTarget is NFC, trimmed, without alias and anchor", () => {
    fc.assert(fc.property(plainWord, plainWord, plainWord, (target, alias, heading) => {
      expect(wikilinkTarget(`${target.normalize("NFD")}|${alias}`)).toBe(target.normalize("NFC"));
      expect(wikilinkTarget(`  ${target}#${heading}  `)).toBe(target.normalize("NFC"));
    }), fcOpts);
  });

  it("scanWikilinks finds every [[title]] in Chinese text, with the title as the body", () => {
    fc.assert(fc.property(fc.array(fc.tuple(unicodeText({ maxLength: 8 }), plainWord), { minLength: 1, maxLength: 5 }), (parts) => {
      const body = parts.map(([prose, title]) => `${prose.replace(/[\[\]\n]/g, "")}[[${title}]]`).join("");
      expect(wikilinkBodies(body)).toEqual(parts.map(([, title]) => title));
    }), fcOpts);
  });

  it("servedLinkTarget finds a page by a title typed in another Unicode form", () => {
    fc.assert(fc.property(titleText, (title) => {
      const clean = normalizeText(title).trim();
      fc.pre(!/[#|\[\]]/.test(clean));
      const served = [{ id: "1", title: clean, slug: slugify(clean) }];
      expect(servedLinkTarget(clean.normalize("NFD"), served)?.id).toBe("1");
      expect(servedLinkTarget(clean.toUpperCase(), served)?.id).toBe("1");
    }), fcOpts);
  });
});

describe("hashtags", () => {
  const tagWord = fc.array(fc.constantFrom(..."的一是不了人我在有他這中大來上國個到說們為標籤筆記abcXYZ019_-"), { minLength: 1, maxLength: 6 }).map((c) => c.join(""));

  it("#name after a space or a line start reads as the whole name, in any script, NFD included", () => {
    fc.assert(fc.property(tagWord, fc.constantFrom("", " ", "\n", "。 "), (name, lead) => {
      const found = [...`${lead}#${name.normalize("NFD")}`.matchAll(HASHTAG_RE)].map((m) => normalizeText(m[2]!));
      expect(found).toEqual([name]);
    }), fcOpts);
  });

  it("a # inside a word (C#, a#b) or after a CJK character is not a tag", () => {
    fc.assert(fc.property(tagWord, (name) => {
      expect([...`C#${name}`.matchAll(HASHTAG_RE)]).toEqual([]);
      expect([...`筆記#${name}`.matchAll(HASHTAG_RE)]).toEqual([]);
    }), fcOpts);
  });
});

// ── Current behaviour (product decisions, see the PR) ────────────────────────
describe("current behaviour: full-width marks and invisible characters", () => {
  it("a full-width ＃ is not a tag mark and full-width ［［ ］］ is not a link", () => {
    expect([...`＃標籤 ＃tag`.matchAll(HASHTAG_RE)]).toEqual([]);
    expect(wikilinkBodies("［［筆記］］ 和 [[筆記]]")).toEqual(["筆記"]);
  });

  it("link names are exact up to NFC and case: full-width Ａ and A are different titles", () => {
    expect(linkNameKey("Ａ計畫")).not.toBe(linkNameKey("A計畫"));
    expect(linkNamesNote("A計畫", { title: "Ａ計畫" })).toBe(false);
  });

  it("a zero-width character inside a title makes a different link name (two titles that look the same)", () => {
    expect(linkNameKey("筆​記")).not.toBe(linkNameKey("筆記"));
    expect(linkNamesNote("筆記", { title: "筆​記" })).toBe(false);
  });

  it("the invisible-character slug is the same, so a slug clash can hide a different title", () => {
    expect(slugify("筆​記")).toBe(slugify("筆記"));
  });
});

describe("regressions", () => {
  // Found at PROPS_SEED=20261023: a BOM inside a title is "whitespace" to \\s and became a dash.
  it("slugify: a BOM or zero-width space inside a title is no separator, and does not stop é composing", () => {
    expect(slugify("的\ufeff的")).toBe("的的");
    expect(slugify("e\u200b\u0301")).toBe("é");
  });
  it("slugify keeps CJK extension characters and drops emoji and full-width punctuation", () => {
    expect(slugify("𠮷野家：（第１章）")).toBe("𠮷野家第１章");
    expect(slugify("Ａ　B")).toBe("ａ-b");
  });
  it("slugify of an all-symbol title falls back", () => {
    expect(slugify("（）🔥")).toBe("node");
    expect(toFullwidth("A1")).toBe("Ａ１");
    expect(invisibleChar).toBeDefined();
  });
});
