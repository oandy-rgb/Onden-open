// The local SQLite mirror's row writers: one per table, so the column list and
// the merge rules live once. Bootstrap persistence, sync deltas and the
// worker's optimistic writes all go through these.
//
// Two rules a caller would otherwise have to re-derive (and used to, four
// times, slightly differently):
//   • A SLIM row carries no body: it keeps the body this device already stored
//     instead of erasing it. A row is slim when its markdown is "" and its
//     body_len says there is a body (> 0) — or, in a payload that omits bodies
//     (slim bootstrap), unless body_len confirms an empty note (0).
//   • space_id: a row from the server is authoritative, null included. A row
//     made on this device has no space yet, so it keeps the stored one.

import type { BindParams } from "sql.js";
import type { ContentNode, NodeEdge, NotePointer } from "./api";

export type MirrorDb = { run: (sql: string, params?: BindParams) => unknown };

export type NodeRowOrigin = {
  /** "server": bootstrap or sync delta. "local": an optimistic write here. */
  from: "server" | "local";
  /** The payload leaves bodies out (slim bootstrap): an empty markdown
   *  without body_len means "not sent", not "empty". */
  bodiesOmitted?: boolean;
  /** Refresh the full-text row too (skip when the caller rebuilds FTS wholesale). */
  index?: boolean;
};

/** True for a row that names a body it doesn't carry. */
function isSlimRow(n: Pick<ContentNode, "markdown" | "body_len">, bodiesOmitted = false): boolean {
  if (n.markdown) return false;
  return bodiesOmitted ? n.body_len !== 0 : (n.body_len ?? 0) > 0;
}

const json = (value: unknown) => (value ? JSON.stringify(value) : null);

/** Insert or merge one note row (see the rules above). */
export function upsertNodeInto(d: MirrorDb, n: ContentNode, { from, bodiesOmitted = false, index = true }: NodeRowOrigin): void {
  const slim = isSlimRow(n, bodiesOmitted);
  d.run(
    `INSERT INTO nodes (id, source_type, node_type, title, slug, markdown, parent_id, hidden, sort_order, presentation, tag_schema, class_tag_ids, label_tag_ids, updated_at, body_len, space_id, created_at, collection_views)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_type=excluded.source_type, node_type=excluded.node_type, title=excluded.title,
       slug=excluded.slug,
       markdown=CASE WHEN ? = 1 THEN nodes.markdown ELSE excluded.markdown END,
       parent_id=excluded.parent_id, hidden=excluded.hidden, sort_order=excluded.sort_order,
       presentation=excluded.presentation,
       tag_schema=excluded.tag_schema, class_tag_ids=excluded.class_tag_ids,
       label_tag_ids=excluded.label_tag_ids, updated_at=excluded.updated_at,
       body_len=excluded.body_len,
       space_id=CASE WHEN ? = 1 THEN COALESCE(excluded.space_id, nodes.space_id) ELSE excluded.space_id END,
       created_at=COALESCE(excluded.created_at, nodes.created_at),
       collection_views=CASE WHEN ? = 1 THEN excluded.collection_views ELSE nodes.collection_views END`,
    [
      n.id, n.source_type, n.node_type, n.title, n.slug, n.markdown ?? "",
      n.parent_id ?? null, n.hidden ? 1 : 0, n.sort_order ?? 0,
      json(n.presentation), json(n.tag_schema), json(n.class_tag_ids), json(n.label_tag_ids),
      n.updated_at ?? null,
      slim ? (n.body_len ?? null) : (n.markdown ?? "").length,
      n.space_id ?? null,
      n.created_at ?? null,
      json(n.collection_views),
      slim ? 1 : 0,
      from === "local" ? 1 : 0,
      // A row that does not carry its views (an optimistic write of the text)
      // keeps the stored ones; one that does (bootstrap, sync) replaces them.
      n.collection_views !== undefined ? 1 : 0,
    ],
  );
  if (index && !slim) reindexNodeText(d, n.id, n.title, n.markdown ?? "");
}

/** Replace a note's full-text row. Best effort: FTS5 may be unavailable. */
export function reindexNodeText(d: MirrorDb, id: string, title: string, markdown: string): void {
  try {
    d.run("DELETE FROM nodes_fts WHERE id = ?", [id]);
    d.run("INSERT INTO nodes_fts(id, title, markdown) VALUES(?, ?, ?)", [id, title, markdown]);
  } catch { /* FTS is best-effort; ignore when the virtual table is unavailable */ }
}

export function upsertEdgeInto(d: MirrorDb, e: NodeEdge): void {
  d.run(
    `INSERT INTO edges (id, source_node_id, target_node_id, edge_type, status, origin) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_node_id=excluded.source_node_id, target_node_id=excluded.target_node_id,
       edge_type=excluded.edge_type, status=excluded.status, origin=COALESCE(excluded.origin, edges.origin)`,
    [e.id, e.source_node_id, e.target_node_id, e.edge_type, e.status, e.origin ?? null],
  );
}

export function upsertPointerInto(d: MirrorDb, p: NotePointer): void {
  d.run(
    `INSERT INTO pointers (id, parent_id, target_id, sort_order, display_prefix) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, target_id=excluded.target_id,
       sort_order=excluded.sort_order, display_prefix=excluded.display_prefix`,
    [p.id, p.parent_id, p.target_id, p.sort_order ?? 0, p.display_prefix ?? null],
  );
}

export type MirrorAttribute = {
  node_id: string;
  key: string;
  value: string;
  /** Omitted fields take the column defaults: text, not inheritable, explicit. */
  value_type?: string;
  is_inheritable?: boolean;
  source?: string;
};

const INSERT_ATTRIBUTE = "INSERT INTO node_attributes (node_id, key, value, value_type, is_inheritable, source) VALUES (?, ?, ?, ?, ?, ?)";
const attributeParams = (a: MirrorAttribute) =>
  [a.node_id, a.key, a.value, a.value_type ?? "text", a.is_inheritable ? 1 : 0, a.source ?? "ui"];

/** Add an attribute this device has no copy of; an existing copy wins (a
 *  server value read on open, localDbPersist.fillAttributesInto). */
export function fillAttributeInto(d: MirrorDb, a: MirrorAttribute): void {
  d.run(
    `${INSERT_ATTRIBUTE} ON CONFLICT(node_id, key) DO NOTHING`,
    attributeParams(a),
  );
}

export function upsertAttributeInto(d: MirrorDb, a: MirrorAttribute): void {
  d.run(
    `${INSERT_ATTRIBUTE}
     ON CONFLICT(node_id, key) DO UPDATE SET
       value=excluded.value, value_type=excluded.value_type,
       is_inheritable=excluded.is_inheritable, source=excluded.source,
       updated_at=datetime('now')`,
    attributeParams(a),
  );
}
