import { describe, it, expect, beforeEach } from "vitest";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { persistBootstrapInto, persistBootstrapMetaInto, fillAttributesInto, planDrawingDownload, replaceStaleCopiesInto, drawingCopyKey, persistTagCatalogInto, slimBootstrapNodeDrops, dropNodeFromMirror } from "../lib/localDbPersist";
import { upsertNodeInto, upsertAttributeInto } from "../lib/localMirror";
import { restoreTagCatalog, tagFromNode } from "../lib/tagProjection";
import type { Bootstrap, ContentNode } from "../lib/api";

// Drives the real persist logic against a real in-memory sql.js DB (sql.js runs
// fine under Node; only the worker module's wasm-on-jsdom path can't). This is
// the non-clobber guarantee (review #3, HIGH-B): a SLIM / partial bootstrap must
// MERGE into the local mirror, never wipe rows or hydrated bodies that aren't in
// the payload. A FULL bootstrap stays the authoritative wholesale replace.

let SQL: SqlJsStatic;

beforeEach(async () => {
  SQL = await initSqlJs();
});

function freshDb(): Database {
  const db = new SQL.Database();
  db.run("CREATE TABLE sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.run(`CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, home_node_id TEXT, actor_role TEXT, site_config TEXT, chrome TEXT, modules TEXT, modules_to_confirm TEXT, time_zone TEXT, day_start_hour INTEGER, actor_is_owner INTEGER, can_review INTEGER)`);
  db.run(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, node_type TEXT NOT NULL,
    title TEXT NOT NULL, slug TEXT NOT NULL, markdown TEXT NOT NULL DEFAULT '',
    parent_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    presentation TEXT, tag_schema TEXT, class_tag_ids TEXT, label_tag_ids TEXT, updated_at TEXT, body_len INTEGER, space_id TEXT, created_at TEXT, collection_views TEXT)`);
  db.run(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, edge_type TEXT NOT NULL, status TEXT NOT NULL, origin TEXT)`);
  db.run(`CREATE TABLE pointers (id TEXT PRIMARY KEY, parent_id TEXT, target_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, display_prefix TEXT)`);
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', due_date TEXT, recur TEXT)`);
  db.run(`CREATE TABLE suggestions (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, suggestion_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, reasoning TEXT)`);
  db.run(`CREATE TABLE node_attributes (node_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, value_type TEXT NOT NULL DEFAULT 'text', is_inheritable INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'explicit', updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (node_id, key))`);
  db.run(`CREATE TABLE canvas_memberships (canvas_id TEXT NOT NULL, node_id TEXT NOT NULL, canvas_title TEXT NOT NULL DEFAULT '', PRIMARY KEY (canvas_id, node_id))`);
  db.run(`CREATE TABLE graph_positions (node_id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL)`);
  db.run(`CREATE TABLE note_anchors (anchor_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, pos_from INTEGER NOT NULL, pos_to INTEGER NOT NULL, status TEXT NOT NULL, cand_from INTEGER, cand_to INTEGER, quote TEXT NOT NULL DEFAULT '')`);
  db.run(`CREATE TABLE note_link_bindings (note_id TEXT NOT NULL, link_text TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY (note_id, link_text))`);
  // The Node sql.js build may lack FTS5 — persistBootstrapInto's FTS rebuild is
  // wrapped in try/catch for exactly this, so skip the virtual table when the
  // module is unavailable (mirrors the worker's best-effort FTS handling).
  try { db.run(`CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, markdown)`); } catch { /* FTS5 unavailable */ }
  return db;
}

