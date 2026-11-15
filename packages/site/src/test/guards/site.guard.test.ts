// Guard: the home page's shared data and rules are defined once, here in @onden/site.
// Review 2026-10-27 (docs/archive/research/review-2026-10-27/deep-modules-site.md, problems 3, 4, 8) found
// the row/design types written in three places, the nesting rule in three, and
// a Markdown-image regex in four. Each now has one owner; these tests keep it so.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const posix = (file: string) => relative(PACKAGES, file).split(sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "fixtures", "__snapshots__"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
}

const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const scan = (roots: string[], pattern: RegExp) =>
  roots.flatMap((root) => sourceFiles(join(PACKAGES, root))).filter((file) => pattern.test(code(readFileSync(file, "utf8")))).map(posix);

describe("row and frozen-design types", () => {
  const DEFINITION = /\b(?:type|interface)\s+(?:SiteRow|SiteTagPage|FrozenDesign|ViewKind|TagPageData)\b\s*(?:=|<|\{)/;

  it("are defined only in @onden/site (src/rows.ts)", () => {
    // Importers use `import type { SiteRow } from "@onden/site"`; a second `type SiteRow = …` can drift (it did: string vs string|null).
    expect(scan(["site/src", "backend/src", "frontend/src"], DEFINITION)).toEqual(["site/src/rows.ts"]);
  });
});

describe("nesting rule", () => {
  it("the allow lists are asked only through allowedAt (registry.ts), never with a second condition", () => {
    // config.tsx hands the lists to Puck as slot `allow` — that is data for Puck, not a rule check.
    const asked = scan(["site/src", "frontend/src/modules/website"], /(?:TOP_ALLOW|OUTER_SLOT_ALLOW|INNER_SLOT_ALLOW|INNER_PART_TYPES)[^\n]*\.includes\(/);
    // suggestions.ts asks whether a block is an inner PART (to offer a wrap), a different question from "may it sit here".
    const REASONS: Record<string, string> = {
      "frontend/src/modules/website/studio/suggestions.ts": "asks whether a block is an inner part, to suggest wrapping; not a placement check",
    };
    expect(asked.filter((file) => !(file in REASONS) && file !== "site/src/registry.ts")).toEqual([]);
  });
});

describe("finding a note's picture", () => {
  // `firstImage` (@onden/markdown) is the one rule: it skips code and knows <img>. A new `!\[` or `<img` regex
  // in the site's code is a second rule that picks a different picture.
  const IMAGE_SYNTAX = /!\\\[|<img\\b/;
  // ratchet:list EXCEPTIONS
  const EXCEPTIONS: Record<string, string> = {
    "site/src/react/render.tsx": "firstParagraph() skips a block that starts with an image when looking for prose; it does not pick a picture",
  };

  it("@onden/site has no Markdown-image regex of its own", () => {
    expect(scan(["site/src"], IMAGE_SYNTAX).filter((file) => !(file in EXCEPTIONS))).toEqual([]);
  });
});
