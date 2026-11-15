// Warm boot in two phases (perf F4). loadBootstrapList paints the notes with no
// edges, tasks, suggestions, graph positions or attrs; this module merges the
// rest when it arrives. The rule everywhere: what the store already holds wins.
// The rest was read from the mirror after the paint, so a note the user (or a
// sync delta) changed since is newer than the mirror row read for it; the merge
// only fills what is missing, and never for a note the store no longer has.
import type { Bootstrap } from "../api";

type Relations = Pick<Bootstrap, "edges" | "pointers" | "tasks" | "suggestions" | "graph_positions">;

function unionById<T extends { id: string }>(held: T[] | undefined, read: T[] | undefined, keep: (item: T) => boolean = () => true): T[] | undefined {
  if (!read || read.length === 0) return held;
  const ids = new Set((held ?? []).map(item => item.id));
  const added = read.filter(item => !ids.has(item.id) && keep(item));
  return added.length === 0 ? held : [...(held ?? []), ...added];
}

/** Edges, pointers, tasks and suggestions the store lacks; an edge or pointer
 *  only while its notes are still in the store. Graph positions only fill an
 *  empty store. Returns `prev` itself when nothing was added. */
export function mergeBootstrapRelations(prev: Bootstrap, rest: Relations): Bootstrap {
  const live = new Set(prev.nodes.map(n => n.id));
  const edges = unionById(prev.edges, rest.edges, e => live.has(e.source_node_id) && live.has(e.target_node_id)) ?? prev.edges;
  const pointers = unionById(prev.pointers, rest.pointers, p => live.has(p.target_id) && (p.parent_id === null || live.has(p.parent_id)));
  const tasks = unionById(prev.tasks, rest.tasks) ?? prev.tasks;
  const suggestions = unionById(prev.suggestions, rest.suggestions) ?? prev.suggestions;
  const graph_positions = (prev.graph_positions?.length ?? 0) === 0 && (rest.graph_positions?.length ?? 0) > 0
    ? rest.graph_positions!.filter(g => live.has(g.nodeId)) : prev.graph_positions;
  if (edges === prev.edges && pointers === prev.pointers && tasks === prev.tasks && suggestions === prev.suggestions && graph_positions === prev.graph_positions) return prev;
  return { ...prev, edges, ...(pointers ? { pointers } : {}), tasks, suggestions, ...(graph_positions ? { graph_positions } : {}) };
}

/** Attribute rows into the notes' attrs maps, key by key and only where the
 *  note has no value for that key yet. Returns `prev` itself when nothing was added. */
export function mergeAttributeRows(prev: Bootstrap, rows: Array<{ node_id: string; key: string; value: string }>): Bootstrap {
  const byNode = new Map<string, Array<{ key: string; value: string }>>();
  for (const row of rows) {
    const list = byNode.get(row.node_id);
    if (list) list.push(row); else byNode.set(row.node_id, [row]);
  }
  let changed = false;
  const nodes = prev.nodes.map(node => {
    const list = byNode.get(node.id);
    if (!list) return node;
    const attrs = node.attrs ?? {};
    const missing = list.filter(row => !(row.key in attrs));
    if (missing.length === 0) return node;
    changed = true;
    const filled = { ...attrs };
    for (const row of missing) filled[row.key] = row.value;
    return { ...node, attrs: filled };
  });
  return changed ? { ...prev, nodes } : prev;
}