function rows(db: Database, sql: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function node(id: string, over: Partial<ContentNode> = {}): ContentNode {
  return {
    id, source_type: "user", node_type: "note", title: `node ${id}`,
    slug: `node-${id}`, markdown: "", parent_id: null, hidden: false,
    sort_order: 0, presentation: null, updated_at: "2026-01-01T00:00:00Z",
    attrs: {}, ...over,
  } as unknown as ContentNode;
}

function bootstrap(over: Partial<Bootstrap> & { nodes: ContentNode[] }): Bootstrap {
  return {
    bodies: "full",
    workspace: { id: "ws1", name: "WS", slug: "ws", home_node_id: null },
    edges: [], tasks: [], suggestions: [], events: [],
    actor_role: "owner", tags: [],
    ...over,
  } as unknown as Bootstrap;
}

describe("persistBootstrapInto — non-clobber on slim/partial bootstrap", () => {
  it("retains scoped module metadata without a readable tag node and persists revocation independently", () => {
    const db = freshDb();
    const tag = tagFromNode(node("scoped-tag", { node_type: "class_tag", tag_schema: { behaviour: { modules: { review: { enabled: true } } } } }));
    persistBootstrapInto(db, bootstrap({ nodes: [node("member", { class_tag_ids: [tag.id] })], tags: [tag] }));
    const catalog = () => String(rows(db, "SELECT value FROM sync_state WHERE key='tags_json'")[0].value);
    expect(rows(db, "SELECT id FROM nodes")).toEqual([{ id: "member" }]);
    expect(restoreTagCatalog(catalog(), [])).toEqual([tag]);
    persistTagCatalogInto(db, [{ ...tag, schema_behaviour: { modules: { review: { enabled: false } } } }]);
    expect(restoreTagCatalog(catalog(), [node("unrelated")])[0].schema_behaviour).toEqual({ modules: { review: { enabled: false } } });
    persistTagCatalogInto(db, []);
    expect(restoreTagCatalog(catalog(), [node("scoped-tag", { node_type: "class_tag" })])).toEqual([]);
    db.close();
  });
  it("rolls back revoked-mirror cleanup if the replacement snapshot fails", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ nodes: [node("a", { markdown: "old", attrs: { ink: "old ink" } })] }));
    db.run("CREATE TRIGGER reject_insert BEFORE INSERT ON nodes WHEN NEW.title = 'bad' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    expect(() => persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("a", { title: "bad" })] }), ["a"]))
      .toThrow("test storage failure");
    expect(rows(db, "SELECT id, markdown FROM nodes")).toEqual([{ id: "a", markdown: "old" }]);
    expect(rows(db, "SELECT key, value FROM node_attributes")).toEqual([{ key: "ink", value: "old ink" }]);
    db.close();
  });

  it("FULL bootstrap replaces wholesale (baseline behaviour)", () => {
    const db = freshDb();
    // Seed a complete mirror, then a full bootstrap that drops node 'b'.
    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a", { markdown: "A body" }), node("b", { markdown: "B body" })] }));
    expect(rows(db, "SELECT id FROM nodes ORDER BY id").map((r) => r.id)).toEqual(["a", "b"]);

    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a", { markdown: "A2" })] }));
    // Full = authoritative: 'b' is gone, 'a' updated.
    expect(rows(db, "SELECT id, markdown FROM nodes ORDER BY id")).toEqual([{ id: "a", markdown: "A2" }]);
  });

  it("a whole bootstrap leaves a pin once, under the id the server now has, when the copy held the id from before migration 194", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ nodes: [node("parent"), node("target")], pointers: [{ id: "old-id", parent_id: "parent", target_id: "target", sort_order: 0, display_prefix: null }] }));
    persistBootstrapInto(db, bootstrap({ nodes: [node("parent"), node("target")], pointers: [{ id: "derived-id", parent_id: "parent", target_id: "target", sort_order: 0, display_prefix: null }] }));
    expect(rows(db, "SELECT id FROM pointers WHERE parent_id = 'parent' AND target_id = 'target'")).toEqual([{ id: "derived-id" }]);
    db.close();
  });

  it("dropNodeFromMirror cascades to tasks, edges, pointers and attributes (H17)", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a"), node("keep")] }));
    // Dependent rows for node 'a' (the kind a slim-drop used to orphan).
    db.run("INSERT INTO tasks (id, node_id, title, status) VALUES ('t1','a','T','todo')");
    db.run("INSERT INTO edges (id, source_node_id, target_node_id, edge_type, status) VALUES ('e1','a','keep','ref','active')");
    db.run("INSERT INTO edges (id, source_node_id, target_node_id, edge_type, status) VALUES ('e2','keep','a','ref','active')");
    db.run("INSERT INTO node_attributes (node_id, key, value) VALUES ('a','sketch_data','{}')");
    db.run("INSERT INTO pointers (id, parent_id, target_id) VALUES ('p1','keep','a'), ('p2','a','keep'), ('p3', NULL, 'keep')");
    // An unrelated node's rows must survive.
    db.run("INSERT INTO node_attributes (node_id, key, value) VALUES ('keep','color','red')");
    // D98: boards a note is on (as note or as canvas) and its graph position.
    db.run("INSERT INTO canvas_memberships (canvas_id, node_id) VALUES ('board','a'), ('a','keep'), ('board','keep')");
    db.run("INSERT INTO graph_positions (node_id, x, y) VALUES ('a', 1, 2), ('keep', 3, 4)");

    dropNodeFromMirror(db, "a");
    expect(rows(db, "SELECT canvas_id, node_id FROM canvas_memberships")).toEqual([{ canvas_id: "board", node_id: "keep" }]);
    expect(rows(db, "SELECT node_id FROM graph_positions").map((r) => r.node_id)).toEqual(["keep"]);

    expect(rows(db, "SELECT id FROM nodes ORDER BY id").map((r) => r.id)).toEqual(["keep"]);
    expect(rows(db, "SELECT id FROM tasks WHERE node_id='a' OR id='a'")).toEqual([]);
    expect(rows(db, "SELECT id FROM edges WHERE source_node_id='a' OR target_node_id='a'")).toEqual([]);
    expect(rows(db, "SELECT key FROM node_attributes WHERE node_id='a'")).toEqual([]);
    expect(rows(db, "SELECT id FROM pointers").map((r) => r.id)).toEqual(["p3"]);
    // The other node's data is untouched.
    expect(rows(db, "SELECT key FROM node_attributes WHERE node_id='keep'").map((r) => r.key)).toEqual(["color"]);
  });

  it("SLIM bootstrap does NOT delete rows absent from the payload", () => {
    const db = freshDb();
    // A previously-complete mirror with 3 nodes + their bodies.
    persistBootstrapInto(db, bootstrap({
      bodies: "full",
      nodes: [node("a", { markdown: "A body" }), node("b", { markdown: "B body" }), node("c", { markdown: "C body" })],
    }));

    // A slim bootstrap that, e.g. due to a permission scope or truncation, only
    // carries a SUBSET — and with empty bodies (slim). It must MERGE, not wipe.
    persistBootstrapInto(db, bootstrap({
      bodies: "none",
      nodes: [node("a", { markdown: "" }), node("b", { markdown: "" })],
    }));

    // 'c' (absent from the slim payload) must SURVIVE — the non-clobber guarantee.
    expect(rows(db, "SELECT id FROM nodes ORDER BY id").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("SLIM bootstrap preserves a locally-hydrated body (empty '' never clobbers)", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a", { markdown: "hydrated A body" })] }));

    // Re-persist slim: node 'a' arrives with markdown "" (body stripped).
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("a", { markdown: "", title: "renamed A" })] }));

    const a = rows(db, "SELECT title, markdown FROM nodes WHERE id='a'")[0];
    // Skeleton fields update (title), but the hydrated body is PRESERVED.
    expect(a.title).toBe("renamed A");
    expect(a.markdown).toBe("hydrated A body");
  });

  it("SLIM bootstrap with a NON-empty body still wins (server body is authoritative)", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a", { markdown: "old body" })] }));
    // Edge case: a slim payload that happens to carry a real body must overwrite.
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("a", { markdown: "new server body" })] }));
    expect(rows(db, "SELECT markdown FROM nodes WHERE id='a'")[0].markdown).toBe("new server body");
  });

  it("SLIM bootstrap upserts NEW nodes (growth, not just preservation)", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ bodies: "full", nodes: [node("a", { markdown: "A" })] }));
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("a"), node("z", { title: "new Z" })] }));
    const ids = rows(db, "SELECT id FROM nodes ORDER BY id").map((r) => r.id);
    expect(ids).toEqual(["a", "z"]);
  });

  it("SLIM bootstrap keeps attrs/edges of nodes absent from the payload", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({
      bodies: "full",
      nodes: [node("a", { attrs: { color: "red" } }), node("b", { attrs: { color: "blue" } })],
      edges: [{ id: "e1", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" }] as Bootstrap["edges"],
    }));

    // Slim payload carries only 'a'. 'b' and the a→b edge must survive.
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("a", { attrs: { color: "green" } })] }));

    expect(rows(db, "SELECT value FROM node_attributes WHERE node_id='a' AND key='color'")[0].value).toBe("green");
    expect(rows(db, "SELECT value FROM node_attributes WHERE node_id='b' AND key='color'")[0].value).toBe("blue");
    expect(rows(db, "SELECT id FROM edges").map((r) => r.id)).toEqual(["e1"]);
  });

  it("persists tag identity (tag_schema + class/label membership) as JSON for offline cold start", () => {
    const db = freshDb();
    // A class_tag node carrying a schema, and a content node that is a member of
    // a class tag (class_tag_ids) + a label tag (label_tag_ids).
    persistBootstrapInto(db, bootstrap({
      bodies: "full",
      nodes: [
        node("tagA", { node_type: "class_tag", tag_schema: { name: "A", fields: [{ name: "x" }], policy: { operations: { read: "admin" } } } } as Partial<ContentNode>),
        node("item1", { class_tag_ids: ["tagA"], label_tag_ids: ["toread"] } as Partial<ContentNode>),
      ],
    }));

    const tagA = rows(db, "SELECT tag_schema, class_tag_ids, label_tag_ids FROM nodes WHERE id='tagA'")[0];
    expect(JSON.parse(tagA.tag_schema as string)).toMatchObject({ policy: { operations: { read: "admin" } } });

    const item = rows(db, "SELECT tag_schema, class_tag_ids, label_tag_ids FROM nodes WHERE id='item1'")[0];
    expect(item.tag_schema).toBeNull(); // a plain content node has no schema
    expect(JSON.parse(item.class_tag_ids as string)).toEqual(["tagA"]);
    expect(JSON.parse(item.label_tag_ids as string)).toEqual(["toread"]);
  });

  it("at >5000 slim skeletons the merge stays whole (scale, no truncation)", () => {
    const db = freshDb();
    const many: ContentNode[] = [];
    for (let i = 0; i < 5200; i++) many.push(node(`n${i}`, { markdown: "" }));
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: many }));
    const count = rows(db, "SELECT count(*) AS c FROM nodes")[0].c;
    expect(count).toBe(5200);
  });
});

