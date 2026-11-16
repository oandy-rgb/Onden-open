// A local copy made before order keys (server migration 200) holds the integer `sort_order` and no key. The copy
// opens with this build: every row gets a key that lists it where the older build listed it, and the old column stays.
import { beforeEach, describe, expect, it } from "vitest";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { sortChildren } from "../lib/childOrder";
import { prepareLocalDatabase } from "../lib/localDbSchema";
import { upsertNodeInto } from "../lib/localMirror";
import type { ContentNode } from "../lib/api";

let SQL: SqlJsStatic;
beforeEach(async () => { SQL = await initSqlJs(); });

/** The nodes and pointers tables as the previous build created them. */
function oldCopy(): Database {
  const db = new SQL.Database();
  db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, node_type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
    markdown TEXT NOT NULL DEFAULT '', parent_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    presentation TEXT, tag_schema TEXT, class_tag_ids TEXT, label_tag_ids TEXT, updated_at TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE pointers (id TEXT PRIMARY KEY, parent_id TEXT, target_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, display_prefix TEXT)`);
  return db;
}
const rows = (db: Database, sql: string) => {
  const [r] = db.exec(sql);
  return (r?.values ?? []).map((v) => Object.fromEntries(r!.columns.map((c, i) => [c, v[i]])));
};

describe("a local copy from before order keys", () => {
  it("keeps every list in the order the older build showed, with keys", () => {
    const db = oldCopy();
    const insert = (id: string, parent: string | null, sort: number, created: string | null) =>
      db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, parent_id, sort_order, created_at) VALUES (?, 'manual', 'content', ?, ?, ?, ?, ?)", [id, id, id, parent, sort, created]);
    // Ties, gaps, a negative number, a duplicate creation time (id decides) and a row without created_at (older builds: last among its ties, as the copy listed it).
    insert("d", "p", 0, "2026-10-02T00:00:00Z"); insert("a", "p", 0, "2026-10-01T00:00:00Z"); insert("c", "p", 5, "2026-10-01T00:00:00Z");
    insert("b", "p", 5, "2026-10-01T00:00:00Z"); insert("n", "p", -3, "2026-12-01T00:00:00Z"); insert("old", "p", 0, null);
    insert("r1", null, 1, "2026-10-01T00:00:00Z"); insert("r0", null, 0, "2026-10-09T00:00:00Z");
    db.run("INSERT INTO pointers (id, parent_id, target_id, sort_order) VALUES ('x', NULL, 't', 2), ('y', NULL, 't2', -1), ('z', NULL, 't3', 2)");

    prepareLocalDatabase(db);

    const keyed = rows(db, "SELECT id, parent_id, order_key, order_stamp FROM nodes") as unknown as ContentNode[];
    expect(keyed.every((r) => typeof r.order_key === "string" && r.order_key.length > 0)).toBe(true);
    const parentOrder = sortChildren(keyed.filter((r) => r.parent_id === "p")).map((r) => r.id);
    expect(parentOrder).toEqual(["n", "a", "d", "old", "b", "c"]);
    expect(sortChildren(keyed.filter((r) => r.parent_id === null)).map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(rows(db, "SELECT id FROM pointers ORDER BY order_key, order_stamp, id").map((r) => r.id)).toEqual(["y", "x", "z"]);
    // The old column is still there, unread.
    expect(rows(db, "SELECT sort_order FROM nodes WHERE id = 'c'")).toEqual([{ sort_order: 5 }]);
  });

  it("does not renumber again: a row written later with no key stays without one", () => {
    const db = oldCopy();
    prepareLocalDatabase(db);
    upsertNodeInto(db as never, { id: "new", source_type: "manual", node_type: "content", title: "new", slug: "new", markdown: "", parent_id: null, hidden: false } as ContentNode, { from: "write" } as never);
    prepareLocalDatabase(db);
    expect(rows(db, "SELECT order_key FROM nodes WHERE id = 'new'")).toEqual([{ order_key: null }]);
  });
});

// Server migration 201's lesson: a migration that rewrites what devices hold, with no event, is invisible to a copy that
// already exists. Migration 200 backfills order_key that way, so the copy's schema version asks for a whole bootstrap.
describe("a device that already holds a copy made before order keys", () => {
  it("reads the server's keys again on the next open and lists notes in the server's order", () => {
    const db = oldCopy();
    const insert = (id: string, sort: number) =>
      db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, parent_id, sort_order, created_at) VALUES (?, 'manual', 'content', ?, ?, 'p', ?, '2026-10-01T00:00:00Z')", [id, id, id, sort]);
    insert("a", 0); insert("b", 1); insert("c", 2);
    db.run("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', ?), ('mirror_schema_version', '3')", [String(Date.now())]);

    prepareLocalDatabase(db);
    // The upgrade forgets the last whole download, so the next open does one.
    expect(rows(db, "SELECT value FROM sync_state WHERE key = 'full_refresh_at'")).toEqual([]);

    // The server reordered meanwhile (a move made on another device, keys the copy never saw).
    const server: Record<string, { key: string; stamp: string }> = { c: { key: "a0", stamp: "1" }, a: { key: "a1", stamp: "2" }, b: { key: "a2", stamp: "3" } };
    for (const [id, s] of Object.entries(server)) {
      upsertNodeInto(db as never, { id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: "p", hidden: false, order_key: s.key, order_stamp: s.stamp } as ContentNode, { from: "bootstrap" } as never);
    }
    const after = rows(db, "SELECT id, parent_id, order_key, order_stamp FROM nodes") as unknown as ContentNode[];
    expect(sortChildren(after.filter((r) => r.parent_id === "p")).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(after.every((r) => r.order_key === server[r.id]!.key && r.order_stamp === server[r.id]!.stamp)).toBe(true);
  });
});
