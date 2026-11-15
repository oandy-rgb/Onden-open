// A node's parent is written only by the paths that ask nodeTree.assertReparent
// first (depth audit D102). The three moves — a PATCH (nodeUpdate), a tag
// merge's child moves (tagMerge) and undoing a move (eventRestore) — used to
// check different rules, so undo could make a field clash or put a note under
// a tag. One more is allowed: a space move (spaces.ts) re-attaches a note
// under its old parent in the space it moves to, with its own rules (who gains
// and loses access); the tree rules it needs are the space's.
//
// A new writer of parent_id must either go through one of these or be added
// here with the reason it does not need the shared rules.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that write content_nodes.parent_id on an existing row. The event-history undo
 *  (eventRestore/restore.ts) writes it through nodeUpdate's applyNodeColumns, and is gated below. */
const PARENT_WRITERS = new Set([
  "services/nodeUpdate.ts",
  "services/tagMerge.ts",
  "services/spaces.ts",
]);
/** The writers that move a node within its space: each asks assertReparent. */
const REPARENT_GATED = ["services/nodeUpdate.ts", "services/tagMerge.ts", "services/eventRestore/restore.ts"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "test") sourceFiles(path, out); }
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split(sep).join("/");

/** Ways a file writes parent_id on an existing row: a literal
 *  `UPDATE content_nodes … SET … parent_id =`, a column-list helper
 *  (`set("parent_id", …)`), or a scalar-field list that includes it and is
 *  turned into `${field} = $n` (or `${sqlIdentifier(field)} = $n`) assignments. */
function writesParent(text: string): boolean {
  const literal = /UPDATE\s+content_nodes\b[^;`]*?\bSET\b[^;`]*?\bparent_id\s*=/i.test(text);
  const helper = /\bset\(\s*["']parent_id["']/.test(text);
  const scalarList = /Fields\s*=\s*\[[^\]]*["']parent_id["'][^\]]*\]/.test(text) && /\$\{(?:sqlIdentifier\()?field\)?\}\s*=\s*\$/.test(text);
  const columnList = /\b[A-Z_]*COLUMNS\s*=\s*\[[^\]]*["']parent_id["'][^\]]*\]/.test(text) && /\$\{sqlIdentifier\(column\)\}\s*=\s*\$/.test(text);
  return literal || helper || scalarList || columnList;
}

describe("parent_id has known writers (D102)", () => {
  const files = sourceFiles(SRC).map((path) => ({ path: rel(path), text: readFileSync(path, "utf8") }));

  it("only the listed files write content_nodes.parent_id", () => {
    const writers = files.filter((f) => writesParent(f.text)).map((f) => f.path).sort();
    expect(writers).toEqual([...PARENT_WRITERS].sort());
  });

  it("every move within a space asks assertReparent", () => {
    for (const path of REPARENT_GATED) {
      const text = files.find((f) => f.path === path)?.text ?? "";
      expect(text, path).toMatch(/\bassertReparent\(|\breparentRefusal\(/);
    }
  });

  it("no gated writer keeps a private copy of the tree rules", () => {
    for (const path of REPARENT_GATED) {
      const text = files.find((f) => f.path === path)?.text ?? "";
      expect(text, path).not.toMatch(/\bwouldCreateParentCycle\(\s*(?:workspaceId|row\.workspace_id)/);
      expect(text, path).not.toMatch(/\bassertParentKind\(|\bassertFieldChangeAllowed\(|\bassertNoNewFieldClash\(|\bcanPlaceUnder\(/);
    }
  });
});
