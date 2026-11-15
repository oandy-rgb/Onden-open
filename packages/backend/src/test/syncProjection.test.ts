// The three read surfaces a client mirrors from (bootstrap, sync delta,
// /sync/nodes) select edges, attributes, pointers and the workspace row
// through one column list each (services/syncProjection.ts), so they cannot drift apart or start
// shipping a new table column unannounced.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { edgeColumnsSql, attributeColumnsSql, pointerColumnsSql, workspaceColumnsSql } from "../services/syncProjection.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
// The bootstrap and the sync service (D8, D10); routes/sync.ts holds no SQL.
const surfaces = ["services/sync/bootstrap.ts", "services/sync/delta.ts", "services/sync/membership.ts", "services/sync/rows.ts"]
  .map((rel) => ({ rel, text: readFileSync(join(src, rel), "utf8") }));

describe("sync projection contract", () => {
  it("no surface selects a whole edge, attribute, pointer or workspace row", () => {
    for (const { rel, text } of surfaces) {
      expect(text, rel).not.toMatch(/SELECT\s+(\w+\.)?\*\s+FROM\s+(node_edges|node_attributes|note_pointers|workspaces)\b/i);
    }
  });

  it("every edge, attribute and pointer select on these surfaces uses the shared column list", () => {
    for (const { rel, text } of surfaces) {
      for (const [table, helper] of [["node_edges", "edgeColumnsSql"], ["node_attributes", "attributeColumnsSql"], ["note_pointers", "pointerColumnsSql"]]) {
        // Each `FROM <table>` that starts a select must be preceded by the helper in the same statement.
        const statements = text.split("`").filter((chunk) => new RegExp(`^\\s*SELECT[\\s\\S]*\\bFROM\\s+${table}\\b`, "i").test(chunk));
        for (const statement of statements) expect(statement, `${rel}: ${statement.slice(0, 80)}`).toContain(`\${${helper}(`);
      }
    }
  });

  it("the workspace row the client mirrors has one column list on every surface", () => {
    for (const { rel, text } of surfaces) {
      // A select of the row itself; reading only membership_epoch (the delta
      // and membership pages report it on their own) is not one.
      const statements = text.split("`").filter((chunk) => /^\s*SELECT[\s\S]*\bFROM\s+workspaces\b/i.test(chunk) && !/^\s*SELECT\s+membership_epoch\b/i.test(chunk));
      for (const statement of statements) expect(statement, `${rel}: ${statement.slice(0, 80)}`).toContain("${workspaceColumnsSql(");
    }
    const uses = surfaces.filter(({ text }) => text.includes("${workspaceColumnsSql(")).map(({ rel }) => rel);
    expect(uses).toEqual(["services/sync/bootstrap.ts", "services/sync/delta.ts"]);
  });

  it("the workspace row leaves through workspaceWireRow: the stored module decisions never reach a client", () => {
    for (const rel of ["services/sync/bootstrap.ts", "services/sync/delta.ts"]) {
      expect(surfaces.find((surface) => surface.rel === rel)!.text, rel).toContain("workspaceWireRow(");
    }
  });

  it("the column lists match what the client mirror stores", () => {
    expect(edgeColumnsSql("e").replace(/\s+/g, " ")).toBe("e.id, e.source_node_id, e.target_node_id, e.edge_type, e.status, e.origin, e.created_at");
    expect(attributeColumnsSql("a")).toBe("a.node_id, a.key, a.value, a.value_type, a.is_inheritable, a.source");
    expect(pointerColumnsSql("p")).toBe("p.id, p.parent_id, p.target_id, p.sort_order, p.display_prefix");
    // The owner's module decisions, which workspaceWireRow turns into the
    // `modules` and `modules_to_confirm` the client mirrors, and the workspace's
    // calendar clock (time_zone, day_start_hour) the client's "today" reads.
    expect(workspaceColumnsSql("w")).toBe("w.id, w.name, w.slug, w.home_node_id, w.modules_off, w.modules_confirmed, w.time_zone, w.day_start_hour");
  });
});
