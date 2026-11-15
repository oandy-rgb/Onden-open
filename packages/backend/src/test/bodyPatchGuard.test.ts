// Body patch guard (D60): a stored inverse_patch is made in one place.
// services/eventLog/bodyPatch.ts makeInversePatch catches diff-match-patch
// bug #69 (an edit inside an emoji splits a surrogate pair and patch_toText
// throws "URI malformed") and falls back to a full-replacement patch. Event
// restore carried its own patch_make + patch_toText copy without that
// fallback, so undoing an emoji edit threw inside the transaction → 500.
//
// Source scan, like bodyWriteGuard.test.ts: no non-test file but bodyPatch.ts
// builds or encodes diff-match-patch patches, or imports the library.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const MAKES_PATCH = /\bpatch_(make|toText)\s*\(|from\s+["']diff-match-patch["']/;

describe("body patch guard (D60)", () => {
  it("only services/eventLog/bodyPatch.ts makes diff-match-patch patches", () => {
    const makers = sourceFiles(srcDir)
      .filter((file) => MAKES_PATCH.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcDir, file).split(sep).join("/"));
    expect(makers).toEqual(["services/eventLog/bodyPatch.ts"]);
  });
});

// D79: undo applied the stored inverse with patch_apply on the CURRENT body.
// patch_apply is fuzzy — a hunk whose context still matched "applied" over a
// later writer's edit to the same words, so undo silently overwrote it while
// the merge (bodyMerge.ts) already raised BODY_CONFLICT for the same case.
// patch_apply now runs in one helper, on the event's own post body; a revert
// on top of later edits is a three-way merge.
describe("body patch guard (D79)", () => {
  const applies = (text: string) => text.match(/\.patch_apply\s*\(/g)?.length ?? 0;

  it("patch_apply is called once, inside bodyPatch.ts rebuildPreEventBody", () => {
    const callers = sourceFiles(srcDir)
      .filter((file) => applies(readFileSync(file, "utf8")) > 0)
      .map((file) => relative(srcDir, file).split(sep).join("/"));
    expect(callers).toEqual(["services/eventLog/bodyPatch.ts"]);

    const source = readFileSync(join(srcDir, "services/eventLog/bodyPatch.ts"), "utf8");
    expect(applies(source)).toBe(1);
    const start = source.indexOf("export function rebuildPreEventBody(");
    expect(start).toBeGreaterThan(-1);
    expect(applies(source.slice(start, source.indexOf("\n}\n", start)))).toBe(1);
  });

  it("restore reverts a body by merging against the event's own post body", () => {
    const restore = readFileSync(join(srcDir, "services/eventRestore/restore.ts"), "utf8");
    expect(restore).toMatch(/rebuildPreEventBody\(post, inversePatch\)/);
    expect(restore).toMatch(/mergeBody\(post, pre, currentBody\)/);
  });
});