describe("slimBootstrapNodeDrops — slim reconcile drops server-deleted nodes (HIGH gap #2)", () => {
  it("drops a mirror node absent from the slim payload (server-deleted)", () => {
    const drops = slimBootstrapNodeDrops(new Set(["a", "b"]), ["a", "b", "gone"]);
    expect(drops).toEqual(["gone"]);
  });

  it("keeps nodes still present in the payload", () => {
    expect(slimBootstrapNodeDrops(new Set(["a", "b"]), ["a", "b"])).toEqual([]);
  });

  it("clears every absent mirror before local create input is reconstructed", () => {
    const drops = slimBootstrapNodeDrops(new Set(["a"]), ["a", "offline1", "offline2", "gone"]);
    expect(drops).toEqual(["offline1", "offline2", "gone"]);
  });
});

describe("local mirror row writers — one rule set for bootstrap, delta and local writes", () => {
  const body = (db: Database, id: string) => rows(db, `SELECT markdown, body_len, space_id FROM nodes WHERE id = '${id}'`)[0];

  it("keeps a stored body and space across slim bootstrap, server delta and a local write", () => {
    const db = freshDb();
    // Full bootstrap: body and space arrive.
    persistBootstrapInto(db, bootstrap({ nodes: [node("n1", { markdown: "full body", space_id: "space-a" } as Partial<ContentNode>)] }));
    expect(body(db, "n1")).toEqual({ markdown: "full body", body_len: 9, space_id: "space-a" });

    // Slim bootstrap names the body without carrying it: the body stays.
    persistBootstrapInto(db, bootstrap({ bodies: "none", nodes: [node("n1", { markdown: "", body_len: 9, title: "renamed", space_id: "space-a" } as Partial<ContentNode>)] } as Partial<Bootstrap> & { nodes: ContentNode[] }));
    expect(body(db, "n1")).toEqual({ markdown: "full body", body_len: 9, space_id: "space-a" });

    // A local (optimistic) row has no space yet: the server's space stays.
    upsertNodeInto(db, node("n1", { markdown: "edited here" }), { from: "local" });
    expect(body(db, "n1")).toEqual({ markdown: "edited here", body_len: 11, space_id: "space-a" });

    // A slim local row (title change on a note not downloaded) keeps the body too.
    upsertNodeInto(db, node("n1", { markdown: "", body_len: 11, title: "again" } as Partial<ContentNode>), { from: "local" });
    expect(body(db, "n1")).toEqual({ markdown: "edited here", body_len: 11, space_id: "space-a" });

    // The server is authoritative for space, null included (moved out of reach of a space).
    upsertNodeInto(db, node("n1", { markdown: "server body", space_id: null } as Partial<ContentNode>), { from: "server" });
    expect(body(db, "n1")).toEqual({ markdown: "server body", body_len: 11, space_id: null });

    // An explicit empty body (body_len 0) is a cleared note, not a slim row.
    upsertNodeInto(db, node("n1", { markdown: "", body_len: 0 } as Partial<ContentNode>), { from: "local" });
    expect(body(db, "n1")).toEqual({ markdown: "", body_len: 0, space_id: null });
    db.close();
  });

  it("writes an attribute's type, inheritance and source, defaulting what's omitted", () => {
    const db = freshDb();
    upsertAttributeInto(db, { node_id: "n1", key: "due", value: "2026-10-14", value_type: "date", is_inheritable: true, source: "frontmatter" });
    upsertAttributeInto(db, { node_id: "n1", key: "plain", value: "x" });
    expect(rows(db, "SELECT key, value_type, is_inheritable, source FROM node_attributes ORDER BY key")).toEqual([
      { key: "due", value_type: "date", is_inheritable: 1, source: "frontmatter" },
      { key: "plain", value_type: "text", is_inheritable: 0, source: "ui" },
    ]);
    db.close();
  });
});

