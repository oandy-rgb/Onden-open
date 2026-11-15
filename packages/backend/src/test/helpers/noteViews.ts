// What a workspace holds, in a shape two workspaces can be compared by: every
// note keyed by what a person would call it (space, title, whether it is in the
// trash), never by id. The backup round-trip tests compare these.

import { q } from "../../db.js";

export type NoteView = {
  key: string;
  title: string;
  deleted: boolean;
  slug: string;
  space: string | null;
  parent: string | null;
  hidden: boolean;
  markdown: string;
  tags: string[];
  attributes: Record<string, string>;
  positions: string[];
  /** `origin:target-key` of the edges out of it. */
  edges: string[];
};

type Row = { id: string; title: string; deleted: boolean; slug: string; space: string | null; parent_id: string | null; hidden: boolean; markdown: string; node_type: string };

export async function noteViewsOf(workspaceId: string): Promise<Map<string, NoteView>> {
  const rows = (await q<Row>(
    `SELECT n.id::text, n.title, n.deleted_at IS NOT NULL AS deleted, n.slug, CASE WHEN s.kind = 'personal' THEN 'personal' ELSE s.name END AS space, n.parent_id::text, n.hidden, n.markdown, n.node_type
       FROM content_nodes n LEFT JOIN spaces s ON s.id = n.space_id
      WHERE n.workspace_id = $1 AND n.node_type <> 'class_tag'`, [workspaceId])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A note's key: its space, its parents' titles and its own, and whether it is in the trash. Twins of
  // one title differ by the trash flag; tasks (hidden, one title for a host) by their id-free order.
  const keyOf = (r: Row): string => {
    const path: string[] = [];
    for (let at: Row | undefined = r, guard = 0; at && guard < 50; at = at.parent_id ? byId.get(at.parent_id) : undefined, guard++) path.unshift(at.title);
    return `${r.space ?? "-"}|${path.join("/")}|${r.deleted ? "trash" : "live"}|${r.hidden ? "hidden" : "shown"}`;
  };
  const keys = new Map(rows.map((r) => [r.id, keyOf(r)]));
  const tagNames = new Map((await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [workspaceId])).rows.map((r) => [r.id, r.title]));
  const view = new Map<string, NoteView>();
  for (const r of rows) {
    const attributes = Object.fromEntries((await q<{ key: string; value: string }>(`SELECT key, value FROM node_attributes WHERE node_id = $1 ORDER BY key`, [r.id])).rows.map((a) => [a.key, a.value]));
    const tags = (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [r.id])).rows.map((t) => tagNames.get(t.tag_id) ?? "?").sort();
    const positions = (await q<{ surface: string; x: number; y: number }>(`SELECT surface, x, y FROM node_positions WHERE node_id = $1 ORDER BY surface`, [r.id])).rows
      .map((p) => `${keys.get(p.surface) ?? p.surface}@${p.x},${p.y}`).sort();
    const edges = (await q<{ target_node_id: string; origin: string; edge_type: string }>(`SELECT target_node_id::text, origin, edge_type FROM node_edges WHERE source_node_id = $1`, [r.id])).rows
      .map((e) => `${e.origin}/${e.edge_type}:${keys.get(e.target_node_id) ?? tagNames.get(e.target_node_id) ?? "?"}`).sort();
    const parent = r.parent_id ? keys.get(r.parent_id) ?? null : null;
    const key = `${keys.get(r.id)!}|${r.title}`;
    // Rows that share every visible trait (two tasks of one host with one title) get a counter.
    let unique = key; for (let i = 2; view.has(unique); i++) unique = `${key}#${i}`;
    view.set(unique, { key: unique, title: r.title, deleted: r.deleted, // A task's slug is made from its own id, which is new in every workspace.
    slug: r.slug.replace(/^task-[0-9a-f-]{36}$/, "task-<id>"), space: r.space, parent, hidden: r.hidden, markdown: r.markdown.replace(/onden:\/\/node\/[0-9a-f-]{36}/g, (m) => `onden://node/${keys.get(m.slice(-36)) ?? "?"}`), tags, attributes, positions, edges });
  }
  return view;
}
