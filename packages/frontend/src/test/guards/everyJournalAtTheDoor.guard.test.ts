// @vitest-environment node
// Guard: every journal of edits waiting for their answer (lib/data/optimisticFields) is one the store's door applies its
// one rule to (lib/data/storeOps.ts keepUnanswered): a server copy never replaces a field whose edit has no answer yet.
// A new kind of row that keeps a journal but is not taken over a copy through storeOps would be held nowhere (until
// 2026-11-20 only `node:` was: an attribute, a task, a tag on a note, the home page jumped back to their first value).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, codeLines, sourceFiles } from "./sources";

/** Journals no server copy reaches through storeOps, and why. */
// ratchet:list NOT_AT_THE_DOOR
const NOT_AT_THE_DOOR: Record<string, string> = {
  canvas: "a board's layout is read again by canvasWriter.refreshOpenCanvas, not taken from a sync answer or a bootstrap",
};

/** The prefix of each journal a call names (`node:${id}` → node; a `resource` variable → the prefix it is made from). */
function journalsIn(file: string): string[] {
  const text = codeLines(file).join("\n");
  const found: string[] = [];
  for (const call of text.matchAll(/optimisticFields(?:<[^>]*(?:<[^>]*>[^>]*)?>)?\(\s*([^,]+),/g)) {
    const first = call[1]!.trim();
    const literal = /^`(\w+):/.exec(first);
    if (literal) { found.push(literal[1]!); continue; }
    const name = /^`?\$?\{?(\w+)/.exec(first)?.[1];
    const made = name && new RegExp(`const ${name} = \`(\\w+):`).exec(text);
    found.push(made ? made[1]! : `unresolved in ${file.replace(SRC, "")}: ${first}`);
  }
  return found;
}

describe("every edit journal is kept over a server copy (storeOps.keepUnanswered)", () => {
  const journals = new Set(sourceFiles("lib").filter((f) => !f.endsWith("optimisticFields.ts")).flatMap(journalsIn));
  const storeOps = codeLines(join(SRC, "lib/data/storeOps.ts")).join("\n"); // the code, not its comments

  it("finds the journals the writers keep", () => {
    expect([...journals].sort()).toEqual(expect.arrayContaining(["attribute", "membership", "node", "position", "task", "workspace"]));
  });

  it("each one is named where storeOps applies the rule, or listed with a reason", () => {
    const missing = [...journals].filter((prefix) => !NOT_AT_THE_DOOR[prefix] && !storeOps.includes(`\`${prefix}:`));
    expect(missing).toEqual([]);
  });

  it("an exception is still a journal (a stale one goes)", () => {
    expect(Object.keys(NOT_AT_THE_DOOR).filter((prefix) => !journals.has(prefix))).toEqual([]);
  });
});