describe("the mirror's row writes live in lib/localMirror.ts only", () => {
  it("no other source file inserts into nodes, edges, pointers or node_attributes", () => {
    const src = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== "test") walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name) || full.endsWith("localMirror.ts")) continue;
        if (/INSERT INTO (nodes|edges|pointers|node_attributes)\b/.test(readFileSync(full, "utf8"))) offenders.push(full.slice(src.length + 1));
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("bootstrap attributes keep their type, inheritance and source", () => {
  it("uses the typed attributes when the server ships them, the flat map otherwise", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({
      nodes: [node("t", { attrs: { due: "2026-10-14" } } as Partial<ContentNode>)],
      attributes: [{ node_id: "t", key: "due", value: "2026-10-14", value_type: "date", is_inheritable: true, source: "frontmatter" }],
    } as Partial<Bootstrap> & { nodes: ContentNode[] }));
    expect(rows(db, "SELECT key, value_type, is_inheritable, source FROM node_attributes WHERE node_id='t'"))
      .toEqual([{ key: "due", value_type: "date", is_inheritable: 1, source: "frontmatter" }]);

    persistBootstrapInto(db, bootstrap({ nodes: [node("old", { attrs: { k: "v" } } as Partial<ContentNode>)] }));
    expect(rows(db, "SELECT key, value_type FROM node_attributes WHERE node_id='old'")).toEqual([{ key: "k", value_type: "text" }]);
    db.close();
  });
});

