// Guard: the `[[A#^id]]` fallback (docs/architecture/block-nodes.md 「段落連結的後援」) is decided
// in ONE place. A second copy of "which note holds this block" would drift on the order of
// preferences or on who may be named, so these scans fail when one appears. They read source
// text, so a failure names the file and the line.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|generated)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Non-comment lines of every package source matching `pattern`, minus the allowed files. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return ["markdown", "backend", "frontend"].flatMap((pkg) => sources(join(PACKAGES, pkg, "src"))).flatMap((file) => {
    const rel = relative(PACKAGES, file);
    if (allowed.includes(rel)) return [];
    return readFileSync(file, "utf8").split("\n")
      .map((text, i): [number, string] => [i + 1, text])
      .filter(([, text]) => !/^\s*(\/\/|\/\*|\*)/.test(text) && pattern.test(text))
      .map(([n, text]) => `${rel}:${n}: ${text.trim()}`);
  });
}

describe("block-link fallback is decided once", () => {
  it("only blockHome.ts (site) and blockRefLookup.ts (server) choose among candidates", () => {
    expect(offenders(/\bchooseBlockHome\(/, [
      "markdown/src/blockHome.ts", "backend/src/services/blockRefLookup.ts",
    ])).toEqual([]);
  });

  it("only noteBlockRefs.ts writes the index and only blockRefLookup.ts reads it", () => {
    expect(offenders(/\bnote_block_refs\b/, [
      "backend/src/services/noteBlockRefs.ts", "backend/src/services/blockRefLookup.ts",
    ])).toEqual([]);
  });

  it("the two body-write paths keep the index in step (through services/bodyDerivation.ts deriveFromBody, which a received bundle runs too)", () => {
    expect(readFileSync(join(PACKAGES, "backend/src/services/bodyDerivation.ts"), "utf8")).toContain("syncNoteBlockRefs(");
    for (const file of ["services/bodySideEffects.ts", "services/newNoteDerived.ts", "services/receivedDerivation.ts"]) {
      expect(readFileSync(join(PACKAGES, "backend/src", file), "utf8")).toContain("deriveFromBody(");
    }
  });

  it("the app and the site reach the rule through blockHome / servedBlockPage, not their own scan", () => {
    // A fallback that scans bodies would be a second rule and a per-note cost on every render.
    expect(offenders(/\bblockAnchors\([^)]*\)\.some\(/, ["markdown/src/blockRef.ts", "markdown/src/blockLink.ts"])).toEqual([]);
    expect(offenders(/\bnoteHasBlock\(/, [
      "markdown/src/blockRef.ts", "markdown/src/blockHome.ts", "markdown/src/core.ts", "backend/src/services/blockRefLookup.ts", "frontend/src/lib/blockHome.ts",
    ])).toEqual([]);
  });

  it("who cites a paragraph is read in one place (server), and the app only asks for it", () => {
    // A frontend scan of every note's text for `[[X#^id]]` would be a second count that ignores read scope.
    expect(offenders(/(?<!\.)\bblockCitations\(/, [
      "markdown/src/blockCitations.ts", "markdown/src/core.ts", "backend/src/services/blockCitations.ts", "frontend/src/lib/data/reads.ts",
    ])).toEqual([]);
    expect(offenders(/\/block-citations\b/, [
      "backend/src/routes/nodes.ts", "frontend/src/lib/data/reads.ts",
    ])).toEqual([]);
  });

  it("a copied block link writes its id only through the paste path", () => {
    // copyBlockLink prepares an id (pending); only pasteBlockLink / the ((-pick write it.
    expect(offenders(/\bpasteBlockLink\(/, [
      "frontend/src/lib/blockSafety/pendingLink.ts", "frontend/src/components/MarkdownEditor.tsx",
    ])).toEqual([]);
    expect(offenders(/\bprepareBlockId\(/, ["frontend/src/lib/editorParagraphActions.ts"])).toEqual([]);
  });
});
