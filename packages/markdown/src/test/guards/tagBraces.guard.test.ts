// One rule decides whether a `{…}` at a line's end is a block's tags (text.ts isTagList). A file that matches such
// braces with a pattern of its own must ask the rule too, or the readers disagree: one shows `{ f(); }` as words,
// another cuts it away as "tags". This guard finds every pattern that matches a brace group and requires the file
// to call isTagList.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** A RegExp that matches `{`, then a negated class excluding braces, then `}`: the shape of "a brace group". */
const BRACE_GROUP_PATTERN = /\\+\{\(?\[\^\{\}/;

describe("trailing `{…}`: one rule", () => {
  it("every file with its own brace-group pattern asks isTagList", () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const withPattern = files.filter((name) => BRACE_GROUP_PATTERN.test(readFileSync(join(SRC, name), "utf8")));
    expect(withPattern.sort(), "the files this guard knows of; a new one must call isTagList and be listed here").toEqual(["blockChild.ts", "blockId.ts", "blocks.ts", "linkTargets.ts"]);
    for (const name of withPattern) expect(readFileSync(join(SRC, name), "utf8"), name).toContain("isTagList(");
  });
});