describe("bootstrap timezone survives an offline cold start", () => {
  it("stores the server's zone and clears it when the server stops sending one", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ nodes: [], timezone: "Asia/Taipei" } as Partial<Bootstrap> & { nodes: ContentNode[] }));
    expect(rows(db, "SELECT value FROM sync_state WHERE key='timezone'")).toEqual([{ value: "Asia/Taipei" }]);
    persistBootstrapInto(db, bootstrap({ nodes: [] }));
    expect(rows(db, "SELECT value FROM sync_state WHERE key='timezone'")).toEqual([]);
    db.close();
  });
});

describe("the workspace's own clock survives an offline cold start", () => {
  it("stores the owner's zone and the day start hour on the workspace row, and a later bootstrap replaces them", () => {
    const db = freshDb();
    const workspace = { id: "ws", name: "W", slug: "ws", home_node_id: null };
    persistBootstrapInto(db, bootstrap({ nodes: [], workspace: { ...workspace, time_zone: "Asia/Taipei", day_start_hour: 4 } }));
    expect(rows(db, "SELECT time_zone, day_start_hour FROM workspace")).toEqual([{ time_zone: "Asia/Taipei", day_start_hour: 4 }]);
    persistBootstrapInto(db, bootstrap({ nodes: [], workspace }));
    expect(rows(db, "SELECT time_zone, day_start_hour FROM workspace")).toEqual([{ time_zone: null, day_start_hour: 0 }]);
    db.close();
  });
});

