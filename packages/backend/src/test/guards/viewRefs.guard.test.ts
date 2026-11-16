// Saved views are function references (function-references proposal §6, B2, migration 188): the column
// content_nodes.collection_views is frozen, nothing reads or writes it, and a tag's and a note's views share the one
// storage in services/functionRefs.ts. The files below still name the column only as the key of the composed array a
// client stores (holderViewsSql builds it); this list only shrinks.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "dbSchema.generated.ts" ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const read = (file: string) => code(files.find((f) => f.file === file)!.text);

// ratchet:list VIEWS_COLUMN_NAMED
const NAMES_THE_COLUMN: Record<string, { count: number; reason: string }> = {
  "services/nodeRowProjection.ts": { count: 3, reason: "the wire column list, and the composed array that takes its place" },
  "services/sync/bootstrapWire.ts": { count: 1, reason: "the wire column list of the bootstrap" },
  "services/exportZip.ts": { count: 2, reason: "the composed array under the name the vault export reads" },
  "services/backupArchive.ts": { count: 5, reason: "reads the composed array off the export row" },
  "services/exportInk.ts": { count: 2, reason: "reads the composed array off the export row" },
  "services/functionRefs.ts": { count: 2, reason: "withViews: puts the composed array under the name a client stores" },
};

// ratchet:list STAR_WITHOUT_VIEWS
const STAR_WITHOUT_VIEWS: Record<string, string> = {};

describe("saved views are function references", () => {
  const found: Record<string, number> = {};
  for (const { file, text } of files) {
    const n = (code(text).match(/collection_views/g) ?? []).length;
    if (n > 0) found[file] = n;
  }

  it("no source file reads or writes the frozen column; the list of files that name it only shrinks", () => {
    const unlisted = Object.keys(found).filter((f) => !(f in NAMES_THE_COLUMN) || found[f]! > NAMES_THE_COLUMN[f]!.count);
    expect(unlisted, "read a node's views with functionRefs.viewRecordsOf / holderViewsSql; write them with insertView / patchView / removeView").toEqual([]);
    const stale = Object.keys(NAMES_THE_COLUMN).filter((f) => (found[f] ?? 0) < NAMES_THE_COLUMN[f]!.count);
    expect(stale, "lower or remove the exception").toEqual([]);
  });

  it("a tag's and a note's views are stored by the same functions", () => {
    for (const file of ["services/tagViews.ts", "services/noteViews.ts"]) {
      const text = read(file);
      expect(text, `${file} stores a view`).toMatch(/\binsertView\(/);
      expect(text, `${file} removes a view`).toMatch(/\bremoveView\(/);
      expect(text, `${file} patches a view`).toMatch(/\bpatchView\(/);
      expect(text, `${file} must not keep views in a JSON array`).not.toMatch(/jsonb_array_elements/);
    }
  });

  it("a node row read with * is given its views: the frozen column is never what a client gets", () => {
    // `SELECT * FROM content_nodes` and `… RETURNING *` hand out the frozen collection_views. The files that do it must
    // put the views back with functionRefs.withViews (or read through nodeRowColumnsSql); the list only shrinks.
    const STAR = /(SELECT\s+\*\s+FROM\s+content_nodes|(?:INSERT\s+INTO|UPDATE)\s+content_nodes[^`"]*?RETURNING\s+\*)/g;
    const offenders = files.filter(({ file, text }) => (code(text).match(STAR) ?? []).length > 0 && !/\bwithViews\(/.test(code(text)) && !(file in STAR_WITHOUT_VIEWS));
    expect(offenders.map(({ file }) => file), "wrap the row in withViews(workspaceId, row) or select it with nodeRowColumnsSql").toEqual([]);
    const stale = Object.keys(STAR_WITHOUT_VIEWS).filter((f) => !((code(files.find((x) => x.file === f)?.text ?? "").match(STAR) ?? []).length > 0) || /\bwithViews\(/.test(code(files.find((x) => x.file === f)!.text)));
    expect(stale, "remove it from the list").toEqual([]);
  });

  it("nothing makes or links view module tags any more (the refusals to apply or merge one stay until B3 removes the nodes)", () => {
    const names = /\b(syncViewModuleExtends|aggregateViewModule|viewNameFreeSql)\b/;
    expect(files.filter(({ text }) => names.test(code(text))).map(({ file }) => file)).toEqual([]);
  });
});

// The snapshot table list (spine/snapshotTables.json) is data, not a .ts file, so the scan above does not read it. It names the frozen
// column once, as the label its stamps are filed under (`content_nodes.collection_views`), and the copy carries the column's values
// like any other column: the importer writes them as the source held them and never reads them as views.
describe("the snapshot table list and the frozen views column", () => {
  it("names collection_views only as the stamp label of content_nodes", () => {
    const text = readFileSync(join(SRC, "spine/snapshotTables.json"), "utf8");
    const names = text.match(/[\w.]*collection_views[\w.]*/g) ?? [];
    expect(names).toEqual(["content_nodes.collection_views"]);
  });
});
