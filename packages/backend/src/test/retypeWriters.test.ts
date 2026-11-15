// D94: node_attributes.value_type is derived — the field that governs a key
// decides it (@onden/markdown attributeValue.normalize). Attribute writes type
// what they store, but a write that changes WHICH field governs a key (tag
// membership, a tag's fields or `extends`, its parent, its trash state) must
// retype the values it affects: services/attributeChange.ts retypeGoverned.
// This scan fails when a file makes such a write without calling it (unless
// listed in EXEMPT with why), so a new path cannot leave stored types stale
// for sorts and range filters while the app reads the new schema.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

/** A tag membership write, or a literal `UPDATE content_nodes … SET` of a
 *  tag's schema, parent or trash state. */
const WRITES = /(INSERT INTO|DELETE FROM)\s+node_tags\b|UPDATE\s+content_nodes\b[^`]*\bSET\b[^`]*\b(tag_schema|parent_id|deleted_at)\s*=/;
/** Writers that build the column list at run time (set("parent_id", …), the
 *  undo's scalar fields): checked by name. */
const DYNAMIC_WRITERS = ["services/nodeUpdate.ts"];
/** The undo's scalar fields (a tag back under its old parent) go through the save's applyNodeColumns, which retypes. */
const THROUGH_NODE_COLUMNS = ["services/eventRestore/restore.ts"];
/** Writers whose rows no field governs differently afterwards. */
const EXEMPT: Record<string, string> = {
  "services/siteConfig.ts": "tags the hidden Site Config row with its reserved tag; it has no attribute values to type",
  "services/noteDuplicate.ts": "a copy gets the source's tags and values with the source's types, already under the same fields",
  "services/spaces.ts": "moves notes between spaces; a tag is never moved there (tags have no space)",
};
const RETYPES = /\bretypeGoverned\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

const rel = (path: string) => relative(SRC, path).split("\\").join("/");

describe("a write that changes which field governs a key retypes stored values (D94)", () => {
  it("every tag membership, tag schema, tag parent and tag trash writer calls retypeGoverned", () => {
    const writers = sourceFiles(SRC).filter((path) => DYNAMIC_WRITERS.includes(rel(path)) || WRITES.test(readFileSync(path, "utf8")));
    // The scan still finds the writers this was written against.
    for (const known of ["services/tagMembershipWrites.ts", "services/tagMembership.ts", "services/tagWrites.ts", "services/tagMerge.ts", "services/nodeTrash.ts"]) {
      expect(writers.map(rel)).toContain(known);
    }
    const silent = writers.filter((path) => !RETYPES.test(readFileSync(path, "utf8"))).map(rel).filter((path) => !(path in EXEMPT));
    expect(silent).toEqual([]);
  });

  it("the event-history undo writes the note's columns through the function that retypes", () => {
    for (const file of THROUGH_NODE_COLUMNS) expect(readFileSync(join(SRC, file), "utf8")).toMatch(/\bapplyNodeColumns\(/);
  });

  it("every exemption still names a writer", () => {
    const writers = new Set(sourceFiles(SRC).filter((path) => WRITES.test(readFileSync(path, "utf8"))).map(rel));
    expect(Object.keys(EXEMPT).filter((path) => !writers.has(path))).toEqual([]);
  });
});