describe("persistBootstrapMetaInto (?nodes=none)", () => {
  it("replaces the workspace parts and keeps every node, edge and attribute row", () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({
      nodes: [node("a", { markdown: "kept body" })],
      edges: [{ id: "e1", source_node_id: "a", target_node_id: "a", edge_type: "related", status: "active" }] as Bootstrap["edges"],
      suggestions: [{ id: "s-old", target_id: "a", suggestion_type: "tag", payload: {}, status: "pending", reasoning: null }] as unknown as Bootstrap["suggestions"],
    }));
    upsertAttributeInto(db, { node_id: "a", key: "status", value: "open" });
    persistBootstrapMetaInto(db, bootstrap({
      nodes_omitted: true, nodes: [],
      workspace: { id: "ws", name: "Renamed", slug: "ws", home_node_id: null },
      suggestions: [{ id: "s-new", target_id: "a", suggestion_type: "tag", payload: {}, status: "pending", reasoning: null }] as unknown as Bootstrap["suggestions"],
      timezone: "Asia/Taipei",
    }));
    expect(rows(db, "SELECT id, markdown FROM nodes")).toEqual([{ id: "a", markdown: "kept body" }]);
    expect(rows(db, "SELECT id FROM edges")).toEqual([{ id: "e1" }]);
    expect(rows(db, "SELECT key FROM node_attributes")).toEqual([{ key: "status" }]);
    expect(rows(db, "SELECT id FROM suggestions")).toEqual([{ id: "s-new" }]);
    expect(rows(db, "SELECT name FROM workspace")).toEqual([{ name: "Renamed" }]);
    expect(rows(db, "SELECT value FROM sync_state WHERE key='timezone'")).toEqual([{ value: "Asia/Taipei" }]);
  });
});

// A lean bootstrap (deferred_attribute_keys) leaves drawings out: the copies
// this device holds stay, except for notes the payload no longer has.
describe("lean bootstrap keeps the drawings this device holds", () => {
  const ink = (db: Database) => rows(db, "SELECT node_id, key, value FROM node_attributes WHERE key='ink_data' ORDER BY node_id");
  function seeded(): Database {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ nodes: [node("a"), node("b")] }));
    upsertAttributeInto(db, { node_id: "a", key: "ink_data", value: "A-strokes" });
    upsertAttributeInto(db, { node_id: "b", key: "ink_data", value: "B-strokes" });
    upsertAttributeInto(db, { node_id: "a", key: "status", value: "old" });
    return db;
  }
  const lean = { deferred_attribute_keys: ["ink_data", "pdf_annotations"], attrs_omitted: true as const };

  it("full: keeps a present note's drawing, drops a gone note's, replaces the other attributes", () => {
    const db = seeded();
    persistBootstrapInto(db, bootstrap({ ...lean, nodes: [node("a")], attributes: [{ node_id: "a", key: "status", value: "new", value_type: "text", is_inheritable: false, source: "explicit" }] }));
    expect(ink(db)).toEqual([{ node_id: "a", key: "ink_data", value: "A-strokes" }]);
    expect(rows(db, "SELECT value FROM node_attributes WHERE key='status'")).toEqual([{ value: "new" }]);
  });

  it("slim: keeps each note's drawing", () => {
    const db = seeded();
    persistBootstrapInto(db, bootstrap({ ...lean, bodies: "none", nodes: [node("a"), node("b")], attributes: [] }));
    expect(ink(db).map((r) => r.node_id)).toEqual(["a", "b"]);
    expect(rows(db, "SELECT key FROM node_attributes WHERE key='status'")).toEqual([]);
  });

  it("an old-shape payload still replaces every attribute", () => {
    const db = seeded();
    persistBootstrapInto(db, bootstrap({ nodes: [node("a"), node("b")], attributes: [] }));
    expect(ink(db)).toEqual([]);
  });

  it("fillAttributesInto adds a missing copy and never replaces one", () => {
    const db = seeded();
    fillAttributesInto(db, [{ node_id: "a", key: "ink_data", value: "server" }, { node_id: "b", key: "pdf_annotations", value: "[]" }]);
    expect(ink(db)[0]).toEqual({ node_id: "a", key: "ink_data", value: "A-strokes" });
    expect(rows(db, "SELECT value FROM node_attributes WHERE key='pdf_annotations'")).toEqual([{ value: "[]" }]);
  });
});

