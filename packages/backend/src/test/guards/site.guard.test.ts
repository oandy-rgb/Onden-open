// Guard: publishing finds a note's picture through @onden/markdown's `firstImage`.
// Review 2026-10-27 (docs/archive/research/review-2026-10-27/deep-modules-site.md, problem 8): the card image
// and the article cover came from two regexes with different rules. A new image regex in the
// publishing code brings that back.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE_SYNTAX = /!\\\[|<img\\b/;
/** File → why a Markdown-image pattern is allowed there. */
// ratchet:list EXCEPTIONS
const EXCEPTIONS: Record<string, string> = {};

const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.ts$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

describe("publishing finds pictures through firstImage", () => {
  it("modules/website/publishing has no Markdown-image regex of its own", () => {
    const offenders = filesIn(join(SRC, "modules", "website", "publishing"))
      .filter((file) => IMAGE_SYNTAX.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(SRC, file).split(sep).join("/"))
      .filter((file) => !(file in EXCEPTIONS));
    expect(offenders).toEqual([]);
  });
});
