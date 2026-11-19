// noteSummary (@onden/markdown, the excerpt lists and the published site
// show) finds images and markdown links with a scanner instead of regexes
// (a regex rescanned up to 2000 characters at every `[`). The output must
// not change: the old regex version is kept here as the reference and
// both run over random bodies built from the characters that matter, plus
// the length limits (500-character label, 2000-character URL). The reference
// follows plainText.ts's reading of the rest (fences by line, quote / list
// markers in front of a line, underscores inside a word kept, footnote marks
// and HTML tags dropped); only the link scanning is what it is checked against.

import { describe, expect, it } from "vitest";
import { PROPS_SEED } from "./helpers/propsConfig.js";
import { noteSummary, replaceWikilinks, stripLineMarker, wikilinkLabel, withoutFences } from "@onden/markdown";

const excerptOf = (markdown: string, maxLen = 280) => noteSummary(markdown, { maxLen });

function referenceExcerptOf(markdown: string, maxLen = 280): string {
  const stripped = withoutFences(markdown.replace(/^---\n[\s\S]*?\n---\n?/, ""), " ")
    // D37: heading, table and rule lines are structure, not prose; list
    // markers and ^block-ids go too (the regex form of noteSummary's filter).
    .split("\n")
    .filter((line) => !/^#{1,6}(\s|$)/.test(line.trim()) && !line.trim().startsWith("|")
      && !/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.trim()))
    .map((line) => stripLineMarker(line).replace(/\s\^[A-Za-z0-9-]{1,64}\s*$/, ""))
    .join("\n")
    .replace(/!\[[^\]]{0,500}\]\([^)]{0,2000}\)/g, " ");
  const labelled = replaceWikilinks(stripped, wikilinkLabel);
  const text = labelled
    .replace(/\[([^\]]{1,500})\]\([^)]{0,2000}\)/g, "$1")
    .replace(/\[\^[^\]\n]{0,200}\]/g, "")
    .replace(/<\/?[A-Za-z][^>\n]{0,500}>/g, "")
    .replace(/[*~`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

// A small seeded generator, so a failure reproduces.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["[", "]", "(", ")", "!", "![", "](", "[[", "]]", "|", "a", "b c", " ", "\n", "#", "*", "`"];

function body(next: () => number, length: number): string {
  let out = "";
  while (out.length < length) {
    const roll = next();
    if (roll < 0.02) out += "x".repeat(495 + Math.floor(next() * 10));        // around the label limit
    else if (roll < 0.04) out += "y".repeat(1995 + Math.floor(next() * 10));  // around the URL limit
    else out += PIECES[Math.floor(next() * PIECES.length)];
  }
  return out;
}

describe("noteSummary's link scanner", () => {
  it("matches the regex version on random bodies", () => {
    const next = random(PROPS_SEED);
    for (let n = 0; n < 4000; n++) {
      const markdown = body(next, 1 + Math.floor(next() * 400));
      expect(excerptOf(markdown, 100_000), `PROPS_SEED=${PROPS_SEED} ${JSON.stringify(markdown)}`).toBe(referenceExcerptOf(markdown, 100_000));
    }
  });

  it("matches the regex version at the length limits", () => {
    for (const label of [0, 1, 499, 500, 501]) {
      for (const url of [0, 1999, 2000, 2001]) {
        for (const opener of ["![", "["]) {
          const markdown = `before ${opener}${"l".repeat(label)}](${"u".repeat(url)}) after`;
          expect(excerptOf(markdown, 100_000), `${opener} label ${label} url ${url}`).toBe(referenceExcerptOf(markdown, 100_000));
        }
      }
    }
  });

  it("keeps the default excerpt length behaviour", () => {
    const next = random(PROPS_SEED);
    for (let n = 0; n < 500; n++) {
      const markdown = body(next, 50 + Math.floor(next() * 3000));
      expect(excerptOf(markdown), `PROPS_SEED=${PROPS_SEED} ${JSON.stringify(markdown)}`).toBe(referenceExcerptOf(markdown));
    }
  });
});