describe("planDrawingDownload (the offline drawing download's to-do list)", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const old = "2026-10-19 11:00:00", fresh = "2026-10-19 11:59:30";
  const index = [
    { node_id: "a", key: "ink_data", size: 1, hash: "server-a" }, // same copy here
    { node_id: "b", key: "ink_data", size: 1, hash: "server-b" }, // no copy: missing
    { node_id: "c", key: "ink_data", size: 1, hash: "server-c" }, // stale copy
    { node_id: "d", key: "ink_data", size: 1, hash: "server-d" }, // differs, but strokes queued
    { node_id: "e", key: "ink_data", size: 1, hash: "server-e" }, // differs, written a moment ago
    { node_id: "zz", key: "ink_data", size: 1, hash: "x" },       // not held here
  ];
  const local = new Map([
    [drawingCopyKey("a", "ink_data"), { hash: "server-a", updated_at: old }],
    [drawingCopyKey("c", "ink_data"), { hash: "old-c", updated_at: old }],
    [drawingCopyKey("d", "ink_data"), { hash: "local-d", updated_at: old }],
    [drawingCopyKey("e", "ink_data"), { hash: "local-e", updated_at: fresh }],
  ]);
  it("fetches the missing, re-fetches the stale, and never touches the person's own unsynced strokes", () => {
    const plan = planDrawingDownload(index, new Set(["a", "b", "c", "d", "e"]), local, new Set(["d"]), now);
    expect(plan.missing).toEqual(["b"]);
    expect(plan.stale).toEqual([{ node_id: "c", key: "ink_data", localHash: "old-c" }]);
  });
  it("without hashes (an older server, or no Web Crypto here) only fetches missing copies", () => {
    const plan = planDrawingDownload(index.map(({ hash: _h, ...e }) => e), new Set(["a", "b", "c"]), local, new Set(), now);
    expect(plan).toEqual({ missing: ["b"], stale: [] });
  });
});

describe("replaceStaleCopiesInto", () => {
  const sha = async (text: string) => `h(${text})`;
  it("replaces an unchanged stale copy; keeps one drawn on meanwhile or with queued strokes", async () => {
    const db = freshDb();
    persistBootstrapInto(db, bootstrap({ nodes: [node("a"), node("b"), node("c")] }));
    for (const id of ["a", "b", "c"]) upsertAttributeInto(db, { node_id: id, key: "ink_data", value: `old ${id}` });
    upsertAttributeInto(db, { node_id: "b", key: "ink_data", value: "drawn meanwhile" });
    const rows = ["a", "b", "c"].map((id) => ({ node_id: id, key: "ink_data", value: `server ${id}`, expected_hash: `h(old ${id})` }));
    expect(await replaceStaleCopiesInto(db, rows, new Set(["c"]), sha)).toBe(1);
    expect(rows.length).toBe(3);
    expect(Object.fromEntries(rows.map((r) => [r.node_id, (db.exec("SELECT value FROM node_attributes WHERE node_id=? AND key='ink_data'", [r.node_id])[0]!.values[0]![0])])))
      .toEqual({ a: "server a", b: "drawn meanwhile", c: "old c" });
  });
});
