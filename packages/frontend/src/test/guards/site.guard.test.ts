// @vitest-environment node
// Guard: the website module's shared rules have one owner each.
// Review 2026-10-27 (docs/archive/research/review-2026-10-27/deep-modules-site.md, problems 2 and 8): the
// `_published` attribute name was spelled in three files, and the cover and the studio card each had
// their own Markdown-image regex. Keep one spelling and use `firstImage` from @onden/markdown.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const posix = (file: string) => relative(SRC, file).split(sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["test", "__snapshots__", "fixtures"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|testing)\.|fixtures\.ts$/.test(entry.name) ? [path] : [];
  });
}
const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const scan = (root: string, pattern: RegExp) =>
  sourceFiles(join(SRC, root)).filter((file) => pattern.test(code(readFileSync(file, "utf8")))).map(posix);

describe("the _published attribute name", () => {
  it("is spelled nowhere in the app: PUBLISHED_ATTR (publishBlocker.ts) is @onden/markdown's PUBLISHED_ATTR_KEY", () => {
    // Backend counterpart: PUBLISHED_KEY in systemAttributes.ts, the same shared constant. Everyone else imports it.
    expect(scan(".", /["'`]_published["'`]/)).toEqual([]);
    expect(scan(".", /["'`]_published_by_parent["'`]/)).toEqual([]);
  });
});

describe("finding a note's picture", () => {
  const IMAGE_SYNTAX = /!\\\[|<img\\b/;
  // ratchet:list EXCEPTIONS
  const EXCEPTIONS: Record<string, string> = {
    "components/siteFrame/SiteFrames.tsx": "splitCover() finds the cover's own line to remove it from the body; which image is the cover comes from firstImage",
  };

  it("the website module and the site frames have no Markdown-image regex of their own", () => {
    const offenders = [...scan("modules/website", IMAGE_SYNTAX), ...scan("components/siteFrame", IMAGE_SYNTAX)];
    expect(offenders.filter((file) => !(file in EXCEPTIONS))).toEqual([]);
  });
});
