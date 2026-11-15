// Function references (docs/architecture/proposals/function-references-2026-11-02.md §8 B1):
// "which functions does this tag have" is answered by services/functionRefs.ts only. New code does not read
// tag_schema.module / tag_schema.extends / behaviour.modules to work it out. The files below still read them
// for a reason that is not "the tag's functions" (a module tag's identity, tag membership, field inheritance,
// the views of a parent or extended tag a tag shows); the list only shrinks, and a file that stops needing it must be removed.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

// tag_schema->>'module', tag_schema->'extends', ->'behaviour'->'modules', and the same through a loaded schema object.
const LEGACY_READ = /tag_schema->>?'(?:module|extends)'|behaviour->'modules'|tag_schema\??\.(?:module|extends)\b/g;

// ratchet:list FUNCTION_LEGACY_READS
const FUNCTION_LEGACY_READS: Record<string, { count: number; reason: string }> = {
  "services/tagReads.ts": { count: 2, reason: "tag detail payload (module marker and extends list as stored), not a function computation" },
  "services/tagHierarchy.ts": { count: 3, reason: "tag membership (a tag extending a tag lists its notes; a view module tag has no members)" },
  "services/tagWrites.ts": { count: 1, reason: "the extends/fields clash check of a schema write (field inheritance)" },
  "services/tagFields.ts": { count: 1, reason: "field inheritance along extends" },
  "services/tagPacks.ts": { count: 1, reason: "finds the module tag a pack's switch points its function settings at" },
  "services/viewModules.ts": { count: 1, reason: "a view module tag's module marker (identity): it is never applied to a note nor merged, until B3 removes those tag nodes" },
  "services/workspaceModules.ts": { count: 2, reason: "finding and adopting the module's tag node (identity, not the function)" },
  "services/reservedTags.ts": { count: 1, reason: "the tasks module tag is protected like a reserved tag (identity)" },
  "services/tagCatalog.ts": { count: 2, reason: "the catalog sends the module marker and extends list to the client as stored" },
  "services/tagViews.ts": { count: 2, reason: "saved views inherit along parents/extends (which tags' views a tag shows), not a function computation" },
  "services/parentKind.ts": { count: 2, reason: "a module tag sits at the top of the tag tree (identity)" },
};

describe("function references: nobody but functionRefs.ts works out a tag's functions from the old fields", () => {
  const found: Record<string, number> = {};
  for (const { file, text } of files) {
    if (file === "services/functionRefs.ts" || file === "services/legacyTagFunctionWrites.ts") continue;
    const n = [...stripComments(text).matchAll(LEGACY_READ)].length;
    if (n > 0) found[file] = n;
  }

  it("no new file reads them, and no listed file reads them more", () => {
    const unlisted = Object.keys(found).filter((f) => !(f in FUNCTION_LEGACY_READS) || found[f]! > FUNCTION_LEGACY_READS[f]!.count);
    expect(unlisted, "use services/functionRefs.ts (functionsOf / functionIndex); this list only shrinks").toEqual([]);
  });
  it("every listed file still needs its exception", () => {
    const stale = Object.keys(FUNCTION_LEGACY_READS).filter((f) => (found[f] ?? 0) < FUNCTION_LEGACY_READS[f]!.count);
    expect(stale, "lower or remove the exception").toEqual([]);
  });

  it("the old computations are gone", () => {
    const names = /\b(effectiveTagModules|loadTagAbilities|tagsExtending|moduleTagExists|setTagModules|setTagExtends|changeTagExtends|isTagModuleEnabled|wouldCreateTagExtendsCycle|registerTagModule)\b/;
    expect(files.filter(({ text }) => names.test(stripComments(text))).map(({ file }) => file)).toEqual([]);
  });

  it("the legacy view/extends reads inside functionRefs only shrink", () => {
    const text = readFileSync(join(SRC, "services/functionRefs.ts"), "utf8");
    const declared = Number(/export const LEGACY_FUNCTION_READS = (\d+)/.exec(text)?.[1]);
    // B1 left one: the view functions (legacyViewFunctions). B2 deleted it: a view is a reference like any other.
    expect(declared).toBe(0);
    expect(stripComments(text)).not.toMatch(/legacyViewFunctions/);
  });
});
