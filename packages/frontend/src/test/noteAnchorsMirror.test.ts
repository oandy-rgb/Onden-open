// Paragraph anchors in the device's local copy (docs/architecture/proposals/block-anchors-2026-11-01.md §9, batch 0):
//   * a bootstrap and a sync delta write them, and a cold start reads them back as the server shipped them;
//   * they follow the note they belong to: dropped with it (deleted, or its reader lost access) and in the
//     in-memory view too;
//   * a slim bootstrap that does not carry a note leaves that note's anchors as they were;
//   * signing out / losing access wipes the table with the rest.
import { beforeEach, describe, expect, it } from "vitest";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareLocalDatabase } from "../lib/localDbSchema";
import { NOTE_ANCHORS_SELECT, applyNoteAnchorDeltaInto, dropNodeFromMirror, persistBootstrapInto } from "../lib/localDbPersist";
import { anchorsOf, applyAnchorsOfDelta, replaceAllAnchors, type NoteAnchor } from "../lib/blockAnchorStore";
import type { Bootstrap, ContentNode } from "../lib/api";

let SQL: SqlJsStatic;
beforeEach(async () => { SQL = await initSqlJs(); replaceAllAnchors([]); });

const anchor = (id: string, note: string, from: number, over: Partial<NoteAnchor> = {}): NoteAnchor =>
  ({ anchor_id: id, note_id: note, from, to: from + 10, status: "valid", candidate_from: null, candidate_to: null, quote: "", ...over });
const note = (id: string) => ({
  id, source_type: "user", node_type: "note", title: id, slug: id, markdown: "x", parent_id: null, hidden: false,
  sort_order: 0, presentation: null, updated_at: "2026-11-01T00:00:00Z", attrs: {},
} as unknown as ContentNode);
function bootstrap(nodes: ContentNode[], note_anchors: NoteAnchor[] | undefined, slim = false): Bootstrap {
  return {
    ...(slim ? { bodies: "none" as const } : {}),
    workspace: { id: "w", name: "W", slug: "w" }, nodes, edges: [], tasks: [], suggestions: [], events: [], ...(note_anchors ? { note_anchors } : {}),
  } as unknown as Bootstrap;
}
function held(db: Database): NoteAnchor[] {
  const out: NoteAnchor[] = [];
  const stmt = db.prepare(NOTE_ANCHORS_SELECT);
  while (stmt.step()) out.push(stmt.getAsObject() as unknown as NoteAnchor);
  stmt.free();
  return out;
}
const fresh = (): Database => { const db = new SQL.Database(); prepareLocalDatabase(db); return db; };

describe("note anchors in the local copy", () => {
  it("a bootstrap stores them and a cold start reads them back as the server shipped them", () => {
    const db = fresh();
    const shipped = [anchor("a1", "n1", 0), anchor("a2", "n1", 20, { status: "maybe", candidate_from: 40, candidate_to: 60 }), anchor("b1", "n2", 5, { status: "lost" })];
    persistBootstrapInto(db, bootstrap([note("n1"), note("n2")], shipped));
    expect(held(db)).toEqual(shipped);
  });

  it("a delta replaces the shipped notes' anchors whole; an anchor the server dropped goes", () => {
    const db = fresh();
    persistBootstrapInto(db, bootstrap([note("n1"), note("n2")], [anchor("a1", "n1", 0), anchor("a2", "n1", 20), anchor("b1", "n2", 5)]));
    applyNoteAnchorDeltaInto(db, { upsert: [anchor("a1", "n1", 3)], replace_for: ["n1"] });
    expect(held(db).map((a) => [a.anchor_id, a.from])).toEqual([["a1", 3], ["b1", 5]]);
  });

  it("goes with the note: deleted or revoked notes leave no anchors behind, in the copy and in memory", () => {
    const db = fresh();
    const rows = [anchor("a1", "n1", 0), anchor("b1", "n2", 5)];
    persistBootstrapInto(db, bootstrap([note("n1"), note("n2")], rows));
    dropNodeFromMirror(db, "n1");
    expect(held(db).map((a) => a.note_id)).toEqual(["n2"]);

    replaceAllAnchors(rows);
    applyAnchorsOfDelta({ nodes: { delete: ["n1"] } });
    expect(anchorsOf("n1")).toEqual([]);
    expect(anchorsOf("n2")).toHaveLength(1);
    // A re-grant ships them again (the membership projection): they come back with the note.
    applyAnchorsOfDelta({ nodes: { delete: [] }, note_anchors: { upsert: [rows[0]!], replace_for: ["n1"] } });
    expect(anchorsOf("n1")).toEqual([rows[0]]);
  });

  it("a slim bootstrap that does not carry a note keeps that note's anchors", () => {
    const db = fresh();
    persistBootstrapInto(db, bootstrap([note("n1"), note("n2")], [anchor("a1", "n1", 0), anchor("b1", "n2", 5)]));
    persistBootstrapInto(db, bootstrap([note("n1")], [anchor("a9", "n1", 9)], true));
    expect(held(db).map((a) => a.anchor_id)).toEqual(["a9", "b1"]);
    // A ?nodes=none snapshot says nothing about them.
    persistBootstrapInto(db, bootstrap([], undefined, true));
    expect(held(db)).toHaveLength(2);
  });

  it("an in-memory bootstrap replaces only the notes it carried", () => {
    replaceAllAnchors([anchor("a1", "n1", 0), anchor("b1", "n2", 5)]);
    replaceAllAnchors([anchor("a9", "n1", 9)], ["n1"]);
    expect(anchorsOf("n1").map((a) => a.anchor_id)).toEqual(["a9"]);
    expect(anchorsOf("n2")).toHaveLength(1);
  });

  it("every table the local copy creates is wiped when access is revoked", () => {
    const db = fresh();
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'nodes_fts%'")[0]!.values.map((r) => String(r[0]));
    const worker = readFileSync(join(__dirname, "../lib/localDbWorker.ts"), "utf8");
    const wiped = worker.slice(worker.indexOf("async function wipeWorkspaceMirror"), worker.indexOf("// ── RPC dispatch"));
    const missing = tables.filter((t) => !wiped.includes(`"${t}"`));
    expect(missing, "這些本機資料表在撤權時不會被清掉").toEqual([]);
  });
});
